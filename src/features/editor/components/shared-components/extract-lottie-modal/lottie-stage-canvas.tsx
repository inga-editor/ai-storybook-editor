// lottie-stage-canvas.tsx — Center stage (design README §2.3): dark checkerboard scroll area +
// the zoomed content wrapper holding the source <img> and any overlay layers (box / pivot / mask /
// composite) passed as `children`. Children are absolute `inset-0` layers over the image area.
// Presentational — state + handlers come from the shell.
//
// Zoom model (codebase convention — mirrors EditImageModalCanvas): zoom is a MULTIPLIER on top of a
// contain-fit size, NOT a raw width %. `fitNaturalToFrame` scales the image to fit the measured
// stage box on BOTH axes (preserving aspect ratio, never upscaling), so 100% always shows the whole
// image — a portrait image on a landscape stage no longer overflows below the fold. Zoom is applied
// as actual CSS width/height (NOT transform:scale — memory: zoom-via-css-width keeps scroll metrics
// correct) so the `overflow-auto` parent exposes the full scroll range when zoomed past fit.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fitNaturalToFrame, type Size } from '../edit-image-modal/edit-image-modal-fit';

const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: '#0e1220',
  backgroundImage:
    'linear-gradient(45deg, #141a2c 25%, transparent 25%), linear-gradient(-45deg, #141a2c 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #141a2c 75%), linear-gradient(-45deg, transparent 75%, #141a2c 75%)',
  backgroundSize: '24px 24px',
  backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0',
};

export interface LottieStageCanvasProps {
  sourceUrl: string;
  zoom: number;
  /** View tab: keep the source <img> laid out (sizes the wrapper) but invisible so the checkerboard
   *  shows through and the composite renders alone. */
  hideSource?: boolean;
  /** Extra cursor for the wrapper (e.g. 'crosshair' on the Pivot tab). */
  cursor?: string;
  isProcessing?: boolean;
  processingLabel?: string;
  onNaturalSize?: (natural: { w: number; h: number }) => void;
  /** Overlay layers — each rendered `absolute inset-0` over the image area. */
  children?: ReactNode;
}

export function LottieStageCanvas({
  sourceUrl,
  zoom,
  hideSource = false,
  cursor,
  isProcessing = false,
  processingLabel = 'Đang xử lý…',
  onNaturalSize,
  children,
}: LottieStageCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  // Measured content box of the scroll area (excludes p-6 padding — that's the fit frame). Chrome
  // varies per tab (View hides both sidebars), so we measure the real element instead of deriving
  // the frame from viewport minus fixed chrome the way EditImageModal does.
  const [frame, setFrame] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setFrame({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = natural && frame ? fitNaturalToFrame(natural.w, natural.h, frame) : null;
  const scaled = fit
    ? { w: Math.round((fit.w * zoom) / 100), h: Math.round((fit.h * zoom) / 100) }
    : null;

  return (
    <div ref={stageRef} className="relative flex flex-1 overflow-auto p-6" style={CHECKERBOARD_STYLE}>
      {/* `m-auto` centers the content when it fits and collapses to 0 on overflow (start stays
       *  reachable), matching EditImageModalCanvas. */}
      <div
        className="relative m-auto shrink-0 leading-none"
        style={
          scaled
            ? { width: scaled.w, height: scaled.h, maxWidth: 'none', cursor }
            : { maxWidth: '100%', maxHeight: '100%', cursor }
        }
      >
        <img
          src={sourceUrl}
          alt="Source"
          className="block object-contain"
          style={
            scaled
              ? { width: scaled.w, height: scaled.h, maxWidth: 'none', opacity: hideSource ? 0 : 1 }
              : { maxWidth: '100%', maxHeight: '100%', opacity: hideSource ? 0 : 1 }
          }
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) {
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              onNaturalSize?.({ w: img.naturalWidth, h: img.naturalHeight });
            }
          }}
        />
        {children}
      </div>

      {isProcessing && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60"
        >
          <Loader2 className="h-8 w-8 animate-spin text-white" aria-hidden="true" />
          <p className="text-sm text-white">{processingLabel}</p>
        </div>
      )}
    </div>
  );
}
