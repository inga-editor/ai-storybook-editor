import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveSketchStageLockTarget,
  buildSketchStagePayload,
  flushSketchStageUnderLock,
} from './collab-sketch-stage-save-helper';

// ⚡ unified-item-save phase 3: `flushSketchStageUnderLock` now delegates to the engine's `ensureSaved`.
const h = vi.hoisted(() => ({
  ensureSaved: vi.fn(async (_domain: string, _id: string) => 'saved' as string),
}));

vi.mock('@/stores/save-session-store', () => ({
  useSaveSessionStore: { getState: () => ({ ensureSaved: h.ensureSaved }) },
}));

const NODE = { key: 'forest', base: { styles: [] }, variants: [{ key: 'base' }] };
const TARGET = { step: 1, resource_type: 5, resource_id: 'forest', locale: null };

beforeEach(() => {
  h.ensureSaved.mockReset().mockResolvedValue('saved');
});

describe('resolveSketchStageLockTarget', () => {
  it('maps a stage → step 1 / rtype 5, whole-node target, null locale', () => {
    expect(resolveSketchStageLockTarget('forest')).toEqual(TARGET);
  });
});

describe('buildSketchStagePayload', () => {
  it('wraps the whole node as an edit (action_type 3) with log:true', () => {
    expect(buildSketchStagePayload(NODE)).toEqual({ action_type: 3, patch: NODE, log: true });
  });
});

describe('flushSketchStageUnderLock (delegates to ensureSaved)', () => {
  it('delegates to ensureSaved("sketch-stage", <stageKey>) and returns the outcome', async () => {
    const outcome = await flushSketchStageUnderLock('forest', NODE);
    expect(outcome).toBe('saved');
    expect(h.ensureSaved).toHaveBeenCalledTimes(1);
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-stage', 'forest');
  });

  it('passes the engine outcome straight through (blocked / failed / clean)', async () => {
    for (const oc of ['blocked', 'failed', 'clean'] as const) {
      h.ensureSaved.mockResolvedValueOnce(oc);
      expect(await flushSketchStageUnderLock('forest')).toBe(oc);
    }
  });

  it('node / opts args are IGNORED (engine reads the fresh node via the policy)', async () => {
    await flushSketchStageUnderLock('forest', null, { releaseIfAcquired: true });
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-stage', 'forest');
  });
});
