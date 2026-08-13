// constants.ts — Tunable limits + defaults for the art-style library (/styles).

import type { StylesFilterState } from '@/types/art-style';

// Re-export the single shared bucket constant so existing style imports keep working.
export { STORAGE_BUCKET } from '@/constants/storage-constants';

/** Max reference images per style — upload cap in the create/edit modal. */
export const REF_CAP = 12;

/** Card header preview strip: first N reference thumbnails shown (grid-cols must match).
 *  Decoupled from REF_CAP so a style can hold more refs than the card previews. */
export const CARD_REF_THUMBS = 3;

/** Max size for a single reference image upload (10MB). */
export const MAX_STYLE_IMG_BYTES = 10 * 1024 * 1024;

/** Max distinct tag chips rendered on a card before truncation. */
export const MAX_TAG_CHIPS = 4;

/** Debounce for the toolbar search input (ms). */
export const SEARCH_DEBOUNCE_MS = 200;

/** Initial / reset filter state. */
export const DEFAULT_STYLES_FILTERS: StylesFilterState = {
  search: '',
  references: 'all',
  tags: [],
  type: 'all',
};

/** Storage path prefix for art-style reference images. */
export const STYLE_STORAGE_PREFIX = 'art-styles';
