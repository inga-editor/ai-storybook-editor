// parametric-visuals-canvas.tsx — CENTER canvas of the Visuals tab (01-visuals-tab.md §3.1).
// Four mutually exclusive bodies (image / empty / runtime-only / no rows) + the dangling banner
// + the busy overlay. Presentational: every value comes from `useVisualsTab`.
//
// ⚡ Zoom is applied as REAL CSS width/height on the <img>, never `transform: scale` — CSS width
// participates in layout, so the parent's `overflow-auto` exposes the full scroll range
// (memory zoom_via_css_width_not_transform; reference generate-canvas.tsx / edit-image-modal-canvas).
// The fit step reuses `fitNaturalToFrame` via `useStageFitSize` (`Math.min(ratio, 1)` — no upscale;
// the zoom slider stays the only way to enlarge). Sidebar widths of this modal are the SAME
// constants the edit-image-modal chrome math uses, so the shared helper measures correctly.

import { ImageOff, Loader2, Plus, TriangleAlert, Upload, UserRound } from 'lucide-react';
import type { Illustration } from '@/types/prop-types';
import {
  useImageNaturalSize,
  useStageFitSize,
} from '@/features/editor/components/shared-components/edit-image-modal/edit-image-modal-fit';
import {
  PARAMETRIC_DISABLE_TOOLTIP,
  type ParametricDisableReason,
} from './parametric-slot-modal-constants';

const SHORTCUT_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] px-3 py-1.5 text-sm text-[var(--swap-modal-text-primary)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] disabled:cursor-not-allowed disabled:opacity-40';

export interface ParametricVisualsCanvasProps {
  selectedValue: string;
  selectedVer: Illustration | null;
  zoom: number;
  isDangling: boolean;
  isRuntimeOnly: boolean;
  /** No row at all (axis dropped from the book config) — nothing to show or create. */
  hasRows: boolean;
  busyLabel: string | null;
  uploadDisabledReason: ParametricDisableReason | null;
  generateDisabledReason: ParametricDisableReason | null;
  onUploadClick: () => void;
  onGenerateClick: () => void;
}

export function ParametricVisualsCanvas({
  selectedValue,
  selectedVer,
  zoom,
  isDangling,
  isRuntimeOnly,
  hasRows,
  busyLabel,
  uploadDisabledReason,
  generateDisabledReason,
  onUploadClick,
  onGenerateClick,
}: ParametricVisualsCanvasProps) {
  const mediaUrl = selectedVer?.media_url;
  const naturalSize = useImageNaturalSize(mediaUrl);
  const fitSize = useStageFitSize(naturalSize?.w ?? 0, naturalSize?.h ?? 0);

  const renderBody = () => {
    if (!hasRows) {
      return (
        <div className="m-auto flex flex-col items-center gap-2 text-center">
          <TriangleAlert className="h-8 w-8 text-amber-400" aria-hidden="true" />
          <p className="text-sm text-[var(--swap-modal-text-secondary)]">
            Axis không còn giá trị nào trong config.
          </p>
        </div>
      );
    }

    if (isRuntimeOnly) {
      return (
        <div className="m-auto flex max-w-sm flex-col items-center gap-2 text-center">
          <UserRound className="h-8 w-8 text-[var(--swap-modal-text-muted)]" aria-hidden="true" />
          <p className="text-sm text-[var(--swap-modal-text-secondary)]">
            Ảnh do người đọc cung cấp khi đọc truyện — không sinh trước.
          </p>
        </div>
      );
    }

    if (mediaUrl) {
      // Pre-measure frame (natural size unknown for one frame): render with CSS max so the image
      // appears immediately instead of flashing an empty canvas.
      if (!fitSize) {
        return (
          <img
            key={mediaUrl}
            src={mediaUrl}
            alt={`Ảnh của giá trị ${selectedValue}`}
            className="m-auto block object-contain"
            style={{ maxHeight: '78vh', maxWidth: '100%' }}
          />
        );
      }
      const scaledW = Math.round((fitSize.w * zoom) / 100);
      const scaledH = Math.round((fitSize.h * zoom) / 100);
      return (
        <img
          key={mediaUrl}
          src={mediaUrl}
          alt={`Ảnh của giá trị ${selectedValue}`}
          className="m-auto block object-contain"
          style={{ width: scaledW, height: scaledH, maxWidth: 'none' }}
        />
      );
    }

    return (
      <div className="m-auto flex flex-col items-center gap-3 text-center">
        <ImageOff className="h-8 w-8 text-[var(--swap-modal-text-muted)]" aria-hidden="true" />
        <p className="text-sm text-[var(--swap-modal-text-secondary)]">
          Chưa có ảnh cho giá trị «{selectedValue}»
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={SHORTCUT_BUTTON_CLASS}
            disabled={uploadDisabledReason !== null}
            aria-disabled={uploadDisabledReason !== null}
            title={
              uploadDisabledReason ? PARAMETRIC_DISABLE_TOOLTIP[uploadDisabledReason] : 'Upload ảnh'
            }
            onClick={onUploadClick}
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload
          </button>
          <button
            type="button"
            className={SHORTCUT_BUTTON_CLASS}
            disabled={generateDisabledReason !== null}
            aria-disabled={generateDisabledReason !== null}
            title={
              generateDisabledReason
                ? PARAMETRIC_DISABLE_TOOLTIP[generateDisabledReason]
                : 'Sinh ảnh cho giá trị này'
            }
            onClick={onGenerateClick}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Generate
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* The image still renders behind it — a dangling value stays readable/deletable (§3.1). */}
      {isDangling && hasRows && (
        <p className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-200">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Giá trị không còn trong config
        </p>
      )}

      {renderBody()}

      {busyLabel !== null && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/60"
        >
          <Loader2 className="h-8 w-8 animate-spin text-white" aria-hidden="true" />
          <p className="text-sm text-white">{busyLabel}</p>
        </div>
      )}
    </>
  );
}
