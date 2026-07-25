// Regression for the rtype-12 lineups content-sync branch (2026-07-25): the collection scope
// normally routes through `reconcileCollectionByIds`, which KEEPS the local object for every
// matching id (content arrives via separate node-scope events). Lineup tabs have NO node-scope
// event — every write is the collection-scope column-root save — so without the dedicated
// WHOLE-REPLACE branch a peer's rename / entries change would never land. Drives the REAL store
// via `handleActivityInsert` (channel entry point) to prove the wiring.

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

import { useContentSyncStore, isLineupCollectionSync } from '@/stores/content-sync-store';
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

describe('isLineupCollectionSync', () => {
  it('matches on resource_type 12 alone (path may drift on a future write-path change)', () => {
    expect(isLineupCollectionSync({ column: 'illustration', path: ['x'], resource_type: 12 })).toBe(true);
  });
  it('matches on column sketch + path [lineups] alone (descriptor lost its rtype)', () => {
    expect(isLineupCollectionSync({ column: 'sketch', path: ['lineups'] })).toBe(true);
  });
  it('does NOT match other sketch collections (characters keeps reconcile)', () => {
    expect(isLineupCollectionSync({ column: 'sketch', path: ['characters'], resource_type: 3 })).toBe(false);
    expect(isLineupCollectionSync({ column: 'sketch', path: ['spreads'], resource_type: 6 })).toBe(false);
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

  it("REGRESSION: a `characters` collection sync still reconciles (local object KEPT for a matching key)", async () => {
    const localEntity = { key: 'ck0', variants: [{ key: 'base', description: 'LOCAL-EDIT', visual_design: '', art_language: '' }] };
    useSnapshotStore.setState((s) => {
      s.sketch = asState({ ...useSnapshotStore.getState().sketch, characters: [localEntity] });
    });
    fetchSnapshotNode.mockResolvedValue([
      { key: 'ck0', variants: [{ key: 'base', description: 'SERVER', visual_design: '', art_language: '' }] },
    ]);

    useContentSyncStore.getState().handleActivityInsert(
      peerRow({ scope: 'collection', version: VERSION, column: 'sketch', path: ['characters'], step: 1, resource_type: 3, resource_id: 'characters', locale: null }),
    );
    await flush();

    // reconcile keeps the LOCAL object for the matching identity — proof lineups didn't leak
    // the whole-replace behavior onto sibling collections.
    expect(useSnapshotStore.getState().sketch.characters[0].variants[0].description).toBe('LOCAL-EDIT');
  });
});
