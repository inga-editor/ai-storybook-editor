// sketch-stages-creative-space.tsx — root of the Sketch STAGES creative space (design README §2).
// ONE space for EVERY stage (no props): left StageSidebar (collapsible group per stage → Base
// style rows + Variant rows), right StageSheetContentArea (Raw/Crop of the selected target —
// base style attempt OR variant, same displayed 2-cell shape). Owns the local UI state (selection,
// tab, zoom, expanded groups, modal states) and DERIVES the effective selection in RENDER
// (React 19: no useEffect+setState, no ref access in render).
//
// Collab (9th collab space — ADR-043 lineage): mounts `useCollabPersistSession` +
// `useContentSyncSession` FIRST (teardown order — memory *held-session teardown-order*), then
// `useStageLockSession` (per-STAGE held lock, step 1 / rtype 5, whole node — base.styles[] +
// variants[] together). Browse ≠ lock: onSelect is display-only; every mutation seam
// (＋/🔒/✏/✨/[✎]/card/[⧉]) adopts the stage lock first. Peer-lock is advisory (sidebar badge +
// content veil); the acquire 409 is the authority. BATCH-AT-RELEASE: cheap gestures mutate the
// store under the hold and land at the release-save; exceptions (generate persist-after in the
// job slice, the H2 select-crop flush) documented in use-stage-lock-session.ts.
//
// Import ⬆ (design 05): parse tab `Stages` → confirm → REPLACE stages[] via the gateway
// collection-scope save (rtype 5, sentinel resource_id 'stages' — NOT the held session). A stage
// peer-held → whole-batch 409 + toast (locked decision — no FE pre-check guard).
//
// ⚠️ Export name MUST stay `SketchStagesCreativeSpace` (editor-page routing imports it).

import { useCallback, useMemo, useState } from 'react';
import { Landmark } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useSketchStages,
  useStageSheetGenerateOp,
  useStageGenerateStatus,
  useSnapshotActions,
  useSnapshotId,
  stageTargetsEqual,
} from '@/stores/snapshot-store/selectors';
import { useCurrentBookId } from '@/stores/book-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { CANVAS_CONFIRM_DIALOG_Z } from '@/constants/spread-constants';
import type { SketchStage, StageSelection } from '@/types/sketch';
import { effectiveStageBaseUrl } from '@/types/sketch';
import type { SaveResourceDirective } from '@/types/save-resource';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { createLogger } from '@/utils/logger';
import { useStageLockSession } from './use-stage-lock-session';
import { StageSidebar } from './stage-sidebar';
import { StageSheetContentArea } from './stage-sheet-content-area';
import { GenerateStageStyleModal } from './generate-stage-style-modal';
import { EditStageVariantModal } from './edit-stage-variant-modal';
import { StageEditImageModal } from './stage-edit-image-modal';
import { StageExtractImageModal } from './stage-extract-image-modal';
import { useStageImport } from './use-stage-import';
import {
  ZOOM,
  isBlank,
  type GenerateStyleModalState,
  type EditTextModalState,
  type StageEditImageTarget,
  type StageExtractImageTarget,
  type StageGate,
  type StageGenStatus,
} from './sketch-stages-constants';

const log = createLogger('Editor', 'SketchStagesCreativeSpace');

/** Default target for a stage (auto-select order): locked style ?? style 0 ?? first non-base
 *  variant ?? null (a stage can be all-empty right after import). */
function defaultTargetOf(stage: SketchStage): StageSelection | null {
  const lockedIdx = stage.base.styles.findIndex((s) => s.is_selected);
  if (lockedIdx >= 0) return { stageKey: stage.key, target: 'base', styleIndex: lockedIdx };
  if (stage.base.styles.length > 0) return { stageKey: stage.key, target: 'base', styleIndex: 0 };
  const firstVariant = stage.variants.find((v) => v.key !== 'base');
  if (firstVariant) return { stageKey: stage.key, target: 'variant', variantKey: firstVariant.key };
  return null;
}

/** Is this selection still resolvable against the current stages[]? */
function selectionAlive(sel: StageSelection, stages: SketchStage[]): boolean {
  const stage = stages.find((s) => s.key === sel.stageKey);
  if (!stage) return false;
  if (sel.target === 'base') return sel.styleIndex >= 0 && sel.styleIndex < stage.base.styles.length;
  return stage.variants.some((v) => v.key === sel.variantKey && v.key !== 'base');
}

export function SketchStagesCreativeSpace() {
  // ── Collab session mount — DECLARED FIRST (teardown order: persist-session must outlive the
  // held session's release-save cleanup). ─────────────────────────────────────────────────────
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const stages = useSketchStages();
  const op = useStageSheetGenerateOp();
  const {
    setSketchStageStyleSelected,
    selectSketchStageBaseCrop,
    selectSketchStageVariantCrop,
    startStageVariantSheetGenerate,
  } = useSnapshotActions();
  // Book-edit context (Sketch space is never remix) → the opt-in saveResource snapshot root.
  const snapshotId = useSnapshotId();

  // ── Local UI state (owner = this root; state-location rule) ─────────────────────────────────
  const [userSelection, setUserSelection] = useState<StageSelection | null>(null);
  const [activeTab, setActiveTab] = useState<'raw' | 'crop'>('raw');
  const [zoom, setZoom] = useState<number>(ZOOM.default);
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({});
  const [generateStyleModal, setGenerateStyleModal] = useState<GenerateStyleModalState | null>(null);
  const [editTextModal, setEditTextModal] = useState<EditTextModalState | null>(null);
  const [editImageTarget, setEditImageTarget] = useState<StageEditImageTarget | null>(null);
  const [extractImageTarget, setExtractImageTarget] = useState<StageExtractImageTarget | null>(null);
  // ✨ on a variant that already has crops → confirm EVERY time (guards the pick + per-cell edits).
  const [pendingRegenerate, setPendingRegenerate] = useState<{ stageKey: string; variantKey: string } | null>(null);

  // Derive the effective selection in RENDER (React 19: never set state in render): keep the
  // user's choice while it still resolves, else fall back to the first stage's default target.
  const selection = useMemo<StageSelection | null>(() => {
    if (userSelection && selectionAlive(userSelection, stages)) return userSelection;
    for (const stage of stages) {
      const target = defaultTargetOf(stage);
      if (target) return target;
    }
    return null;
  }, [userSelection, stages]);

  const selectedStage = useMemo(
    () => (selection ? stages.find((s) => s.key === selection.stageKey) : undefined),
    [stages, selection],
  );

  // Content binding: ONE component, TWO bindings — base style attempt | variant (same shape).
  const sheet = useMemo(() => {
    if (!selection || !selectedStage) return undefined;
    if (selection.target === 'base') {
      const style = selectedStage.base.styles[selection.styleIndex];
      return style ? { illustrations: style.illustrations, crops: style.crops } : undefined;
    }
    const variant = selectedStage.variants.find((v) => v.key === selection.variantKey);
    return variant ? { illustrations: variant.illustrations, crops: variant.crops } : undefined;
  }, [selection, selectedStage]);

  const genStatusSelected = useStageGenerateStatus(selection);

  // Per-row status from the single-flight op (fresh on every phase/error transition).
  const genStatusByTarget = useCallback(
    (target: StageSelection): StageGenStatus => {
      if (op && stageTargetsEqual(op.target, target)) return { isBusy: !op.error, phase: op.phase, error: op.error };
      return { isBusy: false };
    },
    [op],
  );

  // ✨ gate — FE fail-fast on API 12's hard preconditions. REACTIVE (reads the subscribed stages).
  const gateByVariant = useCallback(
    (stageKey: string, variantKey: string): StageGate => {
      const stage = stages.find((s) => s.key === stageKey);
      if (!stage || !effectiveStageBaseUrl(stage)) {
        return { canGenerate: false, reason: 'base-not-ready' };
      }
      const variant = stage.variants.find((v) => v.key === variantKey);
      if (isBlank(variant?.visual_design) && isBlank(variant?.art_language)) {
        return { canGenerate: false, reason: 'empty-text' };
      }
      return { canGenerate: true };
    },
    [stages],
  );

  // ── Per-stage save session (lockless) — binds to the SELECTED stage; begins 'held' synchronously
  // (no acquire). ──────────────────────────────────────────────────────────────────────────────
  const lock = useStageLockSession(selection?.stageKey ?? null);

  // ── Handlers ─────────────────────────────────────────────────────────────────────────────────
  // SELECT (display + session target). Switching to a DIFFERENT stage re-targets the session → the
  // OLD stage node release-saves on the switch.
  const handleSelect = useCallback((sel: StageSelection) => {
    setUserSelection(sel);
    setActiveTab('raw');
  }, []);

  const handleToggleStage = useCallback((stageKey: string) => {
    setExpandedStages((prev) => ({ ...prev, [stageKey]: !(prev[stageKey] ?? true) }));
  }, []);

  // ＋ add style: open the generate modal (mode add).
  const handleAddStyle = useCallback((stageKey: string) => {
    log.info('handleAddStyle', 'open generate modal', { stageKey });
    setGenerateStyleModal({ stageKey, mode: 'add' });
  }, []);

  // 🔒 lock style: exclusive is_selected + clone refresh (all inside the store setter), then flush
  // the stage node eagerly — a lock is a high-value pick (mirrors the base space's persistLockStyle
  // and the crop-pick net): waiting for save-on-leave/idle-sweep risks losing it on a tab kill.
  const handleLockStyle = useCallback(
    (stageKey: string, styleIndex: number) => {
      log.info('handleLockStyle', 'lock style', { stageKey, styleIndex });
      setSketchStageStyleSelected(stageKey, styleIndex);
      lock.flushStageNow(stageKey);
    },
    [setSketchStageStyleSelected, lock],
  );

  // ✏ edit text (Base header → 'base'; variant row → that variant): open the modal.
  const handleEditText = useCallback((stageKey: string, variantKey: string) => {
    log.info('handleEditText', 'open text modal', { stageKey, variantKey });
    setEditTextModal({ stageKey, variantKey });
  }, []);

  // ✨ generate variant: run (the job flushes the stage node itself — 12 reads the DB).
  const doGenerateVariant = useCallback(
    (stageKey: string, variantKey: string) => {
      log.info('doGenerateVariant', 'start variant sheet generate', {
        stageKey,
        variantKey,
      });
      startStageVariantSheetGenerate(stageKey, variantKey);
    },
    [startStageVariantSheetGenerate],
  );

  const handleGenerateVariant = useCallback(
    (stageKey: string, variantKey: string) => {
      const variant = stages.find((s) => s.key === stageKey)?.variants.find((v) => v.key === variantKey);
      if ((variant?.crops.length ?? 0) > 0) {
        log.debug('handleGenerateVariant', 'crops present → confirm regenerate', { stageKey, variantKey });
        setPendingRegenerate({ stageKey, variantKey });
        return;
      }
      doGenerateVariant(stageKey, variantKey);
    },
    [stages, doGenerateVariant],
  );

  const confirmRegenerate = useCallback(() => {
    if (pendingRegenerate) doGenerateVariant(pendingRegenerate.stageKey, pendingRegenerate.variantKey);
    setPendingRegenerate(null);
  }, [pendingRegenerate, doGenerateVariant]);

  // [✎] raw: open the edit-image modal (raw scope — commit AUTO re-cuts).
  const handleEditRaw = useCallback(() => {
    if (!selection) return;
    log.info('handleEditRaw', 'open image modal (raw scope)', {
      stageKey: selection.stageKey,
      target: selection.target,
    });
    setEditImageTarget(
      selection.target === 'base'
        ? { stageKey: selection.stageKey, scope: 'base-raw', styleIndex: selection.styleIndex }
        : { stageKey: selection.stageKey, scope: 'variant-raw', variantKey: selection.variantKey },
    );
  }, [selection]);

  // Click crop card = pick 1/2: flip the mutex + EAGER flush (crop-pick net; the session is already
  // held for the selected stage — see use-stage-lock-session.flushStageNow).
  const handleSelectCrop = useCallback(
    (cropIndex: number) => {
      if (!selection) return;
      log.debug('handleSelectCrop', 'pick crop + flush', { cropIndex });
      if (selection.target === 'base') {
        selectSketchStageBaseCrop(selection.stageKey, selection.styleIndex, cropIndex);
      } else {
        selectSketchStageVariantCrop(selection.stageKey, selection.variantKey, cropIndex);
      }
      lock.flushStageNow(selection.stageKey);
    },
    [selection, lock, selectSketchStageBaseCrop, selectSketchStageVariantCrop],
  );

  // [✎] one crop cell: open the edit-image modal on that cell.
  const handleEditCrop = useCallback(
    (cropIndex: number) => {
      if (!selection) return;
      log.info('handleEditCrop', 'open image modal (crop scope)', {
        stageKey: selection.stageKey,
        cropIndex,
      });
      setEditImageTarget(
        selection.target === 'base'
          ? { stageKey: selection.stageKey, scope: 'base-crop', styleIndex: selection.styleIndex, cropIndex }
          : { stageKey: selection.stageKey, scope: 'variant-crop', variantKey: selection.variantKey, cropIndex },
      );
    },
    [selection],
  );

  // [⧉] extract from one crop cell: open the extract modal (crop scope, append version).
  const handleExtractCrop = useCallback(
    (cropIndex: number) => {
      if (!selection) return;
      log.info('handleExtractCrop', 'open extract modal', {
        stageKey: selection.stageKey,
        cropIndex,
      });
      setExtractImageTarget(
        selection.target === 'base'
          ? { stageKey: selection.stageKey, scope: 'base-crop', styleIndex: selection.styleIndex, cropIndex }
          : { stageKey: selection.stageKey, scope: 'variant-crop', variantKey: selection.variantKey, cropIndex },
      );
    },
    [selection],
  );

  // === Phase 04: opt-in saveResource for the Edit path (4 scopes) ===
  // Stage anchors (per BE path grammar): base workspace lives PER-STAGE under
  // `key:stages/find:key/key:base/key:styles/idx`; the stage variant is FLAT (NO `raw_sheet`) —
  // variant-raw anchors the variant node itself, crops are positional (`key:crops/idx`).
  // Undefined snapshot ⇒ omit. (Extract crop = RESERVED — see the modal mount below.)
  const editImageSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (!snapshotId || !editImageTarget) return undefined;
    const t = editImageTarget;
    const stageRoot = `col:sketch/key:stages/find:key=${t.stageKey}`;
    let path: string;
    switch (t.scope) {
      case 'base-raw':
        path = `${stageRoot}/key:base/key:styles/idx:${t.styleIndex}`;
        break;
      case 'base-crop':
        path = `${stageRoot}/key:base/key:styles/idx:${t.styleIndex}/key:crops/idx:${t.cropIndex}`;
        break;
      case 'variant-raw':
        path = `${stageRoot}/key:variants/find:key=${t.variantKey}`; // FLAT — no raw_sheet
        break;
      case 'variant-crop':
        path = `${stageRoot}/key:variants/find:key=${t.variantKey}/key:crops/idx:${t.cropIndex}`;
        break;
    }
    return buildImageVersionSaveResource(path, snapshotId, 'edit');
  }, [snapshotId, editImageTarget]);

  // ── Import ⬆ (design 05) — parse/confirm/commit pipeline lives in useStageImport. ───────────
  const handleImportReplaced = useCallback(() => {
    setUserSelection(null); // stale selection after a full replace → re-derive
    setExpandedStages({});
  }, []);
  const { isImporting, pendingImport, handleImport, confirmImport, cancelImport } = useStageImport({
    hasExistingStages: stages.length > 0,
    onReplaced: handleImportReplaced,
  });

  const regenerateMention = pendingRegenerate
    ? `@${pendingRegenerate.stageKey}/${pendingRegenerate.variantKey}`
    : '';

  return (
    <main className="flex h-full" role="main" aria-label="Sketch stages creative space">
      <StageSidebar
        stages={stages}
        selection={selection}
        expandedStages={expandedStages}
        genStatusByTarget={genStatusByTarget}
        gateByVariant={gateByVariant}
        onSelect={handleSelect}
        onToggleStage={handleToggleStage}
        onAddStyle={handleAddStyle}
        onLockStyle={handleLockStyle}
        onEditText={handleEditText}
        onGenerateVariant={handleGenerateVariant}
        onImport={handleImport}
        isImporting={isImporting}
      />

      <div className="relative flex flex-1 min-w-[480px] overflow-hidden">
        {selection ? (
          <StageSheetContentArea
            selection={selection}
            sheet={sheet}
            activeTab={activeTab}
            zoom={zoom}
            genStatus={genStatusSelected}
            onChangeTab={setActiveTab}
            onChangeZoom={setZoom}
            onEditRaw={handleEditRaw}
            onSelectCrop={handleSelectCrop}
            onEditCrop={handleEditCrop}
            onExtractCrop={handleExtractCrop}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Overlays (mount by state). None persists directly: mutations land under the held lock
          at the release-save; the raw-edit re-cut + generate chains persist inside the job slice. */}
      {generateStyleModal && (
        <GenerateStageStyleModal
          stageKey={generateStyleModal.stageKey}
          mode={generateStyleModal.mode}
          styleIndex={generateStyleModal.styleIndex}
          onEnqueued={(stageKey, styleIndex) => {
            setUserSelection({ stageKey, target: 'base', styleIndex });
            setActiveTab('raw');
          }}
          onClose={() => setGenerateStyleModal(null)}
        />
      )}
      {editTextModal && (
        <EditStageVariantModal
          stageKey={editTextModal.stageKey}
          variantKey={editTextModal.variantKey}
          onClose={() => setEditTextModal(null)}
        />
      )}
      {editImageTarget && (
        <StageEditImageModal
          target={editImageTarget}
          onClose={() => setEditImageTarget(null)}
          saveResource={editImageSaveResource}
        />
      )}
      {extractImageTarget && (
        // Phase 04 RESERVED: NO saveResource — the stage Extract exposes the Crop tab only (CV cut,
        // no AI provider → no anchor to double-write). Extracted cells persist via onCreateImages
        // (setSketchStage*CropIllustrations + the stage held-session release-save).
        <StageExtractImageModal target={extractImageTarget} onClose={() => setExtractImageTarget(null)} />
      )}

      {/* Regenerate-variant confirm — over-canvas z (shadcn z-50 is buried by canvas textboxes). */}
      <AlertDialog
        open={pendingRegenerate !== null}
        onOpenChange={(open) => !open && setPendingRegenerate(null)}
      >
        <AlertDialogContent zIndex={CANVAS_CONFIRM_DIALOG_Z}>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate {regenerateMention}?</AlertDialogTitle>
            <AlertDialogDescription>
              This overwrites the current 2 option crops for {regenerateMention}. The picked cell and
              any per-cell edits will be lost. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRegenerate}>Regenerate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import confirm — REPLACE loses every generated image (locked decision: no merge-by-key). */}
      <AlertDialog open={pendingImport !== null} onOpenChange={(open) => !open && cancelImport()}>
        <AlertDialogContent zIndex={CANVAS_CONFIRM_DIALOG_Z}>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace ALL stages?</AlertDialogTitle>
            <AlertDialogDescription>
              Importing replaces every stage with the Excel data — all generated base styles and
              variant images will be deleted, including stages with matching keys. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmImport}>Replace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

/** Shown when there is no stage at all yet (nothing imported). */
function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Landmark className="h-10 w-10 opacity-60" aria-hidden="true" />
      <div>
        <p className="text-sm">No stages yet</p>
        <p className="mt-1 text-xs">Import stages from Excel (⬆ in the sidebar).</p>
      </div>
    </div>
  );
}
