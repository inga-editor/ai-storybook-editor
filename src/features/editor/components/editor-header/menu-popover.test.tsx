// menu-popover.test.tsx — Behaviour lock for the header hamburger menu (phase 04).
//
// What this file guards (the phase's own completion criteria, previously verified by reading):
//  1. Cost-row permission matrix — allowed → actionable; denied → inert + reason, no callback.
//  2. Permission-PENDING must not render as denied (a real review finding: an admin briefly saw
//     a greyed row + a false "only the owner…" tooltip while the role fetch was in flight).
//  3. Cost label states: loading → skeleton, error → "—", loaded → formatUsd of the value given.
//  4. No row is EVER hidden — greyed, never filtered (hard project rule).
//  5. Clone ships disabled ("Coming soon") for everyone, owner included, and fires nothing.
//  6. Editor-mode submenu: both options disabled, current one checked.
//
// Assertions are role/aria/text based on purpose — Tailwind class strings are implementation
// detail and would break on any restyle.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { EditorMode } from '@/types/editor';
import { MenuPopover, type MenuPopoverCost } from './menu-popover';

// The nav-guard selectors are the only store coupling in this component; stub them so the menu
// renders without a snapshot store. Every test here is about permissions, not the nav guard.
const { navGuardState } = vi.hoisted(() => ({
  navGuardState: { hasPendingImageTasks: false, isSketchGenerating: false, isVariantGenerating: false },
}));

vi.mock('@/stores/snapshot-store/selectors', () => ({
  useHasPendingImageTasks: () => navGuardState.hasPendingImageTasks,
  useIsAnySketchGenerating: () => navGuardState.isSketchGenerating,
  useIsAnyVariantSheetGenerating: () => navGuardState.isVariantGenerating,
}));

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

// (Radix needs a ResizeObserver; the stub lives in src/test/setup.ts — shared by every
// component test.)

const COST_DENIED_TEXT = 'Only the book owner can view costs.';
const CLONE_COMING_SOON_TEXT = 'Coming soon';
const MODE_READ_ONLY_TEXT = "Editor mode is set by the book type and can't be changed here.";

const LOADED_COST: MenuPopoverCost = {
  isLoading: false,
  hasError: false,
  totalCostUsd: 12.5,
  budgetUsd: 100,
};

interface RenderOptions {
  cost?: Partial<MenuPopoverCost>;
  canViewCost?: boolean;
  isCostPermissionPending?: boolean;
  isOwner?: boolean;
  editorMode?: EditorMode;
}

function renderMenu(options: RenderOptions = {}) {
  const spies = {
    onNavigateHome: vi.fn(),
    onOpenCostModal: vi.fn(),
    onRequestCloneBook: vi.fn(),
    onOpenChange: vi.fn(),
  };

  render(
    // delayDuration 0 → the reason tooltips resolve without fake timers.
    <TooltipProvider delayDuration={0}>
      <MenuPopover
        isOpen
        onOpenChange={spies.onOpenChange}
        editorMode={options.editorMode ?? 'book'}
        cost={{ ...LOADED_COST, ...options.cost }}
        canViewCost={options.canViewCost ?? true}
        isCostPermissionPending={options.isCostPermissionPending ?? false}
        isOwner={options.isOwner ?? true}
        onNavigateHome={spies.onNavigateHome}
        onOpenCostModal={spies.onOpenCostModal}
        onRequestCloneBook={spies.onRequestCloneBook}
      >
        <button type="button">menu</button>
      </MenuPopover>
    </TooltipProvider>,
  );

  return { user: userEvent.setup(), ...spies };
}

const costRow = () => screen.getByRole('menuitem', { name: /^Cost/ });
const cloneRow = () => screen.getByRole('menuitem', { name: /clone this book/i });

/** Radix opens a tooltip on trigger focus with no delay — deterministic, unlike hover timing.
 *  `findAllByText` IS the assertion: it rejects (failing the test) if the reason never appears. */
async function expectReasonTooltip(row: HTMLElement, text: string) {
  fireEvent.focus(row);
  // Radix renders the reason twice (visible content + a visually-hidden `role="tooltip"` copy).
  await screen.findAllByText(text);
}

describe('MenuPopover — cost row permission matrix', () => {
  it('is actionable and opens the modal when the viewer may see costs', async () => {
    const { user, onOpenCostModal } = renderMenu({ canViewCost: true });

    const row = costRow();
    expect(row).not.toHaveAttribute('aria-disabled');

    await user.click(row);
    expect(onOpenCostModal).toHaveBeenCalledTimes(1);
  });

  it('is inert, explains why, and opens nothing when the viewer may not', async () => {
    const { user, onOpenCostModal } = renderMenu({
      canViewCost: false,
      isCostPermissionPending: false,
    });

    const row = costRow();
    expect(row).toHaveAttribute('aria-disabled', 'true');

    await user.click(row);
    expect(onOpenCostModal).not.toHaveBeenCalled();

    await expectReasonTooltip(row, COST_DENIED_TEXT);
  });

  it('shows "—" instead of a number when the viewer may not see costs', () => {
    renderMenu({ canViewCost: false, isCostPermissionPending: false });

    expect(within(costRow()).getByText('—')).toBeInTheDocument();
    expect(within(costRow()).queryByText(/\$/)).not.toBeInTheDocument();
  });
});

describe('MenuPopover — permission-pending window', () => {
  // Regression lock: `isCostRowInert` used to follow `!canViewCost`, which is also true while the
  // role is still resolving → an admin got a greyed, aria-disabled row plus a tooltip saying
  // something false, which then flipped to enabled.
  it('does not commit to the denied appearance while the role is still resolving', async () => {
    renderMenu({ canViewCost: false, isCostPermissionPending: true });

    const row = costRow();
    expect(row).not.toHaveAttribute('aria-disabled');

    fireEvent.focus(row);
    // The tooltip is pinned shut while pending, so the wrong reason can never flash.
    expect(screen.queryByText(COST_DENIED_TEXT)).not.toBeInTheDocument();
    await screen.findByRole('status', { name: 'Loading cost' });
  });

  it('renders a neutral skeleton, not "—", while the role is still resolving', () => {
    renderMenu({ canViewCost: false, isCostPermissionPending: true });

    expect(screen.getByRole('status', { name: 'Loading cost' })).toBeInTheDocument();
    expect(within(costRow()).queryByText('—')).not.toBeInTheDocument();
  });

  it('stays a no-op if clicked while the row looks neutral', async () => {
    // NOTE: `handleCostClick`'s `|| isCostPermissionPending` clause is defence in depth, not the
    // guard under test — `!canViewCost` already returns here, and via EditorHeader the two flags
    // can never both be true (`useCurrentProfile` reports `role: null` whenever `isLoading`).
    // What this locks is the user-visible property: a neutral-looking row is still not a door.
    const { user, onOpenCostModal } = renderMenu({
      canViewCost: false,
      isCostPermissionPending: true,
    });

    await user.click(costRow());
    expect(onOpenCostModal).not.toHaveBeenCalled();
  });
});

describe('MenuPopover — cost label states', () => {
  it('renders a skeleton while the cost request is in flight', () => {
    renderMenu({ canViewCost: true, cost: { isLoading: true } });

    expect(screen.getByRole('status', { name: 'Loading cost' })).toBeInTheDocument();
    expect(within(costRow()).queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('renders "—" when the cost request failed', () => {
    renderMenu({ canViewCost: true, cost: { hasError: true } });

    expect(within(costRow()).getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading cost' })).not.toBeInTheDocument();
  });

  it('renders the formatted figure it is handed — the Original-scope total, not a grand total', () => {
    // EditorHeader passes `scopes[0].totalCostUsd` (Original); remix spend is billed separately
    // (ADR-050). This locks the formatting + that the row shows exactly the value it receives.
    renderMenu({ canViewCost: true, cost: { totalCostUsd: 12.5 } });

    expect(within(costRow()).getByText('$12.50')).toBeInTheDocument();
  });

  it('renders $0.00 — a real answer — rather than a dash for a book with no spend', () => {
    renderMenu({ canViewCost: true, cost: { totalCostUsd: 0 } });

    expect(within(costRow()).getByText('$0.00')).toBeInTheDocument();
    expect(within(costRow()).queryByText('—')).not.toBeInTheDocument();
  });
});

describe('MenuPopover — no row is ever hidden', () => {
  const ROW_NAMES = [/^Cost/, /^Home$/, /^Editor Mode$/, /clone this book/i];

  it.each([
    ['owner', { canViewCost: true, isOwner: true, isCostPermissionPending: false }],
    ['admin (not owner)', { canViewCost: true, isOwner: false, isCostPermissionPending: false }],
    ['collaborator', { canViewCost: false, isOwner: false, isCostPermissionPending: false }],
    ['role pending', { canViewCost: false, isOwner: false, isCostPermissionPending: true }],
  ])('renders every row for %s', (_label, options) => {
    renderMenu(options);

    for (const name of ROW_NAMES) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('menuitem')).toHaveLength(ROW_NAMES.length);
  });
});

describe('MenuPopover — clone row', () => {
  it.each([
    ['owner', true],
    ['non-owner', false],
  ])('is disabled with a "Coming soon" reason for %s', async (_label, isOwner) => {
    renderMenu({ isOwner });

    const row = cloneRow();
    expect(row).toHaveAttribute('aria-disabled', 'true');
    await expectReasonTooltip(row, CLONE_COMING_SOON_TEXT);
  });

  it('does not request a clone when clicked, even for the owner', async () => {
    const { user, onRequestCloneBook } = renderMenu({ isOwner: true });

    await user.click(cloneRow());
    expect(onRequestCloneBook).not.toHaveBeenCalled();
  });
});

describe('MenuPopover — Home row', () => {
  it('navigates home and closes the menu', async () => {
    const { user, onNavigateHome, onOpenChange } = renderMenu();

    await user.click(screen.getByRole('menuitem', { name: /^Home$/ }));

    expect(onNavigateHome).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('MenuPopover — editor mode submenu', () => {
  it.each([
    ['book' as const, 'Book'],
    ['asset' as const, 'Asset'],
  ])('marks %s as the current mode and disables both options', async (editorMode, checkedLabel) => {
    const { user } = renderMenu({ editorMode });

    const trigger = screen.getByRole('menuitem', { name: /^Editor Mode$/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['Book', 'Asset']);

    for (const option of options) {
      expect(option).toHaveAttribute('aria-disabled', 'true');
      expect(option).toHaveAttribute(
        'aria-checked',
        String(option.textContent === checkedLabel),
      );
    }
  });

  it('explains why the mode cannot be changed here', async () => {
    const { user } = renderMenu({ editorMode: 'book' });

    await user.click(screen.getByRole('menuitem', { name: /^Editor Mode$/ }));
    const option = (await screen.findAllByRole('menuitemradio'))[0];

    await expectReasonTooltip(option, MODE_READ_ONLY_TEXT);
  });
});

// §4.2 — Radix `Popover` (unlike `DropdownMenu`) ships NO arrow-key navigation, so `role="menu"`
// would be promising behaviour that does not exist. The handler is hand-rolled, which is exactly
// why it needs a test: deleting its body left every other test in this file green.
describe('MenuPopover — arrow-key roving focus', () => {
  const ROW_ORDER = [/^Cost/, /^Home$/, /^Editor Mode$/, /clone this book/i];

  const menu = () => screen.getByRole('menu', { name: 'Book menu' });
  const rowAt = (index: number) => screen.getByRole('menuitem', { name: ROW_ORDER[index] });

  it('enters the ring at the first row and steps down', () => {
    renderMenu();
    menu().focus();

    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(rowAt(0)).toHaveFocus();

    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(rowAt(1)).toHaveFocus();
  });

  it('enters at the last row on ArrowUp and wraps around in both directions', () => {
    renderMenu();
    menu().focus();

    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(rowAt(ROW_ORDER.length - 1)).toHaveFocus();

    // last → wrap forward to first
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(rowAt(0)).toHaveFocus();

    // first → wrap backward to last
    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(rowAt(ROW_ORDER.length - 1)).toHaveFocus();
  });

  it('keeps disabled rows in the ring so their reason stays reachable', () => {
    // Deliberate: the rows use `aria-disabled`, not `disabled`, precisely so a keyboard user can
    // land on them and be told WHY they are unavailable.
    renderMenu({ canViewCost: false, isOwner: false });
    menu().focus();

    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(costRow()).toHaveFocus();
    expect(costRow()).toHaveAttribute('aria-disabled', 'true');

    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(cloneRow()).toHaveFocus();
    expect(cloneRow()).toHaveAttribute('aria-disabled', 'true');
  });

  it('ignores other keys', () => {
    renderMenu();
    menu().focus();

    fireEvent.keyDown(menu(), { key: 'ArrowLeft' });
    expect(menu()).toHaveFocus();
  });
});
