// video-worker/src/errors.ts
// Coarse error classification → HTTP status + stable code for the /render handler.
// Keeps upstream stack traces out of client responses while preserving a debuggable code.
//
// BGM degrade (SSRF block / fetch fail / over-cap) is NOT a client error — it is
// handled internally in render-book.ts, logged, and surfaced as `warnings[]` in the
// 200 response. No error code here for it.

export type RenderErrorCode =
  | "BUNDLE_FAILED"
  | "COMPOSITION_NOT_FOUND"
  | "RENDER_TIMEOUT"
  | "RENDER_FAILED"
  // /render-book specific:
  | "INVALID_INPUT"    // 400 — missing/wrong illustration or edition
  | "EMPTY_SEQUENCE"   // 422 — walker resolved 0 spreads
  | "BOOK_TOO_LARGE"   // 413 — sequence.length > MAX_BOOK_SPREADS (data guard)
  | "BUSY"             // 429 — in-flight guard (shared with /render)
  // /transcode specific (design 08 §5):
  | "SOURCE_NOT_FOUND"     // 404 — sourceFileName not in OUT_DIR
  | "SOURCE_FETCH_FAILED"  // 502 — sourceUrl fetch fail / SSRF-block / over-cap
  | "TRANSCODE_TIMEOUT"    // 504 — ffmpeg exceeded TRANSCODE_TIMEOUT_MS
  | "TRANSCODE_FAILED"     // 500 — ffmpeg/ffprobe other error
  // storage-service upload (design 02 §3 — /render-book + /transcode):
  | "UPLOAD_FAILED";       // 502 — storage-service PUT failed after retries

export interface ClassifiedError {
  code: RenderErrorCode;
  status: number;
  message: string;
}

/** Status map for error codes raised directly by handlers (no substring match needed). */
export const ERROR_STATUS: Record<RenderErrorCode, number> = {
  INVALID_INPUT: 400,
  EMPTY_SEQUENCE: 422,
  BOOK_TOO_LARGE: 413,
  BUSY: 429,
  RENDER_TIMEOUT: 504,
  COMPOSITION_NOT_FOUND: 404,
  BUNDLE_FAILED: 500,
  RENDER_FAILED: 500,
  SOURCE_NOT_FOUND: 404,
  SOURCE_FETCH_FAILED: 502,
  TRANSCODE_TIMEOUT: 504,
  TRANSCODE_FAILED: 500,
  UPLOAD_FAILED: 502,
};

/** True when `err` is a storage-upload failure (StorageUploadError, code
 *  UPLOAD_FAILED). Duck-typed on the `code` field to avoid a circular import
 *  with storage-upload.ts — never message-matched (this is a worker-owned type). */
export function isUploadError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === "UPLOAD_FAILED"
  );
}

export function classifyRenderError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { code: "RENDER_TIMEOUT", status: 504, message };
  }
  if (lower.includes("no composition") || lower.includes("not found")) {
    return { code: "COMPOSITION_NOT_FOUND", status: 404, message };
  }
  if (lower.includes("bundle") || lower.includes("webpack")) {
    return { code: "BUNDLE_FAILED", status: 500, message };
  }
  return { code: "RENDER_FAILED", status: 500, message };
}

/** Sentinel thrown by transcodeDownscale when ffmpeg exceeds the timeout. The
 *  message carries "timeout" so callers reusing classifyRenderError also map it. */
export class TranscodeTimeoutError extends Error {
  constructor(message = "transcode timed out") {
    super(message);
    this.name = "TranscodeTimeoutError";
  }
}

/** Classify a /transcode-path error → status + stable code. Distinct from
 *  classifyRenderError: a generic ffmpeg failure here is TRANSCODE_FAILED, not
 *  RENDER_FAILED. SOURCE_NOT_FOUND / SOURCE_FETCH_FAILED are raised explicitly by
 *  the handler (not substring-matched) and pass through unchanged. */
export function classifyTranscodeError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (err instanceof TranscodeTimeoutError || lower.includes("timeout") || lower.includes("timed out")) {
    return { code: "TRANSCODE_TIMEOUT", status: 504, message };
  }
  return { code: "TRANSCODE_FAILED", status: 500, message };
}
