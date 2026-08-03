// collab-owned-subtree — the FE mirror of the server-side per-spread owned-key
// partition (ADR-044 §Revision 2026-07-10). A spread node hosts TWO disjoint
// sub-trees that lock + save independently: SCENE (rtype 6, step 2) and RETOUCH
// (rtype 10, step 3). The held-spread session picks ONLY its pipeline's owned keys
// for the baseline, the dirty-diff, and the save patch, so a scene edit and a
// retouch edit on the SAME spread never clobber each other.
//
// SSOT ALIGNMENT (non-negotiable): these two sets MUST stay byte-identical to the
// backend constants in `ai-storybook-image-api/src/services/resource/addressing.py`
// (SCENE_OWNED_KEYS / RETOUCH_OWNED_KEYS). The server ENFORCES the partition (it
// drops any non-owned key), so a FE/BE drift only ever wastes payload or omits a
// key from the dirty-diff — never a security hole — but a MISSING key here means an
// edit to it is neither diffed nor saved on release (silent data loss). The union of
// both sets + `id` is exhaustive over the spread node (illustration-structure.md
// §spreads[]); pinned by collab-owned-subtree.test.ts.

/** SCENE pipeline (rtype 6, step 2) — the editor-only raw layers + spread metadata. */
export const SCENE_OWNED_KEYS = [
  'raw_images',
  'raw_textboxes',
  'manuscript',
  'tiny_sketch_media_url',
  'pages',
  'branch_setting',
  // Spread Pool metadata (2026-08-03) — author-entered pool membership + title +
  // system-generated thumbnail. Structure group of the SCENE partition. MUST stay
  // byte-identical (order + content) with Python SCENE_OWNED_KEYS.
  'pool',
  'thumbnail_url',
  'title',
] as const;

/** RETOUCH pipeline (rtype 10, step 3) — the playable layers + animations.
 *  NOTE `shapes`: a PLAYABLE layer → owned by RETOUCH here. A legacy SCENE mutator
 *  (spreads-sidebar shape-reorder → rtype-6 whole-node) still writes it; that reorder
 *  MUST be re-routed onto the retouch path before the scene per-spread swap ships,
 *  else the scene merge (which excludes `shapes`) drops reorders. */
export const RETOUCH_OWNED_KEYS = [
  'images',
  'textboxes',
  'shapes',
  'videos',
  'auto_pics',
  'audios',
  'auto_audios',
  'composites',
  'quizzes',
  'animations',
] as const;

export type OwnedKey =
  | (typeof SCENE_OWNED_KEYS)[number]
  | (typeof RETOUCH_OWNED_KEYS)[number];

/**
 * Pick ONLY the owned keys present on `node` into a fresh sub-object. Undefined-safe:
 * a non-object node → `{}`; an absent owned key is simply omitted (so the dirty-diff
 * treats "key never existed" and "key deleted to undefined" identically, matching the
 * server merge which no-ops on an absent key). The result is a shallow projection —
 * the caller structuredClone()s it for the baseline so later mutations don't alias it.
 */
export function extractOwnedSubtree(
  node: unknown,
  ownedKeys: readonly string[],
): Record<string, unknown> {
  if (node == null || typeof node !== 'object') return {};
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ownedKeys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
