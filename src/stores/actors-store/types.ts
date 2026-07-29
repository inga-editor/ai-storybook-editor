// actors-store/types.ts — Store shape split into per-slice interfaces.
// `ActorsStore` = intersection of all slice interfaces (parity remix-store).
// Each slice factory is typed `StateCreator<ActorsStore, SubscribeMw, [], XxxSlice>`
// so cross-slice `get()` sees the full store while each file owns only its surface.
//
// Design ref: ai-storybook-design/component/stores/actors-store.md

import type { StateCreator } from 'zustand';
import type {
  ActorPair,
  ActorStageKind,
  ActorJobPhase,
  AddActorInput,
  InjectResult,
} from '@/types/actors';
import type { SpreadTag } from '@/types/spread-types';
import type { BackgroundJob } from '@/stores/background-jobs-store';
import type { JobStatus } from '@/stores/background-jobs-store/types';
import type { ModelParamsBody, GrainBody } from '@/apis/jobs-api';
import type { ImportFinalEntry } from '../remix-store/stage-finals';

// Re-export the domain row type so consumers import from one surface.
export type { ActorPair } from '@/types/actors';

// ── Ephemeral job projection ─────────────────────────────────────────────────

/** Materialized projection of a `background_jobs` row scoped to the actor
 *  pipeline (jobs 14/15/16). Derived from `applyJobRow`; `phase === job.type`. */
export interface ActorJob {
  id: string;
  phase: ActorJobPhase;
  pairId: string;
  batchId: string;
  status: JobStatus;
  progress?: { done: number; total: number };
}

export type InjectUiState = 'idle' | 'running' | 'error';

/** 3-branch outcome of `startStageJob` (parity `EnqueueRemixJobOutcome`). */
export type EnqueueJobOutcome =
  | { kind: 'enqueued'; jobId: string; totalSteps: number }
  | { kind: 'deduped'; jobId: string; status: 'queued' | 'running' }
  | { kind: 'skipped'; reason: string };

/** Lean crop reference the swap-casting modal (phase 04) passes to seed a NEW
 *  stage batch. `nativeDim` is a native-piece px estimate → packed with
 *  `absolutePx: true` (composer rescales defensively). Structurally aligned with
 *  `ImportFinalEntry` so both add/import paths share one batch builder. */
export interface CropRef {
  spread_id: string;
  id: string; // layer id
  media_url: string;
  tags: SpreadTag[];
  nativeDim: { w: number; h: number };
}

// ── Per-slice interfaces ─────────────────────────────────────────────────────

/** Actor CRUD (bảng `actors`, RLS) + active selection. NEVER writes
 *  `books.casting_slot` (read-only với casting config — chốt 2026-07-29). */
export interface ActorsCrudSlice {
  actorPairs: ActorPair[];
  selectedPairId: string | null;

  /** INSERT 1 row. `23505 uq_actors_pair` (collaborator race) → SELECT existing
   *  row, toast.info, reuse (NOT an error). Selects the resulting row. */
  createActorPair: (input: AddActorInput) => Promise<ActorPair>;
  /** DELETE row. Does NOT touch `book.casting_slot` / `casting_slot.actors[]`. */
  deleteActorPair: (pairId: string) => Promise<void>;
  setSelectedPairId: (pairId: string | null) => void;
}

/** Stage pipeline (mixes/rmbgs/upscales) — LWW client-direct write to ONE stage
 *  column of the `actors` row. Optimistic + rollback on every write. Mirror of
 *  remix swap-slice; reuses the PURE crop-layout/finals helpers (never forks). */
export interface ActorsStageSlice {
  /** Seed a NEW batch of `stage` from an explicit crop subset (modal-supplied,
   *  phase 04). No selection ⇒ no-op warn. K=1, native-px pack. Resolves the new
   *  batch id on persist success, `null` on guard-miss / persist error (phase 08
   *  adapter auto-selects the freshly-created batch). */
  addStageBatch: (
    pairId: string,
    stage: ActorStageKind,
    cropSubset?: CropRef[],
  ) => Promise<string | null>;
  /** Import previous-stage finals (already-resolved entries) into a NEW batch.
   *  Resolves the new batch id on success, `null` on guard-miss / persist error. */
  importStageBatch: (
    pairId: string,
    stage: ActorStageKind,
    entries: ImportFinalEntry[],
  ) => Promise<string | null>;
  removeStageBatch: (
    pairId: string,
    stage: ActorStageKind,
    batchId: string,
  ) => Promise<void>;
  /** DESTRUCTIVE (clears `swap_results`) — caller MUST gate (confirm dialog). */
  appendStageBatchSheet: (
    pairId: string,
    stage: ActorStageKind,
    batchId: string,
  ) => Promise<void>;
  /** `sheetIndex` accepted for caller-API parity but unused (engine re-packs). */
  removeStageBatchSheet: (
    pairId: string,
    stage: ActorStageKind,
    batchId: string,
    sheetIndex: number,
  ) => Promise<void>;
  /** R5 take-back — set `is_final` on `(spreadId, layerId)` inside `batchId`,
   *  clear it on every other batch (per-stage mutex). Gated when a job of THAT
   *  stage is running. */
  takeFinalBack: (
    pairId: string,
    stage: ActorStageKind,
    spreadId: string,
    layerId: string,
    batchId: string,
  ) => Promise<void>;
}

/** Background-job enqueue + ephemeral projection (jobs 14/15/16). */
export interface ActorsJobsSlice {
  jobs: ActorJob[];

  /** POST /api/jobs/actors/{pairId}/{swap|rmbg|upscale} + optimistic seed into
   *  the unified BackgroundJobsStore (single ingest path). Guard: an
   *  already-running job of the SAME stage no-ops to `skipped`. Throws
   *  `EnqueueJobError` after toasting on a non-2xx (caller may ignore). */
  startStageJob: (args: {
    pairId: string;
    stage: ActorStageKind;
    batchId: string;
    modelParams?: ModelParamsBody;
    grain?: GrainBody;
  }) => Promise<EnqueueJobOutcome>;
  cancelJob: (jobId: string) => Promise<void>;
  dismissJob: (jobId: string) => void;

  /** Upsert a `background_jobs` row into `jobs[]` (progress/status). The index
   *  bridge fires `refetchPair` separately on the terminal transition. */
  applyJobRow: (row: BackgroundJob) => void;
}

/** Inject (phase 09) — SKELETON here. `injectState` is wired now. */
export interface ActorsInjectSlice {
  injectState: Record<string, InjectUiState>;
  injectActorFinals: (pairId: string) => Promise<InjectResult>;
}

/** Server sync. Bảng `actors` KHÔNG vào realtime publication → refetch on
 *  (a) mount, (b) job terminal, (c) sau own stage action. */
export interface ActorsSyncSlice {
  syncState: 'idle' | 'loading' | 'error';
  /** Full SELECT theo `snapshot_id`. */
  syncFromServer: (snapshotId: string) => Promise<void>;
  /** Scoped 1-row SELECT + in-place merge (post job terminal / own action). */
  refetchPair: (pairId: string) => Promise<void>;
  /** Đổi book/snapshot — clear all slice state. */
  reset: () => void;
}

// ── Composed store ───────────────────────────────────────────────────────────

export type ActorsStore = ActorsCrudSlice &
  ActorsStageSlice &
  ActorsJobsSlice &
  ActorsInjectSlice &
  ActorsSyncSlice;

/** Middleware tuple matching `index.ts` — `subscribeWithSelector` (no immer;
 *  `set` is plain merge-style — parity remix-store). */
export type ActorsStoreMutators = [['zustand/subscribeWithSelector', never]];

/** Slice factory signature — produces only `XxxSlice` but `get()` sees the full
 *  `ActorsStore` for cross-slice calls. */
export type ActorsSliceCreator<XxxSlice> = StateCreator<
  ActorsStore,
  ActorsStoreMutators,
  [],
  XxxSlice
>;
