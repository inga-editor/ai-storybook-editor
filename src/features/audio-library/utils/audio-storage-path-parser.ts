import { createLogger } from '@/utils/logger';
import { pathFromStorageUrl } from '@/utils/storage-url';

const log = createLogger('AudioLibrary', 'StoragePathParser');

/**
 * Parse the object key of a storage public URL (BOTH shapes — legacy Supabase and
 * new `/files/` — via the shared `pathFromStorageUrl`), then keep it only if it
 * starts with one of the allowed `prefixes`. Returns null when unparseable or the
 * prefix does not match; caller skips Storage cleanup on null.
 */
export function parseStoragePathFromUrl(
  url: string | null | undefined,
  prefixes: string[],
): string | null {
  const path = pathFromStorageUrl(url);
  if (!path) return null;
  if (prefixes.length > 0 && !prefixes.some((p) => path.startsWith(p + '/') || path === p)) {
    log.debug('parseStoragePathFromUrl', 'prefix mismatch', {
      path: path.slice(0, 60),
      prefixes,
    });
    return null;
  }
  return path;
}
