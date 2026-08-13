import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { STORAGE_BUCKET, isStorageServiceEnabled } from '@/constants/storage-constants';
import { deleteObjects } from '@/apis/storage-service-client';
import type { AudioResource, AudioTableName } from '../types';
import { parseStoragePathFromUrl } from './audio-storage-path-parser';

const log = createLogger('AudioLibrary', 'DeleteAudioRowAndCleanup');

export interface DeleteAudioRowAndCleanupOptions {
  tableName: AudioTableName;
  pathPrefixes: string[];
  item: AudioResource;
}

export interface DeleteAudioRowAndCleanupResult {
  ok: boolean;
  error?: string;
}

/**
 * Delete the DB row first; on success, best-effort Storage cleanup with a
 * ref-count check (skip removal if any other row still references the same
 * media URL — important for music generate which uses SHA256-keyed paths).
 */
export async function deleteAudioRowAndCleanup({
  tableName,
  pathPrefixes,
  item,
}: DeleteAudioRowAndCleanupOptions): Promise<DeleteAudioRowAndCleanupResult> {
  log.info('deleteAudioRowAndCleanup', 'start', { id: item.id, tableName });

  const { error: dbErr } = await supabase.from(tableName).delete().eq('id', item.id);
  if (dbErr) {
    log.error('deleteAudioRowAndCleanup', 'db delete failed', {
      id: item.id,
      pgCode: dbErr.code,
      pgMessage: dbErr.message?.slice(0, 120),
    });
    return { ok: false, error: dbErr.message ?? 'Delete failed' };
  }

  const path = parseStoragePathFromUrl(item.mediaUrl, pathPrefixes);
  if (!path) {
    log.warn('deleteAudioRowAndCleanup', 'cannot parse storage path; skip cleanup', {
      url: (item.mediaUrl ?? '').slice(0, 60),
    });
    return { ok: true };
  }

  // Ref-count check: any other row referencing the same media URL?
  const { count, error: countErr } = await supabase
    .from(tableName)
    .select('id', { count: 'exact', head: true })
    .eq('media_url', item.mediaUrl);

  if (countErr) {
    log.warn('deleteAudioRowAndCleanup', 'ref-count query failed; skip cleanup', {
      pgCode: countErr.code,
      pgMessage: countErr.message?.slice(0, 120),
    });
    return { ok: true };
  }

  if ((count ?? 0) > 0) {
    log.debug('deleteAudioRowAndCleanup', 'other rows reference url; skip cleanup', {
      count,
    });
    return { ok: true };
  }

  if (isStorageServiceEnabled()) {
    await deleteObjects([path], STORAGE_BUCKET);
    log.debug('deleteAudioRowAndCleanup', 'storage cleanup done', { path, backend: 'service' });
    return { ok: true };
  }

  const { error: rmErr } = await supabase.storage.from(STORAGE_BUCKET).remove([path]);
  if (rmErr) {
    log.warn('deleteAudioRowAndCleanup', 'storage cleanup failed', {
      path,
      err: rmErr.message,
    });
  } else {
    log.debug('deleteAudioRowAndCleanup', 'storage cleanup ok', { path });
  }
  return { ok: true };
}
