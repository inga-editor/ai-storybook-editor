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

// === Media tier (ADR-057 — device rendition resolve) ===
export {
  withTier,
  applyMediaTier,
  setActiveMediaTier,
  getActiveMediaTier,
  detectDeviceTier,
  type DeviceTier,
} from './media-tier';
export { MediaTierHost } from './media-tier-host';
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
