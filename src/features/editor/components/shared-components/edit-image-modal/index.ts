// index.ts — Barrel for the EditImageModal tabbed full-screen workspace.

export { EditImageModal } from './edit-image-modal';
export type { EditImageModalProps } from './edit-image-modal';
export type { EditToolKey } from './edit-image-modal-constants';
// The parent-side prop-variant candidate resolvers were removed 2026-07-25 (04-inpaint-tab.md §8.7)
// — the Inpaint tab resolves its own candidates from the provenance API, so no store-coupled hook
// needs to leave this barrel any more.
