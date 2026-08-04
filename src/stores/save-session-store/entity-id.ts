// entity-id.ts — composite id helpers for the two ENTITY save-domains
// (`illustration-entity` rtype 3/4/5, `sketch-entity` rtype 3/4). A bare `resource_id`
// (the entity key) does NOT encode the rtype, and a key alone is ambiguous across
// characters/props/stages — so these two domains address an item by `"{kind}/{entityKey}"`
// (Validation S1 Q3: keep the 9-value SaveDomain union, disambiguate via a composite id).
//
// The `kind` half is the domain's OWN vocabulary:
//   • illustration-entity → 'character' | 'prop' | 'stage'   (resolveImageLockTarget kind)
//   • sketch-entity       → 'characters' | 'props'           (resolveSketchVariantLockTarget kind)
// The engine never inspects `kind` outside the policy, so the two vocabularies never collide.
//
// INVARIANT (asserted by callers + tests): the parsed `key` — which becomes the LockTarget
// `resource_id` — never contains a '/', so `keyOf(...)` stays unambiguous. Entity keys are
// lowercase_underscore mention keys and spread/entity ids are UUIDs; neither contains '/'.

/** Build a composite entity id: `"{kind}/{entityKey}"`. */
export function makeEntityId(kind: string, entityKey: string): string {
  return `${kind}/${entityKey}`;
}

export interface ParsedEntityId {
  kind: string;
  key: string;
}

/**
 * Parse a composite entity id back to `{ kind, key }`. Splits on the FIRST '/' only (the kind
 * half never contains '/'; the key half is verified '/'-free above). Throws on a malformed id
 * so a mis-wired entity domain fails loudly instead of resolving a bogus lock target.
 */
export function parseEntityId(id: string): ParsedEntityId {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    throw new Error(`parseEntityId: expected composite "{kind}/{key}", got "${id}"`);
  }
  const kind = id.slice(0, slash);
  const key = id.slice(slash + 1);
  return { kind, key };
}
