// sketch-spread-generate-job-slice.ts — orchestrates SEQUENTIAL sketch spread-image generation.
// One job = N spreads, one API call per spread, run one-at-a-time in DOC-ORDER (position in
// sketch.spreads[]). After each page resolves: prepend a versioned backdrop
// (addSketchSpreadImageVersion) then AWAIT the write so it lands in the DB before the next
// page/spread — per-page durability (the UI fills in gradually / survives a reload; the backend
// no longer reads prior spreads — 2026-07-21). Two write paths: under collabPersist the per-page node goes
// through the resource-lock gateway (create-vs-upload, see persistPageImage); in the legacy solo
// path it is flushSnapshot(). Partial failures never abort the job.
//
// Differs from sketch-generate-job-slice (entity sheets): 1 task = 1 spread (no `kind`), no
// snapshotId param (resolved from meta.id AFTER an initial flush — a brand-new unsaved book has
// no snapshot row until then), and the per-spread flush is AWAITED (not fire-and-forget).
//
// Async rule (mirrors image-task-slice): runJob is a PLAIN async function (NOT inside an immer
// producer). Every mutation between awaits goes through a synchronous set((state)=>…) producer.
// After each await we re-read the job and bail if it was replaced/reset (race guard).

import type { StateCreator } from 'zustand';
import type {
  SnapshotStore,
  SketchSpreadGenerateJobSlice,
  SketchSpreadGenerateTask,
  SketchSpreadTaskError,
  SpreadRefFailure,
} from '../types';
import { callGenerateSketchSpread } from '@/apis/sketch-spread-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { SketchSpread, SketchPageType, SketchSpreadImage } from '@/types/sketch';
// resource-lock-store is loaded by snapshot-store/index (line 6) BEFORE the slices, so this static
// import resolves cleanly in the app. The isolated slice unit tests import this module directly
// (bypassing index) and therefore mock '@/stores/resource-lock-store' to avoid the module cycle
// (slice → resource-lock-store → auth-store → snapshot-store/index → slice).
import {
  useResourceLockStore,
  ACTION_TYPE_CREATE,
  type LockTarget,
  type ResourceLockState,
  type SavePayload,
} from '@/stores/resource-lock-store';
import {
  insertGenerateSummaryLog,
  ACTION_TYPE_UPLOAD,
  TARGET_TYPE_SPREAD,
} from '@/apis/activity-log-client';
import { toast } from 'sonner';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'SketchSpreadGenerateJobSlice');

/** LockTarget for one spread PER-PAGE image (resource_type 1, language-agnostic). The
 *  resource_id is the SketchSpreadImage.id — matches the canvas's image lock (phase 04). */
function imageLockTarget(imageId: string): LockTarget {
  return { step: 1, resource_type: 1, resource_id: imageId, locale: null };
}

/** LockTarget for the WHOLE spread (structural, resource_type 6) — the job's advisory GENERATE
 *  lock, acquired per spread BEFORE any AI call. Same key the sidebar's edit/delete ops acquire,
 *  so while a spread generates the peer's sidebar row greys and their structural ops are 409'd. */
function spreadLockTarget(spreadId: string): LockTarget {
  return { step: 1, resource_type: 6, resource_id: spreadId, locale: null };
}

/** 1-based doc-order "spread #N" of a spread (audit `spread_number`), or 0 if not found. */
function spreadNumber(spreadId: string, spreads: SketchSpread[]): number {
  const idx = spreads.findIndex((s) => s.id === spreadId);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * Pages to generate for a spread, IN ORDER: 'full' alone, else 'left' BEFORE 'right'. The old
 * reason (backend folded the left page into the right page's consistency refs) died with the
 * 2026-07-21 minimal-prompt rework — the ordering is kept as a cosmetic/durability convention
 * (left lands in the DB first), NOT a consistency condition. Sorted explicitly, not pages[] order.
 */
function orderedPageTypes(spread: SketchSpread): SketchPageType[] {
  const present = new Set(spread.pages.map((p) => p.type));
  if (present.has('full')) return ['full'];
  return (['left', 'right'] as SketchPageType[]).filter((t) => present.has(t));
}

// Backend error codes → Vietnamese FALLBACK copy (2026-07-21 error-detail plan). Used ONLY
// when the response body carried no message — the backend-built `error.message` wins
// (BE owns the user-facing copy; for REFERENCE_IMAGE_MISSING it is already VI + N-specific).
// (ART_STYLE_* entries removed 2026-07-21 — the backend no longer reads art styles.)
const SKETCH_SPREAD_ERROR_MESSAGES: Record<string, string> = {
  REFERENCE_IMAGE_MISSING: 'Thiếu ảnh tham chiếu cho một số đối tượng',
  SPREAD_NO_ART_DIRECTION: 'Trang chưa có nội dung art direction',
  PAGE_NOT_IN_SPREAD: 'Trang không tồn tại trong spread',
  SNAPSHOT_NOT_FOUND: 'Không tìm thấy dữ liệu sách (snapshot)',
  SPREAD_NOT_FOUND: 'Không tìm thấy spread',
  UNSUPPORTED_MODEL: 'Model không được hỗ trợ',
  VALIDATION_ERROR: 'Dữ liệu gửi lên không hợp lệ',
  LLM_ERROR: 'Dịch vụ AI gặp sự cố — thử lại sau',
  NO_IMAGE_IN_RESPONSE: 'AI không trả về ảnh (có thể bị chặn bởi bộ lọc)',
  PROMPT_TEMPLATE_NOT_FOUND: 'Thiếu cấu hình prompt (liên hệ admin)',
  STORAGE_UPLOAD_ERROR: 'Lỗi lưu ảnh lên máy chủ',
  TIMEOUT: 'Máy chủ phản hồi quá lâu — thử lại',
  CONNECTION_ERROR: 'Mất kết nối máy chủ — thử lại',
};

const SKIPPED_DELETED_MESSAGE = 'Skipped — spread was deleted';
const PERSIST_FAILED_MESSAGE = 'Image generated but could not be saved — please try again';
/** A page generated but its lock was held by ANOTHER editor → the gateway save would 409, so the
 *  image only lives in this session's store. Distinct wording: retrying now would fail the same
 *  way, the user has to wait for the other editor. */
const PERSIST_LOCK_BLOCKED_MESSAGE =
  'Image generated but not saved — another editor is holding this page';

/** Array on a sketch spread node that holds the per-page image nodes (nested-CREATE collection). */
const SPREAD_IMAGES_COLLECTION = 'images';

/** Generic terminal fallback when neither the body nor the code map gives a message. */
const GENERIC_SPREAD_ERROR_MESSAGE = 'Tạo ảnh spread thất bại';

/**
 * Maps an ImageApiFailure (or a non-success result) to a STRUCTURED task error —
 * replaces the old string-flattening classifyError. `failures[]` (when the backend
 * sent them — REFERENCE_IMAGE_MISSING) passes through VERBATIM: the messages are
 * already complete Vietnamese lines built backend-side. Backend `error.message`
 * wins over the local code map (BE owns the copy); the map is body-less fallback only.
 */
function buildTaskError(result: { error?: string }, page?: SketchPageType): SketchSpreadTaskError {
  const f = result as ImageApiFailure;
  const rawFailures = f.errorDetails?.failures;
  const failures = Array.isArray(rawFailures) ? (rawFailures as SpreadRefFailure[]) : undefined;
  // A body-less response degrades to the client's "HTTP <status> …" placeholder — that is
  // NOT a backend-built message, so the VI code map outranks it. Any real body message wins.
  const isBodylessFallback = !f.error || /^HTTP \d/.test(f.error);
  const message =
    (!isBodylessFallback ? f.error : undefined) ||
    (f.errorCode && SKETCH_SPREAD_ERROR_MESSAGES[f.errorCode]) ||
    f.error ||
    GENERIC_SPREAD_ERROR_MESSAGE;
  return { message, errorCode: f.errorCode, httpStatus: f.httpStatus, failures, page };
}

/** Typed throw carrying the structured task error through the per-spread try/catch —
 *  keeps the abort-this-spread control flow without flattening back to a string. */
class SpreadPageGenError extends Error {
  readonly taskError: SketchSpreadTaskError;
  constructor(taskError: SketchSpreadTaskError) {
    super(taskError.message);
    this.name = 'SpreadPageGenError';
    this.taskError = taskError;
  }
}

/** Catch-site normalizer: unwrap a SpreadPageGenError, wrap anything else as message-only. */
function toTaskError(err: unknown): SketchSpreadTaskError {
  if (err instanceof SpreadPageGenError) return err.taskError;
  return { message: err instanceof Error ? err.message : GENERIC_SPREAD_ERROR_MESSAGE };
}

export const createSketchSpreadGenerateJobSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  SketchSpreadGenerateJobSlice
> = (set, get) => {
  /** status = cancelled if a cancel was requested, else completed. Only if still the active job.
   *  Also RETAINS the failed tasks into `sketchSpreadLastErrors` in the SAME producer — the
   *  notifications hook dismisses (nulls) the job right after the toast, and the error-detail
   *  modal must still have data to render after that. */
  function finalize(jobId: string): void {
    set((state) => {
      const j = state.sketchSpreadGenerateJob;
      if (!j || j.id !== jobId) return;
      j.status = j.cancelRequested ? 'cancelled' : 'completed';
      j.currentIndex = -1;
      j.completedAt = new Date().toISOString();
      const spreads = state.sketch.spreads;
      // `skipped` tasks (all pages 409-blocked by another editor) are excluded: they are
      // NOT generation failures (their own type contract) and the summary toast already
      // reports them separately as "K skipped (being edited)".
      state.sketchSpreadLastErrors = j.tasks
        .filter((t) => t.status === 'error' && t.error !== undefined && !t.skipped)
        .map((t) => {
          const idx = spreads.findIndex((s) => s.id === t.spreadId);
          return {
            spreadId: t.spreadId,
            // Current doc-order number; a spread deleted mid-job falls back to its
            // enqueue-time ordinal so the modal still names it.
            spreadNumber: idx >= 0 ? idx + 1 : t.ordinal,
            page: t.error?.page,
            error: t.error!,
          };
        });
      log.debug('finalize', 'retained last errors', {
        jobId,
        errorCount: state.sketchSpreadLastErrors.length,
      });
    });
  }

  /** Resolve the per-page image node id for (spread, page): reuse the existing node's id, else mint a
   *  fresh uuid. Called BEFORE the generate call so the opt-in saveResource directive and the
   *  addSketchSpreadImageVersion node-create share ONE id — the BE nested-create + the client prepend
   *  address the SAME node (else two nodes for one page). Read FRESH via get() ('left' may have minted
   *  its node just before 'right'). */
  function resolveSpreadPageImageId(spreadId: string, pageType: SketchPageType): string {
    const existing = get()
      .sketch.spreads.find((s) => s.id === spreadId)
      ?.images.find((im) => im.type === pageType);
    return existing?.id ?? crypto.randomUUID();
  }

  /** Column-relative `image_version` anchor for one spread page node (helper prepends snapshot root). */
  function spreadPageImagePath(spreadId: string, imageId: string): string {
    return `col:sketch/spread:${spreadId}/key:images/find:id=${imageId}`;
  }

  /** Mark task `i` SKIPPED because a peer holds its lock(s): counted in job.skipped + named for
   *  the summary toast. Shared by the Phase-0 spread-lock skip (blocked BEFORE any AI call) and
   *  the all-pages-blocked skip (every existing page image 409'd in Phase A). */
  function markSpreadSkipped(jobId: string, i: number, num: number): void {
    set((state) => {
      const j = state.sketchSpreadGenerateJob;
      if (!j || j.id !== jobId) return;
      j.skipped += 1;
      j.skippedNames.push(`spread #${num}`);
      j.tasks[i].status = 'error';
      j.tasks[i].skipped = true;
      j.tasks[i].error = { message: 'Skipped — being edited by another editor' };
      j.tasks[i].completedAt = new Date().toISOString();
    });
  }

  // Page-image nodes this session has already ATTEMPTED a gateway write for (the marker is set on
  // both the CREATE and the UPLOAD branch of persistPageImage; on the UPLOAD branch it is a no-op
  // because such ids are already pre-existing). A node minted by
  // addSketchSpreadImageVersion (crypto.randomUUID) has never been written, so its FIRST save must
  // be a nested CREATE — an UPLOAD would address an id the backend cannot resolve (404) and the
  // image would be lost on reload.
  // ATTEMPTED (not "succeeded") on purpose — as an OPTIMIZATION, not a correctness guard. The
  // gateway is id-aware on create: `resolve_snapshot_path` (image-api services/resource/
  // addressing.py) dispatches by resource_type FIRST — `_resolve_image` scans `spreads[].images[]`
  // for the node id — and only falls through to `_resolve_nested_create` when that finds nothing.
  // So a repeat CREATE carrying the SAME id resolves to the existing index and overwrites it in
  // place; it does NOT append a duplicate. Marking on attempt therefore costs nothing and saves a
  // redundant UPLOAD→404→CREATE round-trip on the next save of a node we already created, while
  // that same fallback still recovers the case where the create never landed. Deliberately NOT
  // reset on book switch / snapshot reload: keys are UUIDs (no cross-book collision), set is tiny.
  const attemptedImageIds = new Set<string>();

  /** Nested-CREATE payload: append `img` at `sketch.spreads[i].images[]` under `spreadId`. */
  function buildCreatePayload(
    spreadId: string,
    img: SketchSpreadImage,
    targetRef: Record<string, unknown>,
  ): SavePayload {
    return {
      action_type: ACTION_TYPE_CREATE,
      parent_id: spreadId,
      collection: SPREAD_IMAGES_COLLECTION,
      patch: img,
      target_ref: targetRef,
      log: false,
    };
  }

  /**
   * Persist ONE page-image node through the gateway under the ALREADY-HELD image lock.
   * - brand-new node (client-minted id, never saved) → nested CREATE under the spread's `images[]`
   * - already-persisted node (regenerate) → UPLOAD on the node itself (version prepended in patch)
   * - UPLOAD → 404 (books corrupted by the pre-fix UPLOAD-only path) → retry ONCE as CREATE
   * Returns true when the write landed.
   *
   * The retry is hand-rolled here rather than delegated to the store's `create_fallback` seam
   * (which the canvas uses) because this path additionally needs the job race-guard between the
   * two awaits and per-page failure reporting back to the task.
   */
  async function persistPageImage(
    resourceLock: ResourceLockState,
    target: LockTarget,
    spreadId: string,
    pageType: SketchPageType,
    img: SketchSpreadImage,
    targetRef: Record<string, unknown>,
    isNew: boolean,
    isCurrentJob: () => boolean,
  ): Promise<boolean> {
    log.info('persistPageImage', 'persist page image', { spreadId, page: pageType });
    const createPayload = buildCreatePayload(spreadId, img, targetRef);
    log.debug('persistPageImage', isNew ? 'branch: create (new node)' : 'branch: update (upload)', {
      spreadId,
      page: pageType,
    });
    attemptedImageIds.add(img.id); // BEFORE the await — see attemptedImageIds (no server dedupe)
    let res = await resourceLock.save(
      target,
      isNew
        ? createPayload
        : { action_type: ACTION_TYPE_UPLOAD, patch: img, target_ref: targetRef, log: false },
    );
    if (!res.ok && !isNew && res.notFound) {
      // Race guard (module async rule): the job may have been replaced/reset during the save —
      // don't issue a second write for an abandoned job. The caller re-checks and returns
      // 'replaced' before it reads this result, so `false` here is never mis-reported.
      if (!isCurrentJob()) {
        log.debug('persistPageImage', 'job replaced — skip fallback create', { spreadId, page: pageType });
        return false;
      }
      log.debug('persistPageImage', 'branch: fallback create (node absent in DB)', {
        spreadId,
        page: pageType,
      });
      res = await resourceLock.save(target, createPayload);
    }
    if (res.ok) {
      log.info('persistPageImage', 'persisted', { spreadId, page: pageType });
      return true;
    }
    log.error('persistPageImage', 'page image did not persist', {
      spreadId,
      page: pageType,
      isNew,
      lost: res.lost,
      forbidden: res.forbidden,
      notFound: res.notFound,
    });
    return false;
  }

  // ── collab per-spread driver ────────────────────────────────────────────────────────────────
  // Holds the spread's advisory GENERATE lock (type 6, Phase 0 — blocked ⇒ whole spread skipped
  // BEFORE any AI call) plus a lock per PER-PAGE image, generates each page, and flushes DATA-ONLY through the gateway
  // save (log:false, create-vs-upload per persistPageImage) under the lock — replacing
  // autoSaveSnapshot/flushSnapshot (a no-op under collabPersist).
  // Returns: 'replaced' → caller returns from runJob (job reset); 'cancelled' →
  // caller breaks the loop; 'ok' → continue to the next spread. Releases ALL held image locks at
  // spread end (finally). Skip semantics: a page whose EXISTING image is 409-blocked is skipped;
  // a spread with ALL pages blocked counts as skipped (job.skipped); a partially-blocked spread
  // (≥1 page generated) counts as generated (partial spread — see risk note).
  async function processSpreadCollab(
    resourceLock: ResourceLockState,
    jobId: string,
    i: number,
    task: SketchSpreadGenerateTask,
    spread: SketchSpread,
    snapshotId: string,
    generatedSpreadNumbers: number[],
  ): Promise<'ok' | 'replaced' | 'cancelled'> {
    const pageTypes = orderedPageTypes(spread);
    const heldTargets: LockTarget[] = []; // image locks held for THIS spread (released at end)
    const skippedPages = new Set<SketchPageType>();
    const heldFor = (imageId: string): boolean =>
      heldTargets.some((t) => t.resource_id === imageId);
    // Image nodes present BEFORE this spread's generate → they came from the loaded snapshot, so
    // they are addressable in the DB (an UPLOAD resolves). Anything minted during the run below is
    // brand-new and needs a nested CREATE instead.
    const preExistingImageIds = new Set(spread.images.map((im) => im.id));
    let lastUrl = '';
    let cancelledMidSpread = false;
    let persistedAny = false; // ≥1 page write landed → peers must refetch (summary sync)
    // ≥1 GENERATED page did not land in the DB → the spread task is an error. NOT set for the
    // Phase-A skip of an existing image (nothing was generated there, nothing is lost).
    let persistFailed = false;
    let persistFailedMessage = PERSIST_FAILED_MESSAGE; // first failure names it (see below)

    try {
      // Phase 0 — advisory GENERATE lock on the whole spread (type 6), acquired BEFORE any AI
      // call. Closes the first-generate race: a page with no image yet has no image id to lock,
      // so without this two editors could both burn an AI call on the same new spread and the
      // loser would drop its result at the deferred Phase-B acquire. Blocked → skip the whole
      // spread for free (no generation). Held for the spread's duration (finally releases);
      // peers see the sidebar row grey and their Generate gate counts the spread as blocked.
      const spreadTarget = spreadLockTarget(task.spreadId);
      const spreadAcq = await resourceLock.acquire(spreadTarget);
      if (get().sketchSpreadGenerateJob?.id !== jobId) {
        if (spreadAcq.ok) heldTargets.push(spreadTarget); // finally releases
        return 'replaced';
      }
      if (!spreadAcq.ok) {
        log.info('processSpreadCollab', 'spread locked by another — skip before generate', {
          jobId,
          spreadId: task.spreadId,
          holder: spreadAcq.holder,
        });
        markSpreadSkipped(jobId, i, spreadNumber(task.spreadId, get().sketch.spreads));
        return 'ok';
      }
      heldTargets.push(spreadTarget);

      // Phase A — acquire locks for pages whose image already EXISTS, so both left+right are held
      // for the spread's duration. A page with no image yet (first generate) has no id to lock →
      // it is acquired right after creation in Phase B.
      for (const pageType of pageTypes) {
        const existing = spread.images.find((im) => im.type === pageType);
        if (!existing) continue;
        const target = imageLockTarget(existing.id);
        const acq = await resourceLock.acquire(target);
        if (get().sketchSpreadGenerateJob?.id !== jobId) {
          if (acq.ok) heldTargets.push(target); // finally releases
          return 'replaced';
        }
        if (acq.ok) {
          heldTargets.push(target);
        } else {
          log.info('processSpreadCollab', 'page image locked by another — skip page', {
            jobId,
            spreadId: task.spreadId,
            page: pageType,
            holder: acq.holder,
          });
          skippedPages.add(pageType);
        }
      }

      // Phase B — generate each non-skipped page IN ORDER (left before right), persist via gateway.
      for (const pageType of pageTypes) {
        if (skippedPages.has(pageType)) continue;
        const cur = get().sketchSpreadGenerateJob;
        if (!cur || cur.id !== jobId) return 'replaced';
        if (cur.cancelRequested) {
          cancelledMidSpread = true;
          break;
        }

        // Pre-mint (or reuse) the per-page image node id so the opt-in saveResource directive and the
        // client-side addSketchSpreadImageVersion node-create address the SAME node (BE-first double-write).
        const imageId = resolveSpreadPageImageId(task.spreadId, pageType);
        const result = await callGenerateSketchSpread({
          snapshotId,
          sketchSpreadId: task.spreadId,
          page: pageType,
          saveResource: buildImageVersionSaveResource(
            spreadPageImagePath(task.spreadId, imageId),
            snapshotId,
            'create',
          ),
        });
        if (get().sketchSpreadGenerateJob?.id !== jobId) return 'replaced';
        if (!result.success || !result.data) {
          throw new SpreadPageGenError(buildTaskError(result, pageType));
        }

        lastUrl = result.data.imageUrl;
        log.info('processSpreadCollab', 'spread page done', {
          jobId,
          spreadId: task.spreadId,
          page: pageType,
        });
        // Options object (arg 4). Semantics UNCHANGED from the old 5-positional call: raw generate
        // output carries `aiRequestId` + the pre-minted `imageId` only — deliberately NO `type`
        // (absent coerces to 'created' on read; writing it is a separate, out-of-scope change).
        get().addSketchSpreadImageVersion(task.spreadId, pageType, lastUrl, {
          aiRequestId: result.data.aiRequestId,
          imageId,
        });

        // Resolve the (now-existing) per-page image node + id; acquire its lock if it was deferred
        // (brand-new page), then save DATA-ONLY (log:false) so 'left' lands in the DB before 'right'
        // generates (backend consistency read) — replacing the flush-after-left.
        const img = get()
          .sketch.spreads.find((s) => s.id === task.spreadId)
          ?.images.find((im) => im.type === pageType);
        if (!img) {
          // Defensive: the version WAS generated but the node cannot be found, so nothing can be
          // written → the spread must report failed, never a green 'completed' with no DB row.
          log.error('processSpreadCollab', 'page image missing after version add — cannot save', {
            jobId,
            spreadId: task.spreadId,
            page: pageType,
          });
          persistFailed = true;
          continue;
        }
        const target = imageLockTarget(img.id);
        if (!heldFor(img.id)) {
          const acq = await resourceLock.acquire(target);
          if (get().sketchSpreadGenerateJob?.id !== jobId) {
            if (acq.ok) heldTargets.push(target);
            return 'replaced';
          }
          if (acq.ok) {
            heldTargets.push(target);
          } else {
            // FIRST generate of this page + the lock is held by someone else → the image exists
            // ONLY in this store and disappears on reload. That is a FAILURE, not a silent skip:
            // reporting 'completed' here is exactly the "thumbnail shown, image gone on reload"
            // bug. (The `skippedPages` skip-semantics above cover pages whose image ALREADY
            // exists in the DB — nothing is lost there.)
            log.error('processSpreadCollab', 'could not lock new page image — image not saved', {
              jobId,
              spreadId: task.spreadId,
              page: pageType,
              holder: acq.holder,
            });
            // FIRST failure names the message: with left+right both failing for DIFFERENT
            // reasons the generic "could not be saved" is the safer summary for the spread.
            if (!persistFailed) persistFailedMessage = PERSIST_LOCK_BLOCKED_MESSAGE;
            persistFailed = true;
            continue; // data is local; without a lock the gateway save would 409
          }
        }
        // CREATE-first for a node minted in THIS run (it has never existed in the DB), UPLOAD for
        // one that came from the loaded snapshot / was created earlier in the session.
        const isNew = !preExistingImageIds.has(img.id) && !attemptedImageIds.has(img.id);
        const saved = await persistPageImage(
          resourceLock,
          target,
          task.spreadId,
          pageType,
          img,
          { spread_number: spreadNumber(task.spreadId, get().sketch.spreads), page: pageType },
          isNew,
          () => get().sketchSpreadGenerateJob?.id === jobId,
        );
        if (get().sketchSpreadGenerateJob?.id !== jobId) return 'replaced';
        if (saved) persistedAny = true;
        else persistFailed = true;
      }

      const num = spreadNumber(task.spreadId, get().sketch.spreads);

      // Cancel arrived mid-spread → mark this task terminal (tasks[] has no 'cancelled' status), then
      // signal the outer loop to stop. A page that generated but did NOT persist is an error here
      // too (same rule as the normal completion branch below) — it would vanish on reload.
      if (cancelledMidSpread) {
        if (lastUrl && persistedAny) generatedSpreadNumbers.push(num);
        set((state) => {
          const j = state.sketchSpreadGenerateJob;
          if (!j || j.id !== jobId) return;
          if (lastUrl) {
            j.tasks[i].status = persistFailed ? 'error' : 'completed';
            if (persistFailed) j.tasks[i].error = { message: persistFailedMessage };
            j.tasks[i].imageUrl = lastUrl;
          } else {
            j.tasks[i].status = 'error';
            j.tasks[i].error = { message: 'Cancelled before this spread finished' };
          }
          j.tasks[i].completedAt = new Date().toISOString();
        });
        return 'cancelled';
      }

      if (lastUrl) {
        // ≥1 page generated → success (partial if a page was skip-blocked — partial-spread risk).
        // A page whose write did NOT land marks the whole spread failed: the image only lives in
        // the store and would vanish on reload, so the user must see it (never swallowed).
        if (persistedAny) generatedSpreadNumbers.push(num);
        if (persistFailed) {
          log.error('processSpreadCollab', 'spread image not persisted', {
            jobId,
            spreadId: task.spreadId,
            partial: persistedAny,
          });
        }
        set((state) => {
          const j = state.sketchSpreadGenerateJob;
          if (!j || j.id !== jobId) return;
          j.tasks[i].status = persistFailed ? 'error' : 'completed';
          if (persistFailed) j.tasks[i].error = { message: persistFailedMessage };
          j.tasks[i].imageUrl = lastUrl;
          j.tasks[i].completedAt = new Date().toISOString();
        });
      } else if (skippedPages.size > 0 && skippedPages.size === pageTypes.length) {
        // ALL pages blocked by other editors → the whole spread is SKIPPED (not a failure).
        markSpreadSkipped(jobId, i, num);
      } else {
        // No url and not all-skipped (e.g. spread has no pages) → defensive error.
        set((state) => {
          const j = state.sketchSpreadGenerateJob;
          if (!j || j.id !== jobId) return;
          j.tasks[i].status = 'error';
          j.tasks[i].error = { message: 'No page generated' };
          j.tasks[i].completedAt = new Date().toISOString();
        });
      }
      return 'ok';
    } catch (err) {
      if (get().sketchSpreadGenerateJob?.id !== jobId) return 'replaced';
      const taskErr = toTaskError(err);
      log.error('processSpreadCollab', 'spread failed', {
        jobId,
        spreadId: task.spreadId,
        error: taskErr.message,
        errorCode: taskErr.errorCode,
        failuresCount: taskErr.failures?.length ?? 0,
      });
      set((state) => {
        const j = state.sketchSpreadGenerateJob;
        if (!j || j.id !== jobId) return;
        j.tasks[i].status = 'error';
        j.tasks[i].error = taskErr;
        j.tasks[i].completedAt = new Date().toISOString();
      });
      return 'ok'; // NO abort — continue to the next spread
    } finally {
      for (const t of heldTargets) await resourceLock.release(t); // release spread + image locks at spread end
    }
  }

  // Sequential driver. Fire-and-forget from startSketchSpreadGenerateJob (never awaited).
  async function runJob(jobId: string): Promise<void> {
    const initial = get().sketchSpreadGenerateJob;
    if (!initial || initial.id !== jobId) return;

    // collabPersist = inside a sketch collab space (always true in practice). When true every write
    // routes through the resource-lock gateway (per-page save, log:false) + ONE summary audit row.
    // When false (legacy solo path) keep the autoSaveSnapshot/flushSnapshot flow untouched (KISS).
    // actorId for the summary row = resourceLock.myUserId (auth user id resolved at connect).
    const resourceLock = useResourceLockStore.getState();
    const collab = resourceLock.collabPersist;

    // Initial flush (LEGACY only): under collab, autoSaveSnapshot is suppressed so flushSnapshot is a
    // no-op — pending edits are already gateway-persisted per-resource, and a collab book already has
    // meta.id. In legacy solo mode we still flush to land edits + mint the snapshot row.
    if (!collab) {
      await get().flushSnapshot();
      if (get().sketchSpreadGenerateJob?.id !== jobId) return; // reset during flush
    }

    const snapshotId = get().meta.id;
    if (!snapshotId) {
      log.warn('runJob', 'no snapshot id — cannot generate', { jobId, collab });
      finalize(jobId);
      toast.error('Save the book first, then generate spread images.');
      return;
    }

    const generatedSpreadNumbers: number[] = []; // spreads that produced ≥1 page (summary ref)
    const taskCount = initial.tasks.length;
    for (let i = 0; i < taskCount; i++) {
      const job = get().sketchSpreadGenerateJob;
      if (!job || job.id !== jobId) return; // reset / replaced by a new job
      if (job.cancelRequested) break; // cancel = stop before the next spread

      const task = job.tasks[i];
      const spread = get().sketch.spreads.find((s) => s.id === task.spreadId);

      if (!spread) {
        log.warn('runJob', 'spread deleted mid-job — skip', { jobId, spreadId: task.spreadId });
        set((state) => {
          const j = state.sketchSpreadGenerateJob;
          if (!j || j.id !== jobId) return;
          j.tasks[i].status = 'error';
          j.tasks[i].error = { message: SKIPPED_DELETED_MESSAGE };
          j.tasks[i].completedAt = new Date().toISOString();
        });
        continue;
      }

      set((state) => {
        const j = state.sketchSpreadGenerateJob;
        if (!j || j.id !== jobId) return;
        j.currentIndex = i;
        j.tasks[i].status = 'running';
        j.tasks[i].startedAt = new Date().toISOString();
      });

      if (collab) {
        const outcome = await processSpreadCollab(
          resourceLock,
          jobId,
          i,
          task,
          spread,
          snapshotId,
          generatedSpreadNumbers,
        );
        if (outcome === 'replaced') return; // job reset — abandon (locks already released)
        if (outcome === 'cancelled') break; // stop the whole job cleanly
        continue; // 'ok' → next spread
      }

      // ── LEGACY solo path (collabPersist false) — unchanged flush-based flow ──
      try {
        // PER-PAGE loop: 'full' → 1 call; 2-page → 'left' then 'right'. One API call = one page.
        const pageTypes = orderedPageTypes(spread);
        let lastUrl = '';
        let cancelledMidSpread = false;

        for (const pageType of pageTypes) {
          // Re-check cancel / job-replacement BEFORE each page call → clean stop between left→right.
          const cur = get().sketchSpreadGenerateJob;
          if (!cur || cur.id !== jobId) return;
          if (cur.cancelRequested) {
            cancelledMidSpread = true;
            break;
          }

          // Pre-mint (or reuse) the per-page image node id so the opt-in saveResource directive and
          // the client-side addSketchSpreadImageVersion node-create share ONE id (BE-first double-write).
          const imageId = resolveSpreadPageImageId(task.spreadId, pageType);
          const result = await callGenerateSketchSpread({
            snapshotId,
            sketchSpreadId: task.spreadId,
            page: pageType,
            saveResource: buildImageVersionSaveResource(
              spreadPageImagePath(task.spreadId, imageId),
              snapshotId,
              'create',
            ),
          });

          if (get().sketchSpreadGenerateJob?.id !== jobId) return; // race: job replaced during await
          if (!result.success || !result.data) {
            throw new SpreadPageGenError(buildTaskError(result, pageType));
          }

          lastUrl = result.data.imageUrl;
          log.info('runJob', 'spread page done', { jobId, spreadId: task.spreadId, page: pageType });

          // Prepend the version (sync.isDirty) into the page's slot (same id as the directive).
          // Options object (arg 4); semantics unchanged — aiRequestId + imageId only, NO `type`.
          get().addSketchSpreadImageVersion(task.spreadId, pageType, lastUrl, {
            aiRequestId: result.data.aiRequestId,
            imageId,
          });

          // Flush AFTER 'left' (before 'right') — per-page durability only (the backend no longer
          // reads the left page for 'right'; consistency refs died 2026-07-21).
          if (pageType === 'left' && pageTypes.includes('right')) {
            await get().flushSnapshot();
            if (get().sketchSpreadGenerateJob?.id !== jobId) return; // race: reset during flush
          }
        }

        // Cancel arrived mid-spread → stop the whole job cleanly; finalize() marks it 'cancelled'.
        // Mark THIS task terminal too (the tasks[] status has no 'cancelled' member) — otherwise it
        // stays 'running' and the per-page spinner overlay never clears until the next job replaces
        // the job object. Any page already generated was persisted (flush-after-left): if a page
        // landed, the task is 'completed' (its image exists); if cancel hit before the first page
        // produced anything, it's 'error'.
        if (cancelledMidSpread) {
          set((state) => {
            const j = state.sketchSpreadGenerateJob;
            if (!j || j.id !== jobId) return;
            if (lastUrl) {
              j.tasks[i].status = 'completed';
              j.tasks[i].imageUrl = lastUrl;
            } else {
              j.tasks[i].status = 'error';
              j.tasks[i].error = { message: 'Cancelled before this spread finished' };
            }
            j.tasks[i].completedAt = new Date().toISOString();
          });
          break;
        }

        set((state) => {
          const j = state.sketchSpreadGenerateJob;
          if (!j || j.id !== jobId) return;
          j.tasks[i].status = 'completed';
          j.tasks[i].imageUrl = lastUrl;
          j.tasks[i].completedAt = new Date().toISOString();
        });

        // AWAIT the flush after the whole spread — durability between spreads (the backend no
        // longer reads previous spreads; PREVIOUS_SPREADS_SHEET died 2026-07-21).
        await get().flushSnapshot();
        if (get().sketchSpreadGenerateJob?.id !== jobId) return; // race: reset during flush
      } catch (err) {
        if (get().sketchSpreadGenerateJob?.id !== jobId) return;
        const taskErr = toTaskError(err);
        log.error('runJob', 'spread failed', {
          jobId,
          spreadId: task.spreadId,
          error: taskErr.message,
          errorCode: taskErr.errorCode,
          failuresCount: taskErr.failures?.length ?? 0,
        });
        set((state) => {
          const j = state.sketchSpreadGenerateJob;
          if (!j || j.id !== jobId) return;
          j.tasks[i].status = 'error';
          j.tasks[i].error = taskErr;
          j.tasks[i].completedAt = new Date().toISOString();
        });
        // NO break — partial success: continue to the next spread.
      }
    }

    // Summary audit (collab only) — ONE client-direct row per job, when ≥1 spread generated.
    // Drop 0 sentinels (spreadNumber() returns 0 for a spread concurrently deleted by
    // another editor) so the audit feed never shows a bogus "spread #0".
    const auditSpreadNumbers = generatedSpreadNumbers.filter((n) => n > 0);
    if (collab && auditSpreadNumbers.length > 0) {
      void insertGenerateSummaryLog({
        bookId: get().meta.bookId ?? '',
        actorId: resourceLock.myUserId ?? '',
        actionType: ACTION_TYPE_UPLOAD,
        targetType: TARGET_TYPE_SPREAD,
        targetRef: { spread_numbers: auditSpreadNumbers, count: auditSpreadNumbers.length },
        // content-sync scope 'set': a peer refetches + whole-replaces sketch.spreads at the
        // active version (one summary event covers the whole generate job).
        metadata: {
          sync: { scope: 'set', version: get().meta.id ?? '', targets: [{ column: 'sketch', path: ['spreads'] }] },
        },
      });
    }

    finalize(jobId);
  }

  return {
    sketchSpreadGenerateJob: null,
    sketchSpreadLastErrors: [],
    sketchSpreadErrorModalOpen: false,

    startSketchSpreadGenerateJob: ({ spreadIds }) => {
      if (get().sketchSpreadGenerateJob?.status === 'running') {
        log.warn('startSketchSpreadGenerateJob', 'blocked — a job is already running');
        return;
      }

      // Build tasks in DOC-ORDER: keep only ids that exist in sketch.spreads[], dedup, then sort by
      // position so spread[i] runs after spread[i-1] (backend can read prior spreads from the DB).
      const spreads = get().sketch.spreads;
      const indexById = new Map(spreads.map((s, i) => [s.id, i] as const));
      const orderedIds = [...new Set(spreadIds)]
        .filter((id) => indexById.has(id))
        .sort((a, b) => indexById.get(a)! - indexById.get(b)!);

      const tasks: SketchSpreadGenerateTask[] = orderedIds.map((spreadId, i) => ({
        spreadId,
        ordinal: i + 1,
        status: 'pending',
      }));

      if (tasks.length === 0) {
        log.warn('startSketchSpreadGenerateJob', 'nothing to generate — no eligible spreads');
        return; // caller (content-area) already toasted "nothing to generate"
      }

      const jobId = crypto.randomUUID();
      log.info('startSketchSpreadGenerateJob', 'start', { jobId, taskCount: tasks.length });
      set((state) => {
        state.sketchSpreadGenerateJob = {
          id: jobId,
          status: 'running',
          tasks,
          currentIndex: 0,
          cancelRequested: false,
          skipped: 0,
          skippedNames: [],
          createdAt: new Date().toISOString(),
        };
        // A new run invalidates the previous run's error snapshot + closes the modal.
        state.sketchSpreadLastErrors = [];
        state.sketchSpreadErrorModalOpen = false;
      });

      void runJob(jobId);
    },

    cancelSketchSpreadGenerateJob: () =>
      set((state) => {
        const job = state.sketchSpreadGenerateJob;
        if (job?.status === 'running') {
          log.info('cancelSketchSpreadGenerateJob', 'cancel requested', { jobId: job.id });
          job.cancelRequested = true;
        }
      }),

    dismissSketchSpreadGenerateJob: () =>
      set((state) => {
        if (state.sketchSpreadGenerateJob && state.sketchSpreadGenerateJob.status !== 'running') {
          // sketchSpreadLastErrors deliberately SURVIVES the dismiss — it is the
          // error-detail modal's data source (cleared on the next job start).
          state.sketchSpreadGenerateJob = null;
        }
      }),

    openSketchSpreadErrorModal: () =>
      set((state) => {
        log.debug('openSketchSpreadErrorModal', 'open', {
          entries: state.sketchSpreadLastErrors.length,
        });
        state.sketchSpreadErrorModalOpen = true;
      }),

    closeSketchSpreadErrorModal: () =>
      set((state) => {
        state.sketchSpreadErrorModalOpen = false;
      }),
  };
};
