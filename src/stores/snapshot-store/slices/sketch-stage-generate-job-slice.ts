// sketch-stage-generate-job-slice.ts — orchestrates ONE stage sheet target: a 2-phase chain
// generate the 2-cell 21:9 sheet → AUTO-CUT the 2 cells (api 10, CV). Two flavors, mirroring
// their char/prop siblings:
//   • BASE style attempt (11 — like base #14): STATELESS, the base text ships in the payload
//     (variants[base] read from the store) → NO flush-before-generate. Sink: styles[i].
//   • VARIANT (12 — like variant #15): SNAPSHOT-READING, the backend reads snapshot.sketch by
//     snapshotId → the stage node MUST land in the DB first. COLLAB → gateway whole-stage flush
//     (flushSketchStageUnderLock, keeps the lock); SOLO → awaited flushSnapshot(). A failed
//     flush ABORTS generate (never burn AI tokens on stale / peer-owned text). Sink: variants[vk].
// SINGLE-FLIGHT: at most one op at a time (cross-job gate useIsAnySketchGenerating). Auto-cut
// ALWAYS runs after a raw lands; cut result = 2 positional cells, 0 picked (the user locks 1/2
// via selectSketchStage{Base|Variant}Crop). A re-cut on the LOCKED style clears the base clone
// (via the setter's refreshBaseClone) — accepted "raw changed" consequence.
//
// Async rule (mirrors #13/#14/#15): run* are PLAIN async functions (NOT immer producers); every
// mutation between awaits goes through a synchronous set() producer; after EVERY await re-check
// opStale(target) and bail without writing if the op was reset/replaced.

import type { StateCreator } from 'zustand';
import type {
  SnapshotStore,
  SketchStageGenerateJobSlice,
  StageGeneratePhase,
} from '../types';
import type { SketchStage, SketchStageVariant, StageSelection } from '@/types/sketch';
import { effectiveIllustrationUrl, effectiveStageBaseUrl } from '@/types/sketch';
import type { Illustration } from '@/types/prop-types';
import {
  callGenerateBaseStageSheet,
  callGenerateStageVariantSheet,
  type StageModelParams,
} from '@/apis/sketch-stage-api';
// 2-cell cut reuses the kind-agnostic positional cutter (api 10) — no stage-specific crop route.
import { callCropSheetRow } from '@/apis/sketch-variant-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
// resource-lock-store is a leaf store (loaded before the slices); unit tests mock it.
import { useResourceLockStore } from '@/stores/resource-lock-store';
import { flushSketchStageUnderLock } from './collab-sketch-stage-save-helper';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'SketchStageGenerateJobSlice');

/** Stage sheets are a fixed 2-cell / 1-row / 21:9 grid (11/12 §Grid) → cut exactly 2 cells. */
const STAGE_CELL_COUNT = 2;

/** Shown when the book was never saved (no snapshot row) — 12 would read nothing. Exported so the
 *  notifications hook can skip re-toasting (the slice toasts it directly). */
export const STAGE_NO_SNAPSHOT_MESSAGE = 'Save the book first, then generate.';

// Backend error codes (11 §Error + 12 §Error + 10 §Error) → user-facing English.
const SKETCH_STAGE_ERROR_MESSAGES: Record<string, string> = {
  // shared validation / infra
  VALIDATION_ERROR: 'Invalid stage sheet request — check the stage setup.',
  SSRF_BLOCKED: 'A reference image URL was blocked — please try again.',
  ART_STYLE_NOT_FOUND: 'Selected sketch style not found — please pick one again in settings.',
  ART_STYLE_NO_REFERENCES: 'This sketch style has no reference images — add some in Style settings.',
  UNSUPPORTED_MODEL: 'The selected model is not supported for stage sheets.',
  PROMPT_TEMPLATE_NOT_FOUND: 'The image prompt is misconfigured — please contact support.',
  LLM_ERROR: 'The image model failed to generate this sheet — please try again.',
  NO_IMAGE_IN_RESPONSE: 'The image model returned no image — please try again.',
  STORAGE_UPLOAD_ERROR: 'Could not save the generated image — please try again.',
  IMAGE_FETCH_ERROR: 'A reference image could not be loaded — please try again.',
  // 11 (base style)
  EMPTY_STAGE_DESCRIPTION: 'This stage has no base description yet — add one before generating.',
  // 12 (variant)
  SNAPSHOT_NOT_FOUND: 'Could not find the saved book — save it again, then generate.',
  ENTITY_NOT_FOUND: 'This stage is missing from the saved book — save it, then generate.',
  VARIANT_NOT_FOUND: 'This variant is missing from the saved book — save it, then generate.',
  CANNOT_GENERATE_BASE_VARIANT: 'The base image is generated per style in the Base section, not here.',
  BASE_NOT_READY: 'Lock a base style and pick its crop first — the variant needs it as an anchor.',
  EMPTY_VARIANT_DESCRIPTION: 'This variant has no visual description yet — add one before generating.',
  // 10 (cut)
  DECODE_ERROR: 'The generated sheet could not be read for cutting — please regenerate.',
  ALL_CROPS_FAILED: 'Could not cut any cell from the sheet — please regenerate.',
  INTERNAL: 'Something went wrong — please try again.',
};

/** Maps an ImageApiFailure (or a non-success result) to a friendly message. */
function classifyError(result: { error?: string }): string {
  const code = (result as ImageApiFailure).errorCode;
  return (code && SKETCH_STAGE_ERROR_MESSAGES[code]) || result.error || 'Stage sheet generation failed';
}

/** Two targets identify the same op iff every discriminated field matches. */
function sameTarget(a: StageSelection, b: StageSelection): boolean {
  if (a.stageKey !== b.stageKey || a.target !== b.target) return false;
  if (a.target === 'base' && b.target === 'base') return a.styleIndex === b.styleIndex;
  if (a.target === 'variant' && b.target === 'variant') return a.variantKey === b.variantKey;
  return false;
}

export const createSketchStageGenerateJobSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  SketchStageGenerateJobSlice
> = (set, get) => {
  /** Op no longer owns this target — reset / new op raced in between an await → bail. */
  function opStale(target: StageSelection): boolean {
    const op = get().stageSheetGenerateOp;
    return !op || !sameTarget(op.target, target);
  }

  function stageOf(stageKey: string): SketchStage | undefined {
    return get().sketch.stages.find((s) => s.key === stageKey);
  }

  function variantOf(stageKey: string, variantKey: string): SketchStageVariant | undefined {
    return stageOf(stageKey)?.variants.find((v) => v.key === variantKey);
  }

  // ── internal producers (immer) — called at await boundaries ──────────────────────────────────
  function setOpPhase(phase: StageGeneratePhase): void {
    set((state) => {
      if (state.stageSheetGenerateOp) state.stageSheetGenerateOp.phase = phase;
    });
  }
  function markOpError(message: string): void {
    set((state) => {
      if (state.stageSheetGenerateOp) state.stageSheetGenerateOp.error = message;
    });
  }
  /** Clear the op when it settled without error; on error keep it (the editor-page notifications
   *  hook toasts it once, then dismisses). */
  function finalizeOp(): void {
    set((state) => {
      const op = state.stageSheetGenerateOp;
      if (op && !op.error) state.stageSheetGenerateOp = null;
    });
  }

  /** Persist the RESULT of a chain (sheet + crops already in the store) — the deliberate
   *  persist-after EXCEPTION to batch-at-release (AI output must not be lost to a crash / leaving
   *  the space). COLLAB → gateway whole-stage flush, `releaseIfAcquired:true` (one-shot — the user
   *  may have browsed away during the long AI call and the held-session already released the
   *  stage). SOLO → legacy fire-and-forget autoSaveSnapshot. */
  function persistStage(stageKey: string): void {
    if (useResourceLockStore.getState().collabPersist) {
      void flushSketchStageUnderLock(stageKey, stageOf(stageKey) ?? null, { releaseIfAcquired: true });
    } else {
      void get().autoSaveSnapshot();
    }
  }

  // ── auto-cut (phase 2) — throws on failure so the caller's catch records the error. No DB read.
  // Writes 2 positional cells (each ONE canonical 'created' illustration), CELLS NOT auto-picked.
  async function runCut(target: StageSelection, rawImageUrl: string): Promise<void> {
    const pathPrefix =
      target.target === 'base'
        ? `sketches/base/stages/${target.stageKey}`
        : `sketches/variants/stages/${target.stageKey}/${target.variantKey}`;
    const result = await callCropSheetRow({
      imageUrl: rawImageUrl,
      cellCount: STAGE_CELL_COUNT,
      pathPrefix,
    });
    if (opStale(target)) return; // reset/replaced during the cut → drop
    if (!result.success || !result.data) throw new Error(classifyError(result));

    const now = new Date().toISOString();
    const cells = result.data.crops.map((c) => ({
      is_selected: false,
      illustrations: [
        { type: 'created' as const, media_url: c.imageUrl, created_time: now, is_selected: true },
      ],
    }));
    if (target.target === 'base') {
      get().setSketchStageStyleCrops(target.stageKey, target.styleIndex, cells);
    } else {
      get().setSketchStageVariantCrops(target.stageKey, target.variantKey, cells);
    }

    // Non-fatal geometry warnings (10 §meta) — the sheet still cut, cells may just be off.
    const meta = result.meta;
    if ((meta?.geoFallbackCount ?? 0) > 0 || meta?.fullbleedWarning) {
      log.warn('runCut', 'geometry warning — some cells may be misaligned', {
        stageKey: target.stageKey,
        target: target.target,
        geoFallbackCount: meta?.geoFallbackCount,
        fullbleedWarning: meta?.fullbleedWarning,
      });
      toast.warning('Some cells may be misaligned');
    }
  }

  // ── BASE style chain: 11 (stateless) → auto-cut. Plain async, fire-and-forget from start. ─────
  async function runBaseGenerate(
    target: Extract<StageSelection, { target: 'base' }>,
    params: {
      stylePrompt: string;
      referenceImages: { title: string; media_url: string }[];
      artStyleId: string;
      modelParams?: StageModelParams;
    },
    isAdd: boolean,
  ): Promise<void> {
    const { stageKey, styleIndex } = target;
    // Closure flag (mirror base #14): once a raw sheet lands the style is real (partial success) —
    // never roll it back; a FAILED 'add' with no raw is an unreachable orphan (delete-style UI is
    // deferred) → rolled back in catch.
    let rawLanded = false;
    try {
      // Persist the attempt's prompt + refs on the style (provenance + regenerate re-seed) —
      // synchronous, on the style we just created/own.
      get().updateSketchStageStyleConfig(stageKey, styleIndex, {
        style_prompt: params.stylePrompt,
        image_references: params.referenceImages,
      });

      // ⚡ 11 is STATELESS — base text travels inline from the STORE (no DB read, no flush).
      const base = variantOf(stageKey, 'base');
      const result = await callGenerateBaseStageSheet({
        stageKey,
        visualDescription: base?.visual_design ?? '',
        artLanguage: base?.art_language ?? '',
        artStyleId: params.artStyleId,
        stylePrompt: params.stylePrompt,
        referenceImages: params.referenceImages.map((r) => ({ media_url: r.media_url })),
        modelParams: params.modelParams,
        // Attribution-only — book cost stamps on ai_service_logs.snapshot_id (11 is stateless,
        // so a null id is harmless: request still 200s, just no cost row).
        snapshotId: get().meta.id || undefined,
      });
      if (opStale(target)) return;
      if (!result.success || !result.data) throw new Error(classifyError(result));

      log.info('runBaseGenerate', 'raw sheet done', { stageKey, styleIndex });

      // Prepend the sheet version (newest selected, prior cleared) — crops preserved until re-cut.
      // Persist ai_request_id provenance (raw sheet = direct Gemini output).
      const now = new Date().toISOString();
      const prev = stageOf(stageKey)?.base.styles[styleIndex]?.illustrations ?? [];
      const next: Illustration[] = [
        {
          type: 'created' as const,
          media_url: result.data.imageUrl,
          created_time: now,
          is_selected: true,
          ...(result.data.aiRequestId ? { ai_request_id: result.data.aiRequestId } : {}),
        },
        ...prev.map((i) => ({ ...i, is_selected: false })),
      ];
      get().setSketchStageStyleIllustrations(stageKey, styleIndex, next);
      rawLanded = true;

      setOpPhase('cut');
      await runCut(target, result.data.imageUrl); // AUTO-CUT always runs
    } catch (err) {
      if (opStale(target)) return;
      const msg = err instanceof Error ? err.message : 'Stage sheet generation failed';
      log.error('runBaseGenerate', 'failed', { stageKey, styleIndex, error: msg });
      markOpError(msg); // keep the op so the notifications hook toasts once
      // Roll back the orphaned empty style: only an 'add' that failed before any raw landed
      // (mirror base #14 — there is no delete-style UI to recover it otherwise).
      if (isAdd && !rawLanded) {
        log.info('runBaseGenerate', 'rollback orphaned add-style (no raw landed)', { stageKey, styleIndex });
        get().removeSketchStageStyle(stageKey, styleIndex);
      }
    }

    if (opStale(target)) return;
    persistStage(stageKey); // persist-after (sheet + crops landed in the store)
    finalizeOp();
  }

  // ── VARIANT chain: flush-before (12 is snapshot-reading) → 12 → auto-cut. ─────────────────────
  async function runVariantGenerate(
    target: Extract<StageSelection, { target: 'variant' }>,
  ): Promise<void> {
    const { stageKey, variantKey } = target;
    try {
      // ⚡⚡ FLUSH-BEFORE-GENERATE: 12 reads snapshot.sketch from the DB — land the stage node
      // (text + the base chain just locked) first. COLLAB → gateway whole-stage flush (KEEPS the
      // lock — the caller just adopted the stage); SOLO → awaited flushSnapshot().
      const collab = useResourceLockStore.getState().collabPersist;
      if (collab) {
        const flushed = await flushSketchStageUnderLock(stageKey, stageOf(stageKey) ?? null);
        if (opStale(target)) return;
        if (!flushed) {
          log.warn('runVariantGenerate', 'flush-before-generate failed — abort (stale DB / peer lock)', {
            stageKey,
            variantKey,
          });
          markOpError('Could not save before generating — the stage may be locked by another editor.');
          return;
        }
      } else {
        await get().flushSnapshot();
        if (opStale(target)) return;
      }

      const snapshotId = get().meta.id; // brand-new book: null until the first save
      if (!snapshotId) {
        log.warn('runVariantGenerate', 'no snapshot id — cannot generate', { stageKey, collab });
        markOpError(STAGE_NO_SNAPSHOT_MESSAGE);
        toast.error(STAGE_NO_SNAPSHOT_MESSAGE);
        return; // don't call the endpoint (it would 404 SNAPSHOT_NOT_FOUND)
      }

      // ⚡ NO artStyleId — style/identity anchor from the locked BASE (12 §BASE_VARIANT).
      const gen = await callGenerateStageVariantSheet({
        snapshotId,
        entityKey: stageKey,
        variantKey,
        // Opt-in auto-persist (BE-first double-write): prepend the raw sheet version into
        // stages[stageKey].variants[variantKey].illustrations[] — FLAT (NO raw_sheet). Same node
        // setSketchStageVariantIllustrations writes below. snapshotId non-null here (guarded above).
        saveResource: buildImageVersionSaveResource(
          `col:sketch/key:stages/find:key=${stageKey}/key:variants/find:key=${variantKey}`,
          snapshotId,
          'create',
        ),
      });
      if (opStale(target)) return;
      if (!gen.success || !gen.data) throw new Error(classifyError(gen));

      log.info('runVariantGenerate', 'raw sheet done', { stageKey, variantKey });

      // Persist ai_request_id provenance (raw sheet = direct Gemini output).
      const now = new Date().toISOString();
      const prev = variantOf(stageKey, variantKey)?.illustrations ?? [];
      const next: Illustration[] = [
        {
          type: 'created' as const,
          media_url: gen.data.imageUrl,
          created_time: now,
          is_selected: true,
          ...(gen.data.aiRequestId ? { ai_request_id: gen.data.aiRequestId } : {}),
        },
        ...prev.map((i) => ({ ...i, is_selected: false })),
      ];
      get().setSketchStageVariantIllustrations(stageKey, variantKey, next);

      setOpPhase('cut');
      await runCut(target, gen.data.imageUrl); // AUTO-CUT always runs
    } catch (err) {
      if (opStale(target)) return;
      const msg = err instanceof Error ? err.message : 'Stage variant sheet generation failed';
      log.error('runVariantGenerate', 'failed', { stageKey, variantKey, error: msg });
      markOpError(msg);
    }

    if (opStale(target)) return;
    persistStage(stageKey);
    finalizeOp();
  }

  // ── cut-only re-run (raw edited → crops stale). Failure keeps the PREVIOUS crops (runCut only
  // writes on success) — the raw↔crops mismatch is surfaced by one toast; the user re-triggers. ──
  async function runRecrop(target: StageSelection, rawImageUrl: string): Promise<void> {
    try {
      await runCut(target, rawImageUrl);
    } catch (err) {
      if (opStale(target)) return;
      const msg = err instanceof Error ? err.message : 'Stage sheet cut failed';
      log.error('runRecrop', 'failed', { stageKey: target.stageKey, target: target.target, error: msg });
      markOpError(msg);
    }

    if (opStale(target)) return;
    // Persist even on a cut failure: the RAW edit that triggered this re-cut is already in the
    // store and must land (crops simply stay as they were).
    persistStage(target.stageKey);
    finalizeOp();
  }

  /** Shared single-flight + start-op boilerplate for the two recrop entry points. */
  function startRecrop(target: StageSelection, rawUrl: string | null, what: string): void {
    if (get().stageSheetGenerateOp != null) {
      // Reachable: the edit modal stays open after a raw commit → a 2nd commit can land while the
      // 1st re-cut is in flight. Toast so the raw↔crops mismatch is visible (mirror variant #15).
      log.warn('recropStageSheet', 'blocked — an op is already running', { what });
      toast.warning('Still processing the previous change — the cells were not re-cut. Try again in a moment.');
      return;
    }
    if (!rawUrl) {
      log.warn('recropStageSheet', 'no raw sheet to cut — skip', { what });
      return;
    }
    log.info('recropStageSheet', 'start', { what });
    set((state) => {
      state.stageSheetGenerateOp = {
        target,
        phase: 'cut', // skips 'generate' — the raw already exists ("Cutting cells…")
        startedAt: new Date().toISOString(),
      };
    });
    void runRecrop(target, rawUrl);
  }

  return {
    stageSheetGenerateOp: null,

    startStageBaseSheetGenerate: ({ stageKey, mode, styleIndex, stylePrompt, referenceImages, artStyleId, modelParams }) => {
      if (get().stageSheetGenerateOp != null) {
        log.warn('startStageBaseSheetGenerate', 'blocked — an op is already running', { stageKey });
        return; // single-flight
      }
      const stage = stageOf(stageKey);
      if (!stage) {
        log.warn('startStageBaseSheetGenerate', 'stage not found', { stageKey });
        return;
      }

      // Resolve the target style index. 'add' appends a fresh attempt; 'regenerate' reuses one.
      let i = styleIndex ?? -1;
      if (mode === 'add') {
        get().addSketchStageStyle(stageKey, {
          style_prompt: stylePrompt,
          is_selected: false,
          image_references: [],
          illustrations: [],
          crops: [],
        });
        i = (stageOf(stageKey)?.base.styles.length ?? 0) - 1;
      }
      if (i < 0 || i >= (stageOf(stageKey)?.base.styles.length ?? 0)) {
        log.warn('startStageBaseSheetGenerate', 'invalid styleIndex', { stageKey, mode, styleIndex });
        return;
      }

      log.info('startStageBaseSheetGenerate', 'start', { stageKey, mode, styleIndex: i });
      const target = { stageKey, target: 'base' as const, styleIndex: i };
      set((state) => {
        state.stageSheetGenerateOp = {
          target,
          phase: 'generate',
          startedAt: new Date().toISOString(),
        };
      });

      void runBaseGenerate(target, { stylePrompt, referenceImages, artStyleId, modelParams }, mode === 'add');
    },

    recropStageBaseSheet: (stageKey, styleIndex) => {
      const style = stageOf(stageKey)?.base.styles[styleIndex];
      startRecrop(
        { stageKey, target: 'base', styleIndex },
        style ? effectiveIllustrationUrl(style.illustrations) : null,
        `${stageKey}/base/${styleIndex}`,
      );
    },

    startStageVariantSheetGenerate: (stageKey, variantKey) => {
      if (get().stageSheetGenerateOp != null) {
        log.warn('startStageVariantSheetGenerate', 'blocked — an op is already running', { stageKey });
        return; // single-flight
      }
      // FE mirrors the 12 §Error gates (defensive net — the sidebar ✨ gate blocks first).
      if (variantKey === 'base') {
        log.warn('startStageVariantSheetGenerate', 'base variant is generated via the style workspace', { stageKey });
        toast.warning(SKETCH_STAGE_ERROR_MESSAGES.CANNOT_GENERATE_BASE_VARIANT);
        return;
      }
      const stage = stageOf(stageKey);
      const variant = stage?.variants.find((v) => v.key === variantKey);
      if (!stage || !variant) {
        log.warn('startStageVariantSheetGenerate', 'stage/variant not found', { stageKey, variantKey });
        return;
      }
      if (!effectiveStageBaseUrl(stage)) {
        log.warn('startStageVariantSheetGenerate', 'base not ready — gate', { stageKey, variantKey });
        toast.warning(SKETCH_STAGE_ERROR_MESSAGES.BASE_NOT_READY);
        return;
      }
      if (!variant.visual_design.trim() && !variant.art_language.trim()) {
        log.warn('startStageVariantSheetGenerate', 'empty variant description — gate', { stageKey, variantKey });
        toast.warning(SKETCH_STAGE_ERROR_MESSAGES.EMPTY_VARIANT_DESCRIPTION);
        return;
      }

      log.info('startStageVariantSheetGenerate', 'start', { stageKey, variantKey });
      const target = { stageKey, target: 'variant' as const, variantKey };
      set((state) => {
        state.stageSheetGenerateOp = {
          target,
          phase: 'generate',
          startedAt: new Date().toISOString(),
        };
      });

      void runVariantGenerate(target);
    },

    recropStageVariantSheet: (stageKey, variantKey) => {
      const variant = variantOf(stageKey, variantKey);
      startRecrop(
        { stageKey, target: 'variant', variantKey },
        variant ? effectiveIllustrationUrl(variant.illustrations) : null,
        `${stageKey}/${variantKey}`,
      );
    },

    dismissStageSheetGenerateError: () =>
      set((state) => {
        const op = state.stageSheetGenerateOp;
        if (op && op.error) {
          log.debug('dismissStageSheetGenerateError', 'clear settled-with-error op', {
            stageKey: op.target.stageKey,
            target: op.target.target,
          });
          state.stageSheetGenerateOp = null;
        }
      }),
  };
};
