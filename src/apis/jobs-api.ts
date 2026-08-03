// jobs-api.ts — Thin wrappers over callImageApi for background job endpoints.
// Endpoints: /api/jobs/remix/{id}/audio-swap, /api/jobs/remix/{id}/mix-swap,
//            /api/jobs/{id}/cancel.
// NOTE: image-swap enqueue removed (2026-05-30) — Inject is now a synchronous
// client-side finalize (see remix-store injectFinalCrops).
// Auth: X-API-Key (service-to-service) + Bearer JWT (RLS user_id). Both are
// always sent by callImageApi when a Supabase session is active.
// Spec: ai-storybook-design/api/jobs/01-enqueue-remix-audio-swap.md
//       ai-storybook-design/api/jobs/04-enqueue-remix-character-swap.md
//       ai-storybook-design/api/jobs/03-cancel-job.md

import { callImageApi, type ImageApiFailure } from './image-api-client';
import { DETECT_JOB_CONFIG, type DetectPlane } from '@/types/remix';
import { ACTOR_STAGE_ENDPOINT, type ActorStageKind } from '@/types/actors';
import { createLogger } from '@/utils/logger';

const log = createLogger('API', 'JobsApi');

// ── Response shapes (snake_case from FastAPI) ────────────────────────────────

export interface EnqueueAudioSwapEnqueuedData {
  job_id: string;
  status: 'queued';
  type: 'remix_audio_swap';
  remix_id: string;
  total_steps: number;
  chunks_to_regen: number;
  textboxes_to_recombine: number;
  skipped?: false;
  deduped?: false;
}

export interface EnqueueAudioSwapSkippedData {
  skipped: true;
  reason: string;
  chunks_to_regen?: number;
}

export interface EnqueueAudioSwapDedupedData {
  job_id: string;
  status: 'queued' | 'running';
  type: 'remix_audio_swap';
  remix_id: string;
  deduped: true;
}

export type EnqueueAudioSwapData =
  | EnqueueAudioSwapEnqueuedData
  | EnqueueAudioSwapSkippedData
  | EnqueueAudioSwapDedupedData;

export interface EnqueueJobResponse<T> {
  success: true;
  data: T;
}

export interface CancelJobData {
  job_id: string;
  cancel_requested: boolean;
  current_status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface EnqueueAudioSwapParams {
  triggered_by: 'auto-create' | 'user';
  max_concurrent_chunks_per_textbox: number;
}

// ── Stage jobs (api/jobs/05 mix-swap + 09 rmbg + 10 upscale — batch-level) ───
// ⚡2026-06-12 — one generic wrapper, parameterized by the endpoint segment
// (replaces the mix-only enqueueRemixMixSwap; validation S1 no alias). The 3
// responses share the fields the FE consumes; job-specific extras (e.g. job
// 05's target_count) ride in the index signature.

/** Per-model parameters forwarded to a stage/sprite job (⚡2026-06-13 — wired
 *  from the right-sidebar params via `buildModelParams`). `model` = the picked
 *  model id (allowlist UI); `params` = optional knobs the backend
 *  allowlists/clamps/maps per model (temperature for swap, noise for upscale).
 *  Backend drops keys a model doesn't support (defense). */
export interface ModelParamsBody {
  model: string;
  params?: { temperature?: number; noise?: number };
}

/** ⚡2026-06-29 Watercolor grain post-process — TOP-LEVEL job-10 body field
 *  (sibling of `model_params`, NOT nested inside it). Upscale stage only.
 *  Omit / `enabled:false` → grain off (server normalizes to none). `amp`/`blur`
 *  are CLAMPED server-side (amp→0..50, blur→0..5), never rejected. `seed` is
 *  omitted by the modal — the backend supplies a default and adds a per-crop
 *  seed offset internally. MODEL-AGNOSTIC: applies to all 4 upscale models. */
export interface GrainBody {
  enabled: boolean;
  amp?: number;
  blur?: number;
  seed?: number;
}

export interface EnqueueStageJobBody {
  batch_id: string;
  force_resweep?: boolean;
  /** ⚡2026-06-13 WIRED — per-model params (model + temperature/noise). */
  model_params?: ModelParamsBody;
  /** ⚡2026-06-29 TOP-LEVEL grain knobs (sibling of model_params) — upscale only;
   *  other stages omit it. */
  grain?: GrainBody;
}

export type StageJobEndpointSegment = 'mix-swap' | 'rmbg' | 'upscale';

export interface EnqueueStageJobEnqueuedData {
  job_id: string;
  status: 'queued';
  type: 'remix_mix_swap' | 'remix_rmbg' | 'remix_upscale';
  remix_id: string;
  batch_id: string;
  total_steps: number;
  sheets_to_process: number;
  estimated_duration_sec: number;
  skipped?: false;
  deduped?: false;
  [k: string]: unknown;
}

export interface EnqueueStageJobSkippedData {
  skipped: true;
  /** Opaque per-job reason — job 05: 'all_sheets_already_swapped' |
   *  'no_crop_sheets'; jobs 09/10: 'all_sheets_already_done' | … . FE only
   *  displays it. */
  reason: string;
  sheets_to_process: 0;
}

export interface EnqueueStageJobDedupedData {
  job_id: string;
  status: 'queued' | 'running';
  type: 'remix_mix_swap' | 'remix_rmbg' | 'remix_upscale';
  remix_id: string;
  active_swap_key: string;
  deduped: true;
}

export type EnqueueStageJobData =
  | EnqueueStageJobEnqueuedData
  | EnqueueStageJobSkippedData
  | EnqueueStageJobDedupedData;

// ── Sprite swap (api/jobs/02 — sprite-level swap, Variants tab) ──────────────

export interface EnqueueSpriteSwapBody {
  sprite_id: string;
  force_resweep?: boolean;
  /** ⚡2026-06-13 WIRED — per-model params (swap model + temperature). */
  model_params?: ModelParamsBody;
}

export interface EnqueueSpriteSwapEnqueuedData {
  job_id: string;
  status: 'queued';
  type: 'remix_sprite_swap';
  remix_id: string;
  sprite_id: string;
  object_count: number;
  total_steps: number;
  sheets_to_process: number;
  estimated_duration_sec: number;
  skipped?: false;
  deduped?: false;
}

export interface EnqueueSpriteSwapSkippedData {
  skipped: true;
  reason: 'all_sheets_already_swapped' | 'no_crop_sheets' | string;
  sheets_to_process: 0;
}

export interface EnqueueSpriteSwapDedupedData {
  job_id: string;
  status: 'queued' | 'running';
  type: 'remix_sprite_swap';
  remix_id: string;
  /** Sprite-swap dedup key = sprite_id (INDEPENDENT of mix-swap — disjoint). */
  active_swap_key: string;
  deduped: true;
}

export type EnqueueSpriteSwapData =
  | EnqueueSpriteSwapEnqueuedData
  | EnqueueSpriteSwapSkippedData
  | EnqueueSpriteSwapDedupedData;

// ── Actor stage jobs (api/jobs/14 swap + 15 rmbg + 16 upscale — batch-level) ──
// Actors casting-swap pipeline. Path shape differs from the remix stage jobs:
// `/api/jobs/actors/{pair_id}/{swap|rmbg|upscale}` (stage-1 segment is `swap`,
// NOT `mix-swap`). Body/response share the SAME shape as job 05 (deliberately
// not forked). `grain` is TOP-LEVEL + upscale-only. Auth = X-API-Key + Bearer
// via callImageApi (BE `verify_api_key`), identical to the remix jobs.

/** Body for an actor stage job (jobs 14/15/16). Structurally identical to the
 *  remix `EnqueueStageJobBody`; kept as its own type for the actors domain.
 *  `grain` is upscale-stage-only (top-level) — the wrapper strips it otherwise. */
export interface EnqueueActorStageBody {
  batch_id: string;
  force_resweep?: boolean;
  /** Per-model params (model + temperature/noise). */
  model_params?: ModelParamsBody;
  /** TOP-LEVEL grain knobs (sibling of model_params) — stage `upscales` only;
   *  swap/rmbg omit it (client strips defensively). */
  grain?: GrainBody;
}

export type ActorStageJobType = 'actor_swap' | 'actor_rmbg' | 'actor_upscale';

export interface EnqueueActorStageEnqueuedData {
  job_id: string;
  status: 'queued';
  type: ActorStageJobType;
  pair_id: string;
  batch_id: string;
  total_steps: number;
  sheets_to_process: number;
  estimated_duration_sec: number;
  skipped?: false;
  deduped?: false;
  [k: string]: unknown;
}

export interface EnqueueActorStageSkippedData {
  skipped: true;
  /** Opaque per-job reason (e.g. 'all_sheets_already_swapped') — FE displays it. */
  reason: string;
  sheets_to_process: 0;
}

export interface EnqueueActorStageDedupedData {
  job_id: string;
  status: 'queued' | 'running';
  type: ActorStageJobType;
  pair_id: string;
  active_swap_key: string;
  deduped: true;
}

export type ActorStageJobData =
  | EnqueueActorStageEnqueuedData
  | EnqueueActorStageSkippedData
  | EnqueueActorStageDedupedData;

/** POST /api/jobs/actors/{pairId}/{swap|rmbg|upscale} (jobs 14/15/16). Segment
 *  resolved from `ACTOR_STAGE_ENDPOINT[stage]`. Returns parsed `data` on 2xx
 *  (enqueued/skipped/deduped — union preserved); throws `EnqueueJobError`
 *  (with backend `code` + `httpStatus`) on non-2xx so the caller can distinguish
 *  422 REFERENCE_IMAGE_MISSING / EMPTY_BATCH from a generic failure. `grain` is
 *  TOP-LEVEL + upscale-only — stripped on swap/rmbg. */
export async function enqueueActorStageJob(
  pairId: string,
  stage: ActorStageKind,
  body: EnqueueActorStageBody,
): Promise<ActorStageJobData> {
  const segment = ACTOR_STAGE_ENDPOINT[stage];
  log.info('enqueueActorStageJob', 'request', {
    pairId,
    stage,
    segment,
    batchId: body.batch_id,
    forceResweep: body.force_resweep ?? true,
    model: body.model_params?.model,
    // grain present (upscale only) — log the toggle, not the knobs.
    grainEnabled: stage === 'upscales' ? body.grain?.enabled : undefined,
  });
  const result = await callImageApi<EnqueueJobResponse<ActorStageJobData>>(
    `/api/jobs/actors/${encodeURIComponent(pairId)}/${segment}`,
    {
      batch_id: body.batch_id,
      force_resweep: body.force_resweep ?? true,
      ...(body.model_params ? { model_params: body.model_params } : {}),
      // grain is TOP-LEVEL (sibling of model_params) + upscale-only — defensively
      // stripped on swap/rmbg so an errant grain never trips a 400.
      ...(stage === 'upscales' && body.grain ? { grain: body.grain } : {}),
    },
  );
  if (!result.success) {
    const failure = result as ImageApiFailure;
    log.error('enqueueActorStageJob', 'failed', {
      pairId,
      stage,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
    });
    throw new EnqueueJobError(failure.error, failure.httpStatus, failure.errorCode);
  }
  return result.data;
}

// ── Detect swap defects (api/jobs/11 sprite + 12 mix — generic Check) ─────────
// Mirror swap: enqueue a background job that loops every swapped sheet and
// returns `defectsBySheet` via `background_jobs.result`. Advisory/ephemeral.
// ⚡2026-06-27 — ONE generic wrapper parameterized by `plane` (sprite/mix); the
// scope key + endpoint + job-type are resolved from `DETECT_JOB_CONFIG`.

export interface EnqueueDetectBody {
  /** Scope to inspect — sprite_id (sprite plane) | batch_id (mix plane). The
   *  wrapper sets the correct body field from `DETECT_JOB_CONFIG[plane].scopeKey`. */
  scopeId: string;
  force_resweep?: boolean;
  /** Swap intent context the core re-reads (NOT a model dispatch). */
  swap_model?: string;
  swap_temperature?: number;
  focus_objects?: string[];
  severity_threshold?: 'low' | 'medium' | 'high';
  max_defects?: number;
}

/** Detect job-type — 3 separate dedup families (sprite vs mix vs rmbg). */
export type DetectJobType =
  | 'remix_detect_defects'
  | 'remix_detect_mix_defects'
  | 'remix_detect_rmbg_defects';

export interface EnqueueDetectEnqueuedData {
  job_id: string;
  status: 'queued';
  type: DetectJobType;
  remix_id: string;
  /** Exactly one of these is set per plane (sprite_id | batch_id). */
  sprite_id?: string;
  batch_id?: string;
  /** mix-only — # of target objects across the batch (api/jobs/12). */
  target_count?: number;
  total_steps: number;
  sheets_to_process: number;
  estimated_duration_sec?: number;
  skipped?: false;
  deduped?: false;
}

export interface EnqueueDetectSkippedData {
  skipped: true;
  reason: 'no_swap_result' | 'no_crop_sheets' | string;
  sheets_to_process: 0;
}

export interface EnqueueDetectDedupedData {
  job_id: string;
  status: 'queued' | 'running';
  type: DetectJobType;
  remix_id: string;
  /** Detect dedup key = scope id (INDEPENDENT of swap + of the other plane). */
  active_swap_key: string;
  deduped: true;
}

export type EnqueueDetectData =
  | EnqueueDetectEnqueuedData
  | EnqueueDetectSkippedData
  | EnqueueDetectDedupedData;

/** Error thrown by enqueue wrappers on non-2xx so callers can branch on the
 *  backend `code` (e.g. MISSING_VARIANT_REFERENCE) — a plain `Error` would lose
 *  it. `code`/`httpStatus` mirror the `ImageApiFailure` fields. */
export class EnqueueJobError extends Error {
  readonly code?: string;
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number, code?: string) {
    super(message);
    this.name = 'EnqueueJobError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ── Wrappers ─────────────────────────────────────────────────────────────────

/** POST /api/jobs/remix/{remixId}/audio-swap */
export async function enqueueAudioSwap(
  remixId: string,
  params: EnqueueAudioSwapParams,
): Promise<EnqueueJobResponse<EnqueueAudioSwapData> | ImageApiFailure> {
  log.info('enqueueAudioSwap', 'request', { remixId, triggered_by: params.triggered_by });
  return callImageApi<EnqueueJobResponse<EnqueueAudioSwapData>>(
    `/api/jobs/remix/${encodeURIComponent(remixId)}/audio-swap`,
    params,
  );
}

/** POST /api/jobs/remix/{remixId}/{mix-swap|rmbg|upscale} (jobs 05/09/10 —
 *  batch-level stage jobs, ⚡2026-06-12 generic). Returns parsed `data` on 2xx
 *  (enqueued/skipped/deduped); throws `EnqueueJobError` (with backend `code`)
 *  on non-2xx so the modal can toast per-code (e.g. 422
 *  MISSING_VARIANT_REFERENCE on mix-swap). */
export async function enqueueRemixStageJob(
  remixId: string,
  endpointSegment: StageJobEndpointSegment,
  body: EnqueueStageJobBody,
): Promise<EnqueueStageJobData> {
  log.info('enqueueRemixStageJob', 'request', {
    remixId,
    endpointSegment,
    forceResweep: body.force_resweep ?? true,
    model: body.model_params?.model,
    // ⚡2026-06-29 grain present (upscale only) — log the toggle, not the knobs.
    grainEnabled: body.grain?.enabled,
  });
  const result = await callImageApi<EnqueueJobResponse<EnqueueStageJobData>>(
    `/api/jobs/remix/${encodeURIComponent(remixId)}/${endpointSegment}`,
    {
      batch_id: body.batch_id,
      force_resweep: body.force_resweep ?? true,
      ...(body.model_params ? { model_params: body.model_params } : {}),
      // ⚡2026-06-29 grain is TOP-LEVEL (sibling of model_params); upscale only.
      ...(body.grain ? { grain: body.grain } : {}),
    },
  );
  if (!result.success) {
    const failure = result as ImageApiFailure;
    log.error('enqueueRemixStageJob', 'failed', {
      remixId,
      endpointSegment,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
    });
    throw new EnqueueJobError(failure.error, failure.httpStatus, failure.errorCode);
  }
  return result.data;
}

/** POST /api/jobs/remix/{remixId}/sprite-swap (api/jobs/02 — sprite-level swap).
 *  Returns parsed `data` on 2xx (enqueued/skipped/deduped); throws
 *  `EnqueueJobError` (with backend `code`) on non-2xx so the modal can
 *  distinguish 422 NO_SWAP_OBJECTS / MISSING_OBJECT_CONFIG / 404 SPRITE_NOT_FOUND
 *  from a generic failure. Body carries `sprite_id` + `force_resweep` +
 *  ⚡2026-06-13 `model_params` (swap model + temperature). */
export async function enqueueRemixSpriteSwap(
  remixId: string,
  body: EnqueueSpriteSwapBody,
): Promise<EnqueueSpriteSwapData> {
  log.info('enqueueRemixSpriteSwap', 'request', {
    remixId,
    forceResweep: body.force_resweep ?? true,
    model: body.model_params?.model,
  });
  const result = await callImageApi<EnqueueJobResponse<EnqueueSpriteSwapData>>(
    `/api/jobs/remix/${encodeURIComponent(remixId)}/sprite-swap`,
    {
      sprite_id: body.sprite_id,
      force_resweep: body.force_resweep ?? true,
      ...(body.model_params ? { model_params: body.model_params } : {}),
    },
  );
  if (!result.success) {
    const failure = result as ImageApiFailure;
    log.error('enqueueRemixSpriteSwap', 'failed', {
      remixId,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
    });
    throw new EnqueueJobError(failure.error, failure.httpStatus, failure.errorCode);
  }
  return result.data;
}

/** POST /api/jobs/remix/{remixId}/{detect-sprite-defects | detect-mix-defects}
 *  (api/jobs/11 sprite | 12 mix — generic Check). The endpoint + scope-key are
 *  resolved from `DETECT_JOB_CONFIG[plane]`. Returns parsed `data` on 2xx
 *  (enqueued/skipped/deduped); throws `EnqueueJobError` (with backend `code` +
 *  `httpStatus`) on non-2xx so the caller can branch — NOTE the dedup
 *  divergence: sprite (11) returns HTTP 200 `{ deduped: true }` while mix (12)
 *  returns HTTP 409 `JOB_ALREADY_ACTIVE`; the store action (`startDetectJob`)
 *  tolerates BOTH. SECURITY: never log defect messages/media. */
export async function enqueueDetectDefects(
  plane: DetectPlane,
  remixId: string,
  body: EnqueueDetectBody,
): Promise<EnqueueDetectData> {
  const cfg = DETECT_JOB_CONFIG[plane];
  log.info('enqueueDetectDefects', 'request', {
    plane,
    remixId,
    endpoint: cfg.endpointSegment,
    forceResweep: body.force_resweep ?? true,
    model: body.swap_model,
  });
  // ⚡rmbg (job 13) forbids swap_model/swap_temperature (no swap identity → BE
  // `extra="forbid"` → 400). Gate the display-only swap context per-plane so the
  // generic body never trips the rmbg model. sprite/mix accept them.
  const swapContext = cfg.carriesSwapContext
    ? {
        ...(body.swap_model ? { swap_model: body.swap_model } : {}),
        ...(body.swap_temperature != null
          ? { swap_temperature: body.swap_temperature }
          : {}),
      }
    : {};
  const result = await callImageApi<EnqueueJobResponse<EnqueueDetectData>>(
    `/api/jobs/remix/${encodeURIComponent(remixId)}/${cfg.endpointSegment}`,
    {
      [cfg.scopeKey]: body.scopeId,
      force_resweep: body.force_resweep ?? true,
      ...swapContext,
      ...(body.focus_objects ? { focus_objects: body.focus_objects } : {}),
      ...(body.severity_threshold
        ? { severity_threshold: body.severity_threshold }
        : {}),
      ...(body.max_defects != null ? { max_defects: body.max_defects } : {}),
    },
  );
  if (!result.success) {
    const failure = result as ImageApiFailure;
    log.error('enqueueDetectDefects', 'failed', {
      plane,
      remixId,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
    });
    throw new EnqueueJobError(failure.error, failure.httpStatus, failure.errorCode);
  }
  return result.data;
}

// ── Export PDF (api/jobs/06 — book + remix route) ────────────────────────────

export interface StartExportPdfOpts {
  dpi?: number;
  color_mode?: 'cmyk' | 'rgb';
}

export interface EnqueueExportPdfEnqueuedData {
  job_id: string;
  status: 'queued';
  type: 'export_pdf';
  source: 'book' | 'remix';
  book_id: string;
  remix_id?: string;
  total_steps: number;
  spreads_to_render: number;
  estimated_duration_sec: number;
  estimated_file_size_mb: number;
  skipped?: false;
  deduped?: false;
}

export interface EnqueueExportPdfSkippedData {
  skipped: true;
  reason: 'no_interior_spreads' | 'snapshot_empty' | string;
  spreads_to_render: 0;
}

export interface EnqueueExportPdfDedupedData {
  job_id: string;
  status: 'queued' | 'running';
  type: 'export_pdf';
  source: 'book' | 'remix';
  book_id: string;
  remix_id?: string;
  deduped: true;
}

export type EnqueueExportPdfData =
  | EnqueueExportPdfEnqueuedData
  | EnqueueExportPdfSkippedData
  | EnqueueExportPdfDedupedData;

/** Narrowing guards — `data` is a 3-way union (enqueued | skipped | deduped). */
export function isExportPdfSkipped(
  d: EnqueueExportPdfData,
): d is EnqueueExportPdfSkippedData {
  return (d as EnqueueExportPdfSkippedData).skipped === true;
}

export function isExportPdfDeduped(
  d: EnqueueExportPdfData,
): d is EnqueueExportPdfDedupedData {
  return (d as EnqueueExportPdfDedupedData).deduped === true;
}

/** POST /api/jobs/{bookId}/export-pdf (book source). Path verbatim (FastAPI —
 *  no kebab flatten). v1 callers pass `{ dpi: 300, color_mode: 'cmyk' }`. */
export async function enqueueBookExportPdf(
  bookId: string,
  opts: StartExportPdfOpts = {},
): Promise<EnqueueJobResponse<EnqueueExportPdfData> | ImageApiFailure> {
  log.info('enqueueBookExportPdf', 'request', {
    bookId,
    dpi: opts.dpi,
    colorMode: opts.color_mode,
  });
  return callImageApi<EnqueueJobResponse<EnqueueExportPdfData>>(
    `/api/jobs/${encodeURIComponent(bookId)}/export-pdf`,
    opts,
  );
}

/** POST /api/jobs/remix/{remixId}/export-pdf (remix source). */
export async function enqueueRemixExportPdf(
  remixId: string,
  opts: StartExportPdfOpts = {},
): Promise<EnqueueJobResponse<EnqueueExportPdfData> | ImageApiFailure> {
  log.info('enqueueRemixExportPdf', 'request', {
    remixId,
    dpi: opts.dpi,
    colorMode: opts.color_mode,
  });
  return callImageApi<EnqueueJobResponse<EnqueueExportPdfData>>(
    `/api/jobs/remix/${encodeURIComponent(remixId)}/export-pdf`,
    opts,
  );
}

// ── Render Book Video (api/jobs/07 — book + remix route) ────────────────────

export interface StartRenderVideoOpts {
  edition: 'classic' | 'dynamic';
  language?: string;
  start_spread_id?: string;
}

export interface EnqueueRenderVideoEnqueuedData {
  job_id: string;
  status: 'queued';
  type: 'render_book_video';
  source: 'book' | 'remix';
  book_id: string;
  remix_id?: string;
  edition: 'classic' | 'dynamic';
  resolution: 'qhd';
  total_steps: number;
  spreads_in_sequence: number;
  estimated_duration_sec: number;
  skipped?: false;
  deduped?: false;
}

export interface EnqueueRenderVideoSkippedData {
  skipped: true;
  reason: 'empty_sequence' | 'snapshot_empty' | string;
  spreads_in_sequence: 0;
}

export interface EnqueueRenderVideoDedupedData {
  job_id: string;
  status: 'queued' | 'running';
  type: 'render_book_video';
  source: 'book' | 'remix';
  book_id: string;
  remix_id?: string;
  edition: 'classic' | 'dynamic';
  deduped: true;
}

export type EnqueueRenderVideoData =
  | EnqueueRenderVideoEnqueuedData
  | EnqueueRenderVideoSkippedData
  | EnqueueRenderVideoDedupedData;

/** Narrowing guards — 3-way union (enqueued | skipped | deduped). */
export function isRenderVideoSkipped(
  d: EnqueueRenderVideoData,
): d is EnqueueRenderVideoSkippedData {
  return (d as EnqueueRenderVideoSkippedData).skipped === true;
}

export function isRenderVideoDeduped(
  d: EnqueueRenderVideoData,
): d is EnqueueRenderVideoDedupedData {
  return (d as EnqueueRenderVideoDedupedData).deduped === true;
}

/** POST /api/jobs/{bookId}/render-book-video (book source). v1 fixed QHD master;
 *  body carries `edition` (required) + optional `language` / `start_spread_id`. */
export async function enqueueBookRenderVideo(
  bookId: string,
  opts: StartRenderVideoOpts,
): Promise<EnqueueJobResponse<EnqueueRenderVideoData> | ImageApiFailure> {
  log.info('enqueueBookRenderVideo', 'request', { bookId, edition: opts.edition });
  return callImageApi<EnqueueJobResponse<EnqueueRenderVideoData>>(
    `/api/jobs/${encodeURIComponent(bookId)}/render-book-video`,
    opts,
  );
}

/** POST /api/jobs/remix/{remixId}/render-book-video (remix source). */
export async function enqueueRemixRenderVideo(
  remixId: string,
  opts: StartRenderVideoOpts,
): Promise<EnqueueJobResponse<EnqueueRenderVideoData> | ImageApiFailure> {
  log.info('enqueueRemixRenderVideo', 'request', { remixId, edition: opts.edition });
  return callImageApi<EnqueueJobResponse<EnqueueRenderVideoData>>(
    `/api/jobs/remix/${encodeURIComponent(remixId)}/render-book-video`,
    opts,
  );
}

// ── Spread thumbnails (api/jobs/17 — batch render spread pool thumbnails) ─────
// Config Spread Pool "Generate" button. Body `{snapshot_id, canvas}` — canvas is
// FE-resolved from `book.dimension` (single-source TS, NOT re-derived server-side).
// BE loops every spread, renders + persists `spreads[i].thumbnail_url` leaf-write
// service-role (NO rtype-6 lock — peers refetch). `step_details[spreadId]` carries
// per-spread status + thumbnail_url the watcher merges optimistically.
// Spec: ai-storybook-design/api/jobs/17-enqueue-spread-thumbnails.md

export interface EnqueueSpreadThumbnailsParams {
  snapshot_id: string;
  canvas: { width: number; height: number };
  spread_ids?: string[];
  max_side?: number;
}

/** Per-spread progress detail in `background_jobs.step_details[spreadId]`. */
export interface SpreadThumbnailStepDetail {
  status: 'pending' | 'done' | 'failed' | 'skipped';
  thumbnail_url?: string;
  error_code?: string;
}

export interface EnqueueSpreadThumbnailsEnqueuedData {
  job_id: string;
  status: 'queued';
  type: 'spread_thumbnail';
  total_steps: number;
  skipped?: false;
  deduped?: false;
}

export interface EnqueueSpreadThumbnailsDedupedData {
  deduped: true;
  job_id: string;
  status: 'queued' | 'running';
}

export interface EnqueueSpreadThumbnailsSkippedData {
  skipped: true;
  reason: 'no_spreads';
}

export type EnqueueSpreadThumbnailsData =
  | EnqueueSpreadThumbnailsEnqueuedData
  | EnqueueSpreadThumbnailsDedupedData
  | EnqueueSpreadThumbnailsSkippedData;

/** Narrowing guards — 3-way union (enqueued | deduped | skipped). */
export function isSpreadThumbnailsDeduped(
  d: EnqueueSpreadThumbnailsData,
): d is EnqueueSpreadThumbnailsDedupedData {
  return (d as EnqueueSpreadThumbnailsDedupedData).deduped === true;
}

export function isSpreadThumbnailsSkipped(
  d: EnqueueSpreadThumbnailsData,
): d is EnqueueSpreadThumbnailsSkippedData {
  return (d as EnqueueSpreadThumbnailsSkippedData).skipped === true;
}

/** POST /api/jobs/spread-thumbnails (path verbatim — FastAPI, no kebab flatten).
 *  Returns parsed `data` on 2xx (enqueued/deduped/skipped — union preserved);
 *  throws `EnqueueJobError` (with backend `code` + `httpStatus`) on non-2xx. */
export async function enqueueSpreadThumbnails(
  params: EnqueueSpreadThumbnailsParams,
): Promise<EnqueueSpreadThumbnailsData> {
  log.info('enqueueSpreadThumbnails', 'request', {
    snapshotId: params.snapshot_id,
    canvasW: params.canvas.width,
    canvasH: params.canvas.height,
    spreadIdCount: params.spread_ids?.length,
    maxSide: params.max_side,
  });
  const result = await callImageApi<EnqueueJobResponse<EnqueueSpreadThumbnailsData>>(
    '/api/jobs/spread-thumbnails',
    {
      snapshot_id: params.snapshot_id,
      canvas: params.canvas,
      ...(params.spread_ids ? { spread_ids: params.spread_ids } : {}),
      ...(params.max_side != null ? { max_side: params.max_side } : {}),
    },
  );
  if (!result.success) {
    const failure = result as ImageApiFailure;
    log.error('enqueueSpreadThumbnails', 'failed', {
      snapshotId: params.snapshot_id,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
    });
    throw new EnqueueJobError(failure.error, failure.httpStatus, failure.errorCode);
  }
  return result.data;
}

/** POST /api/jobs/{jobId}/cancel */
export async function cancelJobRemote(
  jobId: string,
): Promise<EnqueueJobResponse<CancelJobData> | ImageApiFailure> {
  log.info('cancelJobRemote', 'request', { jobId });
  return callImageApi<EnqueueJobResponse<CancelJobData>>(
    `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    {},
  );
}
