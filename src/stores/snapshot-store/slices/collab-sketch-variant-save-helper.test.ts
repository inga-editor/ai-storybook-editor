import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SKETCH_KIND_TO_RESOURCE_TYPE,
  resolveSketchVariantLockTarget,
  buildSketchEntityPayload,
  flushSketchEntityUnderLock,
} from './collab-sketch-variant-save-helper';

// ⚡ unified-item-save phase 3: `flushSketchEntityUnderLock` now delegates to the save-session engine's
// `ensureSaved` (the engine owns acquire/save/release + solo fork). The pure resolver/payload exports
// are unchanged. vi.hoisted → available inside the hoisted vi.mock factory.
const h = vi.hoisted(() => ({
  ensureSaved: vi.fn(async (_domain: string, _id: string) => 'saved' as string),
}));

// The helper `await import('@/stores/save-session-store')` at call time → mock the engine surface.
vi.mock('@/stores/save-session-store', () => ({
  useSaveSessionStore: { getState: () => ({ ensureSaved: h.ensureSaved }) },
}));

const NODE = { key: 'kid', variants: [{ key: 'hero' }] };

beforeEach(() => {
  h.ensureSaved.mockReset().mockResolvedValue('saved');
});

describe('resolveSketchVariantLockTarget', () => {
  it('maps character → step 1 / rtype 3, whole-node target', () => {
    expect(resolveSketchVariantLockTarget('characters', 'kid')).toEqual({
      step: 1,
      resource_type: 3,
      resource_id: 'kid',
      locale: null,
    });
  });
  it('maps prop → step 1 / rtype 4', () => {
    expect(resolveSketchVariantLockTarget('props', 'sword')).toEqual({
      step: 1,
      resource_type: 4,
      resource_id: 'sword',
      locale: null,
    });
  });
  it('maps alter_characters → step 1 / rtype 3 (same node type as a character)', () => {
    // An alter IS a `characters[]` entity: same rtype, same grant; the entity key disambiguates.
    expect(resolveSketchVariantLockTarget('alter_characters', 'kid_alt')).toEqual({
      step: 1,
      resource_type: 3,
      resource_id: 'kid_alt',
      locale: null,
    });
  });
  it('constant matches the resolver (char 3 · prop 4 · alter 3)', () => {
    expect(SKETCH_KIND_TO_RESOURCE_TYPE).toEqual({ characters: 3, props: 4, alter_characters: 3 });
  });
});

describe('buildSketchEntityPayload', () => {
  it('wraps the whole node as an edit (action_type 3) with log:true', () => {
    expect(buildSketchEntityPayload(NODE)).toEqual({ action_type: 3, patch: NODE, log: true });
  });
});

describe('flushSketchEntityUnderLock (delegates to ensureSaved)', () => {
  it('character → ensureSaved("sketch-entity", "characters/<key>") and returns the outcome', async () => {
    const outcome = await flushSketchEntityUnderLock('characters', 'kid', NODE);
    expect(outcome).toBe('saved');
    expect(h.ensureSaved).toHaveBeenCalledTimes(1);
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-entity', 'characters/kid');
  });

  it('prop → composite id "props/<key>"', async () => {
    await flushSketchEntityUnderLock('props', 'sword');
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-entity', 'props/sword');
  });

  it('alter_characters → composite id "alter_characters/<key>" (engine resolves it to rtype 3)', async () => {
    await flushSketchEntityUnderLock('alter_characters', 'kid_alt');
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-entity', 'alter_characters/kid_alt');
  });

  it('passes the engine outcome straight through (blocked / failed / clean)', async () => {
    for (const oc of ['blocked', 'failed', 'clean'] as const) {
      h.ensureSaved.mockResolvedValueOnce(oc);
      expect(await flushSketchEntityUnderLock('characters', 'kid')).toBe(oc);
    }
  });

  it('node / opts args are IGNORED (engine reads the fresh node via the policy)', async () => {
    await flushSketchEntityUnderLock('characters', 'kid', null, { releaseIfAcquired: true });
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-entity', 'characters/kid');
  });
});
