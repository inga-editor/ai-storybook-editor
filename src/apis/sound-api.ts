import { callImageApi, type ImageApiFailure } from '@/apis/image-api-client';
import { createLogger } from '@/utils/logger';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('SoundApi', 'callGenerateSoundEffect');

// ───────────────────────── Generate sound effect ─────────────────────────

export type SoundEffectOutputFormat =
  | 'mp3_44100_128'
  | 'mp3_44100_192'
  | 'mp3_22050_32'
  | 'pcm_44100'
  | 'pcm_16000';

export interface GenerateSoundEffectRequest {
  description: string;
  loop?: boolean;
  durationSecs?: number | null;
  promptInfluence?: number;
  seed?: number | null;
  outputFormat?: SoundEffectOutputFormat;
  /** Opt-in auto-persist directive — added to the payload only when defined (table:sounds target). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateSoundEffectData {
  soundUrl: string;
  durationSecs: number;
  mediaType: 'audio/mpeg' | 'audio/wav';
}

export interface GenerateSoundEffectMeta {
  processingTimeMs?: number;
  elevenCallMs?: number;
  uploadMs?: number;
  pathKey?: string;
  charCount?: number;
  durationRequested?: number | null;
  promptInfluence?: number;
  seed?: number | null;
  costEstimate?: number;
}

export interface GenerateSoundEffectSuccess {
  success: true;
  data: GenerateSoundEffectData & SaveResourceOutcomeFields;
  meta?: GenerateSoundEffectMeta;
}

export type GenerateSoundEffectErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_API_KEY'
  | 'ELEVEN_CONTENT_REJECTED'
  | 'ELEVEN_DURATION_OUT_OF_RANGE'
  | 'ELEVEN_GENERATE_FAILED'
  | 'ELEVEN_RATE_LIMITED'
  | 'ELEVEN_AUTH_FAILED'
  | 'ELEVEN_UPSTREAM_ERROR'
  | 'STORAGE_UPLOAD_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR'
  | 'CONNECTION_ERROR'
  | 'UNKNOWN';

export interface GenerateSoundEffectFailure {
  success: false;
  error: string;
  httpStatus: number;
  errorCode: GenerateSoundEffectErrorCode;
}

export type GenerateSoundEffectResult =
  | GenerateSoundEffectSuccess
  | GenerateSoundEffectFailure;

const GENERATE_PATH = '/api/text/generate-sound-effect';

// Defense-in-depth limits mirror BE Pydantic clamps. Server is source of truth.
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 500;
const DURATION_MIN_SECS = 0.5;
const DURATION_MAX_SECS = 22;
const INFLUENCE_MIN = 0;
const INFLUENCE_MAX = 1;

function failure(
  errorCode: GenerateSoundEffectErrorCode,
  error: string,
  httpStatus = 0
): GenerateSoundEffectFailure {
  return { success: false, error, httpStatus, errorCode };
}

function mapErrorCode(code: string | undefined): GenerateSoundEffectErrorCode {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'INVALID_API_KEY':
    case 'ELEVEN_CONTENT_REJECTED':
    case 'ELEVEN_DURATION_OUT_OF_RANGE':
    case 'ELEVEN_GENERATE_FAILED':
    case 'ELEVEN_RATE_LIMITED':
    case 'ELEVEN_AUTH_FAILED':
    case 'ELEVEN_UPSTREAM_ERROR':
    case 'STORAGE_UPLOAD_ERROR':
    case 'TIMEOUT':
    case 'INTERNAL_ERROR':
    case 'CONNECTION_ERROR':
      return code;
    default:
      return 'UNKNOWN';
  }
}

export async function callGenerateSoundEffect(
  params: GenerateSoundEffectRequest
): Promise<GenerateSoundEffectResult> {
  const description = (params.description ?? '').trim();
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    log.warn('callGenerateSoundEffect', 'description length invalid', {
      descLen: description.length,
    });
    return failure(
      'VALIDATION_ERROR',
      `Description must be ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} chars`
    );
  }

  if (
    params.durationSecs !== undefined &&
    params.durationSecs !== null &&
    (params.durationSecs < DURATION_MIN_SECS || params.durationSecs > DURATION_MAX_SECS)
  ) {
    log.warn('callGenerateSoundEffect', 'duration out of range', {
      durationSecs: params.durationSecs,
    });
    return failure(
      'VALIDATION_ERROR',
      `Duration must be ${DURATION_MIN_SECS}-${DURATION_MAX_SECS} seconds`
    );
  }

  if (
    params.promptInfluence !== undefined &&
    (params.promptInfluence < INFLUENCE_MIN || params.promptInfluence > INFLUENCE_MAX)
  ) {
    log.warn('callGenerateSoundEffect', 'promptInfluence out of range', {
      promptInfluence: params.promptInfluence,
    });
    return failure(
      'VALIDATION_ERROR',
      `Prompt influence must be ${INFLUENCE_MIN}-${INFLUENCE_MAX}`
    );
  }

  // Build payload — drop undefined keys (do NOT drop nulls; null is meaningful for durationSecs/seed).
  const payload: Record<string, unknown> = { description };
  if (params.loop !== undefined) payload.loop = params.loop;
  if (params.durationSecs !== undefined) payload.durationSecs = params.durationSecs;
  if (params.promptInfluence !== undefined) payload.promptInfluence = params.promptInfluence;
  if (params.seed !== undefined) payload.seed = params.seed;
  if (params.outputFormat !== undefined) payload.outputFormat = params.outputFormat;
  if (params.saveResource) payload.saveResource = params.saveResource;

  log.info('callGenerateSoundEffect', 'start', {
    descLen: description.length,
    hasSeed: params.seed !== undefined && params.seed !== null,
    loop: params.loop ?? false,
    durationSecs: params.durationSecs ?? null,
  });

  const result = await callImageApi<GenerateSoundEffectSuccess>(GENERATE_PATH, payload);

  if (!result.success) {
    const fail = result as ImageApiFailure;
    log.error('callGenerateSoundEffect', 'failed', {
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

  log.info('callGenerateSoundEffect', 'success', {
    durationSecs: result.data.durationSecs,
    mediaType: result.data.mediaType,
    processingTimeMs: result.meta?.processingTimeMs,
  });
  warnIfSaveResourceFailed(log.warn, 'callGenerateSoundEffect', result);
  return result;
}
