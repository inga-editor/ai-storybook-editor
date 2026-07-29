// actor-stage-tab.tsx — ONE generic stage-tab body for the actors casting-swap
// pipeline (Crops / Remove BG / Upscale). Thin wrapper around the REUSED
// `useStageBatchTab` hook + the shared presentational parts (BatchesSidebar,
// CropSheetStage, RelayoutConfirmDialog, StageBatchEmptyState, StageImportButton)
// — the actors modal supplies its data/actions through the phase-04
// StageDataAdapter, so nothing here forks the ~500-LOC hook (design 04 §7.2).
//
// vs the remix tabs this body drops: the Sprites plane, the Settings review, and
// the live defect Check (ships OFF — the `[✓]` slot renders DISABLED + "Coming
// soon" via `cfg.detectDisabledReason`, never hidden; upscale omits the slot).
//
// SECURITY: never log media_url / swap URLs (crops are PII likenesses).

import { useMemo } from 'react';
import { Eraser, Expand, Repeat } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import type { RemixStageBatch } from '@/types/remix';
import type { ActorStageKind } from '@/types/actors';
import {
  useStageBatchTab,
  type StageBatchTabProps,
  type StageGateResult,
  BatchesSidebar,
  type BatchDetectDescriptor,
  CropSheetStage,
  RelayoutConfirmDialog,
  StageBatchEmptyState,
  StageImportButton,
} from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal';
import type { ActorStageTabConfig } from './actors-stage-tab-config';

const log = createLogger('Editor', 'ActorStageTab');

const STAGE_ICON: Record<ActorStageKind, LucideIcon> = {
  mixes: Repeat,
  rmbgs: Eraser,
  upscales: Expand,
};

export interface ActorStageTabProps extends StageBatchTabProps {
  stage: ActorStageKind;
  cfg: ActorStageTabConfig;
  /** Crops-tab gate — actor has resolvable visual artwork (else Swap disabled). */
  precondition?: (batch: RemixStageBatch) => StageGateResult;
}

export function ActorStageTab({ stage, cfg, precondition, ...props }: ActorStageTabProps) {
  const t = useStageBatchTab(stage, props, precondition);

  // Ship-OFF Check slot: mixes/rmbgs RENDER a disabled button (Coming soon);
  // upscale (no `detectDisabledReason`) omits the slot entirely.
  const detectDescriptor = useMemo<BatchDetectDescriptor | undefined>(() => {
    if (!cfg.detectDisabledReason) return undefined;
    const reason = cfg.detectDisabledReason;
    return {
      getState: () => ({
        disabled: true,
        busy: false,
        tooltip: reason,
        label: 'Check',
        badge: null,
      }),
      onRun: () => {},
    };
  }, [cfg.detectDisabledReason]);

  log.debug('render', 'actor stage tab', {
    stage,
    batchCount: props.batches.length,
    activeBatchId: t.batch?.id ?? null,
    importDisabled: t.importDisabled,
    detectShown: !!detectDescriptor,
  });

  const importButton = cfg.hasImport ? (
    <StageImportButton
      disabled={t.importDisabled}
      disabledTooltip={t.importTooltip}
      onOpenImport={() => props.onOpenImport?.()}
    />
  ) : null;

  return (
    <>
      <BatchesSidebar
        batches={props.batches}
        activeBatchRef={props.activeBatchRef}
        isCollapsed={t.collapse.isCollapsed}
        onToggleCollapse={t.collapse.toggle}
        anyJobRunning={props.anyJobRunning}
        allowZeroBatch={cfg.allowZeroBatch}
        canAddBatch={t.canAddBatch}
        addBatchTooltip={t.addBatchTooltip}
        selectionSize={t.selectionSize}
        batchAction={{
          icon: STAGE_ICON[stage],
          label: cfg.actionLabel,
          retryLabel: `Retry ${cfg.actionLabel}`,
          getState: t.evaluateBatchAction,
          onRun: t.handleStartBatchJob,
        }}
        batchDetectAction={detectDescriptor}
        onSelectBatchSheet={props.onSelectBatchSheet}
        onAddBatch={t.handleAddBatch}
        onRemoveBatch={t.handleRemoveBatchGuarded}
        onAddSheet={t.handleAddSheetGuarded}
        onRemoveSheet={t.handleRemoveSheetGuarded}
      />

      {props.batches.length === 0 && cfg.allowZeroBatch ? (
        // rmbgs/upscales — first batch arrives via Import from the previous stage.
        <StageBatchEmptyState
          stageLabel={cfg.label}
          disabled={t.importDisabled}
          disabledTooltip={t.importTooltip}
          onImport={() => props.onOpenImport?.()}
        />
      ) : t.batch ? (
        <CropSheetStage
          source={{ mode: 'batches', sheet: t.sheet, selectedSwap: t.selectedSwap }}
          headerActions={importButton}
          compareMode={props.compareMode}
          zoomLevel={props.zoomLevel}
          dividerPosition={props.dividerPosition}
          swapTask={t.swapTask}
          isSubmitting={t.isSubmitting}
          composeMode={cfg.composeMode}
          afterComposeMode={cfg.afterComposeMode}
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
        />
      ) : (
        <section
          className="flex h-full min-w-0 flex-1 items-center justify-center bg-[var(--swap-modal-bg)] p-8 text-center"
          aria-label={`${cfg.label} stage`}
        >
          <p className="text-sm text-[var(--swap-modal-text-muted)]">
            Preparing crops…
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
