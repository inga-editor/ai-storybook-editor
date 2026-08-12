// parse-handoff-fragment.ts — Pure: extract the one-time handoff CODE from the URL hash.
//
// The fragment carries ONLY `handoff` (auth spec §1.1) — a one-time, 60s code, NOT a token.
// Any other hash key is ignored. The code is opaque here — never decoded or persisted; the
// caller wipes the fragment synchronously right after this read (see use-editor-session.ts).
// Mirrors the player's parse-token-fragment.ts (different key, same shape).

/**
 * Parse `#handoff=<code>` from a location hash. Returns `{ code }` when a non-empty code is
 * present, else `null`. Never throws.
 *
 * @param hash `window.location.hash` (with or without the leading `#`).
 */
export function parseHandoffFragment(hash: string): { code: string } | null {
  if (!hash) return null;
  // Strip a single leading '#'. URLSearchParams handles the rest (URL-decodes values).
  const query = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  if (query.length === 0) return null;

  const code = new URLSearchParams(query).get('handoff');
  if (typeof code !== 'string' || code.length === 0) return null;

  return { code };
}
