// actors-api.ts — Thin client for the Actors casting-swap "apply-casting" op.
//
// POST /api/resource/apply-casting upserts N casting entries across many spreads
// in ONE atomic UPDATE (rtype 13 = actant grain). Auth = user JWT Bearer via
// callImageApi (X-API-Key is also sent but the gateway ignores it here).
//
// ⚠️ NEVER route rtype 13 through the generic gateway `saveResource()` /
//    `/api/resource/save` — the gateway answers 422 UNSUPPORTED for rtype 13
//    (single-purpose endpoint). This client is the ONLY write path for casting.
//
// The endpoint does NOT self-acquire/release the lock — FE must lock first
// (see runLockedApplyCasting). Spec: ai-storybook-design/api/resource/06-apply-casting.md
// SECURITY: never log `media_url` (Storage signed/public URL) to the console.

import { callImageApi, type ImageApiFailure } from './image-api-client';
import type { ActorType } from '@/types/actors';
import { createLogger } from '@/utils/logger';

const log = createLogger('API', 'ActorsApi');

/** One casting entry — a target image layer + the new actor media URL. */
export interface CastingEntry {
  spread_id: string;
  image_id: string;
  media_url: string;
}

/** Wire contract for POST /api/resource/apply-casting. `step`/`resource_type`
 *  are literal-pinned (server-side AND inside `applyCasting`) — see ApplyCastingInput. */
export interface ApplyCastingRequest {
  book_id: string;
  snapshot_id: string;
  step: 3; // literal — force-pin retouch
  resource_type: 13; // literal — casting rtype
  actant_id: string;
  actor_id: string;
  actor_type: ActorType;
  entries: CastingEntry[]; // 1..200
}

/** Caller-facing input — `step`/`resource_type` are pinned INSIDE `applyCasting`
 *  and MUST NOT be supplied by callers (anti-wrong-type guard, plan §3). */
export type ApplyCastingInput = Omit<ApplyCastingRequest, 'step' | 'resource_type'>;

export interface ApplyCastingResponse {
  success: true;
  applied: number;
  skipped: Array<{
    spread_id: string;
    image_id: string;
    reason: 'layer_not_found' | 'actant_mismatch';
  }>;
}

const MIN_ENTRIES = 1;
const MAX_ENTRIES = 200;

/** Error carrier for apply-casting failures — keeps the backend `code` +
 *  `httpStatus` so callers map per-code toasts (409 LOCK_NOT_HELD / 403 FORBIDDEN
 *  / 404 SNAPSHOT_NOT_FOUND / 422 REFERENCE_IMAGE_MISSING|UNSUPPORTED). A plain
 *  `Error` would lose the code. */
export class ApplyCastingError extends Error {
  readonly code?: string;
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number, code?: string) {
    super(message);
    this.name = 'ApplyCastingError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Apply casting entries (Inject). Pins `step: 3` + `resource_type: 13` INSIDE the
 * function — callers cannot override them. Client-side validates `entries.length`
 * ∈ [1, 200] before sending (avoids a pointless 400 round-trip). Returns the
 * parsed response on 2xx; throws `ApplyCastingError` (with backend `code`) on
 * non-2xx or a client-side validation miss.
 */
export async function applyCasting(input: ApplyCastingInput): Promise<ApplyCastingResponse> {
  const count = input.entries.length;
  log.info('applyCasting', 'request', {
    actantId: input.actant_id,
    actorType: input.actor_type,
    entryCount: count,
  });

  if (count < MIN_ENTRIES || count > MAX_ENTRIES) {
    log.warn('applyCasting', 'entries out of range — refuse before send', { entryCount: count });
    throw new ApplyCastingError(
      `entries phải trong khoảng ${MIN_ENTRIES}..${MAX_ENTRIES} (nhận ${count})`,
      400,
      'INVALID_BODY',
    );
  }

  const result = await callImageApi<ApplyCastingResponse>('/api/resource/apply-casting', {
    book_id: input.book_id,
    snapshot_id: input.snapshot_id,
    step: 3, // PINNED — force retouch (422 if wrong)
    resource_type: 13, // PINNED — casting rtype (422 if wrong)
    actant_id: input.actant_id,
    actor_id: input.actor_id,
    actor_type: input.actor_type,
    entries: input.entries,
  });

  if (!result.success) {
    const failure = result as ImageApiFailure;
    log.error('applyCasting', 'failed', {
      actantId: input.actant_id,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
    });
    throw new ApplyCastingError(failure.error, failure.httpStatus, failure.errorCode);
  }

  log.info('applyCasting', 'ok', {
    actantId: input.actant_id,
    applied: result.applied,
    skipped: result.skipped.length,
  });
  return result;
}
