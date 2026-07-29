// casting-highlight-overlay.tsx — Presentational highlight layer for the Actors
// display canvas (phase 06). PURE: dashed primary outline + label chip
// ("{actantName} → {actorName}") top-left + status badge, positioned absolutely
// over one image layer's geometry (% bleed-relative, ADR-023).
//
// pointer-events:none — NEVER blocks scroll / nav / underlying render, and does
// NOT go through any selection machinery. Memoized per layer so a pair change
// re-renders only the affected overlays, not the full canvas.

import { memo } from 'react';
import { cn } from '@/utils/utils';
import type { Geometry } from '@/types/spread-types';
import type { CastingPreviewStatus } from './resolve-casting-preview-url';

interface CastingHighlightOverlayProps {
  /** Layer geometry (% of full bleed canvas) — overlay boxes the same rect. */
  geometry: Geometry;
  actantName: string;
  actorName: string;
  status: CastingPreviewStatus;
  /** Stacking order — sits just above its image layer. */
  zIndex?: number;
}

/** Badge copy + tone per status. `not_highlighted` never reaches here (overlay
 *  is only rendered for highlighted layers). */
const STATUS_BADGE: Record<
  CastingPreviewStatus,
  { label: string; className: string }
> = {
  cast: { label: 'cast ✓', className: 'bg-emerald-500/90 text-white' },
  not_generated: { label: 'not generated', className: 'bg-muted text-muted-foreground' },
  error: { label: 'load failed', className: 'bg-destructive/90 text-destructive-foreground' },
  not_highlighted: { label: '', className: '' },
};

function CastingHighlightOverlayInner({
  geometry,
  actantName,
  actorName,
  status,
  zIndex,
}: CastingHighlightOverlayProps) {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.not_generated;
  const rotation = Number.isFinite(geometry.rotation) ? geometry.rotation : 0;

  return (
    <div
      aria-hidden="true"
      className="absolute rounded-sm border-2 border-dashed border-primary"
      style={{
        left: `${geometry.x}%`,
        top: `${geometry.y}%`,
        width: `${geometry.w}%`,
        height: `${geometry.h}%`,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
        pointerEvents: 'none',
        zIndex,
      }}
    >
      {/* Label chip — top-left, hugs the outline. */}
      <div className="absolute left-0 top-0 flex max-w-full flex-wrap items-center gap-1 p-1">
        <span className="truncate rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium leading-tight text-primary-foreground shadow-sm">
          {actantName} → {actorName}
        </span>
        {badge.label && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight shadow-sm',
              badge.className,
            )}
          >
            {badge.label}
          </span>
        )}
      </div>
    </div>
  );
}

export const CastingHighlightOverlay = memo(CastingHighlightOverlayInner);

export default CastingHighlightOverlay;
