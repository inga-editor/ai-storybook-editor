// media-tier-host.tsx — Host component that owns the active media tier
// lifecycle.
//
// Renders nothing. Mounted by PlayableSpreadView only when the host surface
// passes a `mediaTier` prop (player sub-app / editor Preview / share-preview).
// Mount/tier-change sets the module singleton; unmount clears it so edit-mode
// canvases go back to original URLs (tier null → applyMediaTier passthrough).
//
// Design source: ai-storybook-design/component/editor-page/shared/playable-spread-view/03-16-media-tier-resolve.md §2

import { useEffect } from 'react';
import { setActiveMediaTier, type DeviceTier } from './media-tier';

interface MediaTierHostProps {
  tier: DeviceTier; // host decides — no self-detect here
}

export function MediaTierHost({ tier }: MediaTierHostProps): null {
  useEffect(() => {
    setActiveMediaTier(tier);
    return () => setActiveMediaTier(null);
  }, [tier]);
  return null;
}

export default MediaTierHost;
