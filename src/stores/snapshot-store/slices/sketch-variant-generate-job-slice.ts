// sketch-variant-generate-job-slice.ts — orchestrates ONE non-base variant sheet: a 2-phase chain
// generate the RAW 4-cell 21:9 sheet (08|09, AI — 4 independent draws of the SAME variant) → AUTO-CUT
// the 4 cells out of it (10, CV). The unit is a VARIANT (kind, entityKey, variantKey), not N entities.
// PER-ENTITY PARALLEL: ops live in `variantSheetGenerateOps`, a map keyed by `variantOpKey(ref)` so
// status/spinners resolve per ROW — but ADMISSION is per ENTITY (`hasOpForEntity`). N different
// ENTITIES run concurrently; one entity runs one op at a time, whichever variant it is (generate and
// recrop included).
//
// The admission grain must match the PERSIST grain, which is the whole entity node (rtype 3/4):
// `flushSketchEntityUnderLock` takes ONE lock for the entity and writes the WHOLE node. Two variants
// of the same entity settling together would be two writers of that node — the second payload was
// snapshotted before the first landed (whole-node last-writer-wins silently drops a sheet), and the
// first chain's one-shot `releaseIfAcquired` can release the shared lock while the second chain's
// save is still in flight (→ `forbidden`, its raw sheet + crops never persist). Different entities
// hold different locks and write different nodes, so they never contend.
//
// The backend bounds the real Gemini concurrency (GEMINI_IMAGE_CONCURRENCY semaphore); the client
// cap below is UX only.
// Auto-cut ALWAYS runs after a raw sheet lands (no Re-cut button, no confirm). NO auto-select after
// cut — the user locks 1/4 later via selectSketchVariantCrop (phase-01).
//
// ⚡⚡ SNAPSHOT-READING (the #1 correctness point — differs from base #14): generate 08/09 reads
// `snapshot.sketch` from the DB by snapshotId, so we MUST land the variant's edited text in the DB
// BEFORE calling generate.
//   • SOLO (collabPersist=false): AWAITED `flushSnapshot()` (legacy path), then read meta.id.
//   • COLLAB (collabPersist=true, ADR-047): autoSaveSnapshot/flushSnapshot are SUPPRESSED, so we
//     persist the WHOLE sketch entity node through the gateway via `flushSketchEntityUnderLock`
//     (acquires-if-needed, saves, KEEPS the lock held for the component held-session) BEFORE the AI
//     reads the DB — else it draws from STALE text / missing base crops (risk #1). A failed flush
//     (peer lock / reject) ABORTS generate so we never burn AI tokens on a stale / peer-owned node.
// This mirrors sketch-spread-generate-job-slice.ts (also snapshot-reading). Base does NOT need this
// (base ships entity text inside the generate payload).
//
// Async rule (mirrors #13/#14): runGenerate/runCut are PLAIN async functions (NOT immer producers).
// Every mutation between awaits goes through a synchronous set((state)=>…) producer. After EVERY await
// we re-check opStale(ref) and bail WITHOUT writing if the op was reset/replaced.

import type { StateCreator } from 'zustand';
import type {
  SnapshotStore,
  SketchVariantGenerateJobSlice,
  VariantGeneratePhase,
} from '../types';
// Key format + entity-level admission test are shared with selectors.ts / the space component —
// single source, see sketch-op-keys.ts.
import { variantOpKey, hasOpForEntity, countActiveVariantOps } from '../sketch-op-keys';
import type { VariantRef, SketchVariant } from '@/types/sketch';
import { KIND_ENTITY_SOURCE, sketchEntitiesOfKind } from '@/types/sketch';
import type { Illustration } from '@/types/prop-types';
import {
  callGenerateVariantSheet,
  callCropSheetRow,
} from '@/apis/sketch-variant-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
// makeEntityId comes from the PURE entity-id submodule (no imports) to avoid the save-session-store
// barrel; useSaveSessionStore is imported DYNAMICALLY at call-time (save-session-store →
// snapshot-store/index → this slice would be an eval-time cycle if static).
import { makeEntityId } from '@/stores/save-session-store/entity-id';
// Sibling slice-helper (same dir) — whole sketch-entity persist, now a thin `ensureSaved` seam
// (unified-item-save phase 3); the engine owns the solo/collab fork + lock lifecycle.
import { flushSketchEntityUnderLock } from './collab-sketch-variant-save-helper';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'SketchVariantGenerateJobSlice');

/** Variant sheet is a fixed 4-cell / 1-row / 21:9 grid (08/09 §Grid) → cut exactly 4 cells. */
const VARIANT_CELL_COUNT = 4;

/** Max variant ops the UI starts concurrently. The backend semaphore (GEMINI_IMAGE_CONCURRENCY,
 *  default 5) is the real bound — this cap is UX only, so the user cannot fan out dozens of sheets
 *  and then sit behind a server-side queue. 3 variant + 2 base kinds = the backend default. Over
 *  the cap we toast and DROP (no client-side queue — the user retries). */
export const VARIANT_GENERATE_CONCURRENCY_CAP = 3;

/** Shown when a 2nd op is requested for a variant that is already generating / re-cutting. */
export const VARIANT_BUSY_MESSAGE = 'This variant is still generating — please wait.';
/** Shown when a DIFFERENT variant of the same entity holds the entity's slot (see `hasOpForEntity`). */
export const VARIANT_ENTITY_BUSY_MESSAGE =
  'Another variant of this entity is still generating — please wait.';
/** Shown when the client cap is reached (a slot must free up first). */
export const VARIANT_CAP_MESSAGE =
  'Too many sheets generating — wait for one to finish, then try again.';

/** Shown when the book was never saved (no snapshot row yet) — generate would read nothing. Kept on
 *  the op (so it surfaces inline / via the notifications hook) AND toasted immediately. Exported so
 *  the notifications hook can skip re-toasting THIS message (the slice already toasts it directly). */
export const NO_SNAPSHOT_MESSAGE = 'Save the book first, then generate.';

// Backend error codes (api/sketch/08,09 §Error + 10 §Error) → user-facing English. Mirrors
// SKETCH_BASE_ERROR_MESSAGES in #14. Unmapped codes fall back to the raw backend message.
const SKETCH_VARIANT_ERROR_MESSAGES: Record<string, string> = {
  // generate (08/09)
  VALIDATION_ERROR: 'Invalid variant sheet request — check the variant setup.',
  SSRF_BLOCKED: 'A reference image URL was blocked — please try again.',
  SNAPSHOT_NOT_FOUND: 'Could not find the saved book — save it again, then generate.',
  ENTITY_NOT_FOUND: 'This entity is missing from the saved book — save it, then generate.',
  VARIANT_NOT_FOUND: 'This variant is missing from the saved book — save it, then generate.',
  ART_STYLE_NOT_FOUND: 'Selected sketch style not found — please pick one again in settings.',
  CANNOT_GENERATE_BASE_VARIANT: 'The base variant is generated in the Base workspace, not here.',
  BASE_NOT_READY: 'Generate and lock this entity’s base first — the variant needs it as an anchor.',
  EMPTY_VARIANT_DESCRIPTION: 'This variant has no visual description yet — add one before generating.',
  ART_STYLE_NO_REFERENCES: 'This sketch style has no reference images — add some in Style settings.',
  IMAGE_FETCH_ERROR: 'A reference image could not be loaded — please try again.',
  PROMPT_TEMPLATE_NOT_FOUND: 'The image prompt is misconfigured — please contact support.',
  LLM_ERROR: 'The image model failed to generate this sheet — please try again.',
  // Backend exhausted its own 429 retries → the quota is genuinely saturated. No client auto-retry.
  GEMINI_RATE_LIMIT: 'The image model is busy right now — wait a moment and try again.',
  NO_IMAGE_IN_RESPONSE: 'The image model returned no image — please try again.',
  STORAGE_UPLOAD_ERROR: 'Could not save the generated image — please try again.',
  // crop (10)
  DECODE_ERROR: 'The generated sheet could not be read for cutting — please regenerate.',
  ALL_CROPS_FAILED: 'Could not cut any cell from the sheet — please regenerate.',
  // shared
  INTERNAL: 'Something went wrong — please try again.',
};

/** Maps an ImageApiFailure (or a non-success result) to a friendly message. */
function classifyError(result: { error?: string }): string {
  const code = (result as ImageApiFailure).errorCode;
  return (code && SKETCH_VARIANT_ERROR_MESSAGES[code]) || result.error || 'Variant sheet generation failed';
}

export const createSketchVariantGenerateJobSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  SketchVariantGenerateJobSlice
> = (set, get) => {
  /** This variant's op is gone (dismissed / replaced) — it raced an await → bail without writing.
   *  Sibling variants have their own keys, so one op settling never stales another. */
  function opStale(ref: VariantRef): boolean {
    return get().variantSheetGenerateOps[variantOpKey(ref)] == null;
  }

  /** Resolve the live variant node (or undefined) for reading its current raw_sheet versions. */
  function variantOf(ref: VariantRef): SketchVariant | undefined {
    return sketchEntitiesOfKind(get().sketch, ref.kind)
      .find((e) => e.key === ref.entityKey)
      ?.variants.find((v) => v.key === ref.variantKey);
  }

  /** Effective raw sheet url: selected version → newest → null (mirrors the base slice). */
  function effectiveRawUrl(ref: VariantRef): string | null {
    const illustrations = variantOf(ref)?.raw_sheet?.illustrations ?? [];
    return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? null;
  }

  /** Persist the RESULT of a generate/recrop chain (raw sheet + crops already landed in the store).
   *  ⚡ PERSIST-AFTER is the deliberate EXCEPTION to this space's batch-at-release model (ADR-043 Rev
   *  2026-07-16): cheap gestures wait for the release-save, but AI output must never be lost to a
   *  crash / leaving the space mid-chain. Fire-and-forget, SILENT (background persist — no toast).
   *  ⚡ unified-item-save phase 3: the solo/collab fork + the manual rebase are GONE — the engine's
   *  `ensureSaved` (via `flushSketchEntityUnderLock`) internalizes them (held → save-while-held +
   *  rebase baseline; browsed away → one-shot acquire→save→release; solo → whole-snapshot flush). */
  function persistVariantEntity(ref: VariantRef): void {
    void flushSketchEntityUnderLock(ref.kind, ref.entityKey);
  }

  // ── internal producers (immer) — called at await boundaries. All address ONE map entry, so a
  //    sibling variant's op is never touched. ────────────────────────────────────────────────────
  function setOpPhase(ref: VariantRef, phase: VariantGeneratePhase): void {
    set((state) => {
      const op = state.variantSheetGenerateOps[variantOpKey(ref)];
      if (op) op.phase = phase;
    });
  }
  /** Store the (already classified, friendly) message on the op; the op is KEPT until dismiss. */
  function markOpError(ref: VariantRef, message: string): void {
    set((state) => {
      const op = state.variantSheetGenerateOps[variantOpKey(ref)];
      if (op) op.error = message;
    });
  }
  /** Drop the op when it settled without error; on error keep it (content-area shows it inline).
   *  `delete` on the immer draft keeps the map identity stable for untouched keys. */
  function finalizeOp(ref: VariantRef): void {
    set((state) => {
      const key = variantOpKey(ref);
      const op = state.variantSheetGenerateOps[key];
      if (op && !op.error) delete state.variantSheetGenerateOps[key];
    });
  }

  // ── auto-cut (phase 2) — throws on failure so the caller's catch records the error. Reads NO DB. ─
  async function runCut(ref: VariantRef, rawImageUrl: string): Promise<void> {
    // Storage layout is keyed by the REAL COLLECTION ('characters' | 'props' — the endpoint's
    // documented `pathPrefix` shape), NOT the UI kind: an alter's assets live under
    // `sketches/variants/characters/…` next to the rest of that array, mirroring the Base space's
    // `sketches/base/characters` decision (Phase 06).
    const collection = KIND_ENTITY_SOURCE[ref.kind].collection;
    const pathPrefix = `sketches/variants/${collection}/${ref.entityKey}/${ref.variantKey}`;
    const result = await callCropSheetRow({
      imageUrl: rawImageUrl,
      cellCount: VARIANT_CELL_COUNT,
      pathPrefix,
    });
    if (opStale(ref)) return; // reset/replaced during the crop call → drop
    if (!result.success || !result.data) throw new Error(classifyError(result));

    const now = new Date().toISOString();
    // Map crops → positional cells. Each cell holds ONE canonical 'created' illustration (is_selected),
    // but the CELL itself is NOT auto-locked (is_selected=false) — the user picks 1/4 later.
    get().setSketchVariantCrops(
      ref.kind,
      ref.entityKey,
      ref.variantKey,
      result.data.crops.map((c) => ({
        is_selected: false,
        illustrations: [
          { type: 'created' as const, media_url: c.imageUrl, created_time: now, is_selected: true },
        ],
      })),
    );

    // Non-fatal geometry warnings — the sheet still cut, cells may just be slightly off.
    const meta = result.meta;
    if ((meta?.geoFallbackCount ?? 0) > 0 || meta?.fullbleedWarning) {
      log.warn('runCut', 'geometry warning — some cells may be misaligned', {
        kind: ref.kind,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
        geoFallbackCount: meta?.geoFallbackCount,
        fullbleedWarning: meta?.fullbleedWarning,
      });
      toast.warning('Some cells may be misaligned');
    }
  }

  // ── generate (phase 1) → auto-cut (phase 2) chain. Plain async, fire-and-forget from start. ─────
  async function runGenerate(ref: VariantRef): Promise<void> {
    try {
      // ⚡⚡ SAVE-BEFORE-GENERATE (unified-item-save-spec §4.2). Generate is SNAPSHOT-READING: the
      // endpoint reads DB text + the BE save_resource directive must anchor to a persisted node.
      // `ensureSaved` internalizes the solo/collab fork (was a manual `if (collab)` branch here):
      // held session → save-while-held + rebase; no session → one-shot acquire→save→release; solo →
      // flushSnapshot. Continue ONLY on saved|clean — never call the AI on a stale / peer-owned node.
      const { useSaveSessionStore } = await import('@/stores/save-session-store');
      const saveOutcome = await useSaveSessionStore
        .getState()
        .ensureSaved('sketch-entity', makeEntityId(ref.kind, ref.entityKey));
      if (opStale(ref)) return; // op reset during the save
      if (saveOutcome !== 'saved' && saveOutcome !== 'clean') {
        log.warn('runGenerate', 'save-before-generate not persisted — abort (degraded / stale DB)', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
          outcome: saveOutcome,
        });
        markOpError(ref, 'Could not save before generating — please try again.');
        return;
      }

      const snapshotId = get().meta.id; // ⚡ meta.id (NOT meta.snapshotId); brand-new book: null till first save
      if (!snapshotId) {
        log.warn('runGenerate', 'no snapshot id — cannot generate', { kind: ref.kind });
        markOpError(ref, NO_SNAPSHOT_MESSAGE); // keep the op (error set) so it surfaces; retryable after dismiss
        toast.error(NO_SNAPSHOT_MESSAGE);
        return; // do NOT call the endpoint (it would fail SNAPSHOT_NOT_FOUND)
      }

      // ⚡ Contract (ADR-047): artStyleId DROPPED (backend extra=forbid); modelParams optional (omit →
      // DB default — the variant space has no model UI yet). Style is inferred from the BASE_VARIANT.
      const gen = await callGenerateVariantSheet(ref.kind, {
        snapshotId,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
        // Opt-in auto-persist (BE-first double-write): prepend the raw sheet version into
        // variants[variantKey].raw_sheet.illustrations[] — the SAME node
        // setSketchVariantRawSheetIllustrations writes below. snapshotId is non-null here (guarded above).
        // ⚡ Path segment = the REAL COLLECTION, never the UI kind: `alter_characters` is not a
        // snapshot key, so it would anchor at a node that does not exist (silent no-op / 404).
        saveResource: buildImageVersionSaveResource(
          `col:sketch/key:${KIND_ENTITY_SOURCE[ref.kind].collection}/find:key=${ref.entityKey}/key:variants/find:key=${ref.variantKey}/key:raw_sheet`,
          snapshotId,
          'create',
        ),
      });
      if (opStale(ref)) return; // reset/replaced during the generate call → drop
      if (!gen.success || !gen.data) throw new Error(classifyError(gen));

      log.info('runGenerate', 'raw sheet done', {
        kind: ref.kind,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
      });

      // Prepend the raw sheet version (newest selected, clear prior selection) — preserves crops[].
      // Persist ai_request_id provenance (raw sheet = direct Gemini output).
      const now = new Date().toISOString();
      const prev = variantOf(ref)?.raw_sheet?.illustrations ?? [];
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
      get().setSketchVariantRawSheetIllustrations(ref.kind, ref.entityKey, ref.variantKey, next);

      // Phase 2 — AUTO-CUT (ALWAYS runs; no Re-cut button, no confirm).
      setOpPhase(ref, 'cut');
      await runCut(ref, gen.data.imageUrl);
    } catch (err) {
      if (opStale(ref)) return;
      const msg = err instanceof Error ? err.message : 'Variant sheet generation failed';
      log.error('runGenerate', 'failed', {
        kind: ref.kind,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
        error: msg,
      });
      markOpError(ref, msg); // keep the op so the notifications hook toasts once
    }

    if (opStale(ref)) return; // op reset during the last await → nothing to finalize
    persistVariantEntity(ref); // persist-after (raw sheet + crops landed in the store)
    finalizeOp(ref); // clear the op if it settled without error
  }

  // ── cut-only re-run (call-site #2: the user EDITED the raw sheet in the Raw tab → crops stale). ──
  // Mirrors runRecrop in #14. A full failure keeps the PREVIOUS crops[] (runCut only writes on
  // success) → the raw↔crops mismatch is accepted and surfaced by ONE toast from the notifications
  // hook (markOpError); the user re-triggers by editing the raw again / regenerating. No rollback of
  // the raw edit, no auto-retry (KISS — chốt Validation Session 1).
  async function runRecrop(ref: VariantRef, rawImageUrl: string): Promise<void> {
    try {
      await runCut(ref, rawImageUrl);
    } catch (err) {
      if (opStale(ref)) return;
      const msg = err instanceof Error ? err.message : 'Variant sheet cut failed';
      log.error('runRecrop', 'failed', {
        kind: ref.kind,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
        error: msg,
      });
      markOpError(ref, msg); // keep the op so the notifications hook toasts once
    }

    if (opStale(ref)) return; // op reset during the last await → nothing to finalize
    // Persist even on a cut failure: the RAW edit that triggered this re-cut is already in the store
    // and must land (the crops simply stay as they were).
    persistVariantEntity(ref);
    finalizeOp(ref);
  }

  return {
    variantSheetGenerateOps: {},

    startVariantSheetGenerate: (ref: VariantRef) => {
      const ops = get().variantSheetGenerateOps;
      const key = variantOpKey(ref);
      // Defensive net only — the call-site (doGenerate) already guards + toasts BEFORE adopting the
      // lock, so reaching any branch here means a programmatic caller, not a double click.
      if (hasOpForEntity(ops, ref)) {
        log.warn('startVariantSheetGenerate', 'blocked — this entity already has an op', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
          sameVariant: ops[key] != null,
        });
        return; // per-entity single-flight (the persist grain is the whole entity node)
      }
      const inFlight = countActiveVariantOps(ops);
      if (inFlight >= VARIANT_GENERATE_CONCURRENCY_CAP) {
        log.warn('startVariantSheetGenerate', 'blocked — client concurrency cap reached', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
          inFlight,
        });
        return;
      }

      // ⚡ Contract (ADR-047): the art-style gate is GONE — generate no longer requires
      // book.sketchstyle_id (style is inferred from the BASE_VARIANT anchor; backend dropped
      // artStyleId). snapshotId is resolved AFTER the flush (may be null before the first save).
      log.info('startVariantSheetGenerate', 'start', {
        kind: ref.kind,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
      });
      set((state) => {
        state.variantSheetGenerateOps[key] = {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
          phase: 'generate',
          startedAt: new Date().toISOString(),
        };
      });

      void runGenerate({ kind: ref.kind, entityKey: ref.entityKey, variantKey: ref.variantKey });
    },

    recropVariantSheet: (ref: VariantRef) => {
      const key = variantOpKey(ref);
      // Per-ENTITY, not per-variant: a re-cut ends in the same whole-entity persist as a generate,
      // so it must not overlap a sibling variant's chain either.
      if (hasOpForEntity(get().variantSheetGenerateOps, ref)) {
        // Reachable: the edit-image modal stays OPEN after a raw commit, so a 2nd commit can land
        // while the 1st re-cut is still in flight. Dropping it silently would leave crops[] cut from
        // the PREVIOUS raw with no signal and no reason for the user to re-trigger — toast so the
        // mismatch is visible and actionable (mirrors the recrop-failure policy: non-fatal toast,
        // keep the old crops, user re-triggers). Guard is per-variant: another variant generating
        // does NOT block this re-cut.
        log.warn('recropVariantSheet', 'blocked — this variant already has an op', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
        });
        toast.warning('Still processing the previous change — the cells were not re-cut. Try again in a moment.');
        return; // per-variant single-flight (shared with generate — one op per variant)
      }

      // Reads the effective raw SYNCHRONOUSLY, so a caller that just wrote a new raw version (the
      // Raw-tab edit commit) re-cuts from THAT version.
      const rawUrl = effectiveRawUrl(ref);
      if (!rawUrl) {
        log.warn('recropVariantSheet', 'no raw sheet to cut — skip', {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
        });
        return; // nothing generated yet → nothing to cut
      }

      log.info('recropVariantSheet', 'start', {
        kind: ref.kind,
        entityKey: ref.entityKey,
        variantKey: ref.variantKey,
      });
      set((state) => {
        state.variantSheetGenerateOps[key] = {
          kind: ref.kind,
          entityKey: ref.entityKey,
          variantKey: ref.variantKey,
          phase: 'cut', // skips 'generate' — the raw already exists (content-area shows "Cutting cells…")
          startedAt: new Date().toISOString(),
        };
      });

      void runRecrop({ kind: ref.kind, entityKey: ref.entityKey, variantKey: ref.variantKey }, rawUrl);
    },

    dismissVariantSheetGenerateError: (ref: VariantRef) =>
      set((state) => {
        const key = variantOpKey(ref);
        const op = state.variantSheetGenerateOps[key];
        if (op && op.error) {
          log.debug('dismissVariantSheetGenerateError', 'clear settled-with-error op', {
            kind: op.kind,
            entityKey: op.entityKey,
            variantKey: op.variantKey,
          });
          delete state.variantSheetGenerateOps[key]; // kept only to surface the error → drop it
        }
      }),
  };
};
