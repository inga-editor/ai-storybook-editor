// Content-sync WHOLE-REPLACE branch for the column-root collection writes (rtype 12 lineups +
// rtype 14 entity collections — ADR-044 addendum 2, 2026-08-05). These arrays are written whole with
// NO accompanying node-scope event, so a peer MUST whole-replace (not reconcile-by-id, which keeps
// the local object for a matching id) or a content change to an existing id never lands. Drives the
// REAL store via `handleActivityInsert` (channel entry point) to prove the wiring. Spreads (rtype 6
// reorder-only) still reconcile — they are NOT in the `isColumnRootCollectionSync` predicate.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
    rpc: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

const fetchSnapshotNode = vi.fn();
vi.mock('@/stores/content-sync-store/rpc', () => ({ fetchSnapshotNode: (...a: unknown[]) => fetchSnapshotNode(...a) }));

vi.mock('@/stores/resource-lock-store', () => ({
  holdsLiveLock: () => false,
  hasAnyLiveLock: () => false,
}));

import { useContentSyncStore, isColumnRootCollectionSync } from '@/stores/content-sync-store';
import { useSnapshotStore } from '@/stores/snapshot-store';
import type { ActivityLogRawRow } from '@/stores/content-sync-store/types';
import type { SketchLineupTab } from '@/types/sketch';

const VERSION = 'snap-1';
const asState = <T,>(v: T) => v as never;

const peerRow = (sync: unknown): ActivityLogRawRow =>
  ({ id: 'log-1', actor_user_id: 'peer-user', metadata: { sync } }) as unknown as ActivityLogRawRow;

const flush = () => new Promise((r) => setTimeout(r, 0));

const tab = (id: string, name: string, entries: SketchLineupTab['entries'] = []): SketchLineupTab => ({
  id,
  name,
  entries,
});

const lineupSync = (over: Record<string, unknown> = {}) => ({
  scope: 'collection',
  version: VERSION,
  column: 'sketch',
  path: ['lineups'],
  step: 1,
  resource_type: 12,
  resource_id: 'lineups',
  locale: null,
  ...over,
});

describe('isColumnRootCollectionSync', () => {
  it('matches on resource_type 12 (lineups) or 14 (entity collection) alone', () => {
    expect(isColumnRootCollectionSync({ column: 'illustration', path: ['x'], resource_type: 12 })).toBe(true);
    expect(isColumnRootCollectionSync({ column: 'sketch', path: ['characters'], resource_type: 14 })).toBe(true);
  });
  it('matches on column sketch + path [collection] alone (descriptor lost its rtype)', () => {
    expect(isColumnRootCollectionSync({ column: 'sketch', path: ['lineups'] })).toBe(true);
    expect(isColumnRootCollectionSync({ column: 'sketch', path: ['characters'] })).toBe(true);
    expect(isColumnRootCollectionSync({ column: 'sketch', path: ['props'] })).toBe(true);
    expect(isColumnRootCollectionSync({ column: 'sketch', path: ['stages'] })).toBe(true);
  });
  it('does NOT match spreads (reorder-only, rtype 6 → keeps reconcile)', () => {
    expect(isColumnRootCollectionSync({ column: 'sketch', path: ['spreads'], resource_type: 6 })).toBe(false);
  });
});

describe('content-sync merge — rtype 12 lineups whole-replace', () => {
  beforeEach(() => {
    fetchSnapshotNode.mockReset();
    useContentSyncStore.setState({ bookId: 'book-1', myUserId: 'me', status: 'live' });
    useSnapshotStore.setState((s) => {
      s.meta.id = VERSION;
      s.sketch = asState({
        id: VERSION,
        base: {},
        characters: [],
        props: [],
        stages: [],
        spreads: [],
        lineups: [tab('t1', 'Local name', [{ kind: 'characters', entity_key: 'old', variant_key: 'base' }])],
      });
    });
  });

  it("peer rename/entries land: SAME id, server content WINS (whole-replace, NOT reconcile's keep-local)", async () => {
    fetchSnapshotNode.mockResolvedValue([
      tab('t1', 'Peer renamed', [{ kind: 'props', entity_key: 'wand', variant_key: 'base' }]),
    ]);

    useContentSyncStore.getState().handleActivityInsert(peerRow(lineupSync()));
    await flush();

    const lineups = useSnapshotStore.getState().sketch.lineups;
    expect(lineups).toHaveLength(1);
    expect(lineups[0].name).toBe('Peer renamed'); // reconcile-by-id would have kept 'Local name'
    expect(lineups[0].entries).toEqual([{ kind: 'props', entity_key: 'wand', variant_key: 'base' }]);
  });

  it('detects by column+path even when the descriptor carries no resource_type', async () => {
    fetchSnapshotNode.mockResolvedValue([tab('t1', 'Renamed via fallback')]);

    useContentSyncStore.getState().handleActivityInsert(
      peerRow(lineupSync({ resource_type: undefined })),
    );
    await flush();

    expect(useSnapshotStore.getState().sketch.lineups[0].name).toBe('Renamed via fallback');
  });

  it('merged value passes coerceSketchNode (garbage elements dropped before landing)', async () => {
    fetchSnapshotNode.mockResolvedValue([tab('t2', 'Valid'), 'garbage', { no: 'id' }]);

    useContentSyncStore.getState().handleActivityInsert(peerRow(lineupSync()));
    await flush();

    expect(useSnapshotStore.getState().sketch.lineups.map((t) => t.id)).toEqual(['t2']);
  });

  it('null node → SKIP (never deletes the structural sketch.lineups key)', async () => {
    fetchSnapshotNode.mockResolvedValue(null);

    useContentSyncStore.getState().handleActivityInsert(peerRow(lineupSync()));
    await flush();

    expect(useSnapshotStore.getState().sketch.lineups).toHaveLength(1); // untouched
  });

  it('rtype 14 `characters` collection sync WHOLE-REPLACES (peer base-text edit to a matching key lands)', async () => {
    // Base-space entity text edits now route through the rtype-14 collection save (NO node-scope
    // event), so a peer MUST whole-replace — reconcile-by-id would keep the stale LOCAL object.
    const localEntity = { key: 'ck0', variants: [{ key: 'base', description: 'LOCAL-EDIT', visual_design: '', art_language: '' }] };
    useSnapshotStore.setState((s) => {
      s.sketch = asState({ ...useSnapshotStore.getState().sketch, characters: [localEntity] });
    });
    fetchSnapshotNode.mockResolvedValue([
      { key: 'ck0', variants: [{ key: 'base', description: 'SERVER', visual_design: '', art_language: '' }] },
    ]);

    useContentSyncStore.getState().handleActivityInsert(
      peerRow({ scope: 'collection', version: VERSION, column: 'sketch', path: ['characters'], step: 1, resource_type: 14, resource_id: 'characters', locale: null }),
    );
    await flush();

    expect(useSnapshotStore.getState().sketch.characters[0].variants[0].description).toBe('SERVER');
  });
});
