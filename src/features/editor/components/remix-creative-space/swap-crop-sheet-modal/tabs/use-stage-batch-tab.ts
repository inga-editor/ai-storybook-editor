// use-stage-batch-tab.ts — Shared logic of the 3 stage tabs (Crops / Remove BG
// / Upscale — design 05-11). The tabs are isomorphic; everything common lives
// HERE: active batch/sheet/selectedSwap derivation, gating, rev6 tick-flow
// subset Add Batch, rev7 per-stage ownership + take-back, the destructive
// relayout confirm, Import gating, and the per-stage overlay copy.
//
// Instances stay thin: they call this hook with their stage + an optional
// per-stage `precondition` resolver (mixes: visual_swap_url gating; rmbgs/
// upscales: default crops-non-empty), then render Sidebar + CropSheetStage +
// RelayoutConfirmDialog from the returned bag.
//
// Selection lives in the modal-mounted `SelectionProvider` (keyed remount per
// stage — chốt 2026-06-12); this hook only CONSUMES it.
//
// SECURITY: never log media_url / swap URLs.

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import type {
  BatchSwapTaskStatus,
  RemixStageBatch,
  StageKind,
} from '@/types/remix';
import { PREV_STAGE } from '@/types/remix';
import { useStageDataAdapter } from '../stage-data-adapter';
import { STAGE_TAB_CONFIG, type StageTabConfig } from '../stage-tab-config';
import type { RelayoutConfirmKind } from '../relayout-confirm-dialog';
import { useCollapseState, type CollapseSetApi } from '../sidebar/use-collapse-state';
import { useSelectedSwapCrops } from '../hooks/use-selected-swap-crops';
import {
  useCropOwnership,
  type CropOwnershipState,
} from '../hooks/use-crop-ownership';

const log = createLogger('Editor', 'useStageBatchTab');

/** Shared props contract of the 3 stage-tab instances (root 05 §3.3).
 *  Selection is NOT here — it flows through the SelectionProvider context. */
export interface StageBatchTabProps {
  remixId: string;
  batches: RemixStageBatch[];
  activeBatchRef: { batchId: string; sheetIndex: number } | null;
  /** useAnyStageJobRunning(remixId, stage) — guards within THIS stage only. */
  anyJobRunning: boolean;
  submittingBatchId: string | null;
  onSelectBatchSheet: (batchId: string, sheetIndex: number) => void;
  /** Auto-select a freshly created batch (subset-add / import). */
  onActivateBatch: (ref: { batchId: string; sheetIndex: number }) => void;
  onRemoveBatch: (batchId: string) => void;
  onAddSheet: (batchId: string) => void;
  onRemoveSheet: (batchId: string, sheetIndex: number) => void;
  /** Action button → modal's handleStartStageJob(stage, batchId). */
  onStartJob: (batchId: string) => void;
  /** ONLY passed to rmbg/upscale instances (cfg.hasImport). */
  onOpenImport?: () => void;
  // shared stage state (root-owned)
  compareMode: boolean;
  zoomLevel: number;
  dividerPosition: number;
  onToggleCompare: () => void;
  onZoomChange: (z: number) => void;
  onDividerChange: (p: number) => void;
}

/** Per-stage action precondition. Default (rmbgs/upscales): the batch has ≥1
 *  sheet with non-empty `original_crops[]`. */
export interface StageGateResult {
  ok: boolean;
  reason?: string;
}

/** Per-batch evaluation of the stage's primary action (⚡2026-06-26 — moved
 *  from the stage header into each sidebar batch row). Computed per batch so
 *  every row reflects its OWN crops/precondition/running state. */
export interface BatchActionState {
  /** Gate failed OR a stage job is running OR this batch is busy. */
  disabled: boolean;
  /** Why it's disabled (gate reason / per-stage mutex) — surfaced as a row
   *  tooltip. Undefined when actionable. */
  tooltip?: string;
  /** This batch's job is submitting/running → spinner + aria-busy. */
  busy: boolean;
  /** This batch's last job errored → label flips to the retry copy. */
  isError: boolean;
}

interface PendingAction {
  kind: RelayoutConfirmKind;
  batchName: string;
  run: () => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** True when any sheet of the batch carries ≥1 swap result. */
export function batchHasSwapResults(batch: RemixStageBatch): boolean {
  return batch.crop_sheets.some((s) => s.swap_results.length > 0);
}

export interface StageBatchTabState {
  cfg: StageTabConfig;
  batch: RemixStageBatch | null;
  sheetIndex: number;
  sheet: RemixStageBatch['crop_sheets'][number] | null;
  selectedSwap: RemixStageBatch['crop_sheets'][number]['swap_results'][number] | null;
  swapTask: BatchSwapTaskStatus;
  isSubmitting: boolean;
  isRunning: boolean;
  // ⚡2026-06-26 per-batch primary action (sidebar rows)
  evaluateBatchAction: (batch: RemixStageBatch) => BatchActionState;
  handleStartBatchJob: (batchId: string) => void;
  // rev6 selection / subset-add
  selectionSize: number;
  selectedSwapCrops: ReadonlySet<string>;
  toggleSwapCropSelection: (cropKey: string) => void;
  stageSelectable: boolean;
  canAddBatch: boolean;
  addBatchTooltip: string;
  handleAddBatch: () => Promise<void>;
  // rev7 ownership (per stage)
  getOwnership: (cropKey: string) => CropOwnershipState;
  handleTakeBack: (cropKey: string) => void;
  // destructive guard (confirm dialog)
  pending: PendingAction | null;
  confirmPending: () => void;
  cancelPending: () => void;
  handleAddSheetGuarded: (batchId: string) => void;
  handleRemoveSheetGuarded: (batchId: string, sheetIndex: number) => void;
  handleRemoveBatchGuarded: (batchId: string) => void;
  // Import (hasImport stages)
  importDisabled: boolean;
  importTooltip: string;
  // overlay copy
  runningLabel: (current: number, total: number) => string;
  submittingLabel: string;
  // sidebar collapse
  collapse: CollapseSetApi;
}

export function useStageBatchTab(
  stage: StageKind,
  props: StageBatchTabProps,
  /** Per-stage extra precondition (mixes: sprite finals). Runs AFTER the
   *  generic crops-non-empty check. */
  precondition?: (batch: RemixStageBatch) => StageGateResult,
): StageBatchTabState {
  const cfg = STAGE_TAB_CONFIG[stage];
  // `remixId` stays on StageBatchTabProps (public contract) but the owner is now
  // implicit in the adapter — no direct store call keyed on it here.
  const {
    batches,
    activeBatchRef,
    anyJobRunning,
    submittingBatchId,
    onActivateBatch,
    onSelectBatchSheet,
    onStartJob,
    onRemoveBatch,
    onAddSheet,
    onRemoveSheet,
    compareMode,
  } = props;

  const collapse = useCollapseState();
  const [pending, setPending] = useState<PendingAction | null>(null);

  const {
    keys: selectedSwapCrops,
    toggle: toggleSwapCropSelection,
    clear: clearSwapCropSelection,
  } = useSelectedSwapCrops();
  // Stage data + actions come from the modal-mounted adapter (remix today,
  // actors in phase 08) — this hook no longer imports the remix store directly.
  const adapter = useStageDataAdapter();
  const { addStageBatch, takeFinalBack } = adapter;
  const remix = adapter.remix;

  // Import gating — finals of the PREVIOUS stage (mixes has no import → skip).
  const importDisabled =
    cfg.hasImport &&
    adapter.stageFinals(PREV_STAGE[stage as 'rmbgs' | 'upscales']).length === 0;
  const importTooltip = importDisabled
    ? 'Run the previous stage and pick finals first'
    : '';

  // ── Derive active batch / sheet / swap ──────────────────────────────────────
  const batch = useMemo(
    () =>
      batches.find((b) => b.id === activeBatchRef?.batchId) ??
      batches[0] ??
      null,
    [batches, activeBatchRef],
  );

  // ⚡rev7 — per-stage ownership for the AFTER pane. Keyed on the EFFECTIVE
  // batch (ref may be stale/null while the displayed batch falls back to
  // batches[0] — e.g. rows arriving via realtime after mount); using the raw
  // ref would mis-render the batch's own finals as owned-foreign.
  const currentBatchId = batch?.id ?? null;
  const { getOwnership } = useCropOwnership(remix, stage, currentBatchId);
  const sheetCount = batch?.crop_sheets.length ?? 0;
  const sheetIndex =
    batch && sheetCount > 0
      ? clamp(activeBatchRef?.sheetIndex ?? 0, 0, sheetCount - 1)
      : 0;
  const sheet = batch?.crop_sheets[sheetIndex] ?? null;
  const selectedSwap = sheet?.swap_results.find((s) => s.is_selected) ?? null;
  const swapTask = batch?.swapTask ?? { state: 'idle' as const };
  const isSubmitting =
    submittingBatchId != null && submittingBatchId === batch?.id;
  const isRunning = swapTask.state === 'running';

  // ── Per-batch action gating (⚡2026-06-26 — the primary Swap/Remove BG/
  // Upscale action moved from the stage header into each sidebar batch row).
  // Evaluated per batch (the row owns its own gate), so a busy/empty batch
  // disables ITS button while siblings stay actionable. `anyJobRunning` is the
  // shared per-stage mutex (only one job at a time across the remix). ──────────
  const evaluateBatchAction = useCallback(
    (b: RemixStageBatch): BatchActionState => {
      const running = b.swapTask?.state === 'running';
      const submitting = submittingBatchId === b.id;
      const busy = running || submitting;
      const isError = b.swapTask?.state === 'error';

      const hasCrops = b.crop_sheets.some((s) => s.original_crops.length > 0);
      const gate: StageGateResult = !hasCrops
        ? { ok: false, reason: 'This batch has no crops to process' }
        : (precondition?.(b) ?? { ok: true });

      const disabled = !gate.ok || anyJobRunning || busy;
      const tooltip =
        anyJobRunning && !busy
          ? `A ${cfg.actionLabel.toLowerCase()} job is already running for this remix`
          : !gate.ok
            ? gate.reason
            : undefined;
      return { disabled, tooltip, busy, isError };
    },
    [precondition, anyJobRunning, submittingBatchId, cfg.actionLabel],
  );

  // ── rev6 subset Add Batch ───────────────────────────────────────────────────
  const selectionSize = selectedSwapCrops.size;
  const stageSelectable =
    selectedSwap !== null && !compareMode && !isSubmitting && !isRunning;
  const canAddBatch =
    selectionSize > 0 && !isSubmitting && !isRunning && !anyJobRunning;
  const addBatchTooltip =
    selectionSize === 0
      ? 'Tick the crops you want to redo first — checkboxes on each crop in the result'
      : anyJobRunning
        ? 'Wait until the current job finishes'
        : '';

  const handleAddBatch = useCallback(async () => {
    if (selectionSize === 0) {
      log.warn('handleAddBatch', 'empty selection — abort', { stage });
      return;
    }
    if (anyJobRunning || isSubmitting || isRunning) {
      log.warn('handleAddBatch', 'busy — abort', { stage, anyJobRunning });
      return;
    }
    const activeBatchId = activeBatchRef?.batchId ?? batches[0]?.id;
    if (!activeBatchId) {
      log.warn('handleAddBatch', 'no active batch — abort', { stage });
      return;
    }
    log.info('handleAddBatch', 'start subset add batch', {
      stage,
      activeBatchId,
      selectionSize,
    });
    try {
      const newBatchId = await addStageBatch(
        stage,
        activeBatchId,
        selectedSwapCrops,
      );
      if (newBatchId === null) {
        log.error('handleAddBatch', 'addStageBatch returned null', { stage });
        toast.error("Couldn't add batch — try again");
        clearSwapCropSelection();
        return;
      }
      clearSwapCropSelection();
      onActivateBatch({ batchId: newBatchId, sheetIndex: 0 });
      log.info('handleAddBatch', 'success', { stage, newBatchId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add batch';
      log.error('handleAddBatch', 'failed', { stage, error: msg });
      toast.error(msg);
      clearSwapCropSelection();
    }
  }, [
    stage,
    selectionSize,
    anyJobRunning,
    isSubmitting,
    isRunning,
    activeBatchRef,
    batches,
    addStageBatch,
    selectedSwapCrops,
    clearSwapCropSelection,
    onActivateBatch,
  ]);

  // ── rev7 take-back (per-stage mutex) ────────────────────────────────────────
  const handleTakeBack = useCallback(
    (cropKey: string) => {
      if (!currentBatchId) {
        log.warn('handleTakeBack', 'no currentBatchId — ignore', { stage });
        return;
      }
      const sepIdx = cropKey.indexOf('/');
      if (sepIdx < 0) return;
      const spreadId = cropKey.slice(0, sepIdx);
      const layerId = cropKey.slice(sepIdx + 1);
      const ownership = getOwnership(cropKey);
      if (ownership.state !== 'owned-foreign') {
        log.debug('handleTakeBack', 'not foreign-owned — ignore', {
          stage,
          cropKey,
          state: ownership.state,
        });
        return;
      }
      log.info('handleTakeBack', 'invoking takeFinalBack', {
        stage,
        cropKey,
        targetBatchId: currentBatchId,
      });
      takeFinalBack(stage, spreadId, layerId, currentBatchId)
        .then((ok) => {
          if (!ok) toast.error('Could not take the final crop back.');
        })
        .catch((err) => {
          log.warn('handleTakeBack', 'rejected', {
            stage,
            error: err instanceof Error ? err.message : String(err),
          });
          toast.error(
            err instanceof Error
              ? err.message
              : 'Could not take the final crop back.',
          );
        });
    },
    [stage, currentBatchId, getOwnership, takeFinalBack],
  );

  // ── Destructive-action guard (deferred-action pattern) ──────────────────────
  const findBatch = useCallback(
    (batchId: string) => batches.find((b) => b.id === batchId) ?? null,
    [batches],
  );
  const guardDestructive = useCallback(
    (target: RemixStageBatch, kind: RelayoutConfirmKind, run: () => void) => {
      if (batchHasSwapResults(target)) {
        log.info('guardDestructive', 'defer destructive action — confirm', {
          stage,
          batchId: target.id,
          kind,
        });
        setPending({ kind, batchName: target.name, run });
      } else {
        run();
      }
    },
    [stage],
  );

  const handleAddSheetGuarded = useCallback(
    (batchId: string) => {
      const target = findBatch(batchId);
      if (!target) return;
      guardDestructive(target, 'add-sheet', () => onAddSheet(batchId));
    },
    [findBatch, guardDestructive, onAddSheet],
  );
  const handleRemoveSheetGuarded = useCallback(
    (batchId: string, idx: number) => {
      const target = findBatch(batchId);
      if (!target) return;
      guardDestructive(target, 'remove-sheet', () => onRemoveSheet(batchId, idx));
    },
    [findBatch, guardDestructive, onRemoveSheet],
  );
  const handleRemoveBatchGuarded = useCallback(
    (batchId: string) => {
      const target = findBatch(batchId);
      if (!target) return;
      guardDestructive(target, 'remove-batch', () => onRemoveBatch(batchId));
    },
    [findBatch, guardDestructive, onRemoveBatch],
  );

  const confirmPending = useCallback(() => {
    setPending((p) => {
      if (p) {
        log.info('confirmPending', 'run deferred destructive action', {
          stage,
          kind: p.kind,
        });
        p.run();
      }
      return null;
    });
  }, [stage]);
  const cancelPending = useCallback(() => setPending(null), []);

  // ⚡2026-06-26 — per-row action: select the target batch (so the stage canvas
  // tracks ITS progress overlay) then enqueue. `onStartJob` is already
  // per-batch (modal → handleStartStageJob(stage, batchId)); selection only
  // moves the active ref. Preserve the active sheet when re-running the already-
  // selected batch; otherwise start at sheet 0.
  const handleStartBatchJob = useCallback(
    (batchId: string) => {
      const sheetIndex =
        activeBatchRef && activeBatchRef.batchId === batchId
          ? activeBatchRef.sheetIndex
          : 0;
      log.info('handleStartBatchJob', 'select + start stage job', {
        stage,
        batchId,
      });
      onSelectBatchSheet(batchId, sheetIndex);
      onStartJob(batchId);
    },
    [stage, activeBatchRef, onSelectBatchSheet, onStartJob],
  );

  // ── Per-stage overlay copy ──────────────────────────────────────────────────
  const verb =
    stage === 'mixes' ? 'Swapping' : stage === 'rmbgs' ? 'Removing background' : 'Upscaling';
  const runningLabel = useCallback(
    (current: number, total: number) => `${verb} sheet ${current}/${total}…`,
    [verb],
  );
  const submittingLabel = `Starting ${cfg.actionLabel.toLowerCase()}…`;

  return {
    cfg,
    batch,
    sheetIndex,
    sheet,
    selectedSwap,
    swapTask,
    isSubmitting,
    isRunning,
    evaluateBatchAction,
    handleStartBatchJob,
    selectionSize,
    selectedSwapCrops,
    toggleSwapCropSelection,
    stageSelectable,
    canAddBatch,
    addBatchTooltip,
    handleAddBatch,
    getOwnership,
    handleTakeBack,
    pending,
    confirmPending,
    cancelPending,
    handleAddSheetGuarded,
    handleRemoveSheetGuarded,
    handleRemoveBatchGuarded,
    importDisabled,
    importTooltip,
    runningLabel,
    submittingLabel,
    collapse,
  };
}
