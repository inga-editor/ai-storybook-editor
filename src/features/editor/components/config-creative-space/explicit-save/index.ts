// Barrel for the Config Space explicit-save primitives (Phase 1).
// Phases 2-4 consume from here.

export {
  useConfigSectionDraft,
  type ConfigSectionDraft,
  type ConfigSectionDraftOptions,
  type DraftRecipe,
} from './use-config-section-draft';

export { ConfigSectionHeader, type ConfigSectionHeaderProps } from './config-section-header';
export { UnsavedChangesModal, type UnsavedChangesModalProps } from './unsaved-changes-modal';
export { useBeforeUnloadWhenDirty } from './use-before-unload-when-dirty';
export { deepEqual, assertPersisted, assertSnapshotFlushed } from './draft-utils';
export { pruneDeriveKeyed } from './prune-derive-keyed';
