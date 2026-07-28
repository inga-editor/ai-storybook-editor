import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state — vi.hoisted so the (hoisted) vi.mock factory can close over it.
const mock = vi.hoisted(() => ({
  failSnapshot: false,
  calls: { booksInsert: 0, snapshotsInsert: 0, booksUpdate: 0, booksDelete: 0 },
  payloads: { books: null as Record<string, unknown> | null, snapshots: null as Record<string, unknown> | null },
}));

vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      return {
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
                if (table === 'books') return { data: { id: 'book-1' }, error: null };
                if (mock.failSnapshot) return { data: null, error: { message: 'snapshot boom' } };
                return { data: { id: 'snap-1' }, error: null };
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

import { createImportedBook } from '../create-imported-book';
import type { ImportedSketchSnapshot } from '../build-snapshot-from-parsed';
import { MODAL_META } from './fixtures/sketch-manuscript-fixture';

const SNAPSHOT: ImportedSketchSnapshot = {
  sketch: {
    id: 'sk-1',
    base: { character_sheet: { styles: [] }, prop_sheet: { styles: [] }, alter_character_sheet: { styles: [] } },
    characters: [],
    props: [],
    stages: [],
    spreads: [],
    lineups: [],
  },
  characters: [],
  props: [],
  stages: [],
};

beforeEach(() => {
  mock.failSnapshot = false;
  mock.calls.booksInsert = 0;
  mock.calls.snapshotsInsert = 0;
  mock.calls.booksUpdate = 0;
  mock.calls.booksDelete = 0;
  mock.payloads.books = null;
  mock.payloads.snapshots = null;
});

describe('createImportedBook', () => {
  it('happy path: inserts book@step=1 + snapshot (sketch column), sets current_version', async () => {
    const id = await createImportedBook(MODAL_META, SNAPSHOT);
    expect(id).toBe('book-1');
    expect(mock.calls).toMatchObject({ booksInsert: 1, snapshotsInsert: 1, booksUpdate: 1, booksDelete: 0 });

    // book → sketch phase (step 1), not illustration (was 2).
    expect(mock.payloads.books).toMatchObject({ step: 1, type: 1, original_language: 'vi_VN' });

    // snapshot → sketch column populated; illustration/docs/dummies emptied for column parity.
    const snap = mock.payloads.snapshots!;
    expect(snap.sketch).toEqual(SNAPSHOT.sketch);
    expect(snap.illustration).toEqual({ spreads: [], sections: [] });
    expect(snap.docs).toEqual([]);
    expect(snap.dummies).toEqual([]);
    expect(snap.save_type).toBe(1);
  });

  it('rolls back (deletes the book) when the snapshot insert fails', async () => {
    mock.failSnapshot = true;
    await expect(createImportedBook(MODAL_META, SNAPSHOT)).rejects.toThrow(/snapshot/i);
    expect(mock.calls).toMatchObject({ booksInsert: 1, snapshotsInsert: 1, booksDelete: 1, booksUpdate: 0 });
  });
});
