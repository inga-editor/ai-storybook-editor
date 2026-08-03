// config-spread-pool-settings.test.tsx — interaction tests for the Spread Pool panel.
//
// runLockedResourceSave is mocked (no network). Store selectors are mocked so the panel
// renders off a fixed spreads array; because a `blocked` save never applies locally, the
// derived controls stay pinned to the mocked DB value.
// vitest only — NO node builtins (tsc -b type-checks with vite/client types).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { BaseSpread } from '@/types/spread-types';
import type { Book } from '@/types/editor';
import type { LockTarget, SavePayload } from '@/stores/resource-lock-store/types';

// ── Mocks ────────────────────────────────────────────────────────────────────
const runLockedResourceSaveMock = vi.fn();

vi.mock('@/features/editor/utils/structural-lock-resource-save', () => ({
  runLockedResourceSave: (...args: unknown[]) => runLockedResourceSaveMock(...args),
}));

const updateIllustrationSpread = vi.fn();
let mockSpreads: BaseSpread[] = [];
let mockBook: Book | null = null;

vi.mock('@/stores/snapshot-store/selectors', () => ({
  useIllustrationSpreads: () => mockSpreads,
  useSnapshotActions: () => ({ updateIllustrationSpread }),
}));

vi.mock('@/stores/book-store', () => ({
  useCurrentBook: () => mockBook,
}));

import { ConfigSpreadPoolSettings } from './config-spread-pool-settings';

// ── Fixtures ─────────────────────────────────────────────────────────────────
function spread(id: string, over: Partial<BaseSpread> = {}): BaseSpread {
  return { id, pages: [], images: [], textboxes: [], ...over };
}

const BOOK: Book = {
  id: 'b1',
  original_language: 'en_US',
  remix: {
    story: {} as never,
    characters: [],
    memories: {} as never,
    voices: [],
    languages: [
      { name: 'English', code: 'en_US', is_enabled: true },
      { name: 'Tiếng Việt', code: 'vi_VN', is_enabled: true },
    ],
  },
} as unknown as Book;

beforeEach(() => {
  cleanup();
  runLockedResourceSaveMock.mockReset();
  updateIllustrationSpread.mockReset();
  // Default: apply optimistically + report saved.
  runLockedResourceSaveMock.mockImplementation(
    async (_t: LockTarget, _s: SavePayload, applyLocal: () => void) => {
      applyLocal();
      return 'saved';
    },
  );
  mockBook = BOOK;
  mockSpreads = [
    spread('sp1', { pool: { is_true: true, is_default: false }, title: { en_US: { text: 'Hello' } } }),
    spread('sp2', { pool: { is_true: false, is_default: true }, title: { en_US: { text: 'World' } } }),
    spread('sp3'), // never pooled, no title
  ];
});

describe('ConfigSpreadPoolSettings', () => {
  it('toggle OFF disables (not hides) the title input + DEFAULT checkbox while showing the real DB value', () => {
    render(<ConfigSpreadPoolSettings />);
    // sp2 is pool.is_true === false.
    const input = screen.getByLabelText('Title for spread 2 (en_US)') as HTMLInputElement;
    expect(input).toBeInTheDocument(); // not hidden
    expect(input).toBeDisabled();
    expect(input.value).toBe('World'); // real DB value retained

    const checkbox = screen.getByLabelText('Mark World as the default pool spread');
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute('aria-checked', 'true'); // is_default true kept
  });

  it('commits the title only on blur, not on each keystroke', () => {
    render(<ConfigSpreadPoolSettings />);
    const input = screen.getByLabelText('Title for spread 1 (en_US)');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Hello World' } });
    expect(runLockedResourceSaveMock).not.toHaveBeenCalled(); // no per-keystroke save
    fireEvent.blur(input);
    expect(runLockedResourceSaveMock).toHaveBeenCalledTimes(1);
    const save = runLockedResourceSaveMock.mock.calls[0][1] as SavePayload;
    expect(save.patch).toEqual({ title: { en_US: { text: 'Hello World' } } });
  });

  it('passes a lock target with step === 2 and resource_type === 6 (owned-key merge)', () => {
    render(<ConfigSpreadPoolSettings />);
    const toggle = screen.getByLabelText('Include Hello in the spread pool');
    fireEvent.click(toggle); // sp1 toggle off → save
    expect(runLockedResourceSaveMock).toHaveBeenCalledTimes(1);
    const target = runLockedResourceSaveMock.mock.calls[0][0] as LockTarget;
    expect(target.step).toBe(2);
    expect(target.resource_type).toBe(6);
    expect(target.resource_id).toBe('sp1');
  });

  it('toggling ON a never-pooled spread writes a seeded pool object (skip-write covered in helpers)', () => {
    render(<ConfigSpreadPoolSettings />);
    const toggle = screen.getByLabelText('Include Spread 3 in the spread pool');
    expect(toggle).toHaveAttribute('aria-checked', 'false'); // sp3 starts OFF
    fireEvent.click(toggle); // OFF → ON
    expect(runLockedResourceSaveMock).toHaveBeenCalledTimes(1);
    const save = runLockedResourceSaveMock.mock.calls[0][1] as SavePayload;
    expect(save.patch).toEqual({ pool: { is_true: true, is_default: false } });
  });

  it('blocked save leaves the displayed value unchanged (no optimistic apply)', () => {
    runLockedResourceSaveMock.mockImplementation(async () => 'blocked'); // applyLocal NOT called
    render(<ConfigSpreadPoolSettings />);
    const toggle = screen.getByLabelText('Include Hello in the spread pool');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    // Store never updated (applyLocal skipped + updateIllustrationSpread not called) →
    // derived control still reflects DB (checked).
    expect(updateIllustrationSpread).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Include Hello in the spread pool')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('renders an empty state when there are no spreads', () => {
    mockSpreads = [];
    render(<ConfigSpreadPoolSettings />);
    expect(screen.getByText(/finish illustration phase first/i)).toBeInTheDocument();
  });
});
