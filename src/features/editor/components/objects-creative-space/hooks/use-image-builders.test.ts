// use-image-builders.test.ts — buildExtractImages AI-provenance threading (cost attribution).
// Focus: ExtractResult.aiRequestId → illustrations[].ai_request_id on the spawned entry.
//   • AI extract (Layers / Background) → id set; N layers from one call SHARE the same id.
//   • CV crop (Objects / Crops, no aiRequestId) → key absent (never fabricated).
// Uses the raw path (zTier:null + addImage override) so no spread/z-tier scaffolding is needed.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  buildExtractImages,
  sceneLineageOfPlayableSource,
  type BuildExtractImagesOptions,
} from './use-image-builders';
import type { SpreadImage } from '@/types/canvas-types';
import type { ExtractResult } from '@/features/editor/components/shared-components';

const SOURCE: SpreadImage = { id: 'src-1', geometry: { x: 0, y: 0, w: 100, h: 100 } };

/**
 * Capture the spawned images via the addImage override (raw path — no store).
 * `extraOptions`/`source` are optional so the pre-existing provenance cases stay untouched.
 */
function runBuilder(
  results: ExtractResult[],
  extraOptions: Omit<BuildExtractImagesOptions, 'addImage' | 'zTier'> = {},
  source: SpreadImage = SOURCE
): SpreadImage[] {
  const captured: SpreadImage[] = [];
  // Only options.addImage is exercised; actions default is never dereferenced here.
  const actions = {} as unknown as Parameters<typeof buildExtractImages>[4];
  buildExtractImages(results, source, 'spread-1', [], actions, {
    addImage: (_spreadId, img) => captured.push(img),
    zTier: null,
    ...extraOptions,
  });
  return captured;
}

const CROP_RESULT: ExtractResult = {
  id: 'c1',
  media_url: 'https://s/crop-1.png',
  sourceTab: 'crop',
  title: 'C1',
  meta: { geometry: { x: 10, y: 10, w: 20, h: 20 } },
};

describe('buildExtractImages — AI provenance (ai_request_id)', () => {
  it('threads a shared aiRequestId onto every layering result entry (1 call = 1 id)', () => {
    const AI_ID = 'ai-layer-abc';
    const results: ExtractResult[] = [
      { id: 'r1', media_url: 'https://s/layer-1.png', sourceTab: 'layering', title: 'L1', aiRequestId: AI_ID, meta: { layerIndex: 0 } },
      { id: 'r2', media_url: 'https://s/layer-2.png', sourceTab: 'layering', title: 'L2', aiRequestId: AI_ID, meta: { layerIndex: 1 } },
    ];

    const spawned = runBuilder(results);

    expect(spawned).toHaveLength(2);
    expect(spawned[0].illustrations?.[0].ai_request_id).toBe(AI_ID);
    // All N layers from one call share the SAME id (not fabricated per-layer).
    expect(spawned[1].illustrations?.[0].ai_request_id).toBe(AI_ID);
  });

  it('threads the background aiRequestId onto the single generated entry', () => {
    const results: ExtractResult[] = [
      { id: 'bg1', media_url: 'https://s/bg-1.png', sourceTab: 'background', title: 'BG', aiRequestId: 'ai-bg-xyz', meta: { permanent: true } },
    ];

    const spawned = runBuilder(results);

    expect(spawned[0].illustrations?.[0].ai_request_id).toBe('ai-bg-xyz');
  });

  it('omits ai_request_id for CV crop results (no AI provenance → key never fabricated)', () => {
    const results: ExtractResult[] = [CROP_RESULT];

    const spawned = runBuilder(results);
    const entry = spawned[0].illustrations?.[0];

    expect(entry).toBeDefined();
    // Key must be ABSENT (not present-with-undefined) so uploaded/CV entries read as NULL provenance.
    expect(entry && 'ai_request_id' in entry).toBe(false);
  });
});

// Scene lineage (original_image_id) — invariants L2/L3/L9 of
// snapshot/illustration-structure.md#scene-lineage-original_image_id.
// The builder is collection-agnostic: it writes the caller-supplied scene id verbatim and
// NEVER derives one from sourceImage.id (a playable id is not a scene id).
describe('buildExtractImages — scene lineage (original_image_id)', () => {
  it('inherits the caller-supplied scene id onto every spawned image (L2/L3 — flat)', () => {
    // Objects space: source is a playable images[] entry already carrying lineage to raw "scene-1".
    const playableSource: SpreadImage = {
      id: 'playable-9',
      geometry: { x: 0, y: 0, w: 100, h: 100 },
      original_image_id: 'scene-1',
    };
    const results: ExtractResult[] = [
      { ...CROP_RESULT, id: 'c1' },
      { ...CROP_RESULT, id: 'c2' },
    ];

    const spawned = runBuilder(results, { originalImageId: playableSource.original_image_id }, playableSource);

    expect(spawned).toHaveLength(2);
    // Flat: points at the ROOT scene, not at the intermediate playable source.
    expect(spawned[0].original_image_id).toBe('scene-1');
    expect(spawned[1].original_image_id).toBe('scene-1');
  });

  it('leaves the key absent when the playable source has no lineage (never invents one)', () => {
    // Legacy / blank source: caller passes through `undefined` — the builder must not fall back
    // to sourceImage.id, which would forge a fake scene.
    const spawned = runBuilder([CROP_RESULT], { originalImageId: undefined });

    expect(Object.prototype.hasOwnProperty.call(spawned[0], 'original_image_id')).toBe(false);
  });

  it('leaves the key absent for the raw_images[] carve-out (L9 — raw is always the root)', () => {
    // Raw/illustration space call shape: addImage=addRawImage, zTier=null, NO originalImageId.
    const spawned = runBuilder([CROP_RESULT]);

    expect(Object.prototype.hasOwnProperty.call(spawned[0], 'original_image_id')).toBe(false);
  });
});

// The caller seam is where a forged lineage would be introduced (someone "hardening" the Objects
// call site with `?? source.id`). Pinning the helper pins that decision — a forged scene id lands
// in JSONB with no FK, no validation and no cleanup job, i.e. permanent corruption.
describe('sceneLineageOfPlayableSource — inherit-only (L2/L3)', () => {
  it('returns the source lineage, never the source id', () => {
    const source: SpreadImage = {
      id: 'playable-9',
      geometry: { x: 0, y: 0, w: 10, h: 10 },
      original_image_id: 'scene-1',
    };

    expect(sceneLineageOfPlayableSource(source)).toBe('scene-1');
  });

  it('returns undefined for a source with no lineage (never falls back to source.id)', () => {
    const source: SpreadImage = { id: 'playable-9', geometry: { x: 0, y: 0, w: 10, h: 10 } };

    const scene = sceneLineageOfPlayableSource(source);

    expect(scene).toBeUndefined();
    expect(scene).not.toBe(source.id);
  });

  it('end-to-end through the builder: no-lineage source spawns items with the key absent', () => {
    const source: SpreadImage = { id: 'playable-9', geometry: { x: 0, y: 0, w: 100, h: 100 } };

    // Exactly the Objects-space call shape.
    const spawned = runBuilder([CROP_RESULT], { originalImageId: sceneLineageOfPlayableSource(source) }, source);

    expect(Object.prototype.hasOwnProperty.call(spawned[0], 'original_image_id')).toBe(false);
  });
});
