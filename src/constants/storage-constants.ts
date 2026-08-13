// storage-constants.ts — Single source of truth for the storage bucket + the
// Supabase-Storage → self-hosted-storage-service switch (ADR-054).
//
// Backend selection is by ENV PRESENCE, not a boolean flag: if
// `VITE_STORAGE_SERVICE_URL` is set (non-empty after normalize) the app talks to
// the storage service; otherwise it stays on Supabase Storage. Build-time (Vite)
// ⇒ rollback = rebuild without the env. Env is read AT CALL TIME (functions, not
// module-level consts) so `vi.stubEnv` works in tests.

import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'StorageConstants');

/** The single public bucket shared across the whole asset library. Replaces the
 *  scattered `'storybook-assets'` literals in storage/human/style/audio code. */
export const STORAGE_BUCKET = 'storybook-assets';

/** Trim surrounding whitespace and a single trailing slash; '' when nullish. */
function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed.replace(/\/+$/, '');
}

/** Storage-service API base URL (e.g. `http://localhost:8200`), '' when unset. */
export function storageServiceBaseUrl(): string {
  return normalizeBaseUrl(import.meta.env.VITE_STORAGE_SERVICE_URL as string | undefined);
}

/** Public read base URL for `/files/{bucket}/{key}` (nginx). Falls back to the
 *  service base URL when a dedicated public host is not configured. */
export function storagePublicBaseUrl(): string {
  const explicit = normalizeBaseUrl(import.meta.env.VITE_STORAGE_PUBLIC_BASE_URL as string | undefined);
  return explicit || storageServiceBaseUrl();
}

let bootLogged = false;

/** true ⇒ route storage I/O through the storage service; false ⇒ Supabase Storage.
 *  Logs the chosen backend once per session for production diagnosis. */
export function isStorageServiceEnabled(): boolean {
  const enabled = storageServiceBaseUrl() !== '';
  if (!bootLogged) {
    bootLogged = true;
    log.info('isStorageServiceEnabled', 'storage backend selected', {
      backend: enabled ? 'service' : 'supabase',
    });
  }
  return enabled;
}
