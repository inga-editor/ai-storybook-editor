// rewrite-casted-tags.ts — Pure subject-tag rewrite for a CASTED image layer.
//
// After materialize-casting resolves the actor for a `casting_slot` layer, its
// subject tags (`character` / `prop`) must point at the CHOSEN actor's key so
// the downstream crop pipeline (computeCropSheets) affinity-groups by the new
// subject. Only casted layers (a non-null resolvedActor) are rewritten:
//   - object_key  → the chosen actor's key
//   - type        → 'character' | 'prop' per actor_type
//   - variant_key → kept if the actor entity actually has that variant key,
//                   else the actor's BASE variant (type=0) key, else null
//   - 'other' tags → untouched (role tags: background / foreground / vfx)
//
// Layers WITHOUT a resolved actor (plain layers, or resolution that fell to the
// default actor) keep their tags verbatim — we never read/scan a plain layer's
// tags to infer casting (chốt 2026-07-31; see clone-builder.ts header).

import type { SpreadImage, SpreadTagType } from '@/types/spread-types';
import type { CastingAssignment } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import { ACTOR_TYPE_CHARACTER } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'RemixRewriteCastedTags');

export interface RewriteCastedTagsContext {
  snapshotCharacters: Character[];
  snapshotProps: Prop[];
}

/** Minimal variant projection shared by Character/Prop variants. */
interface VariantRef {
  key: string;
  type: number;
}

/**
 * Rewrite the subject tags of one casted layer in place. No-op (returns the
 * layer unchanged) when `resolvedActor` is null or the layer has no tags.
 */
export function rewriteCastedTags(
  layer: SpreadImage,
  resolvedActor: CastingAssignment | null,
  ctx: RewriteCastedTagsContext,
): SpreadImage {
  if (!resolvedActor) return layer; // plain / default-fallback layer — untouched
  const tags = layer.tags;
  if (!tags || tags.length === 0) return layer;

  const actorKey = resolvedActor.actor_id;
  const isChar = resolvedActor.actor_type === ACTOR_TYPE_CHARACTER;
  const tagType: SpreadTagType = isChar ? 'character' : 'prop';

  const variants: VariantRef[] =
    (isChar
      ? ctx.snapshotCharacters.find((c) => c.key === actorKey)?.variants
      : ctx.snapshotProps.find((p) => p.key === actorKey)?.variants) ?? [];
  const variantKeys = new Set(variants.map((v) => v.key));
  const baseVariantKey = variants.find((v) => v.type === 0)?.key ?? null;

  let rewritten = 0;
  layer.tags = tags.map((t) => {
    if (t.type !== 'character' && t.type !== 'prop') return t; // 'other' untouched
    rewritten += 1;
    const variant_key =
      t.variant_key != null && variantKeys.has(t.variant_key)
        ? t.variant_key
        : baseVariantKey;
    return { type: tagType, object_key: actorKey, variant_key };
  });

  log.debug('rewriteCastedTags', 'rewrote subject tags', {
    layerId: layer.id,
    actorKey,
    tagType,
    rewritten,
  });
  return layer;
}
