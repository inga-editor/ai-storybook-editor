// clone-builder.ts — Pure helpers that derive a Remix row payload from the
// active snapshot + user-driven RemixConfig. No side effects.
//
// ⚠️ CASTING AUTHORITY (chốt 2026-07-31): casting materialization goes ONLY
// through each layer's `casting_slot`. We NEVER scan an un-slotted layer's
// `tags[]` to infer which actor is depicted — an item's tags only ever
// reference the STORY's original actor, never a preset's actor, so a tag scan
// cannot enumerate an actor's images. Every actor image MUST carry a
// `casting_slot`; a missing one is an admin data bug fixed upstream, not patched
// here. Displaced default actors are dropped UNCONDITIONALLY by effective-cast.
// DO NOT re-add any layer-content scan to infer the cast — see the forbidding
// quote in `src/features/remix/effective-cast.ts` header + plan phase-05.
//
// Clone source of truth is the DATABASE-SCHEMA.md "Clone policy" (remix-store.md
// is stale on createRemix). Reshape 2026-07-31: remix is LINEAR — branch
// resolve-at-create walks the chosen path, emits `sections: []`, strips every
// `branch_setting`; casted layers materialize the chosen actor media + rewrite
// their subject tags; `characters[]` = effective cast; `props[]` = [].

import type {
  BaseSpread,
  SpreadImage,
  SpreadVideo,
  SpreadAutoPic,
  SpreadAudio,
  SpreadAutoAudio,
  SpreadTag,
  Geometry,
} from '@/types/spread-types';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { IllustrationData } from '@/types/illustration-types';
import type { BookRemix, CastingAxis } from '@/types/editor';
import type {
  InsertableRemixRow,
  RemixCharacter,
  RemixConfig,
  RemixIllustration,
  RemixMix,
  RemixSpread,
} from '@/types/remix';
import { createLogger } from '@/utils/logger';
import { newUuid } from '@/utils/uuid';
import { effectiveCastKeys } from '@/features/remix/effective-cast';
import { resolveRemixSpreadPath } from './clone/resolve-remix-spread-path';
import {
  materializeCastedLayer,
  type MaterializeCastingContext,
} from './clone/materialize-casting';
import {
  rewriteCastedTags,
  type RewriteCastedTagsContext,
} from './clone/rewrite-casted-tags';

const log = createLogger('Store', 'RemixCloneBuilder');

export interface CloneBuilderInput {
  snapshotId: string;
  illustration: IllustrationData;
  characters: Character[];
  /** Kept so casting materialization can read prop actors (actor_type=2). Props
   *  are no longer cloned onto the row (`props: []`). */
  props: Prop[];
  /** book.casting_slot.casting_axes — drives actor resolution + effective cast. */
  castingAxes: CastingAxis[];
  /** book.remix — the enabled-character gate for the effective cast. */
  bookRemix: BookRemix;
}

// ── Public helpers ───────────────────────────────────────────────────────────

/** Drop editor-only fields from a snapshot spread. Layer IDs and the rest are
 *  preserved verbatim — animations[].target.id continues to resolve correctly.
 *  Reshape 2026-07-31: remix is linear ⇒ `branch_setting` is stripped too and
 *  `sections` emits `[]` (the branch walk already linearized the path). */
export function cloneIllustration(src: IllustrationData): RemixIllustration {
  return {
    sections: [],
    spreads: src.spreads.map(stripSpread),
  };
}

function stripSpread(spread: BaseSpread): RemixSpread {
  const cloned = structuredClone(spread) as BaseSpread;
  delete cloned.raw_images;
  delete cloned.raw_textboxes;
  delete cloned.manuscript;
  delete cloned.tiny_sketch_media_url;
  // Remix has no branching — the resolved path is already linear.
  delete cloned.branch_setting;
  return cloned as RemixSpread;
}

// ── Tag-bearing layer iteration ──────────────────────────────────────────────

export type TaggedLayer =
  | SpreadImage
  | SpreadVideo
  | SpreadAutoPic
  | SpreadAudio
  | SpreadAutoAudio;
type TaggedLayerKind = 'image' | 'video' | 'auto_pic' | 'audio' | 'auto_audio';

export interface TaggedLayerVisit {
  layer: TaggedLayer;
  kind: TaggedLayerKind;
}

export function* iterTaggedLayers(spread: RemixSpread): Generator<TaggedLayerVisit> {
  for (const layer of spread.images ?? []) yield { layer, kind: 'image' };
  for (const layer of spread.auto_pics ?? []) yield { layer, kind: 'auto_pic' };
  for (const layer of spread.videos ?? []) yield { layer, kind: 'video' };
  for (const layer of spread.audios ?? []) yield { layer, kind: 'audio' };
  for (const layer of spread.auto_audios ?? []) yield { layer, kind: 'auto_audio' };
}

// ── Crop sheet population ────────────────────────────────────────────────────

export function spreadNumberOf(spread: RemixSpread): number {
  const raw = spread.pages?.[0]?.number;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function geometryOf(layer: TaggedLayer): { x: number; y: number; w: number; h: number } {
  const g = (layer as { geometry?: Geometry | { x: number; y: number } }).geometry;
  if (!g) return { x: 0, y: 0, w: 0, h: 0 };
  const full = g as Geometry;
  return {
    x: full.x ?? 0,
    y: full.y ?? 0,
    w: (full as Partial<Geometry>).w ?? 0,
    h: (full as Partial<Geometry>).h ?? 0,
  };
}

/** Subject tags only — `character` / `prop`. Role tags (`other`, e.g. stage /
 *  background) are excluded so they cannot affect single-vs-mix classification. */
export function subjectTagsOf(layer: TaggedLayer): SpreadTag[] {
  return (layer.tags ?? []).filter((t) => t.type === 'character' || t.type === 'prop');
}

/** Builds the single empty batch skeleton (rev2). `crop_sheets[]` is filled by
 *  `computeCropSheets` (layout engine over `groupCropsForBatch`) right after, in
 *  the same INSERT path. Identity = uuid; legacy `keys[]` lineup is gone. */
export function makeBatchSkeleton(order: number, name: string): RemixMix {
  return { id: newUuid(), order, name, crop_sheets: [] };
}

/** Warn (never prune) when an animation's `target.id` is not a layer present on
 *  its own cloned spread — decided 2026-07-31: KEEP dangling refs (player
 *  tolerates them), surface a warn only. `'spread'` sentinel targets are skipped. */
function warnDanglingAnimationTargets(spread: RemixSpread): void {
  const anims = spread.animations;
  if (!anims || anims.length === 0) return;
  const ids = new Set<string>();
  const push = (arr?: ReadonlyArray<{ id: string }>) => {
    for (const x of arr ?? []) ids.add(x.id);
  };
  push(spread.images);
  push(spread.textboxes);
  push(spread.videos);
  push(spread.auto_pics);
  push(spread.audios);
  push(spread.auto_audios);
  push(spread.shapes);
  push(spread.quizzes);
  push(spread.composites);
  for (const a of anims) {
    if (a.target.id === 'spread') continue; // Camera Zoom sentinel
    if (!ids.has(a.target.id)) {
      log.warn('buildRemixClonePayload', 'animation target not on cloned spread — kept (not pruned)', {
        spreadId: spread.id,
        targetId: a.target.id,
        targetType: a.target.type,
      });
    }
  }
}

// ── Top-level orchestrator ───────────────────────────────────────────────────

export function buildRemixClonePayload(
  input: CloneBuilderInput,
  config: RemixConfig,
  name?: string,
): InsertableRemixRow {
  log.info('buildRemixClonePayload', 'start', {
    snapshotId: input.snapshotId,
    charCount: input.characters.length,
    propCount: input.props.length,
    spreadCount: input.illustration.spreads.length,
    branchChoiceCount: config.story.branches.length,
  });

  // ── 1. Walk the chosen linear branch path ──────────────────────────────────
  const path = resolveRemixSpreadPath(
    input.illustration.spreads,
    input.illustration.sections,
    config.story.branches,
  );

  // ── 2. Strip spreads + materialize casting + rewrite casted tags ───────────
  const materCtx: MaterializeCastingContext = {
    castingAxes: input.castingAxes,
    storyPresets: config.story.presets,
    snapshotCharacters: input.characters,
    snapshotProps: input.props,
  };
  const tagCtx: RewriteCastedTagsContext = {
    snapshotCharacters: input.characters,
    snapshotProps: input.props,
  };

  let castedLayerCount = 0;
  let materializedCount = 0;
  const spreads: RemixSpread[] = path.ordered.map((srcSpread) => {
    const spread = stripSpread(srcSpread);
    for (const layer of spread.images ?? []) {
      const hadSlot = !!layer.casting_slot;
      const { resolvedActor } = materializeCastedLayer(layer, materCtx);
      if (hadSlot) {
        castedLayerCount += 1;
        if (resolvedActor) materializedCount += 1;
        rewriteCastedTags(layer, resolvedActor, tagCtx);
      }
    }
    warnDanglingAnimationTargets(spread);
    return spread;
  });

  const illustration: RemixIllustration = { spreads, sections: [] };

  // ── 3. Effective cast — preset ⊗ book gate ⊗ snapshot keys (NO tag scan) ───
  // ⚠️ Independent of layer content (the old layer-content check was removed
  // 2026-07-31). Modal preview + this clone share the SAME `effectiveCastKeys`,
  // so they can't drift.
  const snapshotCharacterKeys = input.characters.map((c) => c.key);
  const castKeys = new Set(
    effectiveCastKeys({
      storyPresets: config.story.presets,
      castingAxes: input.castingAxes,
      bookRemix: input.bookRemix,
      snapshotCharacterKeys,
    }),
  );

  // ── 4. Clone characters to the effective cast + purge config ───────────────
  const characters: RemixCharacter[] = input.characters
    .filter((c) => castKeys.has(c.key))
    // rev2: crops live on the batch (mixes[]), not on the entity. No
    // `visual_swap_url` base seed — the column is dead; the base variant's swap
    // reference is DERIVED from sprite finals client-side (`useRemixVariants`).
    .map((c) => structuredClone(c) as RemixCharacter);

  const purgedConfig: RemixConfig = {
    ...config,
    characters: config.characters.filter((c) => castKeys.has(c.key)),
    // Keep the narrator voice slot always; drop voices for dropped characters.
    voices: config.voices.filter(
      (v) => v.key === 'narrator' || castKeys.has(v.key),
    ),
  };
  // Legacy — writer never emits `props` (props no longer remix-swappable).
  delete purgedConfig.props;

  // rev2: a single empty batch skeleton. `computeCropSheets` fills its
  // `crop_sheets[]` from `groupCropsForBatch` + the layout engine in the same
  // INSERT path. No more single-subject/mix enumeration.
  const mixes: RemixMix[] = [makeBatchSkeleton(0, 'Batch 1')];

  log.debug('buildRemixClonePayload', 'done', {
    spreadCountIn: input.illustration.spreads.length,
    spreadCountOut: spreads.length,
    truncatedByCycle: path.truncatedByCycle,
    truncatedByCap: path.truncatedByCap,
    castedLayerCount,
    materializedCount,
    castKeyCount: castKeys.size,
    purgedCharacterCount: purgedConfig.characters.length,
    purgedVoiceCount: purgedConfig.voices.length,
    batchCount: mixes.length,
  });

  return {
    snapshot_id: input.snapshotId,
    name: name?.trim() || 'New Remix',
    remix_config: purgedConfig,
    illustration,
    characters,
    props: [], // legacy — props are no longer cloned onto the remix row.
    mixes,
    // Stage 2/3 pipeline columns (⚡2026-06-12) — NEVER auto-seeded; batches
    // arrive via Import (finals of the previous stage) in the modal.
    rmbgs: [],
    upscales: [],
    // Sprite plane (Variants tab) — seeded lazily on modal open (Phase 03
    // ensureRemixSpriteSeed); create-time payload starts empty.
    sprites: [],
    // Lazy-init on first export/toggle (job handler or client). Null = reader
    // coalesces to DEFAULT — no need to materialize the full shape at create.
    distribution: null,
  };
}
