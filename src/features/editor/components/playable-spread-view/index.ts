// index.ts - Barrel exports for PlayableSpreadView component family

// === Domain Types (re-export from @/types for barrel consumers) ===
export type {
  PlayMode,
  PlayableSpread,
  PlayerPhase,
  AnimationStep,
  ReplayableItem,
  PlayerState,
  PlayerAction,
} from '@/types/playable-types';

export type { ItemType } from '@/types/spread-types';

// === Shared Constants (re-export from @/constants for barrel consumers) ===
export { PLAYABLE_ZOOM, ANIMATION_PRESETS } from '@/constants/playable-constants';

// === Components ===
export { PlayableSpreadView } from './playable-spread-view';

// === Media quality (ADR-057 — rendition resolve by convert-width) ===
export {
  withQuality,
  applyMediaQuality,
  setActiveMediaQuality,
  getActiveMediaQuality,
  detectMediaQuality,
  MEDIA_QUALITY_LADDER,
  type MediaQuality,
} from './media-quality';
export { MediaQualityHost } from './media-quality-host';
export { PlayableThumbnailList } from './playable-thumbnail-list';
export { PlayerCanvas } from './player-canvas';
export { PlayerControlSidebar } from './player-control-sidebar';
export { BranchPathModal } from './branch-path-modal';
export { FirstGestureGate } from './first-gesture-gate';

// === Store selectors ===
export {
  usePlayMode,
  useIsPlaying,
  useVolume,
  usePlayerPhase,
  usePlaybackActions,
} from '@/stores/animation-playback-store';
