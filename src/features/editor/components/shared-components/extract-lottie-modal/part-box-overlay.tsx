// part-box-overlay.tsx — Single-active-box overlay for the Lottie stage (design 01-parts-tab §3.3 +
// README §2.4). ADAPTED from extract-image-modal/object-box-overlay (N-box) to ONE active box:
//   • no active part           → faint boxes for every normal part (click-select), no asset/handles
//   • active normal (interactive, Parts tab) → bright box + aspect toolbar + name tag + 4 handles
//                                 + asset overlay (selected version at bbox)
//   • active normal (read-only, Pivot tab)   → bright box (no toolbar/handles) + asset, pointer-events
//                                 off so the pivot layer beneath receives clicks
//   • active null              → nothing (pivot dot handled elsewhere)
// Pure geometry math is reused from extract-box-geometry-utils (drag/resize/aspect/clamp).

import { useCallback, useEffect, useRef } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AspectRatio } from '@/constants/aspect-ratio-constants';
import {
  applyDrag,
  applyResize,
  lockRatioForRatio,
  pointerDeltaToPercent,
  snapBoxToRatio,
  type BoxGeometry,
  type ResizeCorner,
} from '../extract-image-modal/extract-box-geometry-utils';
import type { BBoxPct, LottiePart } from './extract-lottie-modal-types';
import { selectedVersionOf } from './extract-lottie-modal-utils';
import {
  PART_ASPECT_RATIOS,
  PART_BBOX_MIN_PCT,
  PART_BADGE_ACCENT,
  SWAP_MODAL_TOKENS,
  Z_INDEX,
} from './extract-lottie-modal-constants';

const SELECT_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const CORNERS: ResizeCorner[] = ['nw', 'ne', 'sw', 'se'];
const CORNER_STYLE: Record<ResizeCorner, React.CSSProperties> = {
  nw: { top: -5, left: -5, cursor: 'nw-resize' },
  ne: { top: -5, right: -5, cursor: 'ne-resize' },
  sw: { bottom: -5, left: -5, cursor: 'sw-resize' },
  se: { bottom: -5, right: -5, cursor: 'se-resize' },
};
const BOX_COLOR = '#ffffff';
const ACCENT = PART_BADGE_ACCENT;

interface DragState {
  type: 'drag' | 'resize';
  corner?: ResizeCorner;
  start: BoxGeometry;
  startClientX: number;
  startClientY: number;
  lockRatio: number | null;
}

export interface PartBoxOverlayProps {
  parts: LottiePart[];
  activePartId: string | null;
  imageNatural: { w: number; h: number } | null;
  /** true = Parts tab (drag/resize/aspect toolbar); false = Pivot tab read-only (box only). */
  interactive: boolean;
  onSelectPart: (id: string) => void;
  onUpdateBBox: (id: string, bbox: BBoxPct) => void;
  onAspectChange: (id: string, aspect: string) => void;
  /** Clicking the stage area OUTSIDE the active box deselects (→ back to the original image).
   *  Parts tab only; omit to disable. */
  onDeselect?: () => void;
}

export function PartBoxOverlay({
  parts,
  activePartId,
  imageNatural,
  interactive,
  onSelectPart,
  onUpdateBBox,
  onAspectChange,
  onDeselect,
}: PartBoxOverlayProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const active = parts.find((p) => p.id === activePartId) ?? null;
  // Both normal (segment) and manual (hand-crop) parts have an editable box; null parts don't.
  const activeIsBox = active?.kind !== 'null' && !!active?.bbox;

  const beginPointer = useCallback(
    (e: React.MouseEvent, box: BBoxPct, aspect: string, type: 'drag' | 'resize', corner?: ResizeCorner) => {
      if (!interactive) return;
      e.preventDefault();
      e.stopPropagation();
      dragStateRef.current = {
        type,
        corner,
        start: { x: box.x, y: box.y, w: box.w, h: box.h },
        startClientX: e.clientX,
        startClientY: e.clientY,
        lockRatio: lockRatioForRatio(aspect as AspectRatio | 'Free', imageNatural),
      };
    },
    [interactive, imageNatural],
  );

  // Document-level move/up so a drag continues outside the box bounds.
  useEffect(() => {
    if (!interactive || !activeIsBox || !active) return;
    const activeId = active.id;
    const onMove = (e: MouseEvent) => {
      const st = dragStateRef.current;
      const area = areaRef.current;
      if (!st || !area) return;
      const rect = area.getBoundingClientRect();
      const { dxPct, dyPct } = pointerDeltaToPercent(
        e.clientX - st.startClientX,
        e.clientY - st.startClientY,
        rect.width,
        rect.height,
      );
      const next =
        st.type === 'drag'
          ? applyDrag(st.start, dxPct, dyPct)
          : applyResize(st.start, st.corner!, dxPct, dyPct, st.lockRatio, PART_BBOX_MIN_PCT);
      onUpdateBBox(activeId, next);
    };
    const onUp = () => {
      dragStateRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [interactive, activeIsBox, active, onUpdateBBox]);

  const handleAspectChange = useCallback(
    (id: string, aspect: string, box: BBoxPct) => {
      onAspectChange(id, aspect);
      if (aspect === 'Free') return;
      const lock = lockRatioForRatio(aspect as AspectRatio, imageNatural);
      if (lock != null) onUpdateBBox(id, snapBoxToRatio(box, lock, PART_BBOX_MIN_PCT));
    },
    [imageNatural, onAspectChange, onUpdateBBox],
  );

  // ── No active part → faint boxes for every normal part (click-select) ─────────
  if (!active || active.kind === 'null') {
    if (active?.kind === 'null') return null; // active null → no boxes at all
    return (
      <div ref={areaRef} className="absolute inset-0">
        {parts
          .filter((p) => p.kind !== 'null' && p.bbox)
          .map((p) => (
            <div
              key={p.id}
              className="absolute cursor-pointer"
              style={{
                left: `${p.bbox!.x}%`,
                top: `${p.bbox!.y}%`,
                width: `${p.bbox!.w}%`,
                height: `${p.bbox!.h}%`,
                border: `2px dashed ${BOX_COLOR}`,
                opacity: 0.45,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectPart(p.id);
              }}
            />
          ))}
      </div>
    );
  }

  // ── Active normal part → single bright box + asset overlay ─────────────────────
  if (!activeIsBox || !active.bbox) return null;
  const box = active.bbox;
  const version = selectedVersionOf(active);
  // Once cropped, the box is locked: border + name badge only (no drag/resize/aspect). Re-cropping
  // uses a fresh part, so the frozen bboxAtCrop stays authoritative for the build.
  const editable = interactive && !version;

  return (
    <div
      ref={areaRef}
      className="absolute inset-0 select-none leading-none"
      // Click on the empty area (not the box) → deselect. `target === currentTarget` means the
      // click landed on the area itself, not the box or its children.
      onClick={onDeselect ? (e) => e.target === e.currentTarget && onDeselect() : undefined}
    >
      {/* Sub-part source context: the parent part's asset rendered bright at its rect (over the
       *  dimmed original) + dashed boundary — the user positions the child box ON the actual crop
       *  source, and SEES that the crop cuts from the parent, not the original. */}
      {active.source && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: `${active.source.rect.x}%`,
            top: `${active.source.rect.y}%`,
            width: `${active.source.rect.w}%`,
            height: `${active.source.rect.h}%`,
          }}
        >
          <img
            src={active.source.url}
            alt="Nguồn crop"
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: 'fill' }}
          />
          <div
            className="absolute inset-0"
            style={{ border: `1px dashed ${ACCENT}`, opacity: 0.7 }}
          />
        </div>
      )}

      <div
        className="absolute"
        style={{
          left: `${box.x}%`,
          top: `${box.y}%`,
          width: `${box.w}%`,
          height: `${box.h}%`,
          // On the Parts tab the box always captures pointer events so clicking it never deselects
          // (only a locked box drops the move cursor). Pivot tab keeps it click-through.
          pointerEvents: interactive ? 'auto' : 'none',
          cursor: editable ? 'move' : 'default',
        }}
        onMouseDown={editable ? (e) => beginPointer(e, box, active.aspect, 'drag') : undefined}
      >
        {/* Asset overlay (selected version rendered at bbox) */}
        {version && (
          <img
            src={version.media_url}
            alt={active.name}
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{ objectFit: 'fill' }}
          />
        )}

        {/* Border */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            border: `2px solid ${BOX_COLOR}`,
            boxShadow: `0 0 0 1px ${ACCENT}, 0 0 10px ${ACCENT}66`,
          }}
        />

        {/* Toolbar: name tag always (Parts + Pivot), aspect Select only while editable. A
         *  cropped/locked or read-only box keeps the badge but drops the aspect control. */}
        <div
          className={`pointer-events-none absolute flex items-center gap-2 ${
            editable ? 'justify-between' : 'justify-end'
          }`}
          style={{ top: -30, left: 0, right: 0, zIndex: 30 }}
        >
          {editable && (
              <div
                className="pointer-events-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <Select
                  value={active.aspect}
                  onValueChange={(v) => handleAspectChange(active.id, v, box)}
                >
                  <SelectTrigger
                    className="h-6 min-w-0 w-auto gap-1 rounded-md border-white bg-[var(--swap-modal-bg)] px-2 text-[11px] text-[var(--swap-modal-text-primary)]"
                    aria-label="Aspect ratio"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={SELECT_CONTENT_STYLE}>
                    {PART_ASPECT_RATIOS.map((r) => (
                      <SelectItem key={r} value={r} className="text-xs">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          <span
            className="whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-sm"
            style={{ background: ACCENT }}
          >
            {active.name}
          </span>
        </div>

        {/* Corner handles (editable only) */}
        {editable &&
          CORNERS.map((corner) => (
            <div
              key={corner}
              className="absolute"
              style={{
                ...CORNER_STYLE[corner],
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: 'white',
                border: `2px solid ${ACCENT}`,
                zIndex: 25,
              }}
              onMouseDown={(e) => beginPointer(e, box, active.aspect, 'resize', corner)}
            />
          ))}
      </div>
    </div>
  );
}
