// storage-service-client.ts — HTTP client for the self-hosted storage service
// (ADR-054). Replaces supabase-js `.storage.*` for FE writes/deletes.
//
// Only TWO routes are reachable from the browser (through nginx):
//   POST   /api/storage/uploads                      (Bearer user JWT, multipart)
//   DELETE /api/storage/objects/{bucket}/{key}       (Bearer user JWT)
// PUT/HEAD/sign are loopback-only S2S — never called here.
//
// Security: NEVER send X-API-Key (S2S key, loopback-only). NEVER set Content-Type
// on the multipart POST — the browser must generate the boundary itself.

import { createLogger } from '@/utils/logger';
import { STORAGE_BUCKET, storageServiceBaseUrl } from '@/constants/storage-constants';
import { getAuthHeader, refreshAuthHeader } from './supabase-auth-header';

const log = createLogger('API', 'StorageService');

// ── Runtime-configurable base URL seam (parity with image-api-client) ─────────
// Default reads env at call time; a setter lets tests / a future sub-app override.
let baseUrlOverride: string | null = null;

/** Override the storage-service base URL (tests / sub-app). */
export function setStorageServiceBaseUrl(url: string): void {
  log.info('setStorageServiceBaseUrl', 'base url overridden', { url });
  baseUrlOverride = url;
}

function baseUrl(): string {
  return baseUrlOverride ?? storageServiceBaseUrl();
}

export interface StorageObjectData {
  bucket: string;
  key: string;
  url: string;
  etag: string;
  bytes: number;
  deduped: boolean;
}

export type StorageServiceResult =
  | { success: true; data: StorageObjectData }
  | StorageServiceFailure;

export interface StorageServiceFailure {
  success: false;
  error: string; // human-readable (Vietnamese) message for the modal
  errorCode?: string; // VALIDATION_ERROR | PREFIX_NOT_ALLOWED | PAYLOAD_TOO_LARGE | ...
  httpStatus: number;
}

/** Map a service error envelope / HTTP status to a friendly Vietnamese message. */
function friendlyMessage(httpStatus: number, code: string | undefined, raw: string): string {
  switch (code) {
    case 'PAYLOAD_TOO_LARGE':
      return 'File quá lớn so với giới hạn máy chủ.';
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 'Định dạng file không được hỗ trợ.';
    case 'PREFIX_NOT_ALLOWED':
      return 'Không có quyền ghi vào thư mục này.';
    case 'INSUFFICIENT_STORAGE':
      return 'Máy chủ lưu trữ đã đầy — vui lòng thử lại sau.';
    default:
      if (httpStatus === 413) return 'File quá lớn so với giới hạn máy chủ.';
      if (httpStatus === 415) return 'Định dạng file không được hỗ trợ.';
      if (httpStatus === 403) return 'Không có quyền ghi vào thư mục này.';
      return raw || `Lỗi máy chủ (HTTP ${httpStatus}).`;
  }
}

async function parseFailure(response: Response): Promise<StorageServiceFailure> {
  let code: string | undefined;
  let raw = '';
  try {
    const body = await response.json();
    code = body?.error?.code;
    raw = body?.error?.message ?? '';
  } catch {
    // non-JSON body
  }
  const error = friendlyMessage(response.status, code, raw);
  log.error('parseFailure', 'upload failed', { httpStatus: response.status, errorCode: code });
  return { success: false, error, errorCode: code, httpStatus: response.status };
}

/** Build request headers: ONLY Authorization. No Content-Type (multipart boundary
 *  is browser-generated), no X-API-Key (S2S secret). */
async function buildHeaders(header?: string): Promise<Record<string, string>> {
  const authHeader = header ?? (await getAuthHeader());
  const headers: Record<string, string> = {};
  if (authHeader) headers['Authorization'] = authHeader;
  return headers;
}

export interface UploadObjectArgs {
  file: File | Blob;
  key: string;
  bucket?: string;
  contentType?: string;
}

/** Upload one object via multipart POST. Retries ONCE on 401 after a token
 *  refresh (upload uses upsert=true server-side ⇒ retry is idempotent). */
export async function uploadObject({
  file,
  key,
  bucket = STORAGE_BUCKET,
  contentType,
}: UploadObjectArgs): Promise<StorageServiceResult> {
  const url = `${baseUrl()}/api/storage/uploads`;
  const bytes = (file as File).size ?? (file as Blob).size;
  log.info('uploadObject', 'request', {
    key,
    bytes,
    contentType: contentType ?? (file as File).type,
  });

  // Server MIME validation reads the multipart part's Content-Type, which comes
  // from the Blob's `.type`. When the caller passed an explicit contentType that
  // differs (typeless .lottie/.riv blobs, recorded-audio blobs), re-wrap so the
  // service sees the intended type instead of an empty string.
  const partType = contentType ?? (file as File).type;
  const filename = key.split('/').pop() || 'upload';

  const doFetch = async (header?: string): Promise<Response> => {
    const form = new FormData();
    const part = partType && (file as Blob).type !== partType ? new Blob([file], { type: partType }) : file;
    form.append('file', part, filename);
    form.append('key', key);
    form.append('bucket', bucket);
    const headers = await buildHeaders(header);
    return fetch(url, { method: 'POST', headers, body: form });
  };

  try {
    let response = await doFetch();
    if (response.status === 401) {
      log.warn('uploadObject', '401 — refreshing token and retrying once', { key });
      const refreshed = await refreshAuthHeader();
      // Only retry when refresh actually yielded a token; otherwise the retry would
      // re-send the same expired token for a guaranteed second 401.
      if (refreshed) response = await doFetch(refreshed);
    }

    if (!response.ok) {
      return parseFailure(response);
    }

    const body = await response.json();
    const data = body?.data as StorageObjectData;
    log.info('uploadObject', 'done', { key: data?.key, deduped: data?.deduped });
    return { success: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('uploadObject', 'connection error', { key, error: message });
    return {
      success: false,
      error: `Không kết nối được máy chủ lưu trữ (${message}).`,
      errorCode: 'CONNECTION_ERROR',
      httpStatus: 0,
    };
  }
}

/** Delete a single object. Best-effort: always resolves, never throws. Returns
 *  whether the service reported `deleted: true`. */
export async function deleteObject(key: string, bucket: string = STORAGE_BUCKET): Promise<boolean> {
  const escapedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `${baseUrl()}/api/storage/objects/${bucket}/${escapedKey}`;
  try {
    const headers = await buildHeaders();
    const response = await fetch(url, { method: 'DELETE', headers });
    if (!response.ok) {
      log.warn('deleteObject', 'non-2xx', { key, httpStatus: response.status });
      return false;
    }
    const body = await response.json();
    const deleted = body?.data?.deleted === true;
    log.debug('deleteObject', 'done', { key, deleted });
    return deleted;
  } catch (err) {
    log.warn('deleteObject', 'connection error (swallowed)', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Delete many objects sequentially (service has no bulk endpoint). Best-effort.
 *  Returns true only when every delete reported success — parity with the
 *  boolean returned by the old `removeXxxFolder` helpers. */
export async function deleteObjects(keys: string[], bucket: string = STORAGE_BUCKET): Promise<boolean> {
  if (keys.length === 0) return true;
  log.info('deleteObjects', 'start', { count: keys.length });
  let allOk = true;
  for (const key of keys) {
    const ok = await deleteObject(key, bucket);
    if (!ok) allOk = false;
  }
  log.info('deleteObjects', 'done', { count: keys.length, allOk });
  return allOk;
}
