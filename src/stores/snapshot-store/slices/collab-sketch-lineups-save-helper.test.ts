import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LINEUP_LOCK_TARGET,
  LINEUP_RESOURCE_ID,
  resolveLineupsLockTarget,
  buildSketchLineupsPayload,
  flushSketchLineupsUnderLock,
} from './collab-sketch-lineups-save-helper';
import type { SketchLineupTab } from '@/types/sketch';

// ⚡ unified-item-save phase 3: `flushSketchLineupsUnderLock` now delegates to the engine's `ensureSaved`.
const h = vi.hoisted(() => ({
  ensureSaved: vi.fn(async (_domain: string, _id: string) => 'saved' as string),
}));

vi.mock('@/stores/save-session-store', () => ({
  useSaveSessionStore: { getState: () => ({ ensureSaved: h.ensureSaved }) },
}));

const TABS: SketchLineupTab[] = [
  { id: 't1', name: 'Lineup', entries: [{ kind: 'characters', entity_key: 'elara', variant_key: 'base' }] },
];

beforeEach(() => {
  h.ensureSaved.mockReset().mockResolvedValue('saved');
});

describe('resolveLineupsLockTarget', () => {
  it('maps to step 1 / rtype 12 / sentinel resource_id "lineups" / no locale', () => {
    expect(resolveLineupsLockTarget()).toEqual({
      step: 1,
      resource_type: 12,
      resource_id: 'lineups',
      locale: null,
    });
    expect(LINEUP_LOCK_TARGET).toEqual(resolveLineupsLockTarget());
    expect(LINEUP_RESOURCE_ID).toBe('lineups');
  });
});

describe('buildSketchLineupsPayload', () => {
  it('is COLLECTION-SCOPE: LIST patch + collection "lineups" + action_type 3 + log:true', () => {
    const p = buildSketchLineupsPayload(TABS);
    expect(p).toEqual({ action_type: 3, patch: TABS, collection: 'lineups', log: true });
    // The gateway infers collection scope from isinstance(patch, list) — a dict patch is a 400.
    expect(Array.isArray(p.patch)).toBe(true);
    // NO parent_id — its presence would route the save off the column-root path.
    expect('parent_id' in p).toBe(false);
  });
});

describe('flushSketchLineupsUnderLock (delegates to ensureSaved)', () => {
  it('delegates to ensureSaved("sketch-lineups", "lineups") and returns the outcome', async () => {
    const outcome = await flushSketchLineupsUnderLock(TABS);
    expect(outcome).toBe('saved');
    expect(h.ensureSaved).toHaveBeenCalledTimes(1);
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-lineups', 'lineups');
  });

  it('passes the engine outcome straight through (blocked / failed / clean)', async () => {
    for (const oc of ['blocked', 'failed', 'clean'] as const) {
      h.ensureSaved.mockResolvedValueOnce(oc);
      expect(await flushSketchLineupsUnderLock()).toBe(oc);
    }
  });

  it('tabs / opts args are IGNORED (engine reads the fresh array via the policy)', async () => {
    await flushSketchLineupsUnderLock([], { releaseIfAcquired: true });
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-lineups', 'lineups');
  });
});
