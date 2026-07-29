// rmbg-tab.tsx — Stage tab instance `'rmbgs'` (UI label **Remove BG** —
// ⚡2026-06-12 pipeline stage 2, design 05-12). Thin wrapper around the shared
// `useStageBatchTab` hook (05-11). Per-stage parts only:
//   - NO auto-seed: 0 batches → empty-state CTA "Import from previous stage",
//   - Import header button (finals of `mixes[]` → ImportBatchModal — 05-14),
//   - default precondition (batch has crops — job 09 needs no sprite finals),
//   - composeMode 'plain' / afterComposeMode 'sheet-or-crops' (RGBA fast path),
//   - ⚡2026-06-28 the rmbg-plane swap-defect Check (`[✓]` slot + DefectOverlay,
//     05-15 — rmbgs, `cfg.hasDetect`). 2nd Check plane after mix; defects draw
//     over the RGBA-checkerboard AFTER view (coords are sheet_geometry-based, so
//     the transparent background never shifts them).
//
// SECURITY: never log media_url / swap URLs (crops are PII likenesses) / defect
// message (PII §10) — counts + ids only.

import { useCallback } from 'react';
import { Eraser } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { deriveDetectView } from '@/stores/remix-store';
import { useDefectDetection } from '@/features/editor/hooks/use-defect-detection';
import type { RemixStageBatch } from '@/types/remix';
import { useStageDataAdapter } from '../stage-data-adapter';
import { CropSheetStage } from '../crop-sheet-stage';
import { RelayoutConfirmDialog } from '../relayout-confirm-dialog';
import { evaluateDetect, type DetectActionState } from './detect-gating';
import { DETECT_PLANE_CONFIG } from '../detect-plane-config';
import {
  useStageBatchTab,
  type StageBatchTabProps,
} from './use-stage-batch-tab';
import { BatchesSidebar } from './batches-sidebar';
import { StageBatchEmptyState } from './stage-batch-empty-state';
import { StageImportButton } from './stage-import-button';

const log = createLogger('Editor', 'RmbgTab');

/** Remove-BG tab = the shared stage props + the rmbg-plane detect (Check)
 *  wiring. `onOpenImport` is REQUIRED for this instance (root 05 §3.4); the
 *  detect props mirror the mixes tab (rmbgs is the 2nd Check plane, 05-15). */
export interface RmbgTabProps extends StageBatchTabProps {
  /** batch_id currently POSTing an rmbg-detect (mirror submittingBatchId). */
  submittingDetectBatchId: string | null;
  /** True while ANY rmbg-detect job runs for the remix (dedup = 1/remix/plane). */
  anyDetectRunning: boolean;
  /** Enqueue an rmbg swap-defect detect job for the batch (Check). */
  onDetectBatch: (batchId: string) => void;
}

export function RmbgTab(props: RmbgTabProps) {
  const { remixId, submittingDetectBatchId, anyDetectRunning } = props;
  const t = useStageBatchTab('rmbgs', props);

  // ── Detect (Check) — active-batch overlay source + per-row gating (05-15) ────
  // Generic `useDefectDetection('rmbg', …)` derives the active batch's detect
  // view (the overlay reads the SHEET being viewed); the per-row evaluator
  // derives each batch inline via the pure `deriveDetectView` (no hook in a loop).
  // Jobs come from the stage adapter (owner-scoped, all phases); the rmbg detect
  // view is derived per batch below via the pure `deriveDetectView`.
  const { jobs } = useStageDataAdapter();
  const activeBatchId = t.batch?.id ?? null;
  const activeDetect = useDefectDetection('rmbg', remixId, activeBatchId);
  const detectSheetResult =
    activeDetect.defectsBySheet.find((d) => d.sheet_index === t.sheetIndex) ?? null;
  const detectDefects = detectSheetResult?.defects ?? [];
  const detectSwappedDim = detectSheetResult?.swappedDimensions ?? null;
  // Stale guard (defects ephemeral): overlay valid only when the detect ran
  // AFTER the swap result currently shown (jobCreatedAt > selectedSwap.created_time).
  const detectOverlayStale =
    !activeDetect.jobCreatedAt ||
    t.selectedSwap === null ||
    !(activeDetect.jobCreatedAt > t.selectedSwap.created_time);
  const detectOverlayVisible =
    t.selectedSwap !== null &&
    detectDefects.length > 0 &&
    !props.compareMode &&
    !detectOverlayStale;
  const detectProgress =
    activeDetect.task.state === 'running'
      ? { current: activeDetect.task.current, total: activeDetect.task.total }
      : null;

  // Per-row Check evaluator (pure; rmbg plane). `anySwapRunning = anyJobRunning`
  // (the rmbgs stage mutex); `anyDetectRunning` disables every rmbg Check (rmbg
  // detect dedups 1/remix, independent of the mix + sprite detect planes).
  const evaluateBatchDetectRow = useCallback(
    (b: RemixStageBatch): DetectActionState =>
      evaluateDetect(
        b,
        deriveDetectView(jobs, remixId, b.id, DETECT_PLANE_CONFIG.rmbg.jobType),
        {
          submittingScopeId: submittingDetectBatchId,
          anySwapRunning: props.anyJobRunning,
          anyDetectRunning,
        },
      ),
    [jobs, remixId, submittingDetectBatchId, props.anyJobRunning, anyDetectRunning],
  );

  // Per-row Check: select that batch (so the stage overlay tracks ITS sheet)
  // then enqueue the detect job. Preserve the active sheet when re-checking the
  // already-selected batch; else start at sheet 0. Mirror `handleStartBatchJob`.
  const { onSelectBatchSheet, onDetectBatch, activeBatchRef } = props;
  const handleDetectBatch = useCallback(
    (batchId: string) => {
      const sheetIndex =
        activeBatchRef && activeBatchRef.batchId === batchId
          ? activeBatchRef.sheetIndex
          : 0;
      log.info('handleDetectBatch', 'select + detect batch', { batchId });
      onSelectBatchSheet(batchId, sheetIndex);
      onDetectBatch(batchId);
    },
    [activeBatchRef, onSelectBatchSheet, onDetectBatch],
  );

  log.debug('render', 'remove-bg tab (rmbgs)', {
    remixId,
    batchCount: props.batches.length,
    activeBatchId,
    importDisabled: t.importDisabled,
    detectVisible: detectOverlayVisible,
  });

  return (
    <>
      <BatchesSidebar
        batches={props.batches}
        activeBatchRef={props.activeBatchRef}
        isCollapsed={t.collapse.isCollapsed}
        onToggleCollapse={t.collapse.toggle}
        anyJobRunning={props.anyJobRunning}
        allowZeroBatch
        canAddBatch={t.canAddBatch}
        addBatchTooltip={t.addBatchTooltip}
        selectionSize={t.selectionSize}
        batchAction={{
          icon: Eraser,
          label: t.cfg.actionLabel,
          retryLabel: 'Retry Remove BG',
          getState: t.evaluateBatchAction,
          onRun: t.handleStartBatchJob,
        }}
        batchDetectAction={
          t.cfg.hasDetect
            ? { getState: evaluateBatchDetectRow, onRun: handleDetectBatch }
            : undefined
        }
        onSelectBatchSheet={props.onSelectBatchSheet}
        onAddBatch={t.handleAddBatch}
        onRemoveBatch={t.handleRemoveBatchGuarded}
        onAddSheet={t.handleAddSheetGuarded}
        onRemoveSheet={t.handleRemoveSheetGuarded}
      />

      {props.batches.length === 0 ? (
        // No auto-seed on this stage — first batch arrives via Import.
        <StageBatchEmptyState
          stageLabel={t.cfg.label}
          disabled={t.importDisabled}
          disabledTooltip={t.importTooltip}
          onImport={() => props.onOpenImport?.()}
        />
      ) : t.batch ? (
        <CropSheetStage
          source={{ mode: 'batches', sheet: t.sheet, selectedSwap: t.selectedSwap }}
          headerActions={
            <StageImportButton
              disabled={t.importDisabled}
              disabledTooltip={t.importTooltip}
              onOpenImport={() => props.onOpenImport?.()}
            />
          }
          compareMode={props.compareMode}
          zoomLevel={props.zoomLevel}
          dividerPosition={props.dividerPosition}
          swapTask={t.swapTask}
          isSubmitting={t.isSubmitting}
          composeMode={t.cfg.composeMode}
          afterComposeMode={t.cfg.afterComposeMode}
          runningLabel={t.runningLabel}
          submittingLabel={t.submittingLabel}
          onToggleCompare={props.onToggleCompare}
          onZoomChange={props.onZoomChange}
          onDividerChange={props.onDividerChange}
          selectableSwapCrops={t.stageSelectable}
          selectedSwapCropKeys={t.selectedSwapCrops}
          onToggleSwapCropSelection={t.toggleSwapCropSelection}
          getOwnership={t.getOwnership}
          onTakeBack={t.handleTakeBack}
          takeBackDisabled={props.anyJobRunning}
          defectOverlay={{
            defects: detectDefects,
            swappedDimensions: detectSwappedDim,
            visible: detectOverlayVisible,
          }}
          detectProgress={detectProgress}
        />
      ) : (
        <section
          className="flex h-full min-w-0 flex-1 items-center justify-center bg-[var(--swap-modal-bg)] p-8 text-center"
          aria-label="Remove BG stage"
        >
          <p className="text-sm text-[var(--swap-modal-text-muted)]">
            Chọn một batch để bắt đầu.
          </p>
        </section>
      )}

      <RelayoutConfirmDialog
        open={t.pending != null}
        kind={t.pending?.kind ?? 'remove-sheet'}
        batchName={t.pending?.batchName ?? ''}
        onConfirm={t.confirmPending}
        onCancel={t.cancelPending}
      />
    </>
  );
}
