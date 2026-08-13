// supabase-auth-header.ts — Shared Supabase Bearer header provider.
//
// Extracted from image-api-client.ts so the image-api client AND the new
// storage-service client use ONE implementation (DRY). Returns the full
// `Authorization` value (`Bearer <jwt>`) or `undefined` to send NO header —
// never an empty string.

import { supabase } from './supabase';
import { createLogger } from '@/utils/logger';

const log = createLogger('API', 'SupabaseAuthHeader');

/** Bearer header from the active Supabase session; `undefined` when unauthenticated
 *  (share-preview / pre-login) or on lookup error (swallowed + warned). */
export async function getAuthHeader(): Promise<string | undefined> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      log.warn('getAuthHeader', 'session lookup failed', { error: error.message });
      return undefined;
    }
    const token = data.session?.access_token;
    return token ? `Bearer ${token}` : undefined;
  } catch (err) {
    log.warn('getAuthHeader', 'unexpected error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Force a token refresh then return the new Bearer header. Used to retry a 401
 *  once (e.g. token expired mid-upload). `undefined` when refresh fails. */
export async function refreshAuthHeader(): Promise<string | undefined> {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) {
      log.warn('refreshAuthHeader', 'refresh failed', { error: error.message });
      return undefined;
    }
    const token = data.session?.access_token;
    return token ? `Bearer ${token}` : undefined;
  } catch (err) {
    log.warn('refreshAuthHeader', 'unexpected error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
