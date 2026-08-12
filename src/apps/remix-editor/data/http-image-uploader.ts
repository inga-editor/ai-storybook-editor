// http-image-uploader.ts — `ImageUploader` seam impl for the sub-app: uploads a
// File to the swap-service `POST /api/editor/assets`. The sub-app has NO
// supabase-js, so the editor's direct-to-Storage path is replaced by this proxy.
//
// Transport = JSON base64 (matches the BE `UploadAssetParams` model). The BE model
// is `extra="forbid"` and generates the storage path 100% server-side, so we send
// ONLY `imageBase64` — NEVER a `storagePath` (a spurious key would 400 the whole
// request).
//
// SECURITY: never log the base64 payload — only { bytes, contentType }.

import { createLogger } from '@/utils/logger';
import type { ImageUploader, UploadResult } from '@/apis/storage-api';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';
import { callEditorApi } from './editor-service-client';

const log = createLogger('API', 'SwapService');

/** Base64-encode an ArrayBuffer in 32KB chunks. `btoa(String.fromCharCode(...all))`
 *  spreads the whole byte array onto the call stack and overflows for large images;
 *  chunking keeps each `fromCharCode` argument list small. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32768 bytes / fromCharCode call
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** `data` payload of POST /api/editor/assets (editor envelope). */
interface UploadAssetData {
  url: string;
  storagePath: string;
  contentType: string;
  bytes: number;
}

/** Build the HTTP image uploader bound to the sub-app's `authorizedFetch`. The
 *  `pathPrefix` arg of the `ImageUploader` contract is ignored — the service
 *  owns path generation. */
export function createHttpImageUploader(authorizedFetch: AuthorizedFetch): ImageUploader {
  return async function httpImageUploader(file: File): Promise<UploadResult> {
    log.info('httpImageUploader', 'upload', { bytes: file.size, contentType: file.type });

    const imageBase64 = arrayBufferToBase64(await file.arrayBuffer());
    const data = await callEditorApi<UploadAssetData>({
      authorizedFetch,
      method: 'POST',
      path: '/api/editor/assets',
      body: { imageBase64 }, // storagePath is server-generated — never sent (extra=forbid)
    });

    log.info('httpImageUploader', 'done', { bytes: data.bytes, contentType: data.contentType });
    return { publicUrl: data.url, path: data.storagePath };
  };
}
