// remix-store/types.ts — Store shape split into per-slice interfaces.
// `RemixStore` = intersection of all slice interfaces. Each slice factory is
// typed `StateCreator<RemixStore, SubscribeMw, [], XxxSlice>` so cross-slice
// `get()` sees the full store while each file owns only its own surface.

import type { StateCreator } from 'zustand';
import type {
  EnqueueRemixJobOutcome,
  InjectResult,
  Remix,
  RemixConfig,
  RemixCropSheet,
  RemixJob,
  RemixSpread,
  RemixSpreadImage,
  StageKind,
  StartDetectJobParams,
  StartStageJobParams,
  StartSpriteSwapParams,
} from '@/types/remix';
import type { Distribution } from '@/types/editor';
import type { JobEvent } from '@/stores/background-jobs-store';

// ── Patch shape exposed by job/runner helpers ────────────────────────────────
// Discriminated union — `patch` (legacy single-sheet merge) vs `replaceAll`
// (variant relayout rewrites every sheet in deterministic raw-variant order).
// Validation session 1: union shape required because variant relayout cannot
// be expressed as N independent index-based patches (sheet count + ordering
// both change atomically).

// ⚡2026-06-12: crop sheets live on STAGE batches (`mixes`/`rmbgs`/`upscales`
// columns — same row shape). `stage` selects the column; `entityKey` is the
// batch uuid within that column.
export type CropSheetUpdate =
  | {
      kind: 'patch';
      stage: StageKind;
      entityKey: string;
      /** Index into batch.crop_sheets[]. */
      sheetIndex: number;
      patch: Partial<RemixCropSheet>;
    }
  | {
      kind: 'replaceAll';
      stage: StageKind;
      entityKey: string;
      sheets: RemixCropSheet[];
    };

/** Backward-compat alias — existing import paths keep building. New code
 *  should prefer `CropSheetUpdate`. */
export type RemixCropSheetPatch = CropSheetUpdate;

// ── Audio job enqueue options ────────────────────────────────────────────────

export interface StartAudioJobOptions {
  triggeredBy: 'auto-create' | 'user';
  /** Override default CLIENT_AUDIO_CHUNK_CAP. Backend may clamp further. */
  maxConcurrentChunksPerTextbox?: number;
}

// ── Per-slice interfaces ─────────────────────────────────────────────────────

/** Remix CRUD + active selection + illustration/crop-sheet patching. */
export interface RemixCrudSlice {
  remixes: Remix[];
  activeRemixId: string | null;

  createRemix: (config: RemixConfig, name?: string) => Promise<Remix | null>;
  renameRemix: (id: string, name: string) => Promise<boolean>;
  deleteRemix: (id: string) => Promise<boolean>;
  setActiveRemixId: (id: string | null) => void;

  /** Persist `remixes.distribution` (client writes is_enabled only; job handler
   *  owns status/media). Optimistic full-column set + Supabase PATCH + rollback.
   *  Mirrors BookStore.updateBook for the book source. */
  updateRemixDistribution: (id: string, dist: Distribution) => Promise<boolean>;

  patchRemixIllustration: (id: string, spreads: RemixSpread[]) => void;
  patchRemixCropSheets: (id: string, updates: CropSheetUpdate[]) => void;

  /** Granular single-image-layer patch into `remix.illustration.spreads[].images[]` — binding
   *  for the remix image toolbar's Edit modal (`onUpdateIllustrations`). Mirrors
   *  `injectFinalCrops`: optimistic local merge of `patch` into the matched image, then ONE
   *  Supabase UPDATE of the full `illustration` column; rollback via `refetchRemix` on persist
   *  failure. Same column as Inject (last-write-wins, no merge guard). Throws
   *  `REMIX_NOT_FOUND` / `SPREAD_NOT_FOUND` / `IMAGE_NOT_FOUND` on a missing target, or the
   *  Supabase error message on persist failure. */
  updateRemixSpreadImage: (
    remixId: string,
    spreadId: string,
    imageId: string,
    patch: Partial<RemixSpreadImage>,
  ) => Promise<void>;
}

/** Remote background_jobs (audio/mix swap): enqueue, cancel, dismiss. Plus the
 *  synchronous client-side Inject finalize (`injectFinalCrops`, no job). */
export interface RemixJobsSlice {
  jobs: RemixJob[];

  startAudioJob: (
    remixId: string,
    opts: StartAudioJobOptions,
  ) => Promise<EnqueueRemixJobOutcome>;

  /** Inject (Phase 3 — client-side finalize). Resolves the is_final winner
   *  crops, mutates the illustration blob, optimistically updates local state,
   *  then persists the full `illustration` column in ONE Supabase UPDATE (no
   *  background job). Rollback via `refetchRemix` on persist failure. Pure:
   *  returns `InjectResult` or throws (`REMIX_NOT_FOUND` / `no final crops to
   *  inject` / persist error) — the UI handler owns the toast. */
  injectFinalCrops: (remixId: string) => Promise<InjectResult>;

  /** Modal-driven stage-batch job enqueue (⚡2026-06-12 generic — jobs
   *  05/09/10, replaces startMixSwap; validation S1 no alias). POST
   *  `/api/jobs/remix/{id}/{mix-swap|rmbg|upscale}` + optimistic seed of the
   *  stage's job phase. Guard: an already-running job of the SAME stage no-ops
   *  to `skipped` (3 stages are independent — disjoint JSONB columns). Throws
   *  `EnqueueJobError` (with `code`) on non-2xx so the modal can toast
   *  per-code. The job LOOP runs backend; the client only enqueues + reflects
   *  realtime job_upsert into `jobs[]`. */
  startStageJob: (
    params: StartStageJobParams,
  ) => Promise<EnqueueRemixJobOutcome>;

  /** Modal-driven sprite (Variants) crop-sheet swap (api/jobs/02). POST
   *  `/api/jobs/remix/{id}/sprite-swap` + optimistic seed `remix_sprite_swap`
   *  job. Guard: an already-running sprite swap for the same sprite no-ops to
   *  `skipped`. Independent of mix-swap (disjoint dedup key). Throws
   *  `EnqueueJobError` (with `code`) on 422/non-2xx so the modal can toast
   *  NO_SWAP_OBJECTS / MISSING_OBJECT_CONFIG distinctly. */
  startSpriteSwap: (
    params: StartSpriteSwapParams,
  ) => Promise<EnqueueRemixJobOutcome>;

  /** Modal-driven swap-defect detection — GENERIC over plane (api/jobs/11 sprite
   *  Variants Check | 12 mix Crops Check). POST
   *  `/api/jobs/remix/{id}/{detect-sprite-defects|detect-mix-defects}` (resolved
   *  from `DETECT_JOB_CONFIG[plane]`) + optimistic seed. Guard: an
   *  already-running detect for the same scope no-ops to `skipped`. Independent
   *  of swap AND of the other plane (disjoint dedup keys). Advisory/ephemeral:
   *  defects land in `background_jobs.result.defectsBySheet` (NOT persisted to
   *  `remixes`). Handles BOTH dedup contracts — sprite HTTP 200 `{deduped}` AND
   *  mix HTTP 409 `JOB_ALREADY_ACTIVE` (→ `deduped`, attach via realtime).
   *  Throws `EnqueueJobError` on other non-2xx — caller toasts non-fatal. */
  startDetectJob: (
    params: StartDetectJobParams,
  ) => Promise<EnqueueRemixJobOutcome>;

  cancelJob: (jobId: string) => Promise<void>;
  dismissJob: (jobId: string) => void;
}

/** Sprite lifecycle (Variants tab — add/remove sprite + append/remove sprite
 *  sheet + lazy seed). Mirror of the batch lifecycle on the `sprites[]` plane.
 *  Persists ONLY the `sprites` column (disjoint from `mixes`/`characters`). */
export interface RemixSpriteSlice {
  /** remixId → count of in-flight sprite LAYOUT computations (seed / relayout /
   *  add-subset). Layout measures every cell artwork's natural dimensions
   *  (`measureCellDims` image loads) — seconds on a cold cache — so the modal
   *  shows a loading state instead of an empty Sprites tab. Counted (not
   *  boolean) so overlapping ops don't clear each other's pending flag. */
  spriteLayoutPendingByRemix: Record<string, number>;

  /** Appends a NEW sprite as a SUBSET clone of the active sprite (modal "Add as
   *  Sprite" with per-cell selection). `selectedCellKeys` = a set of
   *  `${type}/${object_key}/${variant_key}` keys identifying the PRE-SWAP cells
   *  the user picked off the active sprite. K=1 sheet packed from the subset;
   *  new sprite ordered `max(order)+1`. Optimistic push + `sprites` persist with
   *  rollback. THROWS on empty selection / zero match (stale). Resolves the new
   *  sprite id on success, `null` on guard miss / persist failure. */
  addSprite: (
    remixId: string,
    activeSpriteId: string,
    selectedCellKeys: ReadonlySet<string>,
  ) => Promise<string | null>;

  /** Removes a sprite by id. Guarded so the last sprite (`SPRITE_MIN`) cannot be
   *  removed. Optimistic + rollback. Resolves `true` on success. */
  removeSprite: (remixId: string, spriteId: string) => Promise<boolean>;

  /** Appends one crop sheet to a sprite (clamped to the sprite's crop count).
   *  Re-packs the sprite's cells at K+1. DESTRUCTIVE: clears `swap_results` —
   *  caller MUST gate. Optimistic with rollback. */
  appendSpriteSheet: (remixId: string, spriteId: string) => Promise<boolean>;

  /** Removes one crop sheet from a sprite (clamped to `SHEET_MIN`). `sheetIndex`
   *  is accepted for caller-API parity but unused (engine re-packs from
   *  scratch). DESTRUCTIVE: clears `swap_results` — caller MUST gate. */
  removeSpriteSheet: (
    remixId: string,
    spriteId: string,
    sheetIndex: number,
  ) => Promise<boolean>;

  /** Lazy seed of `sprites[]` for a remix opened in the modal — guards
   *  `sprites.length >= 1` and seeds a K=1 sprite from all enabled-character
   *  variants (idempotent). Resolves `true` when a sprite was seeded. */
  ensureRemixSpriteSeed: (remixId: string) => Promise<boolean>;

  /** R5 user take-back — set `is_final=true` on the cell `(type, objectKey,
   *  variantKey)` inside `fromSpriteId` AND clear it on every other sprite
   *  (cross-sprite mutex). Persists `sprites` then re-applies finals to
   *  `characters`/`props`. Gated when `anySpriteSwapRunning` (defense-in-depth;
   *  UI already disables). Throws on gate reject; resolves `false` on guard miss
   *  / persist failure. */
  takeSpriteFinalBack: (
    remixId: string,
    type: 'character' | 'prop',
    objectKey: string,
    variantKey: string,
    fromSpriteId: string,
  ) => Promise<boolean>;
}

/** Stage-batch lifecycle (⚡2026-06-12 STAGE-GENERIC — validation S1: replaces
 *  the mix-only addBatch/removeBatch/appendBatchSheet/removeBatchSheet, NO
 *  alias). One generic engine resolves the column by `stage`. */
export interface RemixSwapSlice {
  /** Appends a NEW batch to `remix[stage]` as a SUBSET clone of the active
   *  batch (rev6 tick-flow — ALL 3 stages). `selectedCropKeys` is a set of
   *  `${spread_id}/${id}` keys identifying the PRE-JOB crops
   *  (`sheet.original_crops[]`, never `swap_results[].crops[]`) the user
   *  picked off the active batch. K=1 sheets packed from the subset (mixes:
   *  source-% re-scan; rmbgs/upscales: native px). THROWS on empty selection
   *  OR zero match (stale). Resolves the NEW batch id on persist success;
   *  `null` on guard miss / persist failure. */
  addStageBatch: (
    remixId: string,
    stage: StageKind,
    activeBatchId: string,
    selectedCropKeys: ReadonlySet<string>,
  ) => Promise<string | null>;

  /** Imports the PREVIOUS stage's finals into a NEW batch of `stage` (Import
   *  flow, rmbgs/upscales ONLY — 05-14). Copy-on-build snapshot, K=1,
   *  native-px dims. THROWS on empty/stale selection. Resolves the new batch
   *  id; `null` on guard miss / persist failure. */
  importStageBatch: (
    remixId: string,
    stage: 'rmbgs' | 'upscales',
    selectedFinalKeys: ReadonlySet<string>,
  ) => Promise<string | null>;

  /** Lazy seed of `mixes[]` for a remix opened in the modal — guards
   *  `mixes.length >= 1` and delegates to `migrateLegacyRemixToBatch`
   *  (idempotent). Stage 'mixes' ONLY — rmbgs/upscales never seed. */
  seedInitialBatchIfMissing: (remixId: string) => Promise<boolean>;

  /** Removes a batch from a stage column. `BATCH_MIN` guard applies to stage
   *  'mixes' only; rmbgs/upscales may drop to 0 batches (empty-state CTA).
   *  Optimistic + rollback. Resolves `true` on success. */
  removeStageBatch: (
    remixId: string,
    stage: StageKind,
    batchId: string,
  ) => Promise<boolean>;

  /** Appends one crop sheet to a stage batch (clamped to the batch's crop
   *  count) — re-packs the batch's crops at K+1. DESTRUCTIVE: clears the batch's
   *  `swap_results` — caller MUST gate (confirm dialog). */
  appendStageBatchSheet: (
    remixId: string,
    stage: StageKind,
    batchId: string,
  ) => Promise<boolean>;

  /** Removes one crop sheet (clamped to `SHEET_MIN`). `sheetIndex` accepted
   *  for caller-API parity but unused (engine re-packs from scratch).
   *  DESTRUCTIVE: clears the batch's `swap_results` — caller MUST gate. */
  removeStageBatchSheet: (
    remixId: string,
    stage: StageKind,
    batchId: string,
    sheetIndex: number,
  ) => Promise<boolean>;

  /** R5 user take-back — set `is_final=true` on the crop matching
   *  `(spreadId, layerId)` inside `fromBatchId` AND clear `is_final` on every
   *  other batch's crop with the same key. ⚡2026-06-12: the mutex is
   *  PER-STAGE — `stage` selects the column; gated when a job of THAT stage is
   *  running. Throws on gate reject; resolves `false` on guard miss or persist
   *  failure (rolled back). */
  takeFinalBack: (
    remixId: string,
    stage: StageKind,
    spreadId: string,
    layerId: string,
    fromBatchId: string,
  ) => Promise<boolean>;
}

/** Server sync: snapshot remix load, realtime event apply, targeted refetch. */
export interface RemixSyncSlice {
  /** True once `syncFromServer` has completed at least one SUCCESSFUL load
   *  (set in the same commit that populates `remixes`). Drives the Remix Editor
   *  sub-app's one-shot `?remix=` preselect — it must wait for the first server
   *  sync before deciding a deeplinked remix id is missing. Reset by `clearAll`. */
  hasSyncedOnce: boolean;

  syncFromServer: (snapshotId: string) => Promise<void>;
  clearAll: () => void;

  /** ADR-037 consumer hook — receives every remix-swap job event from the
   *  unified BackgroundJobsStore (predicate-filtered to the 3 remix types).
   *  Derives the `jobs[]` projection (upsert + prune lineage) and fires a
   *  targeted `refetchRemix` on the terminal transition. */
  onRemixJobEvent: (event: JobEvent) => void;
  /** Targeted single-remix refetch. Triggered when a background job for
   *  that remix transitions to a terminal status — DB row may have new
   *  illustration/audio chunk URLs the local copy doesn't reflect. */
  refetchRemix: (remixId: string) => Promise<void>;

  /** Lazy migration of a legacy remix to the rev2 batch model. Idempotent —
   *  only runs when a legacy shape is detected (no batch / `mixes[].keys[]` /
   *  entity crops). Rebuilds `mixes` as a single batch from `groupCropsForBatch`
   *  (reads frozen illustration tags), clears entity `crop_sheets`, and persists
   *  `{ mixes, characters, props }` once. Called by the modal root on-mount
   *  (Phase 06). No-op (resolves `false`) when no migration needed. */
  migrateLegacyRemixToBatch: (remixId: string) => Promise<boolean>;
}

// ── Composed store ───────────────────────────────────────────────────────────

export type RemixStore = RemixCrudSlice &
  RemixJobsSlice &
  RemixSwapSlice &
  RemixSpriteSlice &
  RemixSyncSlice;

/** Middleware tuple matching `index.ts` — `subscribeWithSelector` wraps the
 *  store creator (no immer; `set` is plain merge-style). Slice factories use
 *  this so `set`/`get` typings line up with the composed store. */
export type RemixStoreMutators = [['zustand/subscribeWithSelector', never]];

/** Slice factory signature: produces only `XxxSlice` but `get()` sees the
 *  full `RemixStore` for cross-slice calls. */
export type RemixSliceCreator<XxxSlice> = StateCreator<
  RemixStore,
  RemixStoreMutators,
  [],
  XxxSlice
>;
