// casting-highlight-image.tsx — Renders ONE highlighted image layer on the
// Actors display canvas (phase 06): the actor-preview <img> positioned at the
// layer geometry + the CastingHighlightOverlay boxing the same rect.
//
// Display-only: no selection, no drag/resize, no toolbar. The <img> swaps to the
// layer's normal effective URL on load error (404 of an injected actor media),
// flips the status badge to 'error', and reports the failure UP to the parent's
// per-layer Map (so no retry loop + drives the empty-hint). Error state is set in
// the onError EVENT handler — never in an effect.

import { useState, useCallback } from 'react';
import type { SpreadImage } from '@/types/spread-types';
import type { ActorPair } from '@/types/actors';
import { resolveEffectiveImageUrl } from '@/features/editor/components/shared-components';
import { createLogger } from '@/utils/logger';
import {
  resolveCastingPreviewUrl,
  type CastingPreviewStatus,
} from './resolve-casting-preview-url';
import { CastingHighlightOverlay } from './casting-highlight-overlay';

const log = createLogger('Editor', 'CastingHighlightImage');

interface CastingHighlightImageProps {
  layer: SpreadImage;
  selectedPair: ActorPair;
  actantName: string;
  actorName: string;
  zIndex?: number;
  /** True when this layer's CURRENT resolved URL already failed to load in this
   *  session (parent memory, keyed layer|url). Seeds error state so a remount
   *  (spread/row switch) does not retry the dead URL. */
  initiallyFailed?: boolean;
  /** Report a load failure to the parent's per-(layer, url) memory. */
  onLoadError?: (layerId: string, url: string) => void;
}

export function CastingHighlightImage({
  layer,
  selectedPair,
  actantName,
  actorName,
  zIndex,
  initiallyFailed = false,
  onLoadError,
}: CastingHighlightImageProps) {
  // Lazy init from the parent Map — remembers a prior 404 across remounts.
  const [errored, setErrored] = useState<boolean>(initiallyFailed);

  const resolved = resolveCastingPreviewUrl(layer, selectedPair);
  const fallbackUrl = resolveEffectiveImageUrl(layer);

  // Error state is scoped to ONE resolved URL: when Inject writes a NEW media_url
  // for this layer, the fresh URL must get a fresh chance — otherwise a transient
  // failure would pin the fallback (old visual) forever. Adjust-during-render
  // (sanctioned React pattern), NOT an effect.
  const [erroredForUrl, setErroredForUrl] = useState<string | undefined>(resolved.url);
  if (resolved.url !== erroredForUrl) {
    setErroredForUrl(resolved.url);
    setErrored(false);
  }

  // Last URL that actually painted. While a NEW target URL is downloading (e.g.
  // right after Inject swaps entry.media_url), keep the previous visual beneath —
  // without it the layer goes blank and the raw scene under it shows through,
  // which reads as "Inject didn't update anything".
  const [paintedUrl, setPaintedUrl] = useState<string | null>(null);

  const url = errored ? fallbackUrl : resolved.url;
  const status: CastingPreviewStatus = errored ? 'error' : resolved.status;

  const handleError = useCallback(() => {
    // media_url is intentionally NOT logged (design 02 §Security) — only the id.
    log.warn('handleError', 'casting preview image failed to load', {
      layerId: layer.id,
      status: resolved.status,
    });
    setErrored(true);
    if (url) onLoadError?.(layer.id, url);
  }, [layer.id, resolved.status, url, onLoadError]);

  const rotation = Number.isFinite(layer.geometry.rotation) ? layer.geometry.rotation : 0;

  return (
    <>
      {/* Image box — positioned at the layer geometry (% bleed-relative). */}
      <div
        role="img"
        aria-label={layer.title || `Casting layer ${layer.id}`}
        className="absolute overflow-hidden"
        style={{
          left: `${layer.geometry.x}%`,
          top: `${layer.geometry.y}%`,
          width: `${layer.geometry.w}%`,
          height: `${layer.geometry.h}%`,
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          zIndex,
          pointerEvents: 'none',
        }}
      >
        {/* Previous visual stays beneath until the new target paints (removed on load
            so a transparent cutout PNG never shows the stale visual through it). */}
        {paintedUrl && paintedUrl !== url && (
          <img
            src={paintedUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
        )}
        {url && (
          <img
            key={url}
            src={url}
            alt={layer.title ?? ''}
            className="absolute inset-0 h-full w-full object-contain"
            loading="lazy"
            draggable={false}
            onLoad={() => setPaintedUrl(url)}
            onError={handleError}
          />
        )}
      </div>

      {/* Highlight overlay — sits just above the image, non-interactive. */}
      <CastingHighlightOverlay
        geometry={layer.geometry}
        actantName={actantName}
        actorName={actorName}
        status={status}
        zIndex={(zIndex ?? 0) + 1}
      />
    </>
  );
}

export default CastingHighlightImage;
