// human-api.ts — Supabase Storage helpers for human visual/voice profile uploads.
// Path layout: humans/{humanId}/{uuid}.{ext} in bucket 'storybook-assets'.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { STORAGE_BUCKET, isStorageServiceEnabled } from '@/constants/storage-constants';
import { uploadObject, deleteObjects } from '@/apis/storage-service-client';
import { pathFromStorageUrl, assertKeyGrammar } from '@/utils/storage-url';

const log = createLogger('API', 'HumanApi');

const HUMAN_PATH_PREFIX = (id: string) => `humans/${id}`;
// Storage-service branch prepends an `uploads/{type}/` root so FE writes stay off
// the S2S/BE tree; legacy Supabase branch keeps the bare `humans/...` prefix.
const HUMAN_IMAGE_SERVICE_KEY = (id: string, name: string) => `uploads/images/humans/${id}/${name}`;
const HUMAN_AUDIO_SERVICE_KEY = (id: string, name: string) => `uploads/audios/humans/${id}/${name}`;

const IMAGE_MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const AUDIO_MAX_SIZE = 20 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/x-m4a',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
];

export interface UploadHumanAssetResult {
  publicUrl: string;
  path: string;
}

function genUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Map MIME → file extension (image + audio). Fallback to last token of MIME. */
export function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  switch (lower) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/webm':
      return 'webm';
    default: {
      const tail = lower.split('/').pop() ?? 'bin';
      return tail.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'bin';
    }
  }
}

export async function uploadHumanImage(
  humanId: string,
  file: File,
): Promise<UploadHumanAssetResult> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`Unsupported image type: ${file.type}. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`);
  }
  if (file.size > IMAGE_MAX_SIZE) {
    throw new Error(
      `Image too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max ${IMAGE_MAX_SIZE / 1024 / 1024}MB`,
    );
  }

  const ext = extFromMime(file.type);
  const fileName = `${genUuid()}.${ext}`;

  if (isStorageServiceEnabled()) {
    const key = HUMAN_IMAGE_SERVICE_KEY(humanId, fileName);
    assertKeyGrammar(key);
    log.info('uploadHumanImage', 'uploading', { humanId, path: key, size: file.size, backend: 'service' });
    const result = await uploadObject({ file, key, bucket: STORAGE_BUCKET, contentType: file.type });
    if (!result.success) {
      log.error('uploadHumanImage', 'failed', { humanId, path: key, backend: 'service', errorCode: result.errorCode });
      throw new Error(result.error);
    }
    log.info('uploadHumanImage', 'done', { humanId, publicUrl: result.data.url, backend: 'service' });
    return { publicUrl: result.data.url, path: result.data.key };
  }

  const path = `${HUMAN_PATH_PREFIX(humanId)}/${fileName}`;
  log.info('uploadHumanImage', 'uploading', { humanId, path, size: file.size, backend: 'supabase' });

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) {
    log.error('uploadHumanImage', 'failed', { humanId, path, error: error.message });
    throw error;
  }

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(data.path);
  log.info('uploadHumanImage', 'done', { humanId, publicUrl: urlData.publicUrl });
  return { publicUrl: urlData.publicUrl, path: data.path };
}

export async function uploadHumanAudio(
  humanId: string,
  blob: Blob,
  mimeType?: string,
): Promise<UploadHumanAssetResult> {
  const effectiveMime = mimeType ?? blob.type ?? 'application/octet-stream';
  if (!ALLOWED_AUDIO_TYPES.includes(effectiveMime)) {
    log.warn('uploadHumanAudio', 'mime not in allowlist but proceeding', { effectiveMime });
  }
  if (blob.size > AUDIO_MAX_SIZE) {
    throw new Error(
      `Audio too large: ${(blob.size / 1024 / 1024).toFixed(1)}MB. Max ${AUDIO_MAX_SIZE / 1024 / 1024}MB`,
    );
  }

  const ext = extFromMime(effectiveMime);
  const fileName = `${genUuid()}.${ext}`;

  if (isStorageServiceEnabled()) {
    const key = HUMAN_AUDIO_SERVICE_KEY(humanId, fileName);
    assertKeyGrammar(key);
    log.info('uploadHumanAudio', 'uploading', { humanId, path: key, size: blob.size, mime: effectiveMime, backend: 'service' });
    const result = await uploadObject({ file: blob, key, bucket: STORAGE_BUCKET, contentType: effectiveMime });
    if (!result.success) {
      log.error('uploadHumanAudio', 'failed', { humanId, path: key, backend: 'service', errorCode: result.errorCode });
      throw new Error(result.error);
    }
    log.info('uploadHumanAudio', 'done', { humanId, publicUrl: result.data.url, backend: 'service' });
    return { publicUrl: result.data.url, path: result.data.key };
  }

  const path = `${HUMAN_PATH_PREFIX(humanId)}/${fileName}`;
  log.info('uploadHumanAudio', 'uploading', { humanId, path, size: blob.size, mime: effectiveMime, backend: 'supabase' });

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, blob, { contentType: effectiveMime, upsert: false });

  if (error) {
    log.error('uploadHumanAudio', 'failed', { humanId, path, error: error.message });
    throw error;
  }

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(data.path);
  log.info('uploadHumanAudio', 'done', { humanId, publicUrl: urlData.publicUrl });
  return { publicUrl: urlData.publicUrl, path: data.path };
}

// NOTE: `removeHumanStorageFolder` (list+remove by prefix) was removed in the
// ADR-054 cutover — the storage service has NO list endpoint. Deletion now works
// off the URLs stored on the human row (see `removeHumanStorageObjectsByUrls`).
// Trade-off: orphaned objects from a prior failed compensation are no longer
// swept here; that is an ops-side periodic sweep concern (storage is cheap).

/** Bulk remove specific objects by KEY (compensation cleanup). Best-effort,
 *  swallows errors. Routes to storage service or Supabase per env presence. */
export async function removeHumanStorageObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  log.info('removeHumanStorageObjects', 'start', { count: paths.length });
  if (isStorageServiceEnabled()) {
    await deleteObjects(paths, STORAGE_BUCKET);
    log.info('removeHumanStorageObjects', 'done', { count: paths.length, backend: 'service' });
    return;
  }
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
  if (error) {
    log.warn('removeHumanStorageObjects', 'failed', { count: paths.length, error: error.message });
    return;
  }
  log.info('removeHumanStorageObjects', 'done', { count: paths.length, backend: 'supabase' });
}

/** Remove all storage objects referenced by a human row's URLs (visual + voice
 *  profiles). Parses each URL → key (dual-shape), skips unparseable ones. */
export async function removeHumanStorageObjectsByUrls(urls: Array<string | null | undefined>): Promise<void> {
  const keys: string[] = [];
  let skipped = 0;
  for (const url of urls) {
    const key = pathFromStorageUrl(url);
    if (key) keys.push(key);
    else if (url) skipped += 1;
  }
  if (skipped > 0) {
    log.warn('removeHumanStorageObjectsByUrls', 'some urls unparseable; skipped', { skipped });
  }
  await removeHumanStorageObjects(keys);
}
