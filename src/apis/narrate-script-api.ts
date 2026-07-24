import { createLogger } from '@/utils/logger';
import type { RawAlignment } from '@/types/spread-types';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

// ─────────────────────────────────────────────────────────────────────────────
// narrate-script API client
// Spec: ai-storybook-design/api/text-generation/02-narrate-script.md
// Stack: FastAPI — ai-storybook-image-api/src/routers/text/narrate_script.py
// Pattern mirrors src/apis/voice-api.ts (X-API-Key, env flags, error mapping).
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger('NarrateApi', 'Client');

const imageApiBaseUrl = import.meta.env.VITE_IMAGE_API_BASE_URL as string;
const imageApiKey = import.meta.env.VITE_IMAGE_API_KEY as string;

const NARRATE_PATH = '/api/text/narrate-script';
const TIMEOUT_MS = 60_000;

// ───────────────────────── request / response types ─────────────────────────

export interface NarrateScriptSettings {
  stability?: number; // 0..1
  similarityBoost?: number; // 0..1
  style?: number; // 0..1
  speed?: number; // 0.7..1.2
  seed?: number; // uint32
}

export type NarrateScriptOutputFormat =
  | 'mp3_44100_128'
  | 'mp3_44100_192'
  | 'mp3_22050_32'
  | 'pcm_44100'
  | 'pcm_16000';

export interface NarrateScriptRequest {
  script: string;
  modelId: 'eleven_v3';
  settings?: NarrateScriptSettings;
  outputFormat?: NarrateScriptOutputFormat;
  /** Spread-narration context → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Voice-config preview context → ai_service_logs.book_id (book-level, not snapshot-bound). */
  bookId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface NarrationWordTiming {
  text: string;
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
}

export interface NarrateScriptMeta {
  processingTimeMs?: number;
  elevenCallMs?: number;
  uploadMs?: number;
  modelId?: 'eleven_v3';
  pathKey?: string;
  charCount?: number;
  costEstimate?: number;
  alignmentFallback?: boolean;
}

export interface NarrateScriptSuccess {
  success: true;
  data: {
    audioUrl: string;
    durationMs: number;
    voiceId: string;
    text: string;
    words: NarrationWordTiming[];
    /** Raw ElevenLabs alignment — persisted verbatim per chunk result. */
    rawAlignment: RawAlignment;
  } & SaveResourceOutcomeFields;
  meta?: NarrateScriptMeta;
}

export type NarrateScriptErrorCode =
  | 'VALIDATION_ERROR'
  | 'SCRIPT_PARSE_ERROR'
  | 'SCRIPT_TOO_LONG'
  | 'MULTI_TURN_NOT_SUPPORTED'
  | 'INVALID_VOICE_ID'
  | 'INVALID_API_KEY'
  | 'ELEVEN_VOICE_NOT_FOUND'
  | 'ELEVEN_CONTENT_REJECTED'
  | 'ELEVEN_RATE_LIMITED'
  | 'ELEVEN_UPSTREAM_ERROR'
  | 'ELEVEN_AUTH_FAILED'
  | 'STORAGE_UPLOAD_ERROR'
  | 'TIMEOUT'
  | 'CONNECTION_ERROR'
  | 'ABORT'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN';

export interface NarrateScriptFailure {
  success: false;
  error: string;
  httpStatus: number;
  errorCode: NarrateScriptErrorCode;
}

export type NarrateScriptResult = NarrateScriptSuccess | NarrateScriptFailure;

export interface NarrateScriptCallOptions {
  signal?: AbortSignal;
}

// ───────────────────────── helpers ─────────────────────────

function failure(
  errorCode: NarrateScriptErrorCode,
  error: string,
  httpStatus = 0,
): NarrateScriptFailure {
  return { success: false, error, httpStatus, errorCode };
}

function mapErrorCode(code: string | undefined): NarrateScriptErrorCode {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'SCRIPT_PARSE_ERROR':
    case 'SCRIPT_TOO_LONG':
    case 'MULTI_TURN_NOT_SUPPORTED':
    case 'INVALID_VOICE_ID':
    case 'INVALID_API_KEY':
    case 'ELEVEN_VOICE_NOT_FOUND':
    case 'ELEVEN_CONTENT_REJECTED':
    case 'ELEVEN_RATE_LIMITED':
    case 'ELEVEN_UPSTREAM_ERROR':
    case 'ELEVEN_AUTH_FAILED':
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
): Promise<{ message: string; errorCode?: string }> {
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

    return { message: String(message), errorCode };
  } catch {
    return { message: `HTTP ${response.status} ${response.statusText}` };
  }
}

// ───────────────────────── callNarrateScript ─────────────────────────

export async function callNarrateScript(
  params: NarrateScriptRequest,
  options?: NarrateScriptCallOptions,
): Promise<NarrateScriptResult> {
  // Minimal local validation — server enforces full rules.
  const trimmed = (params.script ?? '').trim();
  if (!trimmed) {
    return failure('VALIDATION_ERROR', 'Script rỗng');
  }
  // Note: server cap is 3000 chars (per spec). Keep client cap aligned to avoid
  // false UX rejection when chunk-script-textarea + validate-chunk allow 3000.
  if (trimmed.length > 3000) {
    return failure('SCRIPT_TOO_LONG', 'Script vượt quá 3000 ký tự');
  }
  if (params.modelId !== 'eleven_v3') {
    return failure('VALIDATION_ERROR', 'modelId phải là eleven_v3');
  }

  const url = `${imageApiBaseUrl}${NARRATE_PATH}`;

  // INFO log: no script content — only length + turn count + modelId (spec §Security).
  const turnCount = (trimmed.match(/^@[A-Za-z0-9_-]{10,40}:/gm) ?? []).length;
  log.info('callNarrateScript', 'start', {
    scriptLength: trimmed.length,
    turnCount,
    modelId: params.modelId,
    outputFormat: params.outputFormat,
  });
  // DEBUG: up to 100 chars preview only.
  log.debug('callNarrateScript', 'script preview', {
    preview: trimmed.slice(0, 100),
  });

  // Link caller-abort with internal 60s timeout controller.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options?.signal) {
    if (options.signal.aborted) {
      return failure('ABORT', 'Request aborted', 0);
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      const { message, errorCode } = await extractErrorInfo(response);
      log.error('callNarrateScript', 'http error', {
        httpStatus: response.status,
        errorCode,
      });
      return {
        success: false,
        error: message,
        httpStatus: response.status,
        errorCode: mapErrorCode(errorCode),
      };
    }

    const body = (await response.json()) as {
      success?: boolean;
      data?: NarrateScriptSuccess['data'];
      meta?: NarrateScriptMeta;
      error?: string | { code?: string; message?: string };
    };

    if (body.success === false) {
      const errMsg =
        typeof body.error === 'string'
          ? body.error
          : body.error?.message ?? 'Server returned success=false';
      const errCodeRaw =
        typeof body.error === 'object' ? body.error?.code : undefined;
      log.error('callNarrateScript', 'server returned success=false', {
        errorCode: errCodeRaw,
      });
      return failure(mapErrorCode(errCodeRaw), errMsg, response.status);
    }

    const data = body.data;
    if (!data || typeof data.audioUrl !== 'string' || !data.audioUrl) {
      log.error('callNarrateScript', 'malformed response', {
        hasData: Boolean(data),
      });
      return failure('UNKNOWN', 'Response thiếu audioUrl', response.status);
    }

    log.info('callNarrateScript', 'success', {
      durationMs: data.durationMs,
      wordCount: Array.isArray(data.words) ? data.words.length : 0,
      processingTimeMs: body.meta?.processingTimeMs,
      pathKey: body.meta?.pathKey,
      alignmentFallback: body.meta?.alignmentFallback,
    });

    const result: NarrateScriptResult = { success: true, data, meta: body.meta };
    warnIfSaveResourceFailed(log.warn, 'callNarrateScript', result);
    return result;
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (options?.signal?.aborted) {
      log.info('callNarrateScript', 'aborted by caller');
      return failure('ABORT', 'Request aborted', 0);
    }
    if (name === 'AbortError') {
      // Internal timeout fired (caller didn't abort).
      log.warn('callNarrateScript', 'timeout', { timeoutMs: TIMEOUT_MS });
      return failure('TIMEOUT', 'Quá thời gian xử lý (60s)', 0);
    }
    const rawMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof TypeError) {
      log.error('callNarrateScript', 'connection error', {
        msg: rawMessage.slice(0, 100),
      });
      return failure(
        'CONNECTION_ERROR',
        `Không kết nối được máy chủ (${rawMessage}).`,
        0,
      );
    }
    log.error('callNarrateScript', 'unknown error', {
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
