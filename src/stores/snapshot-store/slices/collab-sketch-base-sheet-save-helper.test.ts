import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveSketchBaseSheetLockTarget,
  buildSketchBaseSheetPayload,
  flushSketchBaseSheetUnderLock,
  deleteSketchBaseSheetViaGateway,
} from './collab-sketch-base-sheet-save-helper';

// ⚡REV 2026-08-21: the lock target is addressed by the GROUP KEY (resource_id === group). The flush
// delegates to the engine's `ensureSaved('sketch-base-sheet', group)`; the delete drives a one-shot
// rtype-11 acquire → local remove → save(action 4) → release through the resource-lock store.
const h = vi.hoisted(() => ({
  ensureSaved: vi.fn(async (_domain: string, _id: string) => 'saved' as string),
  acquire: vi.fn(async (_t: unknown) => ({ ok: true }) as { ok: boolean; holder?: string }),
  save: vi.fn(async (_t: unknown, _p: unknown) => ({ ok: true }) as Record<string, unknown>),
  release: vi.fn(async (_t: unknown) => {}),
  removeSketchBaseSheet: vi.fn((_g: string) => {}),
  toast: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/stores/save-session-store', () => ({
  useSaveSessionStore: { getState: () => ({ ensureSaved: h.ensureSaved }) },
}));
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: {
    getState: () => ({ acquire: h.acquire, save: h.save, release: h.release, holderNames: new Map() }),
  },
  FALLBACK_HOLDER_NAME: 'another editor',
}));
vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: { getState: () => ({ removeSketchBaseSheet: h.removeSketchBaseSheet }) },
}));
vi.mock('sonner', () => ({ toast: h.toast }));

const SHEET_NODE = { kind: 'characters', name: 'Characters', styles: [] };

beforeEach(() => {
  h.ensureSaved.mockReset().mockResolvedValue('saved');
  h.acquire.mockReset().mockResolvedValue({ ok: true });
  h.save.mockReset().mockResolvedValue({ ok: true });
  h.release.mockReset().mockResolvedValue(undefined);
  h.removeSketchBaseSheet.mockReset();
  h.toast.info.mockReset();
  h.toast.error.mockReset();
});

describe('resolveSketchBaseSheetLockTarget', () => {
  it('addresses the node by the GROUP KEY (resource_id === group)', () => {
    expect(resolveSketchBaseSheetLockTarget('character_sheet')).toEqual({
      step: 1,
      resource_type: 11,
      resource_id: 'character_sheet',
      locale: null,
    });
    expect(resolveSketchBaseSheetLockTarget('villains_2')).toEqual({
      step: 1,
      resource_type: 11,
      resource_id: 'villains_2',
      locale: null,
    });
  });
});

describe('buildSketchBaseSheetPayload', () => {
  it('wraps the whole sheet node (kind + name + styles) as an edit (action_type 3) with log:true', () => {
    expect(buildSketchBaseSheetPayload(SHEET_NODE)).toEqual({ action_type: 3, patch: SHEET_NODE, log: true });
  });
});

describe('flushSketchBaseSheetUnderLock (delegates to ensureSaved)', () => {
  it('ensureSaved("sketch-base-sheet", <group>) and returns the outcome', async () => {
    const outcome = await flushSketchBaseSheetUnderLock('character_sheet', SHEET_NODE);
    expect(outcome).toBe('saved');
    expect(h.ensureSaved).toHaveBeenCalledTimes(1);
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-base-sheet', 'character_sheet');
  });

  it('any group key flows straight through as the id', async () => {
    await flushSketchBaseSheetUnderLock('props_2');
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-base-sheet', 'props_2');
  });

  it('passes the engine outcome straight through (blocked / failed / clean)', async () => {
    for (const oc of ['blocked', 'failed', 'clean'] as const) {
      h.ensureSaved.mockResolvedValueOnce(oc);
      expect(await flushSketchBaseSheetUnderLock('character_sheet')).toBe(oc);
    }
  });

  it('node / opts args are IGNORED (engine reads the fresh sheet via the policy)', async () => {
    await flushSketchBaseSheetUnderLock('character_sheet', null, { releaseIfAcquired: true });
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-base-sheet', 'character_sheet');
  });
});

describe('deleteSketchBaseSheetViaGateway (rtype 11, action_type 4)', () => {
  it('acquire → local remove → save(delete) → release', async () => {
    await deleteSketchBaseSheetViaGateway('villains_2');
    const target = { step: 1, resource_type: 11, resource_id: 'villains_2', locale: null };
    expect(h.acquire).toHaveBeenCalledWith(target);
    expect(h.removeSketchBaseSheet).toHaveBeenCalledWith('villains_2');
    expect(h.save).toHaveBeenCalledWith(target, {
      action_type: 4,
      patch: null,
      target_ref: { group: 'villains_2' },
      log: true,
    });
    expect(h.release).toHaveBeenCalledWith(target);
  });

  it('acquire blocked (peer holds the node) → toast holder, NOTHING deleted (lock-403 ≠ write-403)', async () => {
    h.acquire.mockResolvedValueOnce({ ok: false, holder: 'u2' });
    await deleteSketchBaseSheetViaGateway('character_sheet');
    expect(h.removeSketchBaseSheet).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.toast.info).toHaveBeenCalled();
  });

  it('save failure (e.g. owner-only 403) → error toast, lock still released', async () => {
    h.save.mockResolvedValueOnce({ ok: false, forbidden: true, lost: false });
    await deleteSketchBaseSheetViaGateway('character_sheet');
    expect(h.removeSketchBaseSheet).toHaveBeenCalledWith('character_sheet');
    expect(h.toast.error).toHaveBeenCalled();
    expect(h.release).toHaveBeenCalled();
  });
});
