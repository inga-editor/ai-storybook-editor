// lottie-reference-picker.tsx — Edit-tab reference-image picker panel (design 03-edit-tab.md §4).
// Adapts edit-image-modal's inpaint picker, but the grid source is SESSION-LOCAL (NO provenance API
// — parts have no ai_request_id): Upload / Ảnh gốc / other cropped parts' selected version. ONE list,
// cap INPAINT_REF_MAX, base64 convert-on-add. Presentational only — the `useLottieReferences` hook
// lives in edit-tab.ts (react-refresh: a file must export only components).

import { useState } from 'react';
import { Plus, X, Check, Upload } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { PickedReferenceImage } from '../edit-image-modal/edit-image-modal-utils';
import { SWAP_MODAL_TOKENS, Z_INDEX } from './extract-lottie-modal-constants';

const POPOVER_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';
const TILE_CLASS =
  'flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-muted)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] disabled:cursor-not-allowed disabled:opacity-40';

/** One session-local reference candidate (Ảnh gốc / another cropped part). */
export interface LottieRefSource {
  /** `src:original` | `part:<partId>` — the dedupe key. */
  id: string;
  label: string;
  url: string;
}

export interface LottieReferencePickerProps {
  images: PickedReferenceImage[];
  max: number;
  fileInputRef: React.Ref<HTMLInputElement>;
  onOpenUpload: () => void;
  onFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: (index: number) => void;
  /** Ảnh gốc + other cropped parts' selected version (active part excluded upstream). */
  sessionSources: LottieRefSource[];
  onPickSession: (source: LottieRefSource) => void;
}

export function LottieReferencePicker({
  images,
  max,
  fileInputRef,
  onOpenUpload,
  onFilesSelected,
  onRemove,
  sessionSources,
  onPickSession,
}: LottieReferencePickerProps) {
  const [open, setOpen] = useState(false);
  const capped = images.length >= max;

  return (
    <section>
      <p className={SECTION_LABEL_CLASS}>
        <span>Reference Images</span>
        <span className="normal-case tabular-nums text-[var(--swap-modal-text-secondary)]">
          {images.length}/{max}
        </span>
      </p>

      <div className="flex flex-wrap gap-2">
        {images.map((img, i) => (
          <div
            key={img.id ?? `${img.label}-${i}`}
            className="group relative h-16 w-16 overflow-hidden rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)]"
          >
            <img src={img.thumbUrl} alt={img.label} className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={`Remove reference ${img.label}`}
              className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={capped}
              aria-label="Add reference image"
              title={capped ? `Tối đa ${max} ảnh tham khảo` : 'Add reference image'}
              className={TILE_CLASS}
            >
              <Plus className="h-5 w-5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            style={POPOVER_CONTENT_STYLE}
            className="w-64 border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-card-bg)] p-2 text-[var(--swap-modal-text-primary)]"
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenUpload();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-[var(--swap-modal-surface-hover)]"
            >
              <Upload className="h-4 w-4" />
              <span>Upload from device</span>
            </button>

            {sessionSources.length > 0 && (
              <>
                <div className="my-2 border-t border-[var(--swap-modal-border)]" />
                <p className="mb-1 px-2 text-[11px] uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
                  Từ phiên làm việc
                </p>
                <div className="grid max-h-48 grid-cols-3 gap-2 overflow-y-auto px-1 pb-1">
                  {sessionSources.map((src) => {
                    const picked = images.some((im) => im.id === src.id);
                    const disabled = picked || capped;
                    return (
                      <button
                        key={src.id}
                        type="button"
                        disabled={disabled}
                        aria-disabled={disabled}
                        title={src.label}
                        onClick={() => !disabled && onPickSession(src)}
                        className="relative aspect-square overflow-hidden rounded-md border border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface-hover)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <img src={src.url} alt={src.label} className="h-full w-full object-cover" />
                        {picked && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                            <Check className="h-4 w-4 text-white" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={onFilesSelected}
      />
    </section>
  );
}
