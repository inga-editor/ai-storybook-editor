// parametric-stage-column.tsx — CENTER column of EditParametricSlotModal (design §2.4):
// stage header (read-only CONTROL KEY chip + shared ZoomControl), the optional
// "default value has no image" inline warning (§4.3), and the checkerboard canvas frame.
// The canvas CONTENT itself belongs to the active tab and arrives as `children`.

import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { ZoomControl } from '@/features/editor/components/shared-components/zoom-control';
import {
  CANVAS_CHECKERBOARD_STYLE,
  HEADER_HEIGHT_PX,
  ZOOM,
} from './parametric-slot-modal-constants';

export interface ParametricStageColumnProps {
  /** Result of `formatControlKey` — `isDangling` = the character behind the key is gone. */
  controlKey: { label: string; isDangling: boolean };
  zoom: number;
  onZoomChange: (next: number) => void;
  /** Non-null ⇒ that default value currently has zero images → inline warning (§4.3). */
  defaultValueWithoutImages: string | null;
  children: ReactNode;
}

export function ParametricStageColumn({
  controlKey,
  zoom,
  onZoomChange,
  defaultValueWithoutImages,
  children,
}: ParametricStageColumnProps) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-3 border-b border-[var(--swap-modal-border)] px-4"
        style={{ height: HEADER_HEIGHT_PX }}
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
          Control key
        </span>
        <span className="flex items-center gap-1 rounded-md bg-[var(--swap-modal-surface-hover)] px-2 py-1 text-sm text-[var(--swap-modal-text-primary)]">
          {controlKey.isDangling && (
            <TriangleAlert
              className="h-3.5 w-3.5 text-amber-400"
              aria-label="Nhân vật không còn trong snapshot"
            />
          )}
          {controlKey.label}
        </span>
        <div className="flex-1" />
        <ZoomControl
          value={zoom}
          onChange={onZoomChange}
          min={ZOOM.min}
          max={ZOOM.max}
          step={ZOOM.step}
        />
      </div>

      {/* Clearing every image of the DEFAULT value is allowed; the player then falls back to
          the item's plain media — warn inline instead of blocking the action (§4.3). */}
      {defaultValueWithoutImages !== null && (
        <p className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
          Giá trị mặc định «{defaultValueWithoutImages}» chưa có ảnh — player sẽ fallback về ảnh
          gốc của item.
        </p>
      )}

      {/* `relative` anchors the tab's busy overlay / dangling banner; `flex` + the child's
          `m-auto` centres content that fits and collapses to 0 when it overflows (flex
          `items-center` would clip the start of an overflowing axis). Zoom grows the child's real
          CSS width, so `overflow-auto` here exposes the full scroll range. */}
      <div
        className="relative flex min-h-0 flex-1 overflow-auto p-6"
        style={CANVAS_CHECKERBOARD_STYLE}
      >
        {children}
      </div>
    </section>
  );
}
