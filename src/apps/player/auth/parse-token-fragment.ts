// parse-token-fragment.ts — Pure: extract an opaque token from the URL hash fragment.
//
// The fragment carries ONLY `token` (auth spec §3.2). Options (language/edition/...) come
// via `player:init.options`, never the URL. Any other hash key is ignored. The token is
// opaque — never decoded, verified, or persisted here.

/**
 * Parse `#token=<opaque>` from a location hash. Returns `{ token }` when a non-empty
 * token is present, else `null`. Never throws.
 *
 * @param hash `window.location.hash` (with or without the leading `#`).
 */
export function parseTokenFragment(hash: string): { token: string } | null {
  if (!hash) return null;
  // Strip a single leading '#'. URLSearchParams handles the rest (URL-decodes values).
  const query = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  if (query.length === 0) return null;

  const token = new URLSearchParams(query).get('token');
  if (typeof token !== 'string' || token.length === 0) return null;

  return { token };
}
