import { callImageApi, type ImageApiFailure } from '@/apis/image-api-client';
import { createLogger } from '@/utils/logger';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('MusicApi', 'callGenerateMusic');

// ───────────────────────── Generate music ─────────────────────────

export type MusicOutputFormat = 'mp3_44100_128' | 'mp3_44100_192' | 'wav_44100';

export interface GenerateMusicRequest {
  prompt: string;
  finetuneId: string | null;
  durationMs: number | null;
  loop: boolean;
  name: string;
  tags: string;
  forceInstrumental: boolean;
  seed?: number;
  outputFormat?: MusicOutputFormat;
  /** Opt-in auto-persist directive — added to the payload only when defined (table:musics target). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateMusicData {
  musicUrl: string;
  durationMs: number;
  mediaType: 'audio/mpeg' | 'audio/wav';
  loop: boolean;
  name: string;
  tags: string;
}

export interface GenerateMusicMeta {
  processingTimeMs?: number;
  elevenCallMs?: number;
  uploadMs?: number;
  pathKey?: string;
  charCount?: number;
  durationRequested?: number | null;
  finetuneId?: string | null;
  seed?: number | null;
}

export interface GenerateMusicSuccess {
  success: true;
  data: GenerateMusicData & SaveResourceOutcomeFields;
  meta?: GenerateMusicMeta;
}

export type GenerateMusicErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_API_KEY'
  | 'ELEVEN_CONTENT_REJECTED'
  | 'ELEVEN_DURATION_OUT_OF_RANGE'
  | 'ELEVEN_PAYMENT_REQUIRED'
  | 'ELEVEN_GENERATE_FAILED'
  | 'ELEVEN_RATE_LIMITED'
  | 'ELEVEN_AUTH_FAILED'
  | 'STORAGE_UPLOAD_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR'
  | 'CONNECTION_ERROR'
  | 'UNKNOWN';

export interface GenerateMusicFailure {
  success: false;
  error: string;
  httpStatus: number;
  errorCode: GenerateMusicErrorCode;
}

export type GenerateMusicResult = GenerateMusicSuccess | GenerateMusicFailure;

const GENERATE_PATH = '/api/text/generate-music';

const PROMPT_MIN = 10;
const PROMPT_MAX = 2000;
const DURATION_MIN_MS = 3000;
const DURATION_MAX_MS = 600000;
const NAME_MAX = 200;
const TAGS_MAX = 500;
const TAGS_PATTERN = /^[a-z0-9_,\s]*$/;

function failure(
  errorCode: GenerateMusicErrorCode,
  error: string,
  httpStatus = 0,
): GenerateMusicFailure {
  return { success: false, error, httpStatus, errorCode };
}

function mapErrorCode(code: string | undefined): GenerateMusicErrorCode {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'INVALID_API_KEY':
    case 'ELEVEN_CONTENT_REJECTED':
    case 'ELEVEN_DURATION_OUT_OF_RANGE':
    case 'ELEVEN_PAYMENT_REQUIRED':
    case 'ELEVEN_GENERATE_FAILED':
    case 'ELEVEN_RATE_LIMITED':
    case 'ELEVEN_AUTH_FAILED':
    case 'STORAGE_UPLOAD_ERROR':
    case 'TIMEOUT':
    case 'INTERNAL_ERROR':
    case 'CONNECTION_ERROR':
      return code;
    default:
      return 'UNKNOWN';
  }
}

export async function callGenerateMusic(
  params: GenerateMusicRequest,
): Promise<GenerateMusicResult> {
  const prompt = (params.prompt ?? '').trim();
  if (prompt.length < PROMPT_MIN || prompt.length > PROMPT_MAX) {
    log.warn('callGenerateMusic', 'prompt length invalid', { promptLen: prompt.length });
    return failure(
      'VALIDATION_ERROR',
      `Description must be ${PROMPT_MIN}-${PROMPT_MAX} chars`,
    );
  }

  if (
    params.durationMs !== null &&
    (params.durationMs < DURATION_MIN_MS || params.durationMs > DURATION_MAX_MS)
  ) {
    log.warn('callGenerateMusic', 'duration out of range', { durationMs: params.durationMs });
    return failure(
      'VALIDATION_ERROR',
      `Duration must be ${DURATION_MIN_MS / 1000}-${DURATION_MAX_MS / 1000} seconds`,
    );
  }

  const name = (params.name ?? '').trim();
  if (name.length === 0 || name.length > NAME_MAX) {
    log.warn('callGenerateMusic', 'name length invalid', { nameLen: name.length });
    return failure('VALIDATION_ERROR', `Name must be 1-${NAME_MAX} chars`);
  }

  const tags = params.tags ?? '';
  if (tags.length > TAGS_MAX) {
    log.warn('callGenerateMusic', 'tags too long', { tagsLen: tags.length });
    return failure('VALIDATION_ERROR', `Tags must be ≤ ${TAGS_MAX} chars`);
  }
  if (tags.length > 0 && !TAGS_PATTERN.test(tags)) {
    log.warn('callGenerateMusic', 'tags invalid charset', {});
    return failure('VALIDATION_ERROR', 'Tags must be lowercase a-z 0-9 _ , space');
  }

  const payload: Record<string, unknown> = {
    prompt,
    finetuneId: params.finetuneId,
    durationMs: params.durationMs,
    loop: params.loop,
    name,
    tags,
    forceInstrumental: params.forceInstrumental,
  };
  if (params.seed !== undefined) payload.seed = params.seed;
  if (params.outputFormat !== undefined) payload.outputFormat = params.outputFormat;
  if (params.saveResource) payload.saveResource = params.saveResource;

  log.info('callGenerateMusic', 'start', {
    promptLen: prompt.length,
    finetuneId: params.finetuneId ?? null,
    durationMs: params.durationMs,
    loop: params.loop,
    hasSeed: params.seed !== undefined,
  });

  const result = await callImageApi<GenerateMusicSuccess>(GENERATE_PATH, payload);

  if (!result.success) {
    const fail = result as ImageApiFailure;
    log.error('callGenerateMusic', 'failed', {
      httpStatus: fail.httpStatus,
      errorCode: fail.errorCode,
    });
    return {
      success: false,
      error: fail.error,
      httpStatus: fail.httpStatus,
      errorCode: mapErrorCode(fail.errorCode),
    };
  }

  log.info('callGenerateMusic', 'success', {
    durationMs: result.data.durationMs,
    mediaType: result.data.mediaType,
    processingTimeMs: result.meta?.processingTimeMs,
  });
  warnIfSaveResourceFailed(log.warn, 'callGenerateMusic', result);
  return result;
}
