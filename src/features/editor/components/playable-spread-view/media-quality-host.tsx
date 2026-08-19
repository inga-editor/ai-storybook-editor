// media-quality-host.tsx — Host component that owns the active media quality
// lifecycle.
//
// Renders nothing. Mounted by PlayableSpreadView only when the host surface
// passes a `mediaQuality` prop (player sub-app / editor Preview / share-preview).
// Mount/quality-change sets the module singleton; unmount clears it so edit-mode
// canvases go back to original URLs (quality null → applyMediaQuality passthrough).
//
// Design source: ai-storybook-design/component/editor-page/shared/playable-spread-view/03-16-media-quality-resolve.md §2

import { useEffect } from 'react';
import { setActiveMediaQuality, type MediaQuality } from './media-quality';

interface MediaQualityHostProps {
  quality: MediaQuality; // host decides — no self-detect here
}

export function MediaQualityHost({ quality }: MediaQualityHostProps): null {
  useEffect(() => {
    setActiveMediaQuality(quality);
    return () => setActiveMediaQuality(null);
  }, [quality]);
  return null;
}

export default MediaQualityHost;
