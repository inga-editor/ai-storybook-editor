import { createLogger } from '@/utils/logger';
import type { WordTiming } from '@/types/spread-types';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

// ─────────────────────────────────────────────────────────────────────────────
// combine-audio-chunks API client
// Spec: ai-storybook-design/api/text-generation/03-combine-audio-chunks.md
// Stack: FastAPI — ai-storybook-image-api/src/routers/text/combine_audio_chunks.py
// Pattern mirrors src/apis/narrate-script-api.ts (X-API-Key, AbortController + 90s timeout,
// error code map). Stateless server: FE resolves chunks[].results[is_selected] then calls.
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger('CombineAudioChunksApi', 'Client');

const imageApiBaseUrl = import.meta.env.VITE_IMAGE_API_BASE_URL as string;
const imageApiKey = import.meta.env.VITE_IMAGE_API_KEY as string;

const COMBINE_PATH = '/api/text/combine-audio-chunks';
const COMBINE_TIMEOUT_MS = 90_000;
const MIN_CHUNKS = 2;
const MAX_CHUNKS = 50;

// ───────────────────────── request / response types ─────────────────────────

export interface CombineAudioChunkInput {
  /** Public Supabase Storage URL of the per-chunk audio (verbatim from narrate-script). */
  audioUrl: string;
  /** Plain-text script of this chunk (no `@voice_id:` prefix). */
  script: string;
  /** Per-word timings from narrate-script — server rebases against joined script. */
  wordTimings: WordTiming[];
}

export type CombineAudioChunksOutputFormat =
  | 'mp3_44100_128'
  | 'mp3_44100_192';

export interface CombineAudioChunksRequest {
  /** Ordered chunks (2..50). FE must shortcut client-side when length < 2. */
  chunks: CombineAudioChunkInput[];
  /** Defaults to '\n' on server; must be length === 1 if provided. */
  scriptSeparator?: string;
  /** Defaults to 'mp3_44100_128' on server. */
  outputFormat?: CombineAudioChunksOutputFormat;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface CombineAudioChunksMeta {
  processingTimeMs?: number;
  downloadMs?: number;
  encodeMs?: number;
  uploadMs?: number;
  fastPath?: boolean;
  reencodeReason?: 'format_mismatch' | 'codec_mismatch';
  pathKey?: string;
  chunkCount?: number;
  totalInputSizeBytes?: number;
}

export interface CombineAudioChunksSuccess {
  success: true;
  data: {
    audioUrl: string;
    durationMs: number;
    /** Rollup word timings — rebased to combined timeline + joined script offsets. */
    words: WordTiming[];
    /** Start offset (ms) of each chunk in the combined timeline; length === chunks.length. */
    chunkOffsetsMs: number[];
    /** chunks.map(c => c.script).join(scriptSeparator) — server echo for FE verify. */
    joinedScript: string;
  } & SaveResourceOutcomeFields;
  meta?: CombineAudioChunksMeta;
}

export type CombineAudioChunksErrorCode =
  | 'VALIDATION_ERROR'
  | 'INSUFFICIENT_CHUNKS'
  | 'SCRIPT_TOO_LONG'
  | 'WORD_TIMING_INVALID'
  | 'INVALID_API_KEY'
  | 'CHUNK_FETCH_FAILED'
  | 'CHUNK_FETCH_FORBIDDEN'
  | 'AUDIO_DECODE_ERROR'
  | 'FFMPEG_ERROR'
  | 'STORAGE_UPLOAD_ERROR'
  | 'TIMEOUT'
  | 'CONNECTION_ERROR'
  | 'ABORT'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN';

export interface CombineAudioChunksFailure {
  success: false;
  error: string;
  httpStatus: number;
  errorCode: CombineAudioChunksErrorCode;
  /** Optional server detail payload (e.g. `{ failedChunkIndex: 2, status: 404 }`). */
  details?: unknown;
}

export type CombineAudioChunksResult =
  | CombineAudioChunksSuccess
  | CombineAudioChunksFailure;

export interface CombineAudioChunksCallOptions {
  signal?: AbortSignal;
}

// ───────────────────────── helpers ─────────────────────────

function failure(
  errorCode: CombineAudioChunksErrorCode,
  error: string,
  httpStatus = 0,
  details?: unknown,
): CombineAudioChunksFailure {
  return { success: false, error, httpStatus, errorCode, details };
}

function mapErrorCode(
  code: string | undefined,
): CombineAudioChunksErrorCode {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'INSUFFICIENT_CHUNKS':
    case 'SCRIPT_TOO_LONG':
    case 'WORD_TIMING_INVALID':
    case 'INVALID_API_KEY':
    case 'CHUNK_FETCH_FAILED':
    case 'CHUNK_FETCH_FORBIDDEN':
    case 'AUDIO_DECODE_ERROR':
    case 'FFMPEG_ERROR':
    case 'STORAGE_UPLOAD_ERROR':
    case 'TIMEOUT':
    case 'INTERNAL_ERROR':
      return code;
    default:
      return 'UNKNOWN';
  }
}

async function extractErrorInfo(
  response: Response,
): Promise<{ message: string; errorCode?: string; details?: unknown }> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    const detailError =
      typeof detail === 'object' && detail !== null ? detail.error : undefined;

    const errorCode: string | undefined =
      (typeof detailError === 'object' && detailError !== null
        ? detailError.code
        : undefined) ??
      (typeof body?.error === 'object' && body.error !== null
        ? body.error.code
        : undefined);

    const details: unknown =
      (typeof detailError === 'object' && detailError !== null
        ? detailError.details
        : undefined) ??
      (typeof body?.error === 'object' && body.error !== null
        ? body.error.details
        : undefined);

    const message: string =
      (typeof detailError === 'object' &&
      detailError !== null &&
      typeof detailError.message === 'string'
        ? detailError.message
        : null) ??
      (typeof detail === 'string' ? detail : null) ??
      (typeof body?.error === 'object' && body.error !== null
        ? (body.error.message ?? JSON.stringify(body.error))
        : null) ??
      (typeof body?.error === 'string' ? body.error : null) ??
      body?.message ??
      `HTTP ${response.status}`;

    return { message: String(message), errorCode, details };
  } catch {
    return { message: `HTTP ${response.status} ${response.statusText}` };
  }
}

// ───────────────────────── callCombineAudioChunks ─────────────────────────

export async function callCombineAudioChunks(
  params: CombineAudioChunksRequest,
  options?: CombineAudioChunksCallOptions,
): Promise<CombineAudioChunksResult> {
  // Client-side defensive checks — server enforces full rules.
  if (!Array.isArray(params.chunks) || params.chunks.length < MIN_CHUNKS) {
    return failure(
      'INSUFFICIENT_CHUNKS',
      `Cần ít nhất ${MIN_CHUNKS} chunks để combine (FE phải shortcut khi chỉ có 1 chunk).`,
    );
  }
  if (params.chunks.length > MAX_CHUNKS) {
    return failure(
      'VALIDATION_ERROR',
      `Số chunks vượt quá giới hạn ${MAX_CHUNKS}.`,
    );
  }
  if (
    params.scriptSeparator !== undefined &&
    params.scriptSeparator.length !== 1
  ) {
    return failure(
      'VALIDATION_ERROR',
      'scriptSeparator phải là 1 ký tự đơn.',
    );
  }

  const url = `${imageApiBaseUrl}${COMBINE_PATH}`;

  // INFO log: count + total script chars only — no joined script content (spec §Security).
  const totalScriptChars = params.chunks.reduce(
    (sum, c) => sum + (c.script?.length ?? 0),
    0,
  );
  const totalWordTimings = params.chunks.reduce(
    (sum, c) => sum + (Array.isArray(c.wordTimings) ? c.wordTimings.length : 0),
    0,
  );
  log.info('callCombineAudioChunks', 'start', {
    chunkCount: params.chunks.length,
    totalScriptChars,
    totalWordTimings,
    outputFormat: params.outputFormat,
  });
  // DEBUG: ≤100 char preview of joined script (no PII in INFO).
  log.debug('callCombineAudioChunks', 'joined script preview', {
    preview: params.chunks
      .map((c) => c.script ?? '')
      .join(params.scriptSeparator ?? '\n')
      .slice(0, 100),
  });

  // Link caller-abort with internal 90s timeout controller.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options?.signal) {
    if (options.signal.aborted) {
      return failure('ABORT', 'Request aborted', 0);
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timeoutId = setTimeout(
    () => controller.abort(),
    COMBINE_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': imageApiKey,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    if (options?.signal?.aborted) {
      return failure('ABORT', 'Request aborted', 0);
    }

    if (!response.ok) {
      const { message, errorCode, details } = await extractErrorInfo(response);
      log.error('callCombineAudioChunks', 'http error', {
        httpStatus: response.status,
        errorCode,
      });
      return {
        success: false,
        error: message,
        httpStatus: response.status,
        errorCode: mapErrorCode(errorCode),
        details,
      };
    }

    const body = (await response.json()) as {
      success?: boolean;
      data?: CombineAudioChunksSuccess['data'];
      meta?: CombineAudioChunksMeta;
      error?:
        | string
        | { code?: string; message?: string; details?: unknown };
    };

    if (body.success === false) {
      const errMsg =
        typeof body.error === 'string'
          ? body.error
          : body.error?.message ?? 'Server returned success=false';
      const errCodeRaw =
        typeof body.error === 'object' ? body.error?.code : undefined;
      const errDetails =
        typeof body.error === 'object' ? body.error?.details : undefined;
      log.error('callCombineAudioChunks', 'server returned success=false', {
        errorCode: errCodeRaw,
      });
      return failure(
        mapErrorCode(errCodeRaw),
        errMsg,
        response.status,
        errDetails,
      );
    }

    const data = body.data;
    if (!data || typeof data.audioUrl !== 'string' || !data.audioUrl) {
      log.error('callCombineAudioChunks', 'malformed response', {
        hasData: Boolean(data),
      });
      return failure('UNKNOWN', 'Response thiếu audioUrl', response.status);
    }

    log.info('callCombineAudioChunks', 'success', {
      durationMs: data.durationMs,
      wordCount: Array.isArray(data.words) ? data.words.length : 0,
      chunkCount: Array.isArray(data.chunkOffsetsMs)
        ? data.chunkOffsetsMs.length
        : 0,
      processingTimeMs: body.meta?.processingTimeMs,
      fastPath: body.meta?.fastPath,
      pathKey: body.meta?.pathKey,
    });

    const result: CombineAudioChunksResult = { success: true, data, meta: body.meta };
    warnIfSaveResourceFailed(log.warn, 'callCombineAudioChunks', result);
    return result;
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (options?.signal?.aborted) {
      log.info('callCombineAudioChunks', 'aborted by caller');
      return failure('ABORT', 'Request aborted', 0);
    }
    if (name === 'AbortError') {
      log.warn('callCombineAudioChunks', 'timeout', {
        timeoutMs: COMBINE_TIMEOUT_MS,
      });
      return failure('TIMEOUT', 'Quá thời gian xử lý (90s)', 0);
    }
    const rawMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof TypeError) {
      log.error('callCombineAudioChunks', 'connection error', {
        msg: rawMessage.slice(0, 100),
      });
      return failure(
        'CONNECTION_ERROR',
        `Không kết nối được máy chủ (${rawMessage}).`,
        0,
      );
    }
    log.error('callCombineAudioChunks', 'unknown error', {
      name,
      msg: rawMessage.slice(0, 100),
    });
    return failure('UNKNOWN', rawMessage || 'Unknown error', 0);
  } finally {
    clearTimeout(timeoutId);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
