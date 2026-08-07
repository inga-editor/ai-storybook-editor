// after-save-support-languages.test.ts — the retouch-spread afterSave hook (design §4.5). Asserts
// the diff-gate (unchanged map ⇒ no updateBook), the exact updateBook payload on change, the
// no-current-book no-op, and that an updateBook rejection is swallowed (no unhandled rejection).
// book-store + snapshot-store are mocked so the pure recompute (util P01) drives the branch; the
// recompute itself is exercised for real (not mocked) to pin the wiring end-to-end.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const book = {
    id: 'book1' as string | null,
    step: 3,
    original_language: 'en_US',
    support_languages: { en_US: { translation_status: 2 }, vi_VN: { translation_status: 0 } } as
      | Record<string, { translation_status: 0 | 1 | 2 }>
      | null,
  };
  const snapshot = {
    illustration: { spreads: [] as Array<Record<string, unknown>> },
    sketch: { spreads: [] as Array<Record<string, unknown>> },
  };
  const updateBook = vi.fn(async (_id: string, _u: unknown) => true as boolean);
  return { book, snapshot, updateBook };
});

vi.mock('@/stores/book-store', () => ({
  useBookStore: { getState: () => ({ currentBook: h.book.id ? h.book : null, updateBook: h.updateBook }) },
}));
vi.mock('@/stores/snapshot-store', () => ({ useSnapshotStore: { getState: () => h.snapshot } }));

import { recomputeSupportLanguagesAfterSave } from './after-save-support-languages';

// A step-3 illustration spread with one textbox: EN filled, VI empty ⇒ vi_VN status becomes 0.
function spreadWithText(en: string, vi: string) {
  return {
    id: 'sp1',
    textboxes: [{ id: 'tb1', en_US: { text: en }, vi_VN: { text: vi } }],
  };
}

beforeEach(() => {
  h.book.id = 'book1';
  h.book.step = 3;
  h.book.original_language = 'en_US';
  h.book.support_languages = { en_US: { translation_status: 2 }, vi_VN: { translation_status: 0 } };
  h.snapshot.illustration.spreads = [];
  h.snapshot.sketch.spreads = [];
  h.updateBook.mockReset().mockResolvedValue(true);
});

describe('recomputeSupportLanguagesAfterSave', () => {
  it('map UNCHANGED → does NOT call updateBook', () => {
    // EN filled (denominator 1), VI empty → vi_VN=0, already 0 in the map ⇒ no diff.
    h.snapshot.illustration.spreads = [spreadWithText('Hello', '')];
    recomputeSupportLanguagesAfterSave('sp1');
    expect(h.updateBook).not.toHaveBeenCalled();
  });

  it('map CHANGED → calls updateBook exactly once with the recomputed payload', async () => {
    // EN filled AND VI filled → vi_VN flips 0 → 2 (fully translated) ⇒ a diff.
    h.snapshot.illustration.spreads = [spreadWithText('Hello', 'Xin chao')];
    recomputeSupportLanguagesAfterSave('sp1');
    expect(h.updateBook).toHaveBeenCalledTimes(1);
    expect(h.updateBook).toHaveBeenCalledWith('book1', {
      support_languages: {
        en_US: { translation_status: 2 },
        vi_VN: { translation_status: 2 },
      },
    });
    await Promise.resolve(); // let the fire-and-forget .then settle (no throw)
  });

  it('no current book → no-op, does not throw, no updateBook', () => {
    h.book.id = null;
    h.snapshot.illustration.spreads = [spreadWithText('Hello', 'Xin chao')];
    expect(() => recomputeSupportLanguagesAfterSave('sp1')).not.toThrow();
    expect(h.updateBook).not.toHaveBeenCalled();
  });

  it('updateBook REJECTS → rejection is swallowed (no unhandled rejection)', async () => {
    h.snapshot.illustration.spreads = [spreadWithText('Hello', 'Xin chao')];
    h.updateBook.mockRejectedValue(new Error('network'));
    const unhandled = vi.fn();
    // Reach the runtime `process` without pulling in @types/node (editor tests ban
    // node builtins in type-space); the event still fires under vitest's node runner.
    const proc = (globalThis as unknown as {
      process: {
        on(e: string, cb: (...a: unknown[]) => void): void;
        off(e: string, cb: (...a: unknown[]) => void): void;
      };
    }).process;
    proc.on('unhandledRejection', unhandled);
    expect(() => recomputeSupportLanguagesAfterSave('sp1')).not.toThrow();
    // Flush the microtask queue so the rejected promise's .catch runs.
    await Promise.resolve();
    await Promise.resolve();
    proc.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(h.updateBook).toHaveBeenCalledTimes(1);
  });

  it('updateBook returns false → still no throw', async () => {
    h.snapshot.illustration.spreads = [spreadWithText('Hello', 'Xin chao')];
    h.updateBook.mockResolvedValue(false);
    expect(() => recomputeSupportLanguagesAfterSave('sp1')).not.toThrow();
    await Promise.resolve();
    expect(h.updateBook).toHaveBeenCalledTimes(1);
  });
});
