// flush-on-hidden.test.ts — the tab-hide safety net for collab spaces (unified-item-save-spec §4.5).
// `flushAllOnHidden()` fires ONE best-effort `saveResource` per held+dirty session with `keepalive`,
// with NO lock release and NO baseline rebase. Solo books abstain (autoSaveSnapshot owns the flush).
// The resource-lock / snapshot / status stores + the save API are mocked so the wiring is asserted
// without real I/O (same seam as ensure-saved.test.ts / index.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const lock = { collabPersist: true };
  const saveResource = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean });
  return { lock, saveResource };
});

vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.lock },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  isSketchWriteBlocked: () => false,
  FALLBACK_HOLDER_NAME: 'another editor',
  ACTION_TYPE_CREATE: 2,
}));
vi.mock('@/apis/resource-lock-api', () => ({ saveResource: (...a: unknown[]) => h.saveResource(...a) }));
vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: {
    getState: () => ({ sketch: { spreads: [] }, characters: [], props: [], stages: [], flushSnapshot: vi.fn() }),
  },
}));
vi.mock('@/stores/edit-session-status-store', () => ({
  useEditSessionStatusStore: {
    getState: () => ({ beginHold: vi.fn(), endHold: vi.fn(), markSaving: vi.fn(), markSaved: vi.fn() }),
  },
}));
vi.mock('@/stores/edit-history-store', () => ({
  useEditHistoryStore: { getState: () => ({ beginSession: vi.fn(), endSession: vi.fn() }) },
}));
vi.mock('@/stores/edit-history-store/item-key', () => ({
  buildItemKey: (domain: string, t: { resource_type: number; resource_id: string; locale: string | null }) =>
    `${domain}:${t.resource_type}:${t.resource_id}:${t.locale ?? '∅'}`,
}));

import { useSaveSessionStore, SAVE_POLICIES } from './index';
import type { SessionEntry } from './types';

const BOOK = 'bookX';

/** Build a held SessionEntry keyed on its target. `nodeValue` drives the (overridden) policy getNode. */
function seedSession(resourceId: string, baseline: unknown): { key: string; entry: SessionEntry } {
  const target = { step: 2 as const, resource_type: 3 as const, resource_id: resourceId, locale: null };
  const key = `${BOOK}|2|3|${resourceId}|`;
  const entry: SessionEntry = {
    domain: 'illustration-entity',
    id: `character/${resourceId}`,
    target,
    capturedBookId: BOOK,
    collabPersist: true,
    baseline,
    status: 'held',
    lastSavedAt: 0,
    manageHeaderStatus: true,
  };
  return { key, entry };
}

// The illustration-entity policy's getNode reads the snapshot; override it so each session's dirtiness
// is controllable (dirty = node ≠ baseline). Restored after each test.
const origGetNode = SAVE_POLICIES['illustration-entity'].getNode;
let nodeById: Record<string, unknown> = {};

beforeEach(() => {
  h.lock.collabPersist = true;
  h.saveResource.mockClear();
  nodeById = {};
  SAVE_POLICIES['illustration-entity'].getNode = (id: string) => nodeById[id] ?? null;
  useSaveSessionStore.setState({ sessions: new Map() });
});

afterEach(() => {
  SAVE_POLICIES['illustration-entity'].getNode = origGetNode;
});

describe('flushAllOnHidden — collab safety net (spec §4.5)', () => {
  it('solo (collabPersist=false) → NO keepalive save (autoSaveSnapshot owns the solo flush)', () => {
    h.lock.collabPersist = false;
    const { key, entry } = seedSession('hero', { v: 0 });
    nodeById[entry.id] = { v: 1 }; // dirty, but solo → must abstain
    useSaveSessionStore.setState({ sessions: new Map([[key, entry]]) });

    useSaveSessionStore.getState().flushAllOnHidden();
    expect(h.saveResource).not.toHaveBeenCalled();
  });

  it('collab + 2 sessions (1 dirty, 1 clean) → EXACTLY 1 keepalive save, no release request', () => {
    const dirty = seedSession('dirty', { v: 0 });
    nodeById[dirty.entry.id] = { v: 1 }; // node ≠ baseline → dirty
    const clean = seedSession('clean', { v: 0 });
    nodeById[clean.entry.id] = { v: 0 }; // node === baseline → clean
    useSaveSessionStore.setState({
      sessions: new Map([
        [dirty.key, dirty.entry],
        [clean.key, clean.entry],
      ]),
    });

    useSaveSessionStore.getState().flushAllOnHidden();

    // Exactly ONE request — the dirty session only.
    expect(h.saveResource).toHaveBeenCalledTimes(1);
    const [bookId, target, payload, opts] = h.saveResource.mock.calls[0] as unknown as [
      string,
      { resource_id: string },
      { action_type: number; patch: unknown },
      { keepalive: boolean },
    ];
    expect(bookId).toBe(BOOK); // capturedBookId, not the live store bookId
    expect(target.resource_id).toBe('dirty');
    expect(payload.action_type).toBe(3); // normal edit payload (NOT a release/unlock)
    expect(payload.patch).toEqual({ v: 1 });
    expect(opts.keepalive).toBe(true);
    // No unlock/release path is exercised (flushAllOnHidden never releases): the ONLY API call is save.
    expect(h.saveResource).toHaveBeenCalledTimes(1);
  });

  it('held but CLEAN → skipped entirely (no request)', () => {
    const clean = seedSession('clean', { v: 7 });
    nodeById[clean.entry.id] = { v: 7 };
    useSaveSessionStore.setState({ sessions: new Map([[clean.key, clean.entry]]) });
    useSaveSessionStore.getState().flushAllOnHidden();
    expect(h.saveResource).not.toHaveBeenCalled();
  });

  it('non-held session (acquiring) → skipped', () => {
    const { key, entry } = seedSession('mid', { v: 0 });
    nodeById[entry.id] = { v: 1 };
    useSaveSessionStore.setState({ sessions: new Map([[key, { ...entry, status: 'acquiring' }]]) });
    useSaveSessionStore.getState().flushAllOnHidden();
    expect(h.saveResource).not.toHaveBeenCalled();
  });

  it('payload over 60KB → keepalive:false but STILL sent (best-effort, never dropped)', () => {
    const big = seedSession('big', { v: '' });
    nodeById[big.entry.id] = { v: 'x'.repeat(70_000) }; // serialized patch > KEEPALIVE_MAX_BYTES
    useSaveSessionStore.setState({ sessions: new Map([[big.key, big.entry]]) });

    useSaveSessionStore.getState().flushAllOnHidden();

    expect(h.saveResource).toHaveBeenCalledTimes(1);
    const [, , , opts] = h.saveResource.mock.calls[0] as unknown as [unknown, unknown, unknown, { keepalive: boolean }];
    expect(opts.keepalive).toBe(false); // dropped keepalive (over the 64KB browser cap) — but sent
  });
});
