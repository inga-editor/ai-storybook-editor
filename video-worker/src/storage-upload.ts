// video-worker/src/storage-upload.ts
// The worker's ONLY storage seam (design 02 §2b/§2c, 06 §6.1; ADR-054): stream a
// finished book artifact (qhd master or fhd/hd/sd downscale) to the self-hosted
// storage-service via S2S PUT. The service serves it publicly through nginx.
//
// The worker NEVER deletes storage objects — stale-key cleanup is job-side
// (python-api) best-effort. This module only PUTs and reads back the public URL.
//
// PUT contract (storage-service 03-http-api.md §2):
//   PUT {STORAGE_SERVICE_URL}/api/storage/objects/{bucket}/{key}?upsert=false
//     headers: X-API-Key, Content-Type: video/mp4, Content-Length
//     body: raw bytes (STREAMED — MP4 can be GBs, never buffered)
//     201 (new) | 200 (upsert) → {"success":true,"data":{bucket,key,url,...}}
//     409 ALREADY_EXISTS (upsert=false on existing key) → re-PUT with upsert=true
//
// Retry (client-owned, parity image-api `_upload_with_retry`): 3 attempts total,
// backoff 2s/4s, retry on transport error + 5xx; upsert=false on attempt 1,
// upsert=true on attempts ≥2 (a retried PUT may have landed — ts+uuid file names
// make collision ≈0). 401/413/415 → fail fast (no retry).

import { stat, createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";

import {
  STORAGE_SERVICE_URL,
  STORAGE_SERVICE_API_KEY,
  STORAGE_BUCKET,
  tierOutDir,
} from "./paths.js";
import type { TranscodeOutput } from "./transcode.js";

const fsStat = promisify(stat);

const MAX_ATTEMPTS = 3;
/** Backoff before attempt 2, 3 (index = attempt-2). */
const BACKOFF_MS = [2000, 4000];

/** Raised when the storage PUT fails after retries or hits a non-retryable 4xx.
 *  `code = "UPLOAD_FAILED"` → 502 via the errors.ts status map (duck-typed by
 *  `isUploadError`, no import cycle). */
export class StorageUploadError extends Error {
  readonly code = "UPLOAD_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "StorageUploadError";
  }
}

export interface PutBookArtifactParams {
  /** Resolution tier — becomes a key segment (`qhd` | `fhd` | `hd` | `sd`). */
  tier: string;
  /** Book id — key segment `videos/books/{bookId}/...`. */
  bookId: string;
  /** Object file name (last key segment). */
  fileName: string;
  /** Absolute local path of the file to stream. */
  filePath: string;
  /** Force `upsert=true` from the first attempt (transcode outputs have stable
   *  names → re-transcode must overwrite). Default false (render-book master). */
  upsertFirst?: boolean;
}

export interface PutBookArtifactResult {
  /** Public URL from the service (`data.url`) — the ONE source of truth. */
  url: string;
  /** The key we wrote: `videos/books/{bookId}/{tier}/{fileName}`. */
  storageKey: string;
}

/** True when `STORAGE_SERVICE_URL` is configured. Callers combine with `bookId`
 *  presence for the env-presence switch (unset → legacy local-fallback). */
export function isStorageConfigured(): boolean {
  return STORAGE_SERVICE_URL.length > 0;
}

function objectUrl(bucket: string, key: string): string {
  const base = STORAGE_SERVICE_URL.replace(/\/+$/, "");
  const qBucket = encodeURIComponent(bucket);
  const qKey = key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `${base}/api/storage/objects/${qBucket}/${qKey}`;
}

async function parseServiceUrl(resp: Response): Promise<string | null> {
  try {
    const body = (await resp.json()) as { data?: { url?: unknown } };
    const url = body?.data?.url;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

async function parseError(resp: Response): Promise<{ code: string; message: string }> {
  let code = "HTTP_ERROR";
  let message = resp.statusText || "";
  try {
    const body = (await resp.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* non-JSON error body */
  }
  return { code, message };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stream `filePath` → storage-service; return the public URL + the key written.
 *  Throws `StorageUploadError` on exhausted retries or a non-retryable 4xx. */
export async function putBookArtifact(
  params: PutBookArtifactParams,
): Promise<PutBookArtifactResult> {
  const { tier, bookId, fileName, filePath, upsertFirst = false } = params;
  const storageKey = `videos/books/${bookId}/${tier}/${fileName}`;
  const url = objectUrl(STORAGE_BUCKET, storageKey);
  const size = (await fsStat(filePath)).size;

  let lastErr: unknown;
  let forceUpsert = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const upsert = upsertFirst || forceUpsert || attempt > 1;
    // Fresh stream each attempt (web streams are single-use).
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    let resp: Response;
    try {
      console.log(`[storage] PUT ${storageKey} attempt=${attempt} upsert=${upsert}`);
      resp = await fetch(`${url}?upsert=${upsert}`, {
        method: "PUT",
        headers: {
          "X-API-Key": STORAGE_SERVICE_API_KEY,
          "Content-Type": "video/mp4",
          "Content-Length": String(size),
        },
        body,
        // Node fetch requires duplex for a streaming request body.
        duplex: "half",
      });
    } catch (transportErr) {
      lastErr = transportErr;
      console.log(`[storage] PUT ${storageKey} attempt=${attempt} transport-error`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1]);
        continue;
      }
      break;
    }

    if (resp.ok) {
      const serviceUrl = await parseServiceUrl(resp);
      if (!serviceUrl) {
        throw new StorageUploadError(`storage PUT ok but response missing data.url (key=${storageKey})`);
      }
      console.log(`[storage] PUT ${storageKey} done status=${resp.status}`);
      return { url: serviceUrl, storageKey };
    }

    if (resp.status === 409 && !upsert) {
      // Key already exists from a prior (retried) PUT — re-PUT immediately with upsert.
      forceUpsert = true;
      console.log(`[storage] PUT ${storageKey} attempt=${attempt} 409 ALREADY_EXISTS → re-PUT upsert`);
      continue;
    }

    const { code, message } = await parseError(resp);
    if (resp.status >= 500) {
      lastErr = new Error(`storage PUT ${resp.status} ${code}: ${message}`);
      console.log(`[storage] PUT ${storageKey} attempt=${attempt} ${resp.status} ${code}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1]);
        continue;
      }
      break;
    }

    // Non-retryable 4xx (401/413/415/…) → fail fast.
    throw new StorageUploadError(`storage PUT ${resp.status} ${code}: ${message} (key=${storageKey})`);
  }

  throw new StorageUploadError(
    `storage PUT failed after ${MAX_ATTEMPTS} attempts (key=${storageKey}): ${String(lastErr)}`,
  );
}

/** PUT every transcode output to storage sequentially (design 08 §2, all-or-nothing):
 *  each success rewrites `url` → storage URL, attaches `storageKey`, and unlinks the
 *  local `out/{res}` scratch file. Outputs use stable `{base}-{res}.mp4` names →
 *  `upsertFirst` so a re-transcode overwrites. A failure propagates (StorageUploadError)
 *  after already-PUT outputs remain as harmless idempotent orphans; the caller maps to
 *  502 for the whole call. Sequential keeps memory flat + failure attribution simple. */
export async function uploadTranscodeOutputs(
  bookId: string,
  outputs: readonly TranscodeOutput[],
): Promise<TranscodeOutput[]> {
  const result: TranscodeOutput[] = [];
  for (const out of outputs) {
    const localPath = path.join(tierOutDir(out.resolution), out.fileName);
    const put = await putBookArtifact({
      tier: out.resolution,
      bookId,
      fileName: out.fileName,
      filePath: localPath,
      upsertFirst: true,
    });
    result.push({ ...out, url: put.url, storageKey: put.storageKey });
    await unlink(localPath).catch(() => undefined);
  }
  return result;
}
