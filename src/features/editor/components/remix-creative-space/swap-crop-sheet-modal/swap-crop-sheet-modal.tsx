// swap-crop-sheet-modal.tsx — Full-screen workspace for the remix swap modal
// (design 05-swap-crop-sheet-modal.md — ⚡2026-06-12 4-tab PIPELINE:
// Sprites › Crops › Remove BG › Upscale; Lotties removed).
//
// Thin CONTAINER that owns only SHARED state + selectors + action wiring, then
// renders the active tab:
//   • Header   — RemixModalHeader (4-tab pipeline pill group)
//   • Body     — VariantsTab (sprite plane) | one of the 3 isomorphic
//                StageBatchTab instances (BatchesTab/RmbgTab/UpscaleTab —
//                hook useStageBatchTab) + SwapParametersSidebar (right)
//   • Overlay  — ImportBatchModal (rmbg/upscale Import — dialog OVER modal)
//
// Stage state is PER-STAGE (`stageStates` record: activeBatchRef +
// submittingBatchId); rev6 selection lives in a keyed-remount
// `SelectionProvider` per stage (key = `${stage}/${batchId}::${resultCount}` —
// chốt 2026-06-12, no useEffect+setState reset).
//
// Raw active refs hold USER INTENT only; every consumer reads the DERIVED
// effective refs (raw-if-resolvable, else first entity sheet 0) so rows that
// arrive after mount (async sprite seed / mixes migration / realtime)
// auto-select without setState-in-effect.
//
// On mount the root fires the idempotent legacy→batch migration AND lazily
// seeds the initial sprite; an effect closes the modal when the remix
// disappears.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  useRemixById,
  useRemixSprites,
  useRemixStageBatches,
  useAnyStageJobRunning,
  useAnySpriteSwapRunning,
  useRemixActions,
  useRemixStore,
} from '@/stores/remix-store';
import { useAnyDetectRunning } from '@/features/editor/hooks/use-defect-detection';
import { useInteractionLayer } from '@/features/editor/contexts';
import { EnqueueJobError } from '@/apis/jobs-api';
import { createLogger } from '@/utils/logger';
import type {
  RemixModalTab,
  RemixSprite,
  RemixStageBatch,
  StageKind,
  SwapCropSheetTarget,
  SwapModelParams,
} from '@/types/remix';
import { PREV_STAGE } from '@/types/remix';
import { useRemixStageAdapter } from '../hooks/use-remix-stage-adapter';
import { StageDataAdapterProvider } from './stage-data-adapter';
import { RemixModalHeader } from './remix-modal-header';
import { SwapParametersSidebar } from './swap-parameters-sidebar';
import { STAGE_TAB_CONFIG, STAGE_OF_TAB } from './stage-tab-config';
import { DETECT_PLANE_CONFIG } from './detect-plane-config';
import { VariantsTab } from './tabs/variants-tab';
import { BatchesTab } from './tabs/batches-tab';
import { RmbgTab } from './tabs/rmbg-tab';
import { UpscaleTab } from './tabs/upscale-tab';
import { ImportBatchModal } from './import-batch-modal';
import { SelectionProvider } from './hooks/use-selected-swap-crops';
import { DEFAULT_SWAP_PARAMS, SWAP_MODAL_TOKENS, Z_INDEX, ZOOM } from './swap-modal-constants';

const log = createLogger('Editor', 'SwapCropSheetModal');

interface Props {
  target: SwapCropSheetTarget;
  onClose: () => void;
}

/** Active sprite+sheet pointer for the Variants tab. */
interface ActiveSpriteRef {
  spriteId: string;
  sheetIndex: number;
}

/** Active batch+sheet pointer within ONE stage tab. */
interface ActiveBatchRef {
  batchId: string;
  sheetIndex: number;
}

/** Per-stage tab state (⚡2026-06-12). Selection is NOT here — it lives in the
 *  keyed-remount SelectionProvider per stage. */
interface StageTabState {
  activeBatchRef: ActiveBatchRef | null;
  submittingBatchId: string | null;
}

type StageStates = Record<StageKind, StageTabState>;

/** Default tab from the opener target — a `mix` (= batch) opener lands on the
 *  Crops tab, a character/prop opener on Sprites. */
function defaultTab(target: SwapCropSheetTarget): RemixModalTab {
  return target.type === 'mix' ? 'batches' : 'variants';
}

/** First active-sprite pointer — first sprite, sheet 0. Null pre-seed. */
function initialSpriteRef(sprites: RemixSprite[]): ActiveSpriteRef | null {
  if (sprites.length === 0) return null;
  return { spriteId: sprites[0].id, sheetIndex: 0 };
}

/** First active-batch pointer — first batch, sheet 0. Null when the stage has
 *  no batches yet (rmbgs/upscales pre-import → empty-state CTA). */
function initialBatchRef(batches: RemixStageBatch[]): ActiveBatchRef | null {
  if (batches.length === 0) return null;
  return { batchId: batches[0].id, sheetIndex: 0 };
}

/** Sprite to re-select after deleting `removedId` (previous sibling, else next). */
function spriteRefAfterRemoval(
  sprites: RemixSprite[],
  activeRef: ActiveSpriteRef | null,
  removedId: string,
): ActiveSpriteRef | null {
  if (!activeRef || activeRef.spriteId !== removedId) return null;
  const idx = sprites.findIndex((s) => s.id === removedId);
  if (idx === -1) return null;
  const sibling = sprites[idx - 1] ?? sprites[idx + 1] ?? null;
  return sibling ? { spriteId: sibling.id, sheetIndex: 0 } : null;
}

/** Batch to re-select after deleting `removedId`. Mirror of
 *  {@link spriteRefAfterRemoval} on the stage-batch plane. */
function batchRefAfterRemoval(
  batches: RemixStageBatch[],
  activeRef: ActiveBatchRef | null,
  removedId: string,
): ActiveBatchRef | null {
  if (!activeRef || activeRef.batchId !== removedId) return null;
  const idx = batches.findIndex((b) => b.id === removedId);
  if (idx === -1) return null;
  const sibling = batches[idx - 1] ?? batches[idx + 1] ?? null;
  return sibling ? { batchId: sibling.id, sheetIndex: 0 } : null;
}

/** Maps a stage-job enqueue error code to a user-facing toast message. The
 *  swap-specific codes only ever come back from the mix-swap endpoint. */
function mapStageJobError(stage: StageKind, code: string | undefined): string {
  switch (code) {
    case 'MISSING_VARIANT_REFERENCE':
      return 'Generate a swapped visual for every character first — open the Variants tab';
    case 'TOO_MANY_SWAP_TARGETS':
      return 'This batch has too many swap targets — split it into more batches';
    case 'NO_SWAP_TARGETS':
      return 'This batch has no characters to swap';
    default:
      return `Couldn't start ${STAGE_TAB_CONFIG[stage].actionLabel.toLowerCase()} — try again`;
  }
}

/** Maps a sprite-swap enqueue error code (api/jobs/02) to a toast message. */
function mapSpriteSwapError(code: string | undefined): string {
  switch (code) {
    case 'MISSING_OBJECT_CONFIG':
      return 'Finish the swap config (human + visual + extract + ≥1 trait) for every character first';
    case 'NO_SWAP_OBJECTS':
      return 'This sprite has no variants to swap';
    case 'SPRITE_NOT_FOUND':
      return 'This sprite no longer exists — reopen the modal';
    default:
      return "Couldn't start swap — try again";
  }
}

export function SwapCropSheetModal({ target, onClose }: Props) {
  const remix = useRemixById(target.remixId);
  // Stage seam — the 3 stage tabs + Import dialog read their data/actions from
  // this adapter (StageDataAdapterProvider below) instead of the remix store
  // directly, so the same tab layer can be reused by the actors modal (phase 08).
  const stageAdapter = useRemixStageAdapter(target.remixId);
  const sprites = useRemixSprites(target.remixId);
  const anySpriteSwapRunning = useAnySpriteSwapRunning(target.remixId);
  // Detect (Check) — 1 job/remix/plane (dedup). The 3 planes are independent →
  // sprite-check + mix-check + rmbg-check run + dedup separately; each gates ITS
  // own Check.
  const anySpriteDetectRunning = useAnyDetectRunning(
    target.remixId,
    DETECT_PLANE_CONFIG.sprite.jobType,
  );
  const anyMixDetectRunning = useAnyDetectRunning(
    target.remixId,
    DETECT_PLANE_CONFIG.mix.jobType,
  );
  const anyRmbgDetectRunning = useAnyDetectRunning(
    target.remixId,
    DETECT_PLANE_CONFIG.rmbg.jobType,
  );
  // ⚡2026-06-12 — per-stage selectors (fixed-order hook calls; STAGES const).
  const mixBatches = useRemixStageBatches(target.remixId, 'mixes');
  const rmbgBatches = useRemixStageBatches(target.remixId, 'rmbgs');
  const upscaleBatches = useRemixStageBatches(target.remixId, 'upscales');
  const anyMixJobRunning = useAnyStageJobRunning(target.remixId, 'mixes');
  const anyRmbgJobRunning = useAnyStageJobRunning(target.remixId, 'rmbgs');
  const anyUpscaleJobRunning = useAnyStageJobRunning(target.remixId, 'upscales');
  const stageBatches: Record<StageKind, RemixStageBatch[]> = useMemo(
    () => ({ mixes: mixBatches, rmbgs: rmbgBatches, upscales: upscaleBatches }),
    [mixBatches, rmbgBatches, upscaleBatches],
  );
  const anyStageJobRunning: Record<StageKind, boolean> = useMemo(
    () => ({
      mixes: anyMixJobRunning,
      rmbgs: anyRmbgJobRunning,
      upscales: anyUpscaleJobRunning,
    }),
    [anyMixJobRunning, anyRmbgJobRunning, anyUpscaleJobRunning],
  );

  const {
    removeStageBatch,
    appendStageBatchSheet,
    removeStageBatchSheet,
    startStageJob,
    importStageBatch,
    startSpriteSwap,
    startDetectJob,
    removeSprite,
    appendSpriteSheet,
    removeSpriteSheet,
    ensureRemixSpriteSeed,
  } = useRemixActions();
  // `migrateLegacyRemixToBatch` lives on the sync slice — pull it directly.
  const migrateLegacyRemixToBatch = useRemixStore(
    (s) => s.migrateLegacyRemixToBatch,
  );

  // ── Shared modal state ──────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<RemixModalTab>(() =>
    defaultTab(target),
  );
  const [activeSpriteRef, setActiveSpriteRef] = useState<ActiveSpriteRef | null>(
    () => initialSpriteRef(sprites),
  );
  const [submittingSpriteId, setSubmittingSpriteId] = useState<string | null>(
    null,
  );
  // Detect (Check) POST in-flight — mirror submittingSpriteId, modal-local.
  // Per plane: sprite (Variants) + mix (Crops batch).
  const [submittingDetectSpriteId, setSubmittingDetectSpriteId] = useState<
    string | null
  >(null);
  const [submittingDetectBatchId, setSubmittingDetectBatchId] = useState<
    string | null
  >(null);
  // ⚡2026-06-12 — per-stage record (mixes auto-inits from the seeded batch;
  // rmbgs/upscales start null when 0 batches → empty-state CTA Import).
  const [stageStates, setStageStates] = useState<StageStates>(() => ({
    mixes: { activeBatchRef: initialBatchRef(mixBatches), submittingBatchId: null },
    rmbgs: { activeBatchRef: initialBatchRef(rmbgBatches), submittingBatchId: null },
    upscales: {
      activeBatchRef: initialBatchRef(upscaleBatches),
      submittingBatchId: null,
    },
  }));
  const [importModal, setImportModal] = useState<{
    stage: 'rmbgs' | 'upscales';
  } | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(ZOOM.default);
  const [dividerPosition, setDividerPosition] = useState(50);
  const [params, setParams] = useState<SwapModelParams>(DEFAULT_SWAP_PARAMS);

  // ── EFFECTIVE pointers (derived — no setState-in-effect, React 19 lint) ──────
  // The raw refs above capture USER INTENT and are seeded once at mount; rows
  // that arrive AFTER mount (async sprite seed / legacy mixes migration /
  // realtime) would leave them null → sidebar shows no selection while the
  // center stage falls back to [0]. The EFFECTIVE ref mirrors that fallback:
  // raw ref while it still resolves (sheetIndex clamped), else first entity
  // sheet 0, else null. ALL consumers (tabs, sidebars, reset keys, removal
  // re-selection) read the effective ref; only user actions write the raw one.
  const effectiveSpriteRef = useMemo<ActiveSpriteRef | null>(() => {
    const sprite = activeSpriteRef
      ? sprites.find((s) => s.id === activeSpriteRef.spriteId)
      : undefined;
    if (activeSpriteRef && sprite) {
      const maxIndex = Math.max(0, sprite.crop_sheets.length - 1);
      return {
        spriteId: activeSpriteRef.spriteId,
        sheetIndex: Math.min(Math.max(activeSpriteRef.sheetIndex, 0), maxIndex),
      };
    }
    return initialSpriteRef(sprites);
  }, [activeSpriteRef, sprites]);

  const effectiveBatchRefs = useMemo<Record<StageKind, ActiveBatchRef | null>>(() => {
    const resolve = (stage: StageKind): ActiveBatchRef | null => {
      const ref = stageStates[stage].activeBatchRef;
      const batch = ref
        ? stageBatches[stage].find((b) => b.id === ref.batchId)
        : undefined;
      if (ref && batch) {
        const maxIndex = Math.max(0, batch.crop_sheets.length - 1);
        return {
          batchId: ref.batchId,
          sheetIndex: Math.min(Math.max(ref.sheetIndex, 0), maxIndex),
        };
      }
      return initialBatchRef(stageBatches[stage]);
    };
    return {
      mixes: resolve('mixes'),
      rmbgs: resolve('rmbgs'),
      upscales: resolve('upscales'),
    };
  }, [stageStates, stageBatches]);

  // Per-stage state setters (record-merge helpers).
  const setStageActiveBatchRef = useCallback(
    (stage: StageKind, ref: ActiveBatchRef | null) => {
      setStageStates((prev) => ({
        ...prev,
        [stage]: { ...prev[stage], activeBatchRef: ref },
      }));
    },
    [],
  );
  const setStageSubmitting = useCallback(
    (stage: StageKind, batchId: string | null) => {
      setStageStates((prev) => ({
        ...prev,
        [stage]: { ...prev[stage], submittingBatchId: batchId },
      }));
    },
    [],
  );

  // ── Focus restore + ILS slot ────────────────────────────────────────────────
  const triggerElRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerElRef.current = document.activeElement as HTMLElement | null;
    return () => triggerElRef.current?.focus();
  }, []);

  const dialogContentRef = useRef<HTMLDivElement>(null);

  const handleEscOrClickOutside = useCallback(() => {
    log.debug('handleEscOrClickOutside', 'esc/click-outside closes modal', {});
    onClose();
  }, [onClose]);

  useInteractionLayer('modal', {
    id: 'swap-crop-sheet-modal',
    ref: dialogContentRef,
    hotkeys: ['Escape'],
    onHotkey: (key) => {
      if (key === 'Escape') handleEscOrClickOutside();
    },
    onClickOutside: handleEscOrClickOutside,
    captureClickOutside: true,
    portalSelectors: [
      '[data-radix-popper-content-wrapper]',
      '[data-radix-select-content]',
      '[role="listbox"]',
    ],
    // Parameter-sidebar Select dropdowns portal OUTSIDE dialogContentRef. Picking
    // an option (or re-picking the same value) unmounts the popper synchronously
    // on pointerdown, so by mousedown the target is a detached node and
    // portalSelectors can no longer match it → the resolver mis-classifies the
    // click as outside and captureClickOutside pops the modal. dropdownSelectors
    // lets the Provider snapshot "a dropdown was open at pointerdown" and keep
    // the modal open (see interaction-layer-provider §handlePointerDownCapture).
    dropdownSelectors: [
      '[data-radix-select-content]',
      '[data-radix-popper-content-wrapper]',
    ],
  });

  // ── On-mount one-shots (idempotent) ──────────────────────────────────────────
  // Legacy→batch migration + lazy sprite seed. Deps `[target.remixId]` only
  // (React 19 lint — memory feedback_react19_set_state_in_effect). Both actions
  // are no-ops when nothing is needed and persist immediately.
  useEffect(() => {
    void migrateLegacyRemixToBatch(target.remixId);
    void ensureRemixSpriteSeed(target.remixId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.remixId]);

  // ── Auto-close when the remix disappears (realtime delete) ───────────────────
  useEffect(() => {
    if (remix === null) {
      log.warn('autoClose', 'remix resolved null — closing modal', {
        remixId: target.remixId,
      });
      toast.info('Remix đã bị xoá');
      onClose();
    }
  }, [remix, onClose, target.remixId]);

  // ── Tab change + shared stage mutators ───────────────────────────────────────
  const handleTabChange = (tab: RemixModalTab) => {
    log.debug('handleTabChange', 'switch tab', { from: activeTab, to: tab });
    setActiveTab(tab);
    setCompareMode(false);
    setDividerPosition(50);
    // No ref backfill needed — the EFFECTIVE refs above already resolve a null/
    // stale raw ref to the first entity (rmbgs/upscales with 0 batches stay
    // null → empty-state CTA Import).
  };

  const handleSelectSpriteSheet = useCallback(
    (spriteId: string, sheetIndex: number) => {
      log.debug('handleSelectSpriteSheet', 'select sheet', { spriteId, sheetIndex });
      setActiveSpriteRef({ spriteId, sheetIndex });
      setCompareMode(false);
      setDividerPosition(50);
    },
    [],
  );

  const handleSelectStageSheet = useCallback(
    (stage: StageKind, batchId: string, sheetIndex: number) => {
      log.debug('handleSelectStageSheet', 'select sheet', {
        stage,
        batchId,
        sheetIndex,
      });
      setStageActiveBatchRef(stage, { batchId, sheetIndex });
      setCompareMode(false);
      setDividerPosition(50);
    },
    [setStageActiveBatchRef],
  );

  const handleToggleCompare = useCallback(
    () => setCompareMode((prev) => !prev),
    [],
  );
  const handleZoomChange = useCallback((z: number) => setZoomLevel(z), []);
  const handleDividerChange = useCallback(
    (p: number) => setDividerPosition(p),
    [],
  );

  // ── onSwapSprite (Variants tab) ──────────────────────────────────────────────
  const handleSwapSprite = useCallback(
    async (spriteId: string) => {
      setSubmittingSpriteId(spriteId);
      try {
        const outcome = await startSpriteSwap({
          remixId: target.remixId,
          spriteId,
          params,
          forceResweep: true,
        });
        log.info('handleSwapSprite', 'enqueue outcome', {
          spriteId,
          kind: outcome.kind,
        });
        if (outcome.kind === 'deduped') {
          toast.info('A sprite swap is already running for this remix');
        } else if (outcome.kind === 'enqueued') {
          toast.success('Swap started');
        }
        // 'skipped' (busy) is silent — gating already disables the button.
      } catch (err) {
        const code = err instanceof EnqueueJobError ? err.code : undefined;
        log.error('handleSwapSprite', 'enqueue failed', { spriteId, code });
        toast.error(mapSpriteSwapError(code));
      } finally {
        setSubmittingSpriteId(null);
      }
    },
    [startSpriteSwap, target.remixId, params],
  );

  // ── onDetectSprite (Variants tab — Check, sprite plane) ──────────────────────
  // Mirror handleSwapSprite. Enqueue is NON-FATAL advisory: any failure just
  // warns (the swap result stays usable). `deduped` covers BOTH dedup contracts
  // (sprite HTTP 200 envelope + the 409 path normalized in startDetectJob).
  // SECURITY: never log defect data.
  const handleDetectSprite = useCallback(
    async (spriteId: string) => {
      const label = DETECT_PLANE_CONFIG.sprite.defectLabel;
      setSubmittingDetectSpriteId(spriteId);
      try {
        const outcome = await startDetectJob({
          plane: 'sprite',
          remixId: target.remixId,
          scopeId: spriteId,
          params,
        });
        log.info('handleDetectSprite', 'enqueue outcome', {
          spriteId,
          kind: outcome.kind,
        });
        if (outcome.kind === 'deduped') {
          toast.info('Đang kiểm tra một mục khác — đợi xong rồi thử lại');
        } else if (outcome.kind === 'enqueued') {
          toast.success(`Bắt đầu kiểm tra ${label}`);
        }
        // 'skipped' (busy) is silent — gating already disables the button.
      } catch (err) {
        const code = err instanceof EnqueueJobError ? err.code : undefined;
        const httpStatus =
          err instanceof EnqueueJobError ? err.httpStatus : undefined;
        log.warn('handleDetectSprite', 'enqueue failed (non-fatal)', {
          spriteId,
          code,
          httpStatus,
          message: err instanceof Error ? err.message : String(err),
        });
        toast.warning(`Không kiểm tra được ${label}`);
      } finally {
        setSubmittingDetectSpriteId(null);
      }
    },
    [startDetectJob, target.remixId, params],
  );

  // ── onDetectBatch (Crops/Remove BG tabs — Check, batch-scoped planes) ────────
  // Plane-aware (mix = Crops tab, rmbg = Remove BG tab — ⚡2026-06-28); both bind
  // batch_id scope, so ONE handler serves both (the JSX passes the plane). Mirror
  // handleDetectSprite. ⚡DEDUP DIVERGENCE: the batch planes (jobs 12/13) return
  // HTTP 409 JOB_ALREADY_ACTIVE when a detect is already running — startDetectJob
  // normalizes that to `deduped` (attach via realtime), so a 409 surfaces as an
  // info toast here, NOT the warn error path. NON-FATAL.
  const handleDetectBatch = useCallback(
    async (plane: 'mix' | 'rmbg', batchId: string) => {
      const label = DETECT_PLANE_CONFIG[plane].defectLabel;
      setSubmittingDetectBatchId(batchId);
      try {
        const outcome = await startDetectJob({
          plane,
          remixId: target.remixId,
          scopeId: batchId,
          params,
        });
        log.info('handleDetectBatch', 'enqueue outcome', {
          plane,
          batchId,
          kind: outcome.kind,
        });
        if (outcome.kind === 'deduped') {
          toast.info('Đang kiểm tra một mục khác — đợi xong rồi thử lại');
        } else if (outcome.kind === 'enqueued') {
          toast.success(`Bắt đầu kiểm tra ${label}`);
        }
        // 'skipped' (busy) is silent — gating already disables the button.
      } catch (err) {
        const code = err instanceof EnqueueJobError ? err.code : undefined;
        const httpStatus =
          err instanceof EnqueueJobError ? err.httpStatus : undefined;
        log.warn('handleDetectBatch', 'enqueue failed (non-fatal)', {
          plane,
          batchId,
          code,
          httpStatus,
          message: err instanceof Error ? err.message : String(err),
        });
        toast.warning(`Không kiểm tra được ${label}`);
      } finally {
        setSubmittingDetectBatchId(null);
      }
    },
    [startDetectJob, target.remixId, params],
  );

  // ── Generic stage-job enqueue (3 stages — jobs 05/09/10) ─────────────────────
  const handleStartStageJob = useCallback(
    async (stage: StageKind, batchId: string) => {
      setStageSubmitting(stage, batchId);
      try {
        const outcome = await startStageJob({
          remixId: target.remixId,
          stage,
          batchId,
          params,
          forceResweep: true,
        });
        log.info('handleStartStageJob', 'enqueue outcome', {
          stage,
          batchId,
          kind: outcome.kind,
        });
        const action = STAGE_TAB_CONFIG[stage].actionLabel;
        if (outcome.kind === 'deduped') {
          toast.info(`A ${action.toLowerCase()} job is already running for this remix`);
        } else if (outcome.kind === 'enqueued') {
          toast.success(`${action} started`);
        }
      } catch (err) {
        const code = err instanceof EnqueueJobError ? err.code : undefined;
        log.error('handleStartStageJob', 'enqueue failed', { stage, batchId, code });
        toast.error(mapStageJobError(stage, code));
      } finally {
        setStageSubmitting(stage, null);
      }
    },
    [startStageJob, target.remixId, params, setStageSubmitting],
  );

  // ── Import flow (rmbgs/upscales — 05-14) ─────────────────────────────────────
  const handleOpenImport = useCallback((stage: 'rmbgs' | 'upscales') => {
    log.debug('handleOpenImport', 'open import dialog', { stage });
    setImportModal({ stage });
  }, []);

  const handleImportStageBatch = useCallback(
    async (stage: 'rmbgs' | 'upscales', selectedKeys: ReadonlySet<string>) => {
      log.info('handleImportStageBatch', 'confirm import', {
        stage,
        selectionSize: selectedKeys.size,
      });
      try {
        const newBatchId = await importStageBatch(
          target.remixId,
          stage,
          selectedKeys,
        );
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
        // Dialog stays open — the user can retry or Cancel (05-14 §4).
        toast.error(msg);
      }
    },
    [importStageBatch, target.remixId, setStageActiveBatchRef],
  );

  // ── Sprite sidebar action callbacks (thin store delegates) ───────────────────
  const handleRemoveSprite = useCallback(
    (spriteId: string) => {
      const nextRef = spriteRefAfterRemoval(sprites, effectiveSpriteRef, spriteId);
      void removeSprite(target.remixId, spriteId)
        .then((ok) => {
          if (ok && nextRef) {
            handleSelectSpriteSheet(nextRef.spriteId, nextRef.sheetIndex);
          }
        })
        .catch((err) => {
          log.warn('handleRemoveSprite', 'removeSprite rejected', {
            spriteId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [removeSprite, target.remixId, sprites, effectiveSpriteRef, handleSelectSpriteSheet],
  );
  const handleAddSpriteSheet = useCallback(
    (spriteId: string) => void appendSpriteSheet(target.remixId, spriteId),
    [appendSpriteSheet, target.remixId],
  );
  const handleRemoveSpriteSheet = useCallback(
    (spriteId: string, sheetIndex: number) =>
      void removeSpriteSheet(target.remixId, spriteId, sheetIndex),
    [removeSpriteSheet, target.remixId],
  );

  // ── Stage sidebar action callbacks (generic — thin store delegates) ──────────
  const handleRemoveStageBatch = useCallback(
    (stage: StageKind, batchId: string) => {
      const nextRef = batchRefAfterRemoval(
        stageBatches[stage],
        effectiveBatchRefs[stage],
        batchId,
      );
      void removeStageBatch(target.remixId, stage, batchId)
        .then((ok) => {
          if (!ok) return;
          if (nextRef) {
            handleSelectStageSheet(stage, nextRef.batchId, nextRef.sheetIndex);
          } else if (effectiveBatchRefs[stage]?.batchId === batchId) {
            // Removed the LAST batch of an allowZeroBatch stage → empty state.
            setStageActiveBatchRef(stage, null);
          }
        })
        .catch((err) => {
          log.warn('handleRemoveStageBatch', 'removeStageBatch rejected', {
            stage,
            batchId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [
      removeStageBatch,
      target.remixId,
      stageBatches,
      effectiveBatchRefs,
      handleSelectStageSheet,
      setStageActiveBatchRef,
    ],
  );
  const handleAddStageSheet = useCallback(
    (stage: StageKind, batchId: string) =>
      void appendStageBatchSheet(target.remixId, stage, batchId),
    [appendStageBatchSheet, target.remixId],
  );
  const handleRemoveStageSheet = useCallback(
    (stage: StageKind, batchId: string, sheetIndex: number) =>
      void removeStageBatchSheet(target.remixId, stage, batchId, sheetIndex),
    [removeStageBatchSheet, target.remixId],
  );

  // ── Selection reset keys ─────────────────────────────────────────────────────
  // `SelectionProvider` is remounted (→ fresh `new Set()`) by changing its `key`
  // — NOT useEffect+setState (React 19 lint). The reset key is the stage + the
  // active sprite/batch id + the SUM of swap_results across its sheets (a
  // completed job pushes results → sum increases → key changes → selection
  // resets; switching SHEETS within the same batch keeps the sum stable).
  const activeSprite = useMemo(
    () =>
      effectiveSpriteRef
        ? sprites.find((s) => s.id === effectiveSpriteRef.spriteId) ?? null
        : null,
    [sprites, effectiveSpriteRef],
  );
  const activeSpriteSwapResultsCount = useMemo(
    () =>
      activeSprite
        ? activeSprite.crop_sheets.reduce(
            (acc, s) => acc + s.swap_results.length,
            0,
          )
        : 0,
    [activeSprite],
  );
  const spriteSelectionResetKey = `${effectiveSpriteRef?.spriteId ?? '__none__'}::${activeSpriteSwapResultsCount}`;

  /** `${stage}/${batchId}::${totalSwapResultsCount}` — per-stage keyed remount.
   *  Keyed on the EFFECTIVE batch so a stale/null ref can't freeze the reset
   *  key at `__none__`. */
  const stageSelectionResetKey = useCallback(
    (stage: StageKind): string => {
      const ref = effectiveBatchRefs[stage];
      const batch = ref
        ? stageBatches[stage].find((b) => b.id === ref.batchId) ?? null
        : null;
      const count = batch
        ? batch.crop_sheets.reduce((acc, s) => acc + s.swap_results.length, 0)
        : 0;
      return `${stage}/${batch?.id ?? '__none__'}::${count}`;
    },
    [effectiveBatchRefs, stageBatches],
  );

  // entity selectors return [] when the remix is gone; the null-remix close is
  // handled by the effect above. Render null for that single frame.
  if (remix === null) return null;

  const sharedStageProps = {
    compareMode,
    zoomLevel,
    dividerPosition,
    onToggleCompare: handleToggleCompare,
    onZoomChange: handleZoomChange,
    onDividerChange: handleDividerChange,
  };

  /** Stage-generic props bundle for the 3 StageBatchTab instances. */
  const stageTabProps = (stage: StageKind) => ({
    remixId: target.remixId,
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
    ...sharedStageProps,
  });

  const activeStage: StageKind | null =
    activeTab === 'variants' ? null : STAGE_OF_TAB[activeTab];

  return (
    <StageDataAdapterProvider value={stageAdapter}>
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={dialogContentRef}
        aria-labelledby="swap-crop-sheet-modal-title"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        style={
          {
            ...SWAP_MODAL_TOKENS,
            zIndex: Z_INDEX.swapModal,
          } as React.CSSProperties
        }
        className="inset-0 left-0 top-0 flex h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[var(--swap-modal-bg)] p-0 text-[var(--swap-modal-text-primary)] [&>button]:hidden"
      >
        <DialogTitle className="sr-only">Remix — quản lý crop sheet</DialogTitle>
        <DialogDescription className="sr-only">
          Pipeline 4 tab: sprites, crops, remove background và upscale của remix.
        </DialogDescription>

        <RemixModalHeader
          title={remix?.name || 'Remix'}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onClose={onClose}
        />

        <div className="flex min-h-0 flex-1">
          {activeTab === 'variants' && (
            // Keyed remount → per-cell selection inside `SelectionProvider`
            // resets on sprite switch / new swap_results (no useEffect+setState).
            <SelectionProvider key={spriteSelectionResetKey}>
              <VariantsTab
                remixId={target.remixId}
                sprites={sprites}
                activeSpriteRef={effectiveSpriteRef}
                submittingSpriteId={submittingSpriteId}
                anySpriteSwapRunning={anySpriteSwapRunning}
                submittingDetectSpriteId={submittingDetectSpriteId}
                anyDetectRunning={anySpriteDetectRunning}
                onSelectSpriteSheet={handleSelectSpriteSheet}
                onActivateSprite={setActiveSpriteRef}
                onRemoveSprite={handleRemoveSprite}
                onAddSheet={handleAddSpriteSheet}
                onRemoveSheet={handleRemoveSpriteSheet}
                onSwapSprite={handleSwapSprite}
                onDetectSprite={handleDetectSprite}
                {...sharedStageProps}
              />
            </SelectionProvider>
          )}

          {activeStage === 'mixes' && (
            <SelectionProvider key={stageSelectionResetKey('mixes')}>
              <BatchesTab
                {...stageTabProps('mixes')}
                submittingDetectBatchId={submittingDetectBatchId}
                anyDetectRunning={anyMixDetectRunning}
                onDetectBatch={(batchId) => void handleDetectBatch('mix', batchId)}
              />
            </SelectionProvider>
          )}

          {activeStage === 'rmbgs' && (
            <SelectionProvider key={stageSelectionResetKey('rmbgs')}>
              <RmbgTab
                {...stageTabProps('rmbgs')}
                submittingDetectBatchId={submittingDetectBatchId}
                anyDetectRunning={anyRmbgDetectRunning}
                onDetectBatch={(batchId) => void handleDetectBatch('rmbg', batchId)}
                onOpenImport={() => handleOpenImport('rmbgs')}
              />
            </SelectionProvider>
          )}

          {activeStage === 'upscales' && (
            <SelectionProvider key={stageSelectionResetKey('upscales')}>
              <UpscaleTab
                {...stageTabProps('upscales')}
                onOpenImport={() => handleOpenImport('upscales')}
              />
            </SelectionProvider>
          )}

          <SwapParametersSidebar
            params={params}
            onChange={setParams}
            activeTab={activeTab}
          />
        </div>

        {importModal && (
          // Dialog OVER the modal (05-14) — Esc/backdrop close THIS only.
          <ImportBatchModal
            finals={stageAdapter.stageFinals(PREV_STAGE[importModal.stage])}
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
