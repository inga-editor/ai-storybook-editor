import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SKETCH_KIND_TO_SHEET_RESOURCE_ID,
  resolveSketchBaseSheetLockTarget,
  buildSketchBaseSheetPayload,
  flushSketchBaseSheetUnderLock,
} from './collab-sketch-base-sheet-save-helper';

// ⚡ unified-item-save phase 3: `flushSketchBaseSheetUnderLock` now delegates to the engine's
// `ensureSaved` (the gateway still owns the rtype-11 upsert / 404-tolerance — that moved out of the
// client seam entirely). The pure resolver/payload exports are unchanged.
const h = vi.hoisted(() => ({
  ensureSaved: vi.fn(async (_domain: string, _id: string) => 'saved' as string),
}));

vi.mock('@/stores/save-session-store', () => ({
  useSaveSessionStore: { getState: () => ({ ensureSaved: h.ensureSaved }) },
}));

const SHEET_NODE = { styles: [{ style_prompt: 's', is_selected: true, image_references: [], illustrations: [], crops: [] }] };

beforeEach(() => {
  h.ensureSaved.mockReset().mockResolvedValue('saved');
});

describe('resolveSketchBaseSheetLockTarget', () => {
  it('maps characters → step 1 / rtype 11 / resource_id character_sheet', () => {
    expect(resolveSketchBaseSheetLockTarget('characters')).toEqual({
      step: 1,
      resource_type: 11,
      resource_id: 'character_sheet',
      locale: null,
    });
  });
  it('maps props → step 1 / rtype 11 / resource_id prop_sheet', () => {
    expect(resolveSketchBaseSheetLockTarget('props')).toEqual({
      step: 1,
      resource_type: 11,
      resource_id: 'prop_sheet',
      locale: null,
    });
  });
  it('maps alter_characters → step 1 / rtype 11 / resource_id alter_character_sheet', () => {
    // 3 distinct resource_ids ⇒ 3 INDEPENDENT rtype-11 locks (the 3 sheets generate in parallel).
    expect(resolveSketchBaseSheetLockTarget('alter_characters')).toEqual({
      step: 1,
      resource_type: 11,
      resource_id: 'alter_character_sheet',
      locale: null,
    });
  });
  it('constant matches the resolver (characters · props · alter_characters)', () => {
    expect(SKETCH_KIND_TO_SHEET_RESOURCE_ID).toEqual({
      characters: 'character_sheet',
      props: 'prop_sheet',
      alter_characters: 'alter_character_sheet',
    });
  });
});

describe('buildSketchBaseSheetPayload', () => {
  it('wraps the whole sheet node as an edit (action_type 3) with log:true', () => {
    expect(buildSketchBaseSheetPayload(SHEET_NODE)).toEqual({ action_type: 3, patch: SHEET_NODE, log: true });
  });
});

describe('flushSketchBaseSheetUnderLock (delegates to ensureSaved)', () => {
  it('characters → ensureSaved("sketch-base-sheet", "character_sheet") and returns the outcome', async () => {
    const outcome = await flushSketchBaseSheetUnderLock('characters', SHEET_NODE);
    expect(outcome).toBe('saved');
    expect(h.ensureSaved).toHaveBeenCalledTimes(1);
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-base-sheet', 'character_sheet');
  });

  it('props → resource_id "prop_sheet"', async () => {
    await flushSketchBaseSheetUnderLock('props', SHEET_NODE);
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-base-sheet', 'prop_sheet');
  });

  it('alter_characters → resource_id "alter_character_sheet"', async () => {
    await flushSketchBaseSheetUnderLock('alter_characters', SHEET_NODE);
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-base-sheet', 'alter_character_sheet');
  });

  it('passes the engine outcome straight through (blocked / failed / clean)', async () => {
    for (const oc of ['blocked', 'failed', 'clean'] as const) {
      h.ensureSaved.mockResolvedValueOnce(oc);
      expect(await flushSketchBaseSheetUnderLock('characters')).toBe(oc);
    }
  });

  it('node / opts args are IGNORED (engine reads the fresh sheet via the policy)', async () => {
    await flushSketchBaseSheetUnderLock('characters', null, { releaseIfAcquired: true });
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-base-sheet', 'character_sheet');
  });
});
