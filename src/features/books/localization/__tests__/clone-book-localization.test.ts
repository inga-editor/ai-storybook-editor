import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state — vi.hoisted so the (hoisted) vi.mock factory can close over it.
const mock = vi.hoisted(() => ({
  failSnapshot: false,
  sourceBook: null as Record<string, unknown> | null,
  sourceSnapshot: null as Record<string, unknown> | null,
  snapshotReadBy: null as 'id' | 'ordered' | null,
  calls: { booksInsert: 0, snapshotsInsert: 0, booksUpdate: 0, booksDelete: 0 },
  payloads: {
    books: null as Record<string, unknown> | null,
    snapshots: null as Record<string, unknown> | null,
  },
}));

vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      return {
        // Read path: books → .eq().single(); snapshots → .eq().order().order().limit().maybeSingle()
        select() {
          const chain = {
            eq: (col: string) => {
              if (table === 'snapshots' && col === 'id') mock.snapshotReadBy = 'id';
              return chain;
            },
            order: () => {
              if (table === 'snapshots') mock.snapshotReadBy = 'ordered';
              return chain;
            },
            limit: () => chain,
            single: async () =>
              table === 'books'
                ? { data: mock.sourceBook, error: null }
                : { data: mock.sourceSnapshot, error: null },
            maybeSingle: async () =>
              table === 'snapshots'
                ? { data: mock.sourceSnapshot, error: null }
                : { data: mock.sourceBook, error: null },
          };
          return chain;
        },
        insert(payload: Record<string, unknown>) {
          if (table === 'books') {
            mock.calls.booksInsert++;
            mock.payloads.books = payload;
          }
          if (table === 'snapshots') {
            mock.calls.snapshotsInsert++;
            mock.payloads.snapshots = payload;
          }
          return {
            select: () => ({
              single: async () => {
                if (table === 'books') return { data: { id: 'new-book-1' }, error: null };
                if (mock.failSnapshot) return { data: null, error: { message: 'snap boom' } };
                return { data: { id: 'new-snap-1' }, error: null };
              },
            }),
          };
        },
        update() {
          if (table === 'books') mock.calls.booksUpdate++;
          return { eq: async () => ({ error: null }) };
        },
        delete() {
          return {
            eq: async () => {
              if (table === 'books') mock.calls.booksDelete++;
              return { error: null };
            },
          };
        },
      };
    },
  },
}));

import { cloneBookLocalization } from '../clone-book-localization';
import type { ProjectBookItem } from '../../types';

const SOURCE: ProjectBookItem = {
  id: 'src-1',
  title: 'Thỏ và Rùa',
  description: null,
  cover: null,
  step: 2,
  is_international: true,
  original_language: 'vi_VN',
  support_languages: { vi_VN: { translation_status: 2 } },
  support_countries: [{ code: 'VN' }],
  spread_count: 4,
  updated_at: '2026-08-07T00:00:00Z',
};

beforeEach(() => {
  mock.failSnapshot = false;
  mock.snapshotReadBy = null;
  mock.calls = { booksInsert: 0, snapshotsInsert: 0, booksUpdate: 0, booksDelete: 0 };
  mock.payloads = { books: null, snapshots: null };
  mock.sourceBook = {
    id: 'src-1',
    format_id: 'fmt-1',
    book_type: 1,
    dimension: 3,
    target_audience: 2,
    artstyle_id: 'art-1',
    sketchstyle_id: 'sk-1',
    step: 2,
    type: 1,
    project_id: 'proj-1',
    current_version: 'cv-1', // canonical revision — resolved by id, like fetchSnapshot
  };
  mock.sourceSnapshot = {
    sketch: { id: 'sk', spreads: [{ id: 's', textboxes: [{ id: 'a', vi_VN: { text: 'v' }, en_US: { text: 'e' } }] }] },
    illustration: { sections: [], spreads: [] },
    docs: [{ id: 'd' }],
    characters: [{ id: 'c' }],
    props: [],
    stages: [],
    dummies: [],
  };
});

describe('cloneBookLocalization', () => {
  it('happy path: builds localization book payload + filtered snapshot, sets current_version', async () => {
    const result = await cloneBookLocalization({
      source: SOURCE,
      title: '  Thỏ và Rùa  ',
      countryCodes: ['FR', 'FR', 'DE'], // dup FR must dedupe, order preserved
      languageKeys: ['fr_FR', 'de_DE'],
    });
    expect(result).toEqual({ id: 'new-book-1' });
    // current_version set → snapshot resolved by id (matches fetchSnapshot), not by ordering.
    expect(mock.snapshotReadBy).toBe('id');
    expect(mock.calls).toMatchObject({
      booksInsert: 1,
      snapshotsInsert: 1,
      booksUpdate: 1,
      booksDelete: 0,
    });

    // Book payload: metadata copied, is_international=false, original=languageKeys[0].
    expect(mock.payloads.books).toMatchObject({
      title: 'Thỏ và Rùa',
      owner_id: 'user-1',
      format_id: 'fmt-1',
      dimension: 3,
      target_audience: 2,
      artstyle_id: 'art-1',
      sketchstyle_id: 'sk-1',
      step: 2,
      project_id: 'proj-1',
      is_international: false,
      original_language: 'fr_FR',
      support_countries: [{ code: 'FR' }, { code: 'DE' }],
      support_languages: {
        fr_FR: { translation_status: 2 },
        de_DE: { translation_status: 0 },
      },
    });

    // Snapshot payload: save_type=1 (manual baseline — new book, same seed as
    // createBook), filtered textboxes (no unselected lang), verbatim cols.
    const snap = mock.payloads.snapshots!;
    expect(snap.save_type).toBe(1);
    const tb = (snap.sketch as { spreads: { textboxes: Record<string, unknown>[] }[] }).spreads[0]
      .textboxes[0];
    expect('vi_VN' in tb).toBe(false); // dropped — not selected
    expect('en_US' in tb).toBe(false);
    expect(tb.id).toBe('a');
    expect(snap.docs).toEqual([{ id: 'd' }]);
    expect(snap.characters).toEqual([{ id: 'c' }]);
  });

  it('falls back to latest-by-ordering when the source has no current_version', async () => {
    mock.sourceBook = { ...mock.sourceBook!, current_version: null };
    const result = await cloneBookLocalization({
      source: SOURCE,
      title: 'X',
      countryCodes: ['FR'],
      languageKeys: ['fr_FR'],
    });
    expect(result).toEqual({ id: 'new-book-1' });
    expect(mock.snapshotReadBy).toBe('ordered');
  });

  it('clones an empty snapshot (no throw) when the source has none', async () => {
    mock.sourceSnapshot = null;
    const result = await cloneBookLocalization({
      source: SOURCE,
      title: 'Localized',
      countryCodes: ['FR'],
      languageKeys: ['fr_FR'],
    });
    expect(result).toEqual({ id: 'new-book-1' });
    expect(mock.calls.snapshotsInsert).toBe(1);
    // empty snapshot → only book_id/save_type/version, no sketch/docs columns
    const snap = mock.payloads.snapshots!;
    expect(snap.save_type).toBe(1);
    expect('sketch' in snap).toBe(false);
    expect('docs' in snap).toBe(false);
  });

  it('rolls back (deletes the book) when the snapshot insert fails', async () => {
    mock.failSnapshot = true;
    await expect(
      cloneBookLocalization({
        source: SOURCE,
        title: 'X',
        countryCodes: ['FR'],
        languageKeys: ['fr_FR'],
      }),
    ).rejects.toThrow(/snapshot/i);
    expect(mock.calls).toMatchObject({
      booksInsert: 1,
      snapshotsInsert: 1,
      booksDelete: 1,
      booksUpdate: 0,
    });
  });

  it('rejects a non-international source before any write', async () => {
    await expect(
      cloneBookLocalization({
        source: { ...SOURCE, is_international: false },
        title: 'X',
        countryCodes: ['FR'],
        languageKeys: ['fr_FR'],
      }),
    ).rejects.toThrow(/international/i);
    expect(mock.calls.booksInsert).toBe(0);
  });

  it('rejects empty language / country selection', async () => {
    await expect(
      cloneBookLocalization({ source: SOURCE, title: 'X', countryCodes: ['FR'], languageKeys: [] }),
    ).rejects.toThrow(/language/i);
    await expect(
      cloneBookLocalization({ source: SOURCE, title: 'X', countryCodes: [], languageKeys: ['fr_FR'] }),
    ).rejects.toThrow(/country/i);
    expect(mock.calls.booksInsert).toBe(0);
  });
});
