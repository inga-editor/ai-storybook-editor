// prune-derive-keyed.ts — drop entries whose derive-key no longer exists in the
// source of truth. Shared by remix / parametric-slot / casting-slot persistFns so
// that a Save never re-adds an entry a cascade-delete already removed (design §2.2).
//
// Pure + side-effect free (Phase 5 covers it with unit tests). `keyOf` adapts the
// helper to each shape's own key field (`key` / `code` / `actor_id`).

export function pruneDeriveKeyed<T>(
  entries: readonly T[],
  validKeys: Iterable<string>,
  keyOf: (entry: T) => string,
): T[] {
  const valid = validKeys instanceof Set ? validKeys : new Set(validKeys);
  return entries.filter((entry) => valid.has(keyOf(entry)));
}
