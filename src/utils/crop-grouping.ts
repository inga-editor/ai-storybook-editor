// crop-grouping.ts — Group ALL of a remix's tagged image layers into one
// engine-ready batch (rev2 — batch model, replaces the per-key grouping).
//
// `groupCropsForBatch(remix)` scans `illustration.spreads[].images[]` (image
// layers ONLY — auto_pic/video/audio excluded), collects every layer that
// carries ≥1 ENABLED character/prop subject tag, dedups by `(spread_id, id)`
// (a multi-subject layer becomes ONE crop carrying all enabled tags, never
// duplicated per subject), resolves an effective image URL, and returns:
//   - `cropInputs`     — CropInput[] for crop-sheet-layout-engine, ordered by
//                        entity (characters then props), with
//                        `objectKey = tags[0].object_key` for affinity.
//   - `cropMetaById`   — CropEntry metadata keyed by layer id (for the layout
//                        merge step that writes engine placement geometry).
//                        Carries multi-subject `tags[]`.
//
// IMPORTANT — two distinct geometry concepts:
//   - `CropInput.widthPct/heightPct` is the SOURCE layer geometry (% of the
//     spread). It is read here at grouping time, BEFORE the layout engine runs.
//   - `CropEntry.geometry` is the engine OUTPUT (px, sheet-relative). It is a
//     placeholder ({0,0,0,0}) here and gets overwritten in Phase 03. We never
//     persist widthPct/heightPct on CropEntry — re-layout re-scans the (frozen)
//     illustration as the single source of truth.
//
// Pure: scans the in-memory illustration, no I/O. Uses a logger (caller-facing
// util — logs warnings for bad input, unlike the pure engine).
//
// Spec: ai-storybook-design/component/stores/remix-store.md §6.5
//       ai-storybook-design/component/editor-page/remix-creative-space/05-05-crop-sheet-layout-engine.md §6

import type { Remix, CropEntry } from '@/types/remix';
import type { CropInput } from '@/utils/crop-sheet-layout-engine';
import {
  iterTaggedLayers,
  subjectTagsOf,
  spreadNumberOf,
  geometryOf,
  type TaggedLayer,
} from '@/stores/remix-store/clone-builder';
import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'CropGrouping');

export interface GroupCropsResult {
  /** Engine input, ordered by entity (characters then props). */
  cropInputs: CropInput[];
  /** Source crop metadata keyed by layer id — layout merges engine geometry in. */
  cropMetaById: Record<string, CropEntry>;
}

/**
 * Resolve the best display URL for a tagged layer.
 * Priority: final_hires_media_url → selected illustration → first illustration
 * → media_url. Returns '' when nothing is available.
 *
 * Only SpreadImage carries `final_hires_media_url`/`illustrations`; other
 * tagged-layer kinds expose `media_url` only — accessed optionally below.
 */
export function resolveEffectiveUrl(layer: TaggedLayer): string {
  const img = layer as {
    final_hires_media_url?: string;
    illustrations?: Array<{ media_url: string; is_selected: boolean }>;
    media_url?: string;
  };

  if (img.final_hires_media_url) return img.final_hires_media_url;

  const illustrations = img.illustrations ?? [];
  const selected = illustrations.find((i) => i.is_selected);
  if (selected?.media_url) return selected.media_url;
  if (illustrations[0]?.media_url) return illustrations[0].media_url;

  return img.media_url ?? '';
}

/**
 * Group EVERY enabled-subject image crop of a remix into one batch (rev2).
 *
 * Scans `remix.illustration.spreads[].images[]` (image layers only), keeps each
 * layer that carries ≥1 enabled character/prop tag, dedups by `(spread_id, id)`
 * (multi-subject layer → ONE crop carrying all enabled tags), and orders the
 * result by entity: characters (in `remix.characters[]` order) then props
 * (`remix.props[]` order), tie-break by spread_number.
 *
 * `objectKey = enabledTags[0].object_key` (primary subject) drives sheet
 * affinity in the layout engine. `tags[]` is the full enabled-subject list.
 *
 * @param remix  Remix row — `remix_config.characters[]` (swappable set) gates
 *               character membership, `characters`/`props` define the order;
 *               `illustration` is the frozen source of truth.
 */
export function groupCropsForBatch(remix: Remix): GroupCropsResult {
  log.info('groupCropsForBatch', 'start', {
    charCount: remix.characters.length,
    propCount: remix.props.length,
    spreadCount: remix.illustration.spreads.length,
  });

  // Enabled keys + entity order (characters then props).
  // ⚠️ Amend 2026-07-31 (remixable ⊥ casting_slot): `characters[]` is the
  // unGated VISUAL roster, so swap membership comes from the purged
  // `remix_config.characters[]` (swappable set, key membership — the remixer's
  // per-entry `is_enabled` gates swap execution, not grouping). Roster order is
  // kept; a roster character without a config entry gets no crops. Props are
  // legacy (row membership = enabled, new rows carry `[]`).
  // Tolerance: a partial Remix view without `remix_config` falls back to the
  // roster (legacy behavior — pre-amend rows had roster == swappable). Store-
  // mapped rows never hit this (`readRemixConfig` seeds legacy configs from
  // the roster at ingress).
  const configChars = remix.remix_config?.characters;
  if (!configChars) {
    log.warn('groupCropsForBatch', 'remix view lacks remix_config — roster fallback', {
      charCount: remix.characters.length,
    });
  }
  const swappableCharKeys = new Set(
    (configChars ?? remix.characters).map((c) => c.key),
  );
  const charKeys = remix.characters
    .map((c) => c.key)
    .filter((k) => swappableCharKeys.has(k));
  const propKeys = remix.props.map((p) => p.key);
  const enabledKeys = new Set<string>([...charKeys, ...propKeys]);
  const entityOrder = new Map<string, number>(
    [...charKeys, ...propKeys].map((k, i) => [k, i]),
  );

  // `spreadNumber` stays INTERNAL (sort tie-break only) — the LEAN CropEntry
  // (⚡2026-06-12) no longer persists it (nor layer_kind/aspect_ratio/name/
  // annotation; annotation resolves at runtime from the illustration layer).
  type Collected = {
    input: CropInput;
    meta: CropEntry;
    entityIdx: number;
    spreadNumber: number;
  };
  const collected: Collected[] = [];
  const seen = new Set<string>();

  for (const spread of remix.illustration.spreads) {
    const spreadNumber = spreadNumberOf(spread);

    for (const { layer, kind } of iterTaggedLayers(spread)) {
      // Crop sheets are static-image crops only — skip auto_pic/video/audio.
      if (kind !== 'image') continue;

      // Drop disabled subjects — grouping respects swap-enabled state.
      const subjectTags = subjectTagsOf(layer).filter((t) => enabledKeys.has(t.object_key));
      if (subjectTags.length === 0) continue;

      // Dedup: a multi-subject layer becomes ONE crop (tags[] carries all).
      const dedupKey = `${spread.id}:${layer.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // Source layer geometry (% of spread) — engine input, NOT persisted.
      const g = geometryOf(layer);
      if (g.w <= 0 || g.h <= 0) {
        log.warn('groupCropsForBatch', 'crop geometry invalid — skip', {
          id: layer.id,
          w: g.w,
          h: g.h,
        });
        continue;
      }

      const url = resolveEffectiveUrl(layer);
      if (!url) {
        log.warn('groupCropsForBatch', 'crop has empty url', { id: layer.id });
      }

      const primary = subjectTags[0];
      collected.push({
        entityIdx: entityOrder.get(primary.object_key) ?? Number.MAX_SAFE_INTEGER,
        spreadNumber,
        input: {
          id: layer.id,
          widthPct: g.w,
          heightPct: g.h,
          objectKey: primary.object_key,
        },
        // LEAN CropEntry (⚡2026-06-12): 5 fields only. Per-crop annotation is
        // no longer persisted — the swap manifest resolves it at job time from
        // illustration.spreads[].images[].annotation by (spread_id, id).
        meta: {
          spread_id: spread.id,
          id: layer.id,
          tags: subjectTags,
          media_url: url,
          // Placeholder — overwritten with engine placement geometry in Phase 03.
          geometry: { x: 0, y: 0, w: 0, h: 0 },
        },
      });
    }
  }

  // Order by entity (chars then props), tie-break spread_number — stable so the
  // engine's per-entity affinity clusters appear in cast order.
  collected.sort((a, b) => {
    if (a.entityIdx !== b.entityIdx) return a.entityIdx - b.entityIdx;
    return a.spreadNumber - b.spreadNumber;
  });

  const cropInputs: CropInput[] = [];
  const cropMetaById: Record<string, CropEntry> = {};
  for (const { input, meta } of collected) {
    cropInputs.push(input);
    cropMetaById[meta.id] = meta;
  }

  log.debug('groupCropsForBatch', 'done', { cropCount: cropInputs.length });
  return { cropInputs, cropMetaById };
}
