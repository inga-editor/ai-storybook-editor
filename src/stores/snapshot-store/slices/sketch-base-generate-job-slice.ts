// sketch-base-generate-job-slice.ts — orchestrates ONE base-sheet style attempt: a 2-API chain
// generate the RAW sheet (05|06, AI — all base entities of a GROUP as cells) → crop each entity out
// of it (10 `crop-sheet-row`, CV, positional). The unit is a STYLE (group, styleIndex), not N
// entities.
//
// ⚡REV 2026-08-21 (group model): ops are keyed by GROUP KEY (`base[group_key]`). A group is
// single-flight; DISTINCT groups run in PARALLEL (each group is its own rtype-11 sheet node → its
// own lock, no write contention). The route (05 character / 06 prop) is chosen by the group's
// self-describing `base[group].kind` (else derived from the key); the request ALWAYS carries
// `targetGroup = group_key` so the stateless endpoint writes the right sheet node.
//
// ⚡2026-07-15: the base-only crop route (07 `crop-base-sheet`) was REMOVED backend-side. Crop now
// reuses the kind-agnostic POSITIONAL cutter (api 10 `callCropSheetRow` — shared with the variant
// space). Api 10 returns crops in reading order keyed by 1-based `cell`; we pair each crop back to an
// entity via `cellOrder[cell - 1]` (cellOrder from the generate result / reading-order entity keys).
//
// Differs from #12 (entity sheets) / #13 (spreads): per-style 2-phase status (generating → cropping)
// on ONE op, and crop reads NO DB — `imageUrl` is passed straight from the generate result (or the
// effective raw for a re-crop), so base generate is INLINE (no flush-BEFORE-generate).
// ⚡2026-07-15 (ADR-043): the result persist at the end of each chain routes through the sketch-base
// collab gateway (rtype 11 whole-sheet flush) via the engine's `ensureSaved` seam.
//
// Async rule (mirrors #13): runGenerate/runCrop are PLAIN async functions (NOT immer producers).
// Every mutation between awaits goes through a synchronous set((state)=>…) producer. After EVERY
// await we re-check opStale(group, i) and bail without writing if the op was reset/cancelled/replaced.

import type { StateCreator } from 'zustand';
import type { SnapshotStore, SketchBaseGenerateJobSlice, BaseGeneratePhase } from '../types';
import type { Sketch, SketchEntity, SheetKind, SketchBase } from '@/types/sketch';
import { sheetOf, deriveSheetKindFromKey, resolveEntityGroup } from '@/types/sketch';
import type { Illustration, ImageReference } from '@/types/prop-types';
import {
  callGenerateBaseSheet,
  type BaseSheetEntity,
  type BaseReferenceImage,
  type SketchModelParams,
} from '@/apis/sketch-base-api';
// Base crop reuses the shared positional cutter (api 10) — 07 `crop-base-sheet` removed 2026-07-15.
import { callCropSheetRow } from '@/apis/sketch-variant-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
// Persist the WHOLE base[group] SHEET node (rtype 11) via the engine's `ensureSaved` seam
// (unified-item-save phase 3 — the engine owns the solo/collab fork + lock lifecycle + rebase).
import { flushSketchBaseSheetUnderLock } from './collab-sketch-base-sheet-save-helper';
// Grain B (rtype 14): a crops replacement on the LOCKED style re-clones every group entity's base
// variant (sketch-slice cloneLockedStyleCropsToBaseVariants) → the WHOLE entity collection is
// persisted in ONE column-root save (base space "save 1 cục", ADR-044 addendum 2).
import { saveEntityCollection } from './collab-sketch-base-entities-save-helper';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'SketchBaseGenerateJobSlice');

/** Endpoint caps the sheet at 12 cells (1K legibility, [API 05 §Grid]) — content-area blocks first;
 *  this is the defensive net at the slice boundary. */
const MAX_BASE_ENTITIES = 12;

// Backend error codes → user-facing English (mirrors SKETCH_SPREAD_ERROR_MESSAGES in #13).
const SKETCH_BASE_ERROR_MESSAGES: Record<string, string> = {
  ART_STYLE_NOT_FOUND: 'Selected art style not found — please pick one again in settings.',
  ART_STYLE_NO_REFERENCES: 'This art style has no reference images — add some in Style settings.',
  VALIDATION_ERROR: 'Invalid base sheet request — check the entity setup.',
  LLM_ERROR: 'The image model failed to generate this sheet — please try again.',
  // Backend exhausted its own 429 retries → the quota is genuinely saturated. No client auto-retry.
  GEMINI_RATE_LIMIT: 'The image model is busy right now — wait a moment and try again.',
  NO_IMAGE_IN_RESPONSE: 'The image model returned no image — please try again.',
  ALL_CROPS_FAILED: 'Could not crop any entity from the sheet — please regenerate.',
  SKIPPED_DELETED: 'Skipped — the style was removed.',
  TOO_MANY_ENTITIES: 'Too many base entities — keep it to 12 or fewer per sheet.',
  INVALID_TARGET_GROUP: 'Invalid base group — please reload and try again.',
};

/** Maps an ImageApiFailure (or a non-success result) to a friendly message. */
function classifyError(result: { error?: string }): string {
  const code = (result as ImageApiFailure).errorCode;
  return (code && SKETCH_BASE_ERROR_MESSAGES[code]) || result.error || 'Base sheet generation failed';
}

/** A group's `SheetKind`: self-describing node, else derived from the key. */
function groupKind(base: SketchBase, group: string): SheetKind {
  return base[group]?.kind ?? deriveSheetKindFromKey(group);
}

/** Entities of one group in reading order = the group's kind array filtered by `resolveEntityGroup`. */
function groupEntities(sketch: Sketch, group: string): SketchEntity[] {
  const kind = groupKind(sketch.base, group);
  const src = kind === 'props' ? sketch.props ?? [] : sketch.characters ?? [];
  return src.filter((e) => resolveEntityGroup(e, kind) === group);
}

/** Base entities of a group = those carrying a 'base' variant (mirrors useSketchBaseEntityKeys). */
function baseEntitiesOf(entities: SketchEntity[]): SketchEntity[] {
  return entities.filter((e) => e.variants.some((v) => v.key === 'base'));
}

/** Project one entity's 'base' variant text to the sheet-prompt row (§6 payload map). */
function baseVariantText(entity: SketchEntity): BaseSheetEntity {
  const base = entity.variants.find((v) => v.key === 'base');
  return {
    key: entity.key,
    visualDescription: base?.visual_design ?? '',
    artLanguage: base?.art_language ?? '',
  };
}

/** Effective raw url: selected version → newest → null. */
function effectiveIllustration(illustrations: Illustration[]): string | null {
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? null;
}

export const createSketchBaseGenerateJobSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  SketchBaseGenerateJobSlice
> = (set, get) => {
  /** This group's op no longer owns styleIndex — reset / removeStyle / new op raced in between an
   *  await → bail. The map is keyed by GROUP (not by style): only one op per group can exist, so a
   *  styleIndex mismatch still means "our op is gone". */
  function opStale(group: string, styleIndex: number): boolean {
    const op = get().baseSheetGenerateOps[group];
    return !op || op.styleIndex !== styleIndex;
  }

  // ── internal producers (immer) — called at await boundaries. Each addresses ONE group's entry,
  //    so another group's concurrent op is never touched. ────────────────────────────────────────
  function setOpPhase(group: string, phase: BaseGeneratePhase): void {
    set((state) => {
      const op = state.baseSheetGenerateOps[group];
      if (op) op.phase = phase;
    });
  }
  /** Store the (already classified, friendly) message on the op; the op is KEPT until dismiss. */
  function markOpError(group: string, message: string): void {
    set((state) => {
      const op = state.baseSheetGenerateOps[group];
      if (op) op.error = message;
    });
  }
  /** Drop the op when it settled without error; on error keep it (content-area shows it inline). */
  function finalizeOp(group: string): void {
    set((state) => {
      const op = state.baseSheetGenerateOps[group];
      if (op && !op.error) delete state.baseSheetGenerateOps[group];
    });
  }

  // Persist the RESULT of a generate/recrop (raw + crops landed in the store). ⚡ unified-item-save
  // phase 3: the solo/collab fork is GONE — the flush seams delegate to the engine's `ensureSaved`
  // (held → save + rebase; browsed-away → one-shot acquire→save→release; solo → whole-snapshot flush).
  // Grain A = the whole SHEET node (rtype 11, keyed by GROUP). Grain B = the WHOLE entity collection
  // (rtype 14), refreshed only when the LOCKED style's crops landed — `cropsLanded` gates the
  // failed/cancelled paths. Collection = the group's kind (characters | props).
  async function persistBaseSheet(group: string, styleIndex: number, cropsLanded: boolean): Promise<void> {
    await flushSketchBaseSheetUnderLock(group);
    const style = sheetOf(get().sketch.base, group)?.styles[styleIndex];
    if (cropsLanded && style?.is_selected) {
      const kind = groupKind(get().sketch.base, group);
      await saveEntityCollection(kind);
    }
  }

  // ── crop (phase 2) — throws on failure so the caller's catch records the error. NO DB read. ────
  // `cellOrder` = reading-order entity keys (from the generate result, or the group's entity order on
  // a re-crop). Api 10 returns crops in reading order keyed by a 1-based `cell`; we pair each crop
  // back to its entity via cellOrder[cell - 1] — using `cell` (NOT the array index) keeps the pairing
  // correct even when the backend skipped a cell mid-row (index-shifting).
  async function runCrop(
    group: string,
    styleIndex: number,
    imageUrl: string,
    cellOrder: string[],
  ): Promise<void> {
    // Storage prefix is keyed on the entity KIND (collection), not the group: every character group
    // shares `sketches/base/characters/`. Groups are told apart by the snapshot node they land in,
    // NEVER by the folder.
    const kind = groupKind(get().sketch.base, group);
    const result = await callCropSheetRow({
      imageUrl,
      cellCount: cellOrder.length,
      pathPrefix: `sketches/base/${kind}`,
    });
    if (opStale(group, styleIndex)) return; // reset/cancel/removeStyle during crop → drop
    if (!result.success || !result.data) throw new Error(classifyError(result));

    const now = new Date().toISOString();
    const cropRecords = [];
    for (const c of result.data.crops) {
      const key = cellOrder[c.cell - 1]; // 1-based cell → entity key (NOT array index — skip-safe)
      if (!key) {
        log.warn('runCrop', 'crop cell has no matching entity — dropped', { group, styleIndex, cell: c.cell });
        continue;
      }
      cropRecords.push({
        key,
        illustrations: [
          { type: 'created' as const, media_url: c.imageUrl, created_time: now, is_selected: true },
        ],
      });
    }
    get().setSketchBaseStyleCrops(group, styleIndex, cropRecords);

    // Non-fatal degraded-crop signals (api 10 §meta): skipped cells (upload failed), geo-fallback
    // (even split — may be misaligned), full-bleed sheet (borders not white — crops may be off).
    const meta = result.meta;
    const skippedCount = meta?.skipped?.length ?? 0;
    if (skippedCount || meta?.geoFallbackCount || meta?.fullbleedWarning) {
      log.warn('runCrop', 'partial / degraded crop', {
        group,
        styleIndex,
        skipped: skippedCount,
        geoFallback: meta?.geoFallbackCount ?? 0,
        fullbleed: meta?.fullbleedWarning ?? false,
      });
      const parts: string[] = [];
      if (skippedCount) parts.push(`${skippedCount} crop(s) failed`);
      if (meta?.geoFallbackCount) parts.push(`${meta.geoFallbackCount} cell(s) approximated`);
      if (meta?.fullbleedWarning) parts.push('sheet borders not detected — crops may be off');
      toast.warning(parts.join(' · '));
    }
  }

  // ── generate (phase 1) → crop (phase 2) chain. Plain async, fire-and-forget from start. ────────
  // `isAdd` = this op appended a fresh (empty) style up-front; if generate fails BEFORE any raw
  // lands, that style is an unreachable orphan (no delete/regenerate UI) → roll it back in catch.
  async function runGenerate(
    group: string,
    styleIndex: number,
    params: {
      stylePrompt: string;
      referenceImages: ImageReference[];
      artStyleId: string;
      modelParams?: SketchModelParams;
    },
    isAdd: boolean,
  ): Promise<void> {
    // Entities read AT SLICE (base variant text) — same reading-order for generate + crop. The route
    // (05/06) is chosen by the group's kind, and `targetGroup` (the group key) tells the stateless
    // endpoint which sheet node to write, so the cell set + the destination node can never disagree.
    const kind = groupKind(get().sketch.base, group);
    const entities = baseEntitiesOf(groupEntities(get().sketch, group)).map(baseVariantText);
    log.debug('runGenerate', 'resolved entity source for group', {
      group,
      kind,
      entityCount: entities.length,
    });
    // Closure flag: once the raw sheet is written the style is real (partial success) → never roll back.
    let rawLanded = false;
    // Crops replacement reached the store → entity base-variant clones may have refreshed (locked
    // style) → gates the grain-B entity flush in persistBaseSheet.
    let cropsLanded = false;

    try {
      // Refs are the CHOSEN art-style's `image_references` ({title, media_url}) picked in the modal —
      // already hosted in Storage, so no upload roundtrip. Persist them verbatim on the style (provenance
      // + regenerate re-seed) and forward each as a media_url ref (backend SSRF-guards + fetches). Runs
      // synchronously on the style we just created/own (op set before this call) → no opStale needed here.
      if (params.referenceImages.length > 0) {
        log.info('runGenerate', 'persist style reference images', { group, styleIndex, count: params.referenceImages.length });
        get().setSketchBaseStyleImageReferences(group, styleIndex, params.referenceImages);
      }
      const apiRefs: BaseReferenceImage[] = params.referenceImages.map((r) => ({ media_url: r.media_url }));

      const snapshotId = get().meta.id || undefined;
      const result = await callGenerateBaseSheet(kind, {
        entities,
        artStyleId: params.artStyleId,
        stylePrompt: params.stylePrompt,
        referenceImages: apiRefs,
        targetGroup: group,
        modelParams: params.modelParams,
        // Attribution-only — book snapshot version id (empty/absent → omit). Never remix here.
        snapshotId,
        // Opt-in auto-persist (BE-first double-write): prepend the raw sheet version into
        // styles[styleIndex].illustrations[] — the SAME node addSketchBaseStyleIllustration writes
        // below. Omitted when the book has no snapshot row yet (client persist stays sole writer).
        saveResource: snapshotId
          ? buildImageVersionSaveResource(
              `col:sketch/key:base/key:${group}/key:styles/idx:${styleIndex}`,
              snapshotId,
              'create',
            )
          : undefined,
      });
      if (opStale(group, styleIndex)) return;
      if (!result.success || !result.data) throw new Error(classifyError(result));

      log.info('runGenerate', 'raw sheet done', {
        group,
        styleIndex,
        targetGroup: result.data.targetGroup ?? null, // echo — confirms WHICH sheet node it wrote
      });
      // Persist ai_request_id provenance from the generate result (raw sheet = direct Gemini output).
      get().addSketchBaseStyleIllustration(group, styleIndex, result.data.imageUrl, result.data.aiRequestId);
      rawLanded = true;

      // Reading-order entity keys echoed by generate — pair positionally to api-10 crops in runCrop.
      const cellOrder = result.data.cellOrder;

      // Best-effort cancel: stop before the crop phase (raw already saved). Not stale → op is ours.
      if (get().baseSheetGenerateOps[group]?.cancelRequested) {
        log.info('runGenerate', 'cancelled before crop — raw kept, crop skipped', { group, styleIndex });
      } else {
        setOpPhase(group, 'cropping');
        await runCrop(group, styleIndex, result.data.imageUrl, cellOrder);
        cropsLanded = true; // runCrop throws on failure; stale early-return bails before persist
      }
    } catch (err) {
      if (opStale(group, styleIndex)) return;
      const msg = err instanceof Error ? err.message : 'Base sheet generation failed';
      log.error('runGenerate', 'failed', { group, styleIndex, error: msg });
      markOpError(group, msg); // keep the op so the notifications hook toasts once
      // Roll back the orphaned empty style: only an 'add' that failed before any raw landed. The op
      // is unchanged (still owns styleIndex) so opStale stays false → finalizeOp still keeps the error.
      if (isAdd && !rawLanded) {
        log.info('runGenerate', 'rollback orphaned add-style (no raw landed)', { group, styleIndex });
        get().removeSketchBaseStyle(group, styleIndex);
      }
    }

    if (opStale(group, styleIndex)) return; // op reset during the last await → nothing to finalize
    // Persist the result (raw + crops). COLLAB → gateway whole-sheet flush; SOLO → whole-snapshot flush.
    await persistBaseSheet(group, styleIndex, cropsLanded);
    finalizeOp(group);
  }

  // ── crop-only re-run (call-site #2, after editing the Raw sheet). ──────────────────────────────
  async function runRecrop(
    group: string,
    styleIndex: number,
    rawUrl: string,
    cellOrder: string[],
  ): Promise<void> {
    let cropsLanded = false;
    try {
      await runCrop(group, styleIndex, rawUrl, cellOrder);
      cropsLanded = true;
    } catch (err) {
      if (opStale(group, styleIndex)) return;
      const msg = err instanceof Error ? err.message : 'Base sheet crop failed';
      log.error('runRecrop', 'failed', { group, styleIndex, error: msg });
      markOpError(group, msg);
    }

    if (opStale(group, styleIndex)) return;
    // Persist the recropped crops. COLLAB → gateway whole-sheet flush; SOLO → whole-snapshot flush.
    await persistBaseSheet(group, styleIndex, cropsLanded);
    finalizeOp(group);
  }

  return {
    baseSheetGenerateOps: {},

    startBaseSheetGenerate: ({ group, mode, styleIndex, stylePrompt, referenceImages, artStyleId, modelParams }) => {
      // Per-GROUP single-flight: distinct groups run in parallel (each is its own rtype-11 sheet
      // node → no write contention), but two ops on the SAME group would both write that one sheet
      // node last-writer-wins.
      if (get().baseSheetGenerateOps[group] != null) {
        log.warn('startBaseSheetGenerate', 'blocked — this group already has an op', { group });
        return;
      }

      const baseEntities = baseEntitiesOf(groupEntities(get().sketch, group));
      if (baseEntities.length === 0) {
        // Typically a group before any of its entities are imported. The sidebar already greys the
        // ＋ seam for an empty group; this is the slice-level net.
        log.warn('startBaseSheetGenerate', 'no base entities — nothing to generate', { group });
        toast.warning('Import base entities first');
        return;
      }
      // Defensive net (content-area blocks first): no op exists yet → toast, don't markOpError.
      if (baseEntities.length > MAX_BASE_ENTITIES) {
        log.warn('startBaseSheetGenerate', 'too many base entities', { group, count: baseEntities.length });
        toast.error(SKETCH_BASE_ERROR_MESSAGES.TOO_MANY_ENTITIES);
        return;
      }

      // Resolve the target style index. 'add' appends a fresh style; 'regenerate' reuses styleIndex.
      let i = styleIndex ?? -1;
      if (mode === 'add') {
        get().addSketchBaseStyle(group, {
          style_prompt: stylePrompt,
          is_selected: false,
          image_references: [],
          illustrations: [],
          crops: [],
        });
        i = (sheetOf(get().sketch.base, group)?.styles.length ?? 0) - 1;
      }
      const styleCount = sheetOf(get().sketch.base, group)?.styles.length ?? 0;
      if (i < 0 || i >= styleCount) {
        log.warn('startBaseSheetGenerate', 'invalid styleIndex', { group, mode, styleIndex });
        return;
      }

      log.info('startBaseSheetGenerate', 'start', {
        group,
        mode,
        styleIndex: i,
        entityCount: baseEntities.length,
      });
      set((state) => {
        state.baseSheetGenerateOps[group] = {
          group,
          styleIndex: i,
          phase: 'generating',
          startedAt: new Date().toISOString(),
          isRecrop: false,
        };
      });

      void runGenerate(group, i, { stylePrompt, referenceImages, artStyleId, modelParams }, mode === 'add');
    },

    recropBaseSheet: (group, styleIndex) => {
      if (get().baseSheetGenerateOps[group] != null) {
        log.warn('recropBaseSheet', 'blocked — this group already has an op', { group });
        return; // per-group single-flight (shared with generate — one op per group)
      }

      const style = sheetOf(get().sketch.base, group)?.styles[styleIndex];
      if (!style || style.illustrations.length === 0) {
        log.warn('recropBaseSheet', 'no raw sheet to crop', { group, styleIndex });
        return; // need a raw sheet to crop from
      }
      const rawUrl = effectiveIllustration(style.illustrations);
      if (!rawUrl) {
        log.warn('recropBaseSheet', 'raw sheet has no effective url', { group, styleIndex });
        return;
      }

      // Reading-order entity keys = the GROUP's entity order (mirrors the generate reading-order).
      const cellOrder = baseEntitiesOf(groupEntities(get().sketch, group)).map((e) => e.key);
      log.info('recropBaseSheet', 'start', { group, styleIndex, entityCount: cellOrder.length });
      set((state) => {
        state.baseSheetGenerateOps[group] = {
          group,
          styleIndex,
          phase: 'cropping',
          startedAt: new Date().toISOString(),
          isRecrop: true,
        };
      });

      void runRecrop(group, styleIndex, rawUrl, cellOrder);
    },

    cancelBaseSheetGenerate: (group) =>
      set((state) => {
        const op = state.baseSheetGenerateOps[group];
        if (op && !op.error) {
          log.info('cancelBaseSheetGenerate', 'cancel requested', {
            group,
            styleIndex: op.styleIndex,
          });
          op.cancelRequested = true; // best-effort — stops before the crop phase
        }
      }),

    dismissBaseSheetGenerateError: (group) =>
      set((state) => {
        const op = state.baseSheetGenerateOps[group];
        if (op && op.error) {
          log.debug('dismissBaseSheetGenerateError', 'clear settled-with-error op', {
            group,
            styleIndex: op.styleIndex,
          });
          delete state.baseSheetGenerateOps[group]; // kept only to surface the error → drop it
        }
      }),
  };
};
