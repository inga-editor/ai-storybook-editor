// swap-casting-slot-modal.tsx — Full-screen workspace for ONE casting pair's
// 3-stage swap pipeline (Crops › Remove BG › Upscale — design 04). Reuses the
// remix swap-crop-sheet presentational + hook layer via the phase-04
// StageDataAdapter seam (NO Sprites tab, NO Settings/Inject buttons — Inject
// lives on the sidebar `[⟲]` row). Thin container: owns shared per-stage state +
// action wiring, then renders the active `ActorStageTab`.
//
// Jobs keep running when the modal closes (background_jobs realtime) — reopening
// re-derives progress from the store; nothing is torn down on unmount.
//
// SECURITY: never log media_url / swap URLs (crops are PII likenesses).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import { useInteractionLayer } from '@/features/editor/contexts';
import { useCurrentBook } from '@/stores/book-store';
import {
  useCharacters,
  useProps,
  useIllustrationSpreads,
} from '@/stores/snapshot-store/selectors';
import {
  useActorPairById,
  useActorsActions,
  useActorStageBatches,
  useAnyActorStageJobRunning,
  useActorStageAdapter,
} from '@/stores/actors-store';
import { buildModelParams } from '@/stores/remix-store/slices/build-model-params';
import { EnqueueJobError } from '@/apis/jobs-api';
import type { RemixStageBatch, SwapModelParams } from '@/types/remix';
import type { ActorStageKind } from '@/types/actors';
import {
  StageDataAdapterProvider,
  SelectionProvider,
  SwapParametersSidebar,
  ImportBatchModal,
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  ZOOM,
  DEFAULT_SWAP_PARAMS,
} from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal';
import { ActorStageTab } from './actor-stage-tab';
import {
  ACTORS_STAGE_TAB_CONFIG,
  ACTOR_PREV_STAGE,
  ACTOR_STAGE_TO_PARAMS_TAB,
} from './actors-stage-tab-config';
import { seedInitialActorBatch } from './seed-initial-actor-batch';
import { actorHasVisual } from './actor-visual-precondition';
import { resolveSwapLabels } from './resolve-swap-labels';
import { SwapCastingSlotHeader } from './swap-casting-slot-header';

const log = createLogger('Editor', 'SwapCastingSlotModal');

/** Opener target — a casting `pairId`. */
export interface SwapCastingSlotTarget {
  pairId: string;
}

interface Props {
  target: SwapCastingSlotTarget;
  onClose: () => void;
}

const STAGE_ORDER: ActorStageKind[] = ['mixes', 'rmbgs', 'upscales'];

interface ActiveBatchRef {
  batchId: string;
  sheetIndex: number;
}
type StageStates = Record<
  ActorStageKind,
  { activeBatchRef: ActiveBatchRef | null; submittingBatchId: string | null }
>;

function initialBatchRef(batches: RemixStageBatch[]): ActiveBatchRef | null {
  return batches.length === 0 ? null : { batchId: batches[0].id, sheetIndex: 0 };
}

export function SwapCastingSlotModal({ target, onClose }: Props) {
  const { pairId } = target;
  const pair = useActorPairById(pairId);
  const currentBook = useCurrentBook();
  const characters = useCharacters();
  const props = useProps();
  const spreads = useIllustrationSpreads();

  const [activeStage, setActiveStage] = useState<ActorStageKind>('mixes');
  const stageAdapter = useActorStageAdapter(pairId, activeStage);

  const mixBatches = useActorStageBatches(pairId, 'mixes');
  const rmbgBatches = useActorStageBatches(pairId, 'rmbgs');
  const upscaleBatches = useActorStageBatches(pairId, 'upscales');
  const anyMixJobRunning = useAnyActorStageJobRunning(pairId, 'mixes');
  const anyRmbgJobRunning = useAnyActorStageJobRunning(pairId, 'rmbgs');
  const anyUpscaleJobRunning = useAnyActorStageJobRunning(pairId, 'upscales');

  const stageBatches = useMemo<Record<ActorStageKind, RemixStageBatch[]>>(
    () => ({ mixes: mixBatches, rmbgs: rmbgBatches, upscales: upscaleBatches }),
    [mixBatches, rmbgBatches, upscaleBatches],
  );
  const anyStageJobRunning = useMemo<Record<ActorStageKind, boolean>>(
    () => ({
      mixes: anyMixJobRunning,
      rmbgs: anyRmbgJobRunning,
      upscales: anyUpscaleJobRunning,
    }),
    [anyMixJobRunning, anyRmbgJobRunning, anyUpscaleJobRunning],
  );

  const {
    addStageBatch,
    importStageBatch,
    startStageJob,
    removeStageBatch,
    appendStageBatchSheet,
    removeStageBatchSheet,
  } = useActorsActions();

  // ── Shared modal state (`activeStage` declared above for the adapter) ────────
  const [stageStates, setStageStates] = useState<StageStates>(() => ({
    mixes: { activeBatchRef: initialBatchRef(mixBatches), submittingBatchId: null },
    rmbgs: { activeBatchRef: initialBatchRef(rmbgBatches), submittingBatchId: null },
    upscales: { activeBatchRef: initialBatchRef(upscaleBatches), submittingBatchId: null },
  }));
  const [importModal, setImportModal] = useState<{ stage: 'rmbgs' | 'upscales' } | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(ZOOM.default);
  const [dividerPosition, setDividerPosition] = useState(50);
  const [params, setParams] = useState<SwapModelParams>(DEFAULT_SWAP_PARAMS);

  // Crops-stage seed refs — the layers that cast this actant. null → no layer
  // casts the actant (empty state; no batch seeded).
  const seedRefs = useMemo(
    () => (pair ? seedInitialActorBatch(pair, spreads) : null),
    [pair, spreads],
  );
  const hasCastLayers = seedRefs !== null;
  const actorVisualOk = useMemo(
    () => (pair ? actorHasVisual({ characters, props }, pair) : false),
    [pair, characters, props],
  );

  // ── EFFECTIVE per-stage batch refs (derived — no setState-in-effect) ─────────
  const effectiveBatchRefs = useMemo<Record<ActorStageKind, ActiveBatchRef | null>>(() => {
    const resolve = (stage: ActorStageKind): ActiveBatchRef | null => {
      const ref = stageStates[stage].activeBatchRef;
      const batch = ref ? stageBatches[stage].find((b) => b.id === ref.batchId) : undefined;
      if (ref && batch) {
        const maxIndex = Math.max(0, batch.crop_sheets.length - 1);
        return { batchId: ref.batchId, sheetIndex: Math.min(Math.max(ref.sheetIndex, 0), maxIndex) };
      }
      return initialBatchRef(stageBatches[stage]);
    };
    return { mixes: resolve('mixes'), rmbgs: resolve('rmbgs'), upscales: resolve('upscales') };
  }, [stageStates, stageBatches]);

  const setStageActiveBatchRef = useCallback(
    (stage: ActorStageKind, ref: ActiveBatchRef | null) => {
      setStageStates((prev) => ({ ...prev, [stage]: { ...prev[stage], activeBatchRef: ref } }));
    },
    [],
  );
  const setStageSubmitting = useCallback((stage: ActorStageKind, batchId: string | null) => {
    setStageStates((prev) => ({ ...prev, [stage]: { ...prev[stage], submittingBatchId: batchId } }));
  }, []);

  // ── Focus restore + ILS slot ────────────────────────────────────────────────
  const triggerElRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerElRef.current = document.activeElement as HTMLElement | null;
    return () => triggerElRef.current?.focus();
  }, []);
  const dialogContentRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    log.debug('handleClose', 'close modal', { pairId });
    onClose();
  }, [onClose, pairId]);

  useInteractionLayer('modal', {
    id: 'swap-casting-slot-modal',
    ref: dialogContentRef,
    hotkeys: ['Escape'],
    onHotkey: (key) => {
      if (key === 'Escape') handleClose();
    },
    onClickOutside: handleClose,
    captureClickOutside: true,
    portalSelectors: [
      '[data-radix-popper-content-wrapper]',
      '[data-radix-select-content]',
      '[role="listbox"]',
    ],
    // Parameter-sidebar Select dropdowns portal OUTSIDE the dialog — snapshot
    // "a dropdown was open at pointerdown" so picking an option doesn't pop the
    // modal (parity remix swap modal).
    dropdownSelectors: ['[data-radix-select-content]', '[data-radix-popper-content-wrapper]'],
  });

  // ── Seed Crops batch 1 from the cast layers (idempotent, once per pair) ──────
  // Runs when the pair resolves + mixes is empty + layers cast the actant. The
  // `seededRef` guard makes it a one-shot per pair (strict-mode + optimistic
  // re-render safe). No setState here — a store action only (React 19 lint).
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pairId || !pair || seededRef.current === pairId) return;
    if (mixBatches.length > 0) {
      seededRef.current = pairId; // already seeded server-side — mark done
      return;
    }
    if (!seedRefs) return; // no layers cast the actant → empty state (unmarked)
    seededRef.current = pairId;
    log.info('seed', 'seed Crops batch 1 from cast layers', {
      pairId,
      cropCount: seedRefs.length,
    });
    void addStageBatch(pairId, 'mixes', seedRefs);
  }, [pairId, pair, mixBatches.length, seedRefs, addStageBatch]);

  // ── Auto-close when the pair disappears (realtime delete / refetch miss) ─────
  useEffect(() => {
    if (pair === null) {
      log.warn('autoClose', 'pair resolved null — closing modal', { pairId });
      onClose();
    }
  }, [pair, onClose, pairId]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleTabChange = useCallback((stage: ActorStageKind) => {
    log.debug('handleTabChange', 'switch stage', { to: stage });
    setActiveStage(stage);
    setCompareMode(false);
    setDividerPosition(50);
  }, []);

  const handleSelectStageSheet = useCallback(
    (stage: ActorStageKind, batchId: string, sheetIndex: number) => {
      setStageActiveBatchRef(stage, { batchId, sheetIndex });
      setCompareMode(false);
      setDividerPosition(50);
    },
    [setStageActiveBatchRef],
  );

  const handleStartStageJob = useCallback(
    async (stage: ActorStageKind, batchId: string) => {
      setStageSubmitting(stage, batchId);
      try {
        const modelParams = buildModelParams(stage, params);
        const grain =
          stage === 'upscales'
            ? { enabled: params.grainEnabled, amp: params.grainAmp, blur: params.grainBlur }
            : undefined;
        const outcome = await startStageJob({ pairId, stage, batchId, modelParams, grain });
        log.info('handleStartStageJob', 'enqueue outcome', { stage, batchId, kind: outcome.kind });
        if (outcome.kind === 'enqueued') {
          toast.success(`${ACTORS_STAGE_TAB_CONFIG[stage].actionLabel} started`);
        }
        // 'skipped'/'deduped' already toasted inside the store.
      } catch (err) {
        // Store already toasted (incl. 422 REFERENCE_IMAGE_MISSING); swallow here.
        const code = err instanceof EnqueueJobError ? err.code : undefined;
        log.error('handleStartStageJob', 'enqueue failed', { stage, batchId, code });
      } finally {
        setStageSubmitting(stage, null);
      }
    },
    [startStageJob, pairId, params, setStageSubmitting],
  );

  const handleImportStageBatch = useCallback(
    async (stage: 'rmbgs' | 'upscales', selectedKeys: ReadonlySet<string>) => {
      const finals = stageAdapter.stageFinals(ACTOR_PREV_STAGE[stage]);
      const entries = finals.filter((f) => selectedKeys.has(f.cropKey));
      log.info('handleImportStageBatch', 'confirm import', { stage, selectionSize: entries.length });
      try {
        const newBatchId = await importStageBatch(pairId, stage, entries);
        if (newBatchId === null) {
          toast.error("Couldn't import batch — try again");
          return;
        }
        setStageActiveBatchRef(stage, { batchId: newBatchId, sheetIndex: 0 });
        setImportModal(null);
        toast.success('Batch imported');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to import batch';
        log.error('handleImportStageBatch', 'failed', { stage, error: msg });
        toast.error(msg);
      }
    },
    [importStageBatch, pairId, stageAdapter, setStageActiveBatchRef],
  );

  // ── Sidebar sheet/batch mutators (thin store delegates, per-stage) ──────────
  const handleRemoveStageBatch = useCallback(
    (stage: ActorStageKind, batchId: string) => {
      void removeStageBatch(pairId, stage, batchId).then(() => {
        if (effectiveBatchRefs[stage]?.batchId === batchId) {
          setStageActiveBatchRef(stage, null);
        }
      });
    },
    [removeStageBatch, pairId, effectiveBatchRefs, setStageActiveBatchRef],
  );
  const handleAddStageSheet = useCallback(
    (stage: ActorStageKind, batchId: string) => void appendStageBatchSheet(pairId, stage, batchId),
    [appendStageBatchSheet, pairId],
  );
  const handleRemoveStageSheet = useCallback(
    (stage: ActorStageKind, batchId: string, sheetIndex: number) =>
      void removeStageBatchSheet(pairId, stage, batchId, sheetIndex),
    [removeStageBatchSheet, pairId],
  );

  // ── Crops precondition — the actor must have resolvable artwork ──────────────
  const cropsPrecondition = useCallback(
    (): { ok: boolean; reason?: string } =>
      actorVisualOk
        ? { ok: true }
        : { ok: false, reason: 'This actor has no visual artwork' },
    [actorVisualOk],
  );

  // ── Selection reset key (keyed remount — no useEffect+setState) ──────────────
  const stageSelectionResetKey = useCallback(
    (stage: ActorStageKind): string => {
      const ref = effectiveBatchRefs[stage];
      const batch = ref ? stageBatches[stage].find((b) => b.id === ref.batchId) ?? null : null;
      const count = batch
        ? batch.crop_sheets.reduce((acc, s) => acc + s.swap_results.length, 0)
        : 0;
      return `${stage}/${batch?.id ?? '__none__'}::${count}`;
    },
    [effectiveBatchRefs, stageBatches],
  );

  const labels = useMemo(
    () => (pair ? resolveSwapLabels(currentBook?.casting_slot, characters, props, pair) : null),
    [pair, currentBook?.casting_slot, characters, props],
  );

  if (pair === null || !labels) return null;

  const sharedStageProps = {
    compareMode,
    zoomLevel,
    dividerPosition,
    onToggleCompare: () => setCompareMode((v) => !v),
    onZoomChange: (z: number) => setZoomLevel(z),
    onDividerChange: (p: number) => setDividerPosition(p),
  };

  const stageTabProps = (stage: ActorStageKind) => ({
    stage,
    cfg: ACTORS_STAGE_TAB_CONFIG[stage],
    precondition: stage === 'mixes' ? cropsPrecondition : undefined,
    remixId: pairId, // phase-04 field name kept = pairId
    batches: stageBatches[stage],
    activeBatchRef: effectiveBatchRefs[stage],
    anyJobRunning: anyStageJobRunning[stage],
    submittingBatchId: stageStates[stage].submittingBatchId,
    onSelectBatchSheet: (batchId: string, sheetIndex: number) =>
      handleSelectStageSheet(stage, batchId, sheetIndex),
    onActivateBatch: (ref: ActiveBatchRef) => setStageActiveBatchRef(stage, ref),
    onRemoveBatch: (batchId: string) => handleRemoveStageBatch(stage, batchId),
    onAddSheet: (batchId: string) => handleAddStageSheet(stage, batchId),
    onRemoveSheet: (batchId: string, sheetIndex: number) =>
      handleRemoveStageSheet(stage, batchId, sheetIndex),
    onStartJob: (batchId: string) => void handleStartStageJob(stage, batchId),
    onOpenImport: stage === 'mixes' ? undefined : () => setImportModal({ stage: stage as 'rmbgs' | 'upscales' }),
    ...sharedStageProps,
  });

  return (
    <StageDataAdapterProvider value={stageAdapter}>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent
          ref={dialogContentRef}
          aria-labelledby="swap-casting-slot-modal-title"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          style={{ ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.swapModal } as React.CSSProperties}
          className="inset-0 left-0 top-0 flex h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[var(--swap-modal-bg)] p-0 text-[var(--swap-modal-text-primary)] [&>button]:hidden"
        >
          <DialogTitle id="swap-casting-slot-modal-title" className="sr-only">
            Casting swap — {labels.actantName} → {labels.actorName}
          </DialogTitle>
          <DialogDescription className="sr-only">
            3-stage casting-swap pipeline: crops, remove background and upscale.
          </DialogDescription>

          <SwapCastingSlotHeader
            labels={labels}
            activeStage={activeStage}
            onTabChange={handleTabChange}
            onClose={handleClose}
          />

          <div className="flex min-h-0 flex-1">
            {!hasCastLayers ? (
              <section
                className="flex h-full min-w-0 flex-1 items-center justify-center bg-[var(--swap-modal-bg)] p-8 text-center"
                aria-label="No cast layers"
              >
                <p className="text-sm text-[var(--swap-modal-text-muted)]">
                  No layers cast this actant.
                </p>
              </section>
            ) : (
              <>
                {STAGE_ORDER.map(
                  (stage) =>
                    activeStage === stage && (
                      <SelectionProvider key={stageSelectionResetKey(stage)}>
                        <ActorStageTab {...stageTabProps(stage)} />
                      </SelectionProvider>
                    ),
                )}
                <SwapParametersSidebar
                  params={params}
                  onChange={setParams}
                  activeTab={ACTOR_STAGE_TO_PARAMS_TAB[activeStage]}
                />
              </>
            )}
          </div>

          {importModal && (
            <ImportBatchModal
              finals={stageAdapter.stageFinals(ACTOR_PREV_STAGE[importModal.stage])}
              stage={importModal.stage}
              onClose={() => setImportModal(null)}
              onConfirm={(keys) => void handleImportStageBatch(importModal.stage, keys)}
            />
          )}
        </DialogContent>
      </Dialog>
    </StageDataAdapterProvider>
  );
}
