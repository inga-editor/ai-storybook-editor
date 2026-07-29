// Barrel for the swap-crop-sheet modal feature folder.
// Re-exports the public entry so external importers can use the folder path
// (`./swap-crop-sheet-modal`) unchanged after the structural consolidation.
// ⚡2026-06-12 — 4-tab pipeline: LottiesTab removed (deferred to its own
// modal); RmbgTab/UpscaleTab added; RemixModalTab is canonical in types/remix.
export { SwapCropSheetModal } from './swap-crop-sheet-modal';
export { RemixModalHeader } from './remix-modal-header';
export type { RemixModalTab } from '@/types/remix';
export { VariantsTab, type VariantsTabProps } from './tabs/variants-tab';
export { BatchesTab, type BatchesTabProps } from './tabs/batches-tab';
export { RmbgTab, type RmbgTabProps } from './tabs/rmbg-tab';
export { UpscaleTab, type UpscaleTabProps } from './tabs/upscale-tab';

// ── Shared presentational + hook layer (reused by the actors SwapCastingSlotModal,
//    phase 08 — the swap-crop-sheet tabs are owner-agnostic via StageDataAdapter). ──
export {
  StageDataAdapterProvider,
  useStageDataAdapter,
  type StageDataAdapter,
} from './stage-data-adapter';
export {
  useStageBatchTab,
  type StageBatchTabProps,
  type StageGateResult,
} from './tabs/use-stage-batch-tab';
export { BatchesSidebar, type BatchDetectDescriptor } from './tabs/batches-sidebar';
export { StageBatchEmptyState } from './tabs/stage-batch-empty-state';
export { StageImportButton } from './tabs/stage-import-button';
export { CropSheetStage } from './crop-sheet-stage';
export { RelayoutConfirmDialog } from './relayout-confirm-dialog';
export { ImportBatchModal } from './import-batch-modal';
export { SwapParametersSidebar } from './swap-parameters-sidebar';
export { SelectionProvider } from './hooks/use-selected-swap-crops';
export {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  ZOOM,
  DEFAULT_SWAP_PARAMS,
} from './swap-modal-constants';
export {
  STAGE_TAB_CONFIG,
  type StageTabConfig,
  type StageComposeMode,
  type StageAfterComposeMode,
} from './stage-tab-config';
