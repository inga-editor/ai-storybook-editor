// lottie-mask-canvas.tsx — Edit/Eraser-tab stroke surface. Positioned at the active part's bbox
// over the stage image; draws the selected part asset + strokes. Two variants:
//   'mark'  (Edit tab)   — translucent set-of-mark overlay (2-pass offscreen→globalAlpha, mirror
//                          inpaint); strokes are paint-mode marks for the inpaint region.
//   'erase' (Eraser tab) — LIVE erase preview: strokes composite destination-out directly on the
//                          asset draw, showing real transparency as you brush.
// Canvas buffer = asset natural px, so strokes are stored in ASSET space directly (normalized
// 0..1) — no canvas→asset conversion needed at Send/Apply. Committed strokes live in the shell;
// this layer owns only the in-progress stroke + brush cursor. Zoom-independent pointer mapping
// via the canvas rect.

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Stroke, norm, paintStrokesOnCtx } from '../edit-image-modal/erase-stroke-engine';
import {
  INPAINT_MARK_COLOR,
  INPAINT_MARK_ALPHA,
  ACTIVE_PART_FRAME_BORDER,
  ACTIVE_PART_FRAME_SHADOW,
  PART_BADGE_ACCENT,
} from './extract-lottie-modal-constants';
import type { BBoxPct } from './extract-lottie-modal-types';

const BRUSH_RING_FILL = `${INPAINT_MARK_COLOR}80`;

export interface LottieMaskCanvasProps {
  assetUrl: string;
  /** Active part name — shown as the badge above the frame (parity with the Parts/Pivot box). */
  name: string;
  bbox: BBoxPct;
  brushSize: number;
  /** Committed strokes for the active part (asset-space normalized 0..1). */
  strokes: Stroke[];
  /** Append one finished stroke to the shell's stroke store. */
  onStrokeCommit: (stroke: Stroke) => void;
  /** 'mark' (default) = translucent inpaint marks; 'erase' = live destination-out erase. */
  variant?: 'mark' | 'erase';
}

export function LottieMaskCanvas({
  assetUrl,
  name,
  bbox,
  brushSize,
  strokes,
  onStrokeCommit,
  variant = 'mark',
}: LottieMaskCanvasProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const [activeStroke, setActiveStroke] = useState<Stroke | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || img.naturalWidth === 0) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    setCanvasSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  const attachImg = useCallback(
    (node: HTMLImageElement | null) => {
      imgRef.current = node;
      if (node && node.complete && node.naturalWidth > 0) queueMicrotask(handleImageLoad);
    },
    [handleImageLoad],
  );

  // Render: draw asset then composite strokes. 'mark' overlays translucent marks (2-pass, no
  // darken-stack); 'erase' composites erase strokes straight onto the asset draw — the engine's
  // destination-out subtracts alpha, so the preview shows the REAL post-erase transparency.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !canvasSize || img.naturalWidth === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (strokes.length === 0 && !activeStroke) return;
    if (variant === 'erase') {
      paintStrokesOnCtx(ctx, strokes, activeStroke, canvas.width, canvas.height, 1, false);
      return;
    }
    const overlay = document.createElement('canvas');
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const octx = overlay.getContext('2d');
    if (octx) {
      paintStrokesOnCtx(octx, strokes, activeStroke, canvas.width, canvas.height, 1, true);
      ctx.globalAlpha = INPAINT_MARK_ALPHA;
      ctx.drawImage(overlay, 0, 0);
      ctx.globalAlpha = 1;
    }
  }, [strokes, activeStroke, canvasSize, variant]);

  const pointToIntrinsic = (e: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy, rect };
  };

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { x, y, rect } = pointToIntrinsic(e, canvas);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      // Radius in asset-buffer px so it reads ~brushSize display px at the current zoom.
      const radius = brushSize * (canvas.width / Math.max(1, rect.width));
      const stroke: Stroke = {
        points: [norm(x, y, canvas.width, canvas.height)],
        size: radius,
        mode: variant === 'erase' ? 'erase' : 'paint',
        color: INPAINT_MARK_COLOR, // erase mode ignores color (engine contract)
      };
      activeStrokeRef.current = stroke;
      setActiveStroke(stroke);
    },
    [brushSize, variant],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const current = activeStrokeRef.current;
    if (!current) return;
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const updated: Stroke = {
      ...current,
      points: [
        ...current.points,
        norm((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy, canvas.width, canvas.height),
      ],
    };
    activeStrokeRef.current = updated;
    setActiveStroke(updated);
  }, []);

  const handlePointerUp = useCallback(() => {
    const committed = activeStrokeRef.current;
    activeStrokeRef.current = null;
    setActiveStroke(null);
    if (!committed || committed.points.length === 0) return;
    onStrokeCommit(committed);
  }, [onStrokeCommit]);

  return (
    <div
      className="absolute leading-none"
      style={{
        left: `${bbox.x}%`,
        top: `${bbox.y}%`,
        width: `${bbox.w}%`,
        height: `${bbox.h}%`,
      }}
    >
      <img
        key={assetUrl}
        ref={attachImg}
        src={assetUrl}
        alt=""
        crossOrigin="anonymous"
        className="hidden"
        onLoad={handleImageLoad}
      />
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => setCursor(null)}
      />
      {/* Selection frame — marks the active part's region while editing (mirrors Parts-tab box). */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ border: ACTIVE_PART_FRAME_BORDER, boxShadow: ACTIVE_PART_FRAME_SHADOW }}
      />
      {/* Name badge above the frame (parity with the Parts/Pivot box). */}
      <div
        className="pointer-events-none absolute flex justify-end"
        style={{ top: -30, left: 0, right: 0, zIndex: 30 }}
      >
        <span
          className="whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-sm"
          style={{ background: PART_BADGE_ACCENT }}
        >
          {name}
        </span>
      </div>
      {cursor && (
        <div
          className="pointer-events-none absolute rounded-full"
          style={{
            width: brushSize * 2,
            height: brushSize * 2,
            left: cursor.x - brushSize,
            top: cursor.y - brushSize,
            backgroundColor: variant === 'erase' ? 'transparent' : BRUSH_RING_FILL,
            boxShadow: '0 0 0 1px #fff, 0 0 0 2px #000',
          }}
        />
      )}
    </div>
  );
}
