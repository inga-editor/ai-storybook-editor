// config-spread-pool-settings.test.tsx — interaction tests for the Spread Pool panel.
//
// Persistence is OWNER-DIRECT + BATCHED (chốt tối 2026-08-03): toggle/DEFAULT/title
// edits only mutate the store (dirty → 60s autosave / flush-on-hidden / unmount flush);
// flushSnapshot fires immediately ONLY on section unmount here (translate-save flush is
// covered via the modal callback path; generate flush lives in the job hook). Store
// selectors are mocked so the panel renders off a fixed spreads array.
// vitest only — NO node builtins (tsc -b type-checks with vite/client types).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { BaseSpread } from '@/types/spread-types';
import type { Section } from '@/types/illustration-types';
import type { Book } from '@/types/editor';
import type { UseSpreadThumbnailJob } from './use-spread-thumbnail-job';

// ── Mocks ────────────────────────────────────────────────────────────────────
const updateIllustrationSpread = vi.fn();
const flushSnapshotMock = vi.fn();
// Imperative post-flush outcome read (sync.isDirty false ⇒ saved).
let mockSyncState = { isDirty: false, error: null as string | null };
let mockSpreads: BaseSpread[] = [];
let mockSections: Section[] = [];
let mockBook: Book | null = null;

vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: { getState: () => ({ sync: mockSyncState }) },
}));

vi.mock('@/stores/snapshot-store/selectors', () => ({
  useIllustrationSpreads: () => mockSpreads,
  useSections: () => mockSections,
  useSnapshotActions: () => ({ updateIllustrationSpread, flushSnapshot: flushSnapshotMock }),
  useSnapshotId: () => 'snap-1',
}));

vi.mock('@/stores/book-store', () => ({
  useCurrentBook: () => mockBook,
}));

// The thumbnail job hook is exercised in isolation elsewhere — here we drive its
// return so the panel's Generate button + optimistic row overrides are testable.
const startGenerateMock = vi.fn();
let mockJobState: UseSpreadThumbnailJob = {
  isRunning: false,
  progress: null,
  thumbnailOverrides: {},
  startGenerate: startGenerateMock,
};
vi.mock('./use-spread-thumbnail-job', () => ({
  useSpreadThumbnailJob: () => mockJobState,
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
  updateIllustrationSpread.mockReset();
  flushSnapshotMock.mockReset();
  startGenerateMock.mockReset();
  mockSections = [];
  mockSyncState = { isDirty: false, error: null };
  mockJobState = {
    isRunning: false,
    progress: null,
    thumbnailOverrides: {},
    startGenerate: startGenerateMock,
  };
  // Default: flush lands (isDirty stays false ⇒ saved).
  flushSnapshotMock.mockResolvedValue(undefined);
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

  it('commits the title only on blur, not on each keystroke — BATCHED (no immediate flush)', () => {
    render(<ConfigSpreadPoolSettings />);
    const input = screen.getByLabelText('Title for spread 1 (en_US)');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Hello World' } });
    expect(updateIllustrationSpread).not.toHaveBeenCalled(); // no per-keystroke write
    fireEvent.blur(input);
    expect(updateIllustrationSpread).toHaveBeenCalledWith('sp1', {
      title: { en_US: { text: 'Hello World' } },
    });
    expect(flushSnapshotMock).not.toHaveBeenCalled(); // batched — autosave/unmount persists
  });

  it('toggling ON a never-pooled spread writes a seeded pool object — BATCHED (no immediate flush)', () => {
    render(<ConfigSpreadPoolSettings />);
    const toggle = screen.getByLabelText('Include Spread 3 in the spread pool');
    expect(toggle).toHaveAttribute('aria-checked', 'false'); // sp3 starts OFF
    fireEvent.click(toggle); // OFF → ON
    expect(updateIllustrationSpread).toHaveBeenCalledWith('sp3', {
      pool: { is_true: true, is_default: false },
    });
    expect(flushSnapshotMock).not.toHaveBeenCalled();
  });

  it('unmounting the section flushes pending batched edits', () => {
    const { unmount } = render(<ConfigSpreadPoolSettings />);
    fireEvent.click(screen.getByLabelText('Include Spread 3 in the spread pool'));
    expect(flushSnapshotMock).not.toHaveBeenCalled();
    unmount();
    expect(flushSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('locks every edit while the thumbnail job runs (stale flush would clobber BE-written thumbnails)', () => {
    mockJobState = {
      isRunning: true,
      progress: { done: 0, total: 3 },
      thumbnailOverrides: {},
      startGenerate: startGenerateMock,
    };
    render(<ConfigSpreadPoolSettings />);
    expect(screen.getByLabelText('Include Hello in the spread pool')).toBeDisabled();
    expect(screen.getByLabelText('Title for spread 1 (en_US)')).toBeDisabled();
    expect(screen.getByLabelText('Mark Hello as the default pool spread')).toBeDisabled();
  });

  it('renders an empty state when there are no spreads', () => {
    mockSpreads = [];
    render(<ConfigSpreadPoolSettings />);
    expect(screen.getByText(/finish illustration phase first/i)).toBeInTheDocument();
  });

  it('shows "Generating… 1/3" on the button while the thumbnail job runs', () => {
    mockJobState = {
      isRunning: true,
      progress: { done: 1, total: 3 },
      thumbnailOverrides: {},
      startGenerate: startGenerateMock,
    };
    render(<ConfigSpreadPoolSettings />);
    const btn = screen.getByRole('button', { name: /Generating… 1\/3/ });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it('renders a step_details thumbnail override on the matching row', () => {
    mockJobState = {
      isRunning: true,
      progress: { done: 1, total: 3 },
      thumbnailOverrides: { sp1: 'https://cdn.test/sp1-thumb.webp' },
      startGenerate: startGenerateMock,
    };
    render(<ConfigSpreadPoolSettings />);
    // sp1 label resolves to its title 'Hello'.
    const img = screen.getByAltText('Hello') as HTMLImageElement;
    expect(img.src).toContain('sp1-thumb.webp');
  });

  it('clicking Generate delegates to the job hook', () => {
    render(<ConfigSpreadPoolSettings />);
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    expect(startGenerateMock).toHaveBeenCalledTimes(1);
  });

  it('translate modal receives ONLY pool-enabled spreads with a source title', () => {
    // sp1 = pooled + titled ('Hello') → in. sp2 = titled ('World') but pool OFF → out.
    // sp3 = never pooled, no title → out.
    render(<ConfigSpreadPoolSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Translate/ }));
    // Modal renders original titles as text spans (panel titles live in input values).
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByText('World')).not.toBeInTheDocument();
  });

  it('disables the pool toggle for a branch spread (P3 lock)', () => {
    mockSpreads = [
      spread('spb', {
        branch_setting: {} as never,
        pool: { is_true: true, is_default: false },
      }),
    ];
    render(<ConfigSpreadPoolSettings />);
    const toggle = screen.getByLabelText(/Include .* in the spread pool/);
    expect(toggle).toBeDisabled();
  });
});
