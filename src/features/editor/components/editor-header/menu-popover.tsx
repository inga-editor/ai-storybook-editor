// menu-popover.tsx — The header hamburger menu.
//
// Spec: ai-storybook-design/component/editor-page/01-editor-header.md §3.6 (+ §3.6.1-3.6.3, §4.5)
// Mock: .../screenshots/header/header-menu.png
//
// Redesign 2026-07-27: the old `✨ Points 750/1000` row is GONE (a virtual quota with no data
// source) and is replaced by `$ Cost $12.50 ›` + a budget bar, reading real spend out of
// `ai_service_logs` via the cost gateway. Three groups, exactly TWO dividers — there is no divider
// between "Editor Mode" and "Clone this book" (the mock is authoritative).
//
// Purely presentational: every number, permission flag and side effect is owned by EditorHeader.

import { ArrowLeft, ChevronRight, Copy, DollarSign } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useHasPendingImageTasks,
  useIsAnySketchGenerating,
  useIsAnyVariantSheetGenerating,
} from '@/stores/snapshot-store/selectors';
import { toast } from 'sonner';
import { formatUsd } from '@/utils/format-usd';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import { EditorModeSubmenu } from './editor-mode-submenu';
import type { EditorMode } from '@/types/editor';

const log = createLogger('Editor', 'MenuPopover');

/** ≥80% of the budget → warning, ≥100% → danger. Below → primary (mock is a blue bar). */
const BUDGET_WARN_RATIO = 0.8;
const BUDGET_DANGER_RATIO = 1;

const COST_DENIED_REASON = 'Only the book owner can view costs.';
/** ⚠️ No clone endpoint exists yet — the row ships disabled for EVERYONE, owner included.
 *  Enabling it later = deleting `CLONE_NOT_AVAILABLE` and the flag below, nothing else. */
const CLONE_NOT_AVAILABLE: boolean = true;
const CLONE_COMING_SOON_REASON = 'Coming soon';
const CLONE_DENIED_REASON = 'Only the book owner can clone this book.';

/** Shared row geometry — every row is the same height; only group 1 carries a bar underneath. */
const ROW_CLASS =
  'flex w-full items-center gap-2 px-3 py-2 text-sm outline-none focus-visible:bg-accent';

export interface MenuPopoverCost {
  /** Prefetch in flight (or not started yet) → skeleton instead of a number. */
  isLoading: boolean;
  /** Prefetch failed → "—". Distinct from `$0.00`, which is a real answer. */
  hasError: boolean;
  /** ⚡ `scopes[0].totalCostUsd` (Original) — NOT `grandTotalUsd`: remix spend is billed
   *  separately (ADR-050) and folding it in would misstate this book's cost. */
  totalCostUsd: number;
  /** `BOOK_AI_BUDGET_USD` — an FE constant until `books` grows a budget column (§4.1). */
  budgetUsd: number;
}

interface MenuPopoverProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editorMode: EditorMode;
  cost: MenuPopoverCost;
  /** ⚡ `isOwner || isAdmin` — mirrors the backend gate (admin ∨ owner). A narrower FE gate would
   *  grey the row out for admins AND tell them something untrue. */
  canViewCost: boolean;
  /** Role still resolving and the viewer is not the owner: hold a neutral loading row rather than
   *  flashing a "you can't see this" tooltip that may be wrong a moment later. */
  isCostPermissionPending: boolean;
  /** Clone stays owner-only (clone ≠ reading billing). */
  isOwner: boolean;
  onNavigateHome: () => void;
  onOpenCostModal: () => void;
  /** Opens the confirm dialog — never clones directly. */
  onRequestCloneBook: () => void;
  children: React.ReactNode;
}

export function MenuPopover({
  isOpen,
  onOpenChange,
  editorMode,
  cost,
  canViewCost,
  isCostPermissionPending,
  isOwner,
  onNavigateHome,
  onOpenCostModal,
  onRequestCloneBook,
  children,
}: MenuPopoverProps) {
  const hasPendingTasks = useHasPendingImageTasks();
  // Nav-guard — blocks Home while ANY sketch generation runs. Variant ops are OR-ed in explicitly:
  // useIsAnySketchGenerating is the cross-space mutual-exclusion guard and deliberately excludes
  // them, but leaving the editor mid-generate loses the in-flight result either way.
  const isCrossSpaceGenerating = useIsAnySketchGenerating();
  const isVariantGenerating = useIsAnyVariantSheetGenerating();
  const isSketchGenerating = isCrossSpaceGenerating || isVariantGenerating;

  // ── Cost row state ───────────────────────────────────────────────────────────────────────
  // Permission-pending is deliberately NOT the same as denied: it renders neutral (no tooltip,
  // no grey), because a wrong "you can't see this" is worse than a half-second of nothing.
  const isCostDenied = !canViewCost && !isCostPermissionPending;
  // Follows DENIED, not "not yet known" — greying the row (and announcing `aria-disabled`) while
  // the role is still resolving would tell an admin something false for a few hundred ms. The
  // click path has its own pending guard, so a click in that window is a silent no-op.
  const isCostRowInert = isCostDenied;
  const costReason = isCostDenied ? COST_DENIED_REASON : null;

  const isCloneDisabled = CLONE_NOT_AVAILABLE || !isOwner;
  const cloneReason = CLONE_NOT_AVAILABLE
    ? CLONE_COMING_SOON_REASON
    : !isOwner
      ? CLONE_DENIED_REASON
      : null;

  /** Shared by Home and Clone: both leave the current editor, so both would lose in-flight work. */
  const isNavBlocked = (): boolean => {
    if (hasPendingTasks) {
      log.debug('isNavBlocked', 'blocked: image tasks pending');
      toast.warning('Please wait — images are still being generated');
      return true;
    }
    if (isSketchGenerating) {
      log.debug('isNavBlocked', 'blocked: sketch generating');
      toast.warning('Please wait — sketch is still generating');
      return true;
    }
    return false;
  };

  const handleHomeClick = () => {
    if (isNavBlocked()) return;
    log.info('handleHomeClick', 'navigating home');
    onNavigateHome();
    onOpenChange(false);
  };

  const handleCostClick = () => {
    if (!canViewCost || isCostPermissionPending) {
      log.debug('handleCostClick', 'no-op: cost row not actionable', {
        canViewCost,
        isCostPermissionPending,
      });
      return;
    }
    log.info('handleCostClick', 'opening cost breakdown modal');
    onOpenCostModal();
  };

  const handleCloneClick = () => {
    if (isCloneDisabled) {
      log.debug('handleCloneClick', 'no-op: clone row disabled', {
        isOwner,
        notAvailable: CLONE_NOT_AVAILABLE,
      });
      return;
    }
    if (isNavBlocked()) return;
    log.info('handleCloneClick', 'requesting clone confirmation');
    onRequestCloneBook();
  };

  // ── Budget bar ───────────────────────────────────────────────────────────────────────────
  // Ratio drives the COLOUR (so >100% still reads as danger); the clamped value drives the bar
  // (so an over-budget book fills the track instead of overflowing it).
  const budgetRatio =
    cost.budgetUsd > 0 ? cost.totalCostUsd / cost.budgetUsd : 0;
  const isCostFigureUnknown = cost.isLoading || cost.hasError || !canViewCost;
  const budgetPercent = isCostFigureUnknown
    ? 0
    : Math.min(Math.max(budgetRatio, 0), 1) * 100;
  const budgetIndicatorClass = isCostFigureUnknown
    ? 'bg-transparent transition-none'
    : budgetRatio >= BUDGET_DANGER_RATIO
      ? 'bg-destructive'
      : budgetRatio >= BUDGET_WARN_RATIO
        ? 'bg-amber-500'
        : 'bg-primary';

  // Skeleton while the answer is genuinely unknown (cost in flight OR permission not resolved);
  // "—" only once we know there is no number to show.
  const costValue =
    isCostPermissionPending || (canViewCost && cost.isLoading) ? (
      <span
        className="h-3 w-12 animate-pulse rounded bg-muted-foreground/20"
        role="status"
        aria-label="Loading cost"
      />
    ) : (
      <span className={cn('tabular-nums', isCostRowInert ? 'text-muted-foreground/50' : 'text-muted-foreground')}>
        {!canViewCost || cost.hasError ? '—' : formatUsd(cost.totalCostUsd)}
      </span>
    );

  // ↑/↓ roving focus (§4.2). Radix `Popover` — unlike `DropdownMenu` — ships no arrow-key nav, and
  // Tab alone is not what a `role="menu"` promises. Disabled rows stay in the ring on purpose:
  // they use `aria-disabled`, so they are reachable and can announce WHY they are unavailable.
  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const active = document.activeElement as HTMLElement | null;
    // Arrow keys pressed inside the portaled submenu still bubble here through the React tree —
    // ignore them, the submenu owns its own focus.
    if (active && !e.currentTarget.contains(active)) {
      log.debug('handleMenuKeyDown', 'skip: focus is inside the submenu', { key: e.key });
      return;
    }

    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    e.preventDefault();

    const current = active ? items.indexOf(active) : -1;
    const next =
      current < 0
        ? e.key === 'ArrowDown'
          ? 0
          : items.length - 1
        : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        role="menu"
        aria-label="Book menu"
        className="w-64 p-0"
        onKeyDown={handleMenuKeyDown}
      >
        {/* ── Group 1: Cost + budget bar ──────────────────────────────────────────────── */}
        <div role="none" className="py-1">
          <MenuRowWithReason reason={costReason}>
            {/* Whole row is the hit target, not just the chevron (§3.6). `aria-disabled` rather
                than `disabled` so the "why" tooltip can still be triggered. */}
            <button
              type="button"
              role="menuitem"
              onClick={handleCostClick}
              aria-disabled={isCostRowInert ? true : undefined}
              className={cn(
                ROW_CLASS,
                isCostRowInert
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : 'hover:bg-accent',
              )}
            >
              <DollarSign
                aria-hidden="true"
                className={cn('h-4 w-4 shrink-0', !isCostRowInert && 'text-primary')}
              />
              <span>Cost</span>
              <span className="ml-auto flex items-center gap-1">
                {costValue}
                <ChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              </span>
            </button>
          </MenuRowWithReason>

          {/* Same inset as the row above it. No numeric label — the mock has none. */}
          <div role="none" className="px-3 pb-1 pt-0.5">
            <Progress
              value={budgetPercent}
              aria-label="AI budget used"
              className="h-1.5"
              indicatorClassName={budgetIndicatorClass}
            />
          </div>
        </div>

        <Separator />

        {/* ── Group 2: Home ───────────────────────────────────────────────────────────── */}
        <div role="none" className="py-1">
          <button
            type="button"
            role="menuitem"
            onClick={handleHomeClick}
            className={cn(ROW_CLASS, 'hover:bg-accent')}
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>Home</span>
          </button>
        </div>

        <Separator />

        {/* ── Group 3: Editor Mode + Clone (NO divider between them — see mock) ────────── */}
        <div role="none" className="py-1">
          <EditorModeSubmenu editorMode={editorMode} />

          <MenuRowWithReason reason={cloneReason}>
            <button
              type="button"
              role="menuitem"
              onClick={handleCloneClick}
              aria-disabled={isCloneDisabled ? true : undefined}
              className={cn(
                ROW_CLASS,
                isCloneDisabled
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : 'hover:bg-accent',
              )}
            >
              <Copy aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>Clone this book</span>
            </button>
          </MenuRowWithReason>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Attaches a reason tooltip to a greyed-out row. Used by both gated rows — a row is never hidden,
 * so every grey state owes the user a reason.
 *
 * ⚠️ The `Tooltip` wrapper is ALWAYS rendered, even with no reason, and is pinned shut instead.
 * Returning a bare fragment when `reason` is null would change the element type at this position
 * the moment a reason appears (which happens for a non-owner when the role resolves), remounting
 * the row's `<button>` and dropping keyboard focus mid-interaction.
 */
function MenuRowWithReason({
  reason,
  children,
}: {
  reason: string | null;
  children: React.ReactNode;
}) {
  return (
    <Tooltip open={reason ? undefined : false}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {reason ? <TooltipContent side="right">{reason}</TooltipContent> : null}
    </Tooltip>
  );
}
