// pivot-overlay.tsx — Pivot layer for the stage (design 02-pivot-point-tab.md). A full-area
// click-catcher (crosshair) that maps a click to % of the ORIGINAL image (zoom-independent via the
// layer rect) → onSetPivot, plus the orange pivot dot for the active part. No active part → clicks
// are a no-op (README §2.4 supersede: no orphan pivots). Presentational.

import { useRef } from 'react';
import { LOTTIE_MODAL_LAYOUT } from './extract-lottie-modal-constants';

export interface PivotOverlayProps {
  pivot: { x: number; y: number } | null;
  /** Non-null only when there is an active part; null disables click capture. */
  onSetPivot: ((pivot: { x: number; y: number }) => void) | null;
}

export function PivotOverlay({ pivot, onSetPivot }: PivotOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    if (!onSetPivot) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    onSetPivot({ x, y });
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={{ cursor: onSetPivot ? 'crosshair' : 'default' }}
      onClick={handleClick}
    >
      {pivot && (
        <div
          className="pointer-events-none absolute rounded-full"
          style={{
            left: `${pivot.x}%`,
            top: `${pivot.y}%`,
            width: LOTTIE_MODAL_LAYOUT.pivotDotPx,
            height: LOTTIE_MODAL_LAYOUT.pivotDotPx,
            transform: 'translate(-50%, -50%)',
            background: LOTTIE_MODAL_LAYOUT.pivotDotColor,
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
          }}
        >
          <span
            className="absolute rounded-full bg-white"
            style={{ inset: 5 }}
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
}
