// upscale-tab.tsx — Stage tab instance `'upscales'` (UI label **Upscale** —
// ⚡2026-06-12 pipeline stage 3 (final), design 05-13). Thin wrapper around the
// shared `useStageBatchTab` hook (05-11). Per-stage parts only:
//   - NO auto-seed: 0 batches → empty-state CTA Import (finals of `rmbgs[]`),
//   - Import header button (→ ImportBatchModal — 05-14),
//   - progress CROP-level when the running job heartbeats `crops_done/total`
//     (job 10 — Replicate ~10–20s/crop needs the finer granularity),
//   - `upscale_skipped_count` warn badge (crops kept pre-upscale — graceful),
//   - composeMode 'plain' / afterComposeMode 'crops-only' (fit-in-box).
//
// ★ Finals of THIS stage are the Inject Phase 3 source (strict upscales-only).
//
// SECURITY: never log media_url / swap URLs (crops are PII likenesses).

import { useCallback, useMemo } from 'react';
import { AlertTriangle, Expand } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { useStageDataAdapter } from '../stage-data-adapter';
import { CropSheetStage } from '../crop-sheet-stage';
import { RelayoutConfirmDialog } from '../relayout-confirm-dialog';
import {
  useStageBatchTab,
  type StageBatchTabProps,
} from './use-stage-batch-tab';
import { BatchesSidebar } from './batches-sidebar';
import { StageBatchEmptyState } from './stage-batch-empty-state';
import { StageImportButton } from './stage-import-button';

const log = createLogger('Editor', 'UpscaleTab');

/** `onOpenImport` is REQUIRED for this instance (root 05 §3.5). */
export type UpscaleTabProps = StageBatchTabProps;

/** Defensive read of the job-10 crop-level heartbeat off the untyped
 *  step_details blob: `{ crops_done, crops_total }`. */
function readCropProgress(
  details: unknown,
): { done: number; total: number } | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  if (typeof d.crops_done === 'number' && typeof d.crops_total === 'number') {
    return { done: d.crops_done, total: d.crops_total };
  }
  return null;
}

export function UpscaleTab(props: UpscaleTabProps) {
  const t = useStageBatchTab('upscales', props);
  const { jobs } = useStageDataAdapter();

  // Latest upscale job of the ACTIVE batch — crop-level heartbeat + the
  // terminal `upscale_skipped_count` warn badge.
  const latestJob = useMemo(() => {
    const matches = jobs.filter(
      (j) => j.phase === 'remix_upscale' && j.batchId === t.batch?.id,
    );
    if (matches.length === 0) return null;
    return matches.reduce((latest, cur) =>
      cur.createdAt > latest.createdAt ? cur : latest,
    );
  }, [jobs, t.batch?.id]);

  // ⚡05-13 §4.4 — crop-level progress when the heartbeat carries it.
  const cropProgress =
    latestJob && (latestJob.status === 'queued' || latestJob.status === 'running')
      ? readCropProgress(latestJob.stepDetails)
      : null;
  const runningLabel = useCallback(
    (current: number, total: number) =>
      cropProgress
        ? `Upscaling crop ${cropProgress.done}/${cropProgress.total} — sheet ${current}/${total}…`
        : `Upscaling sheet ${current}/${total}…`,
    [cropProgress],
  );

  // ⚡05-13 §4.4 — graceful fallback count (NOT an error; crops kept at
  // pre-upscale dims, export below 300 DPI).
  const skippedCount =
    latestJob?.status === 'completed' &&
    typeof latestJob.result?.upscale_skipped_count === 'number'
      ? latestJob.result.upscale_skipped_count
      : 0;

  log.debug('render', 'upscale tab (upscales)', {
    remixId: props.remixId,
    batchCount: props.batches.length,
    activeBatchId: t.batch?.id ?? null,
    importDisabled: t.importDisabled,
    skippedCount,
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
          icon: Expand,
          label: t.cfg.actionLabel,
          retryLabel: 'Retry Upscale',
          getState: t.evaluateBatchAction,
          onRun: t.handleStartBatchJob,
        }}
        onSelectBatchSheet={props.onSelectBatchSheet}
        onAddBatch={t.handleAddBatch}
        onRemoveBatch={t.handleRemoveBatchGuarded}
        onAddSheet={t.handleAddSheetGuarded}
        onRemoveSheet={t.handleRemoveSheetGuarded}
      />

      {props.batches.length === 0 ? (
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
            <>
              <StageImportButton
                disabled={t.importDisabled}
                disabledTooltip={t.importTooltip}
                onOpenImport={() => props.onOpenImport?.()}
              />
              {skippedCount > 0 && (
                <span
                  role="status"
                  className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300"
                >
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  {skippedCount} crops kept pre-upscale
                </span>
              )}
            </>
          }
          compareMode={props.compareMode}
          zoomLevel={props.zoomLevel}
          dividerPosition={props.dividerPosition}
          swapTask={t.swapTask}
          isSubmitting={t.isSubmitting}
          composeMode={t.cfg.composeMode}
          afterComposeMode={t.cfg.afterComposeMode}
          runningLabel={runningLabel}
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
        />
      ) : (
        <section
          className="flex h-full min-w-0 flex-1 items-center justify-center bg-[var(--swap-modal-bg)] p-8 text-center"
          aria-label="Upscale stage"
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
