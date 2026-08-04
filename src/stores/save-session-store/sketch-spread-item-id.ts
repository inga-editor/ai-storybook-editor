// sketch-spread-item-id.ts — composite-id BUILDERS + SPLITTERS for the two sketch-spread CANVAS
// save-domains (`sketch-image` rtype 1, `sketch-textbox` rtype 2). Like `entity-id.ts`, these encode
// the CONTEXT the policy needs but which the `SavePolicy` `getNode(id)` / `buildPayload(projected,id)`
// signatures do NOT pass separately:
//   • sketch-image   → the parent SPREAD id (create-fallback parent + audit `spread_number`).
//   • sketch-textbox → the parent SPREAD id AND the per-language `locale` (the OLD canvas saved the
//                      per-locale CONTENT slot via `getSketchTextboxContent(tb, langCode)`, not the
//                      whole textbox — so getNode must know the locale).
//
// The LockTarget `resource_id` is ONLY the CHILD segment (imageId / textboxId), so
// `keyOf(bookId, target)` stays byte-identical to the OLD `use-resource-lock-session` canvas path.
// Spread/textbox/image ids are UUIDs and langCodes carry no '/', so the split is unambiguous. A BARE
// id (no '/') is tolerated (unit-test fixtures / legacy): the whole id is BOTH the child and the
// create-fallback parent — see the parity fixtures in `save-policies.test.ts`.

/** `"{spreadId}/{imageId}"`. */
export function makeSketchImageId(spreadId: string, imageId: string): string {
  return `${spreadId}/${imageId}`;
}

/** Split `"{spreadId}/{imageId}"` → parts. Bare id ⇒ `{ spreadId: id, imageId: id }`. */
export function splitSketchImageId(id: string): { spreadId: string; imageId: string } {
  const i = id.indexOf('/');
  if (i <= 0) return { spreadId: id, imageId: id };
  return { spreadId: id.slice(0, i), imageId: id.slice(i + 1) };
}

/** `"{spreadId}/{textboxId}/{locale}"`. */
export function makeSketchTextboxId(spreadId: string, textboxId: string, locale: string): string {
  return `${spreadId}/${textboxId}/${locale}`;
}

/** Split `"{spreadId}/{textboxId}/{locale}"` → parts. 2-part id ⇒ no locale; bare id ⇒ self. */
export function splitSketchTextboxId(id: string): {
  spreadId: string;
  textboxId: string;
  locale: string | null;
} {
  const parts = id.split('/');
  if (parts.length >= 3) return { spreadId: parts[0], textboxId: parts[1], locale: parts[2] };
  if (parts.length === 2) return { spreadId: parts[0], textboxId: parts[1], locale: null };
  return { spreadId: id, textboxId: id, locale: null };
}
