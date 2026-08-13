// storage-url.ts — Storage URL ⇄ object-key helpers, dual-shape aware.
//
// During the Supabase→storage-service cutover (ADR-054) both URL shapes coexist
// in the DB: the old Supabase public URL and the new nginx `/files/` URL. Every
// parse of a stored URL MUST accept BOTH, or cleanup silently skips old rows and
// leaks orphaned objects.

import { STORAGE_BUCKET, storagePublicBaseUrl } from '@/constants/storage-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'StorageUrl');

// New (storage-service via nginx): {base}/files/{bucket}/{key}
const FILES_PATTERN = new RegExp(`/files/${STORAGE_BUCKET}/(.+)$`);
// Legacy (Supabase Storage): {base}/storage/v1/object/public/{bucket}/{key}
const SUPABASE_PATTERN = new RegExp(`/storage/v1/object/public/${STORAGE_BUCKET}/(.+)$`);

/** Extract the object key from a stored storage URL (either shape). Strips query,
 *  decodes percent-escapes. Returns `null` when neither shape matches (host/bucket
 *  mismatch, malformed URL) — callers skip cleanup on null. */
export function pathFromStorageUrl(url: string | null | undefined): string | null {
  if (!url) {
    log.debug('pathFromStorageUrl', 'empty url', {});
    return null;
  }
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not an absolute URL — fall back to raw string matching (still supports both shapes).
    pathname = String(url).split('?')[0];
  }
  const match = pathname.match(FILES_PATTERN) ?? pathname.match(SUPABASE_PATTERN);
  if (!match) {
    log.debug('pathFromStorageUrl', 'no shape matched', { pathname: pathname.slice(0, 80) });
    return null;
  }
  return decodeURIComponent(match[1].split('?')[0]);
}

/** Build the canonical public read URL for an object key. Used only as a
 *  dev/fallback — the primary URL is `data.url` from the upload response. */
export function buildPublicUrl(key: string, bucket: string = STORAGE_BUCKET): string {
  return `${storagePublicBaseUrl()}/files/${bucket}/${key}`;
}

/** Guard an object key against the storage-service key grammar BEFORE the network
 *  round-trip (charset `[A-Za-z0-9._-]` per segment, no `..`/`//`/leading `/`,
 *  extension required on the last segment). Throws a precise error on violation. */
export function assertKeyGrammar(key: string): void {
  if (!key || key.startsWith('/')) {
    throw new Error(`Invalid storage key (empty or leading slash): "${key}"`);
  }
  if (key.includes('//') || key.includes('..')) {
    throw new Error(`Invalid storage key (contains "//" or ".."): "${key}"`);
  }
  const segments = key.split('/');
  for (const seg of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) {
      throw new Error(`Invalid storage key segment "${seg}" in "${key}"`);
    }
  }
  const last = segments[segments.length - 1];
  if (!/\.[A-Za-z0-9]+$/.test(last)) {
    throw new Error(`Storage key must end with a file extension: "${key}"`);
  }
}
