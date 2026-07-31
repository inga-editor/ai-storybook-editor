// materialize-casting.test.ts — 5-step actor resolution + media coercion +
// casting_slot removal.

import { describe, it, expect } from 'vitest';
import { materializeCastedLayer } from './materialize-casting';
import type { MaterializeCastingContext } from './materialize-casting';
import type { CastingAxis } from '@/types/editor';
import type { SpreadImage, ItemCastingSlot } from '@/types/spread-types';

function axisAltCastsC2(): CastingAxis {
  return {
    id: 'ax1',
    name: 'Hero',
    actants: [{ id: 'a1', name: 'Lead' }],
    presets: [
      { id: 'p_def', name: 'Default', is_default: true, actants: [{ actant_id: 'a1', actor_id: 'c1', actor_type: 1 }] },
      { id: 'p_alt', name: 'Alt', is_default: false, actants: [{ actant_id: 'a1', actor_id: 'c2', actor_type: 1 }] },
    ],
  };
}

/** Preset p_empty casts NOTHING for a1. */
function axisAltCastsNothing(): CastingAxis {
  return {
    id: 'ax1',
    name: 'Hero',
    actants: [{ id: 'a1', name: 'Lead' }],
    presets: [
      { id: 'p_def', name: 'Default', is_default: true, actants: [{ actant_id: 'a1', actor_id: 'c1', actor_type: 1 }] },
      { id: 'p_empty', name: 'Empty', is_default: false, actants: [] },
    ],
  };
}

function ctx(axis: CastingAxis, presetId: string): MaterializeCastingContext {
  return {
    castingAxes: [axis],
    storyPresets: [{ axis_id: 'ax1', preset_id: presetId }],
    snapshotCharacters: [],
    snapshotProps: [],
  };
}

function slot(actors: ItemCastingSlot['actors']): ItemCastingSlot {
  return { actant_id: 'a1', actors };
}

function layerWith(castingSlot?: ItemCastingSlot, extra: Partial<SpreadImage> = {}): SpreadImage {
  return {
    id: 'img-1',
    geometry: { x: 0, y: 0, w: 10, h: 10 },
    casting_slot: castingSlot,
    ...extra,
  } as unknown as SpreadImage;
}

describe('materializeCastedLayer', () => {
  it('layer without a casting_slot is returned untouched (resolvedActor null)', () => {
    const layer = layerWith(undefined, { media_url: 'orig' });
    const res = materializeCastedLayer(layer, ctx(axisAltCastsC2(), 'p_alt'));
    expect(res.resolvedActor).toBeNull();
    expect(res.layer.media_url).toBe('orig');
    expect(res.layer.illustrations).toBeUndefined();
  });

  it('resolves all 5 steps: chosen actor media coerced + casting_slot removed', () => {
    const layer = layerWith(
      slot([
        { id: 'c2', actor_type: 1, media_url: 'url-c2', is_default: false },
        { id: 'c1', actor_type: 1, media_url: 'url-c1', is_default: true },
      ]),
    );
    const res = materializeCastedLayer(layer, ctx(axisAltCastsC2(), 'p_alt'));

    expect(res.layer.casting_slot).toBeUndefined();
    expect(res.layer.illustrations).toHaveLength(1);
    expect(res.layer.illustrations![0]).toMatchObject({
      media_url: 'url-c2',
      is_selected: true,
      type: 'created',
    });
    expect(res.layer.final_hires_media_url).toBe('url-c2');
    expect(res.resolvedActor).toEqual({ actant_id: 'a1', actor_id: 'c2', actor_type: 1 });
  });

  it('preset does not cast the actant → default actor media, resolvedActor null', () => {
    const layer = layerWith(
      slot([
        { id: 'c2', actor_type: 1, media_url: 'url-c2', is_default: false },
        { id: 'c1', actor_type: 1, media_url: 'url-c1', is_default: true },
      ]),
    );
    const res = materializeCastedLayer(layer, ctx(axisAltCastsNothing(), 'p_empty'));
    expect(res.layer.illustrations![0].media_url).toBe('url-c1'); // default actor
    expect(res.resolvedActor).toBeNull();
    expect(res.layer.casting_slot).toBeUndefined();
  });

  it('chosen actor has no media entry in the slot → default actor media, resolvedActor null', () => {
    const layer = layerWith(
      slot([{ id: 'c1', actor_type: 1, media_url: 'url-c1', is_default: true }]), // no c2 entry
    );
    const res = materializeCastedLayer(layer, ctx(axisAltCastsC2(), 'p_alt'));
    expect(res.layer.illustrations![0].media_url).toBe('url-c1');
    expect(res.resolvedActor).toBeNull();
  });

  it('no chosen entry AND no default → keep original media (no illustrations written)', () => {
    const layer = layerWith(
      slot([{ id: 'c9', actor_type: 1, media_url: 'url-c9', is_default: false }]), // no c2, no default
      { media_url: 'orig' },
    );
    const res = materializeCastedLayer(layer, ctx(axisAltCastsC2(), 'p_alt'));
    expect(res.layer.illustrations).toBeUndefined();
    expect(res.layer.media_url).toBe('orig');
    expect(res.layer.final_hires_media_url).toBeUndefined();
    expect(res.layer.casting_slot).toBeUndefined(); // still removed
    expect(res.resolvedActor).toBeNull();
  });
});
