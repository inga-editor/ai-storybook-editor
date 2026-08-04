// history-bridge.test.ts — the SaveDomain → EditHistoryDomain mapping + idempotent guard. Sketch
// domains must NOT bridge (EditHistoryDomain 'sketch' is reserved); the illustration/scene/retouch
// domains bridge to their grain and never double-begin.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hist: { beginSession: vi.fn(), endSession: vi.fn() },
}));

vi.mock('@/stores/edit-history-store', () => ({
  useEditHistoryStore: { getState: () => h.hist },
}));
vi.mock('@/stores/edit-history-store/item-key', () => ({
  buildItemKey: (domain: string, t: { resource_type: number; resource_id: string; locale: string | null }) =>
    `${domain}:${t.resource_type}:${t.resource_id}:${t.locale ?? '∅'}`,
}));

import { beginHistory, endHistory, __resetHistoryBridge } from './history-bridge';
import type { LockTarget } from '@/stores/resource-lock-store';

const ENTITY_TARGET: LockTarget = { step: 2, resource_type: 3, resource_id: 'hero', locale: null };
const SCENE_TARGET: LockTarget = { step: 2, resource_type: 6, resource_id: 'sp1', locale: null };
const RETOUCH_TARGET: LockTarget = { step: 3, resource_type: 10, resource_id: 'sp1', locale: null };
const SKETCH_TARGET: LockTarget = { step: 1, resource_type: 3, resource_id: 'skHero', locale: null };

beforeEach(() => {
  __resetHistoryBridge();
  h.hist.beginSession.mockReset();
  h.hist.endSession.mockReset();
});

describe('domain mapping', () => {
  it('illustration-entity → beginSession with the illustration-entity grain', () => {
    beginHistory('illustration-entity', ENTITY_TARGET, { key: 'hero' });
    expect(h.hist.beginSession).toHaveBeenCalledWith(
      'illustration-entity:3:hero:∅',
      { key: 'hero' },
      'illustration-entity',
    );
  });

  it('scene-spread → illustration-scene; retouch-spread → retouch', () => {
    beginHistory('scene-spread', SCENE_TARGET, {});
    expect(h.hist.beginSession).toHaveBeenLastCalledWith(
      'illustration-scene:6:sp1:∅',
      {},
      'illustration-scene',
    );
    beginHistory('retouch-spread', RETOUCH_TARGET, {});
    expect(h.hist.beginSession).toHaveBeenLastCalledWith('retouch:10:sp1:∅', {}, 'retouch');
  });

  it('sketch domains do NOT bridge (reserved)', () => {
    beginHistory('sketch-entity', SKETCH_TARGET, {});
    beginHistory('sketch-stage', { step: 1, resource_type: 5, resource_id: 's', locale: null }, {});
    beginHistory('sketch-base-sheet', { step: 1, resource_type: 11, resource_id: 'character_sheet', locale: null }, {});
    beginHistory('sketch-lineups', { step: 1, resource_type: 12, resource_id: 'lineups', locale: null }, {});
    beginHistory('sketch-image', { step: 1, resource_type: 1, resource_id: 'i', locale: null }, {});
    beginHistory('sketch-textbox', { step: 1, resource_type: 2, resource_id: 't', locale: 'en' }, {});
    expect(h.hist.beginSession).not.toHaveBeenCalled();
    endHistory('sketch-entity', SKETCH_TARGET);
    expect(h.hist.endSession).not.toHaveBeenCalled();
  });
});

describe('idempotent guard', () => {
  it('a double beginHistory for the same key begins only once', () => {
    beginHistory('illustration-entity', ENTITY_TARGET, { v: 1 });
    beginHistory('illustration-entity', ENTITY_TARGET, { v: 2 });
    expect(h.hist.beginSession).toHaveBeenCalledTimes(1);
  });

  it('endHistory closes the session and re-open works', () => {
    beginHistory('illustration-entity', ENTITY_TARGET, {});
    endHistory('illustration-entity', ENTITY_TARGET);
    expect(h.hist.endSession).toHaveBeenCalledWith('illustration-entity:3:hero:∅');
    beginHistory('illustration-entity', ENTITY_TARGET, {});
    expect(h.hist.beginSession).toHaveBeenCalledTimes(2);
  });

  it('endHistory with no open session is a no-op', () => {
    endHistory('illustration-entity', ENTITY_TARGET);
    expect(h.hist.endSession).not.toHaveBeenCalled();
  });
});
