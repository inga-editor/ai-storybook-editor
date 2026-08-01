// player-spread-preload-host.tsx — Host component that owns the spread media
// preload lifecycle.
//
// Renders nothing. Always mounted by PlayableSpreadView (pure player) so
// React's mount/unmount drives the sliding window (un)scheduling inside
// `usePlayerSpreadPreload`. Kept in a dedicated host (vs inline) to scope
// the hook's lifecycle owner and mirror PlayerAudioMixerHost.
//
// Spec: ai-storybook-design/component/editor-page/shared/playable-spread-view/03-11-spread-media-preload.md §8

import { useEffect } from 'react';
import type { PlayableSpread } from '@/types/playable-types';
import {
  useNarrationLanguage,
  useQuizLanguage,
  usePlayEdition,
} from '@/stores/animation-playback-store';
import { usePlayerAudioStore } from '@/stores/player-audio-store';
import { usePlayerSpreadPreload } from '../hooks/use-player-spread-preload';

interface PlayerSpreadPreloadHostProps {
  spreads: PlayableSpread[];
  activeSpreadId: string;
  /**
   * Stable identifier for the spread source — Original vs Remix. Drives both
   * audio pool eviction (stale URLs on switch) and preload re-fire.
   */
  sourceKey?: string;
}

export function PlayerSpreadPreloadHost({
  spreads,
  activeSpreadId,
  sourceKey,
}: PlayerSpreadPreloadHostProps): null {
  const narrationLangCode = useNarrationLanguage();
  const quizLangCode = useQuizLanguage();
  const playEdition = usePlayEdition();

  // On language OR source switch, all pooled audio URLs are stale (different
  // localized tracks / different remix's audio set). Evict everything; preload
  // tier re-primes the new URL set on the next render. Tween reset on these
  // changes (parent behaviour) means in-flight playback is going to be killed
  // anyway, so a hard pause here is safe.
  useEffect(() => {
    return () => {
      usePlayerAudioStore.getState().releaseAllAudio();
    };
  }, [narrationLangCode, quizLangCode, sourceKey]);

  usePlayerSpreadPreload({
    spreads,
    activeSpreadId,
    narrationLangCode,
    quizLangCode,
    playEdition,
    sourceKey,
  });
  return null;
}

export default PlayerSpreadPreloadHost;
