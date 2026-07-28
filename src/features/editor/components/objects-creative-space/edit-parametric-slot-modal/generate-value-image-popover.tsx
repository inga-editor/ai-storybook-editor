// generate-value-image-popover.tsx — The `[+]` generate popover of the VERSIONS panel
// (01-visuals-tab.md §4.2). Mirrors `EditImagePopover` but is NOT reused from it: this one has a
// read-only "Ảnh gốc" header line and no mandatory prompt (the main instruction is server-side).
//
// ⚠ Two Radix gotchas, both handled here, both regressions if undone:
//  1. PORTALING — both this popover and the nested `[📎]` picker render in a Radix Portal attached
//     to <body>, i.e. OUTSIDE the modal's DialogContent. So each content must (a) re-spread
//     SWAP_MODAL_TOKENS or every `var(--swap-modal-*)` resolves to nothing, (b) carry an OPAQUE
//     background (a floating portal has no backdrop) and (c) sit at z ≥ Z_INDEX.selectDropdown to
//     paint above the z-4000 full-screen modal. `PARAMETRIC_PORTAL_MENU_STYLE` does all three.
//     The shell additionally lists `[data-radix-popper-content-wrapper]` in its ILS
//     `dropdownSelectors`, which covers BOTH layers — without it, picking inside the nested
//     picker is routed as a click-outside and closes the parent (memory
//     radix_dropdown_modal_clickoutside).
//  2. HIDDEN FILE INPUTS live OUTSIDE this component entirely (VERSIONS panel body). Closing the
//     popover unmounts its subtree and CANCELS an in-flight native file dialog — the same contract
//     EditImagePopover documents. This component only fires `onAttachClick`.

import { Paperclip, Send, Upload, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { createLogger } from '@/utils/logger';
import type {
  PickedReferenceImage,
  ReferenceImageCandidate,
} from '@/features/editor/components/shared-components/edit-image-modal/edit-image-modal-utils';
import type { InpaintProvenanceStatus } from '@/features/editor/components/shared-components/edit-image-modal/use-inpaint-provenance';
import { PARAMETRIC_PORTAL_MENU_STYLE } from './parametric-slot-modal-constants';
import { PARAMETRIC_PROMPT_MAX, PARAMETRIC_REF_MAX } from './parametric-generate-utils';

const log = createLogger('Editor', 'GenerateValueImagePopover');

const MUTED_LINE_CLASS = 'px-1 text-[11px] leading-snug text-[var(--swap-modal-text-muted)]';
const ICON_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] disabled:cursor-not-allowed disabled:opacity-40';

const PROVENANCE_STATUS_TEXT: Record<InpaintProvenanceStatus, string> = {
  idle: 'Ảnh gốc không có dữ liệu lần sinh trước',
  loading: 'Đang tải…',
  ready: '',
  empty: 'Lần sinh trước không có ảnh tham khảo',
  error: 'Không tải được refs',
};

export interface GenerateValueImagePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Trigger button — owned by the VERSIONS header so its disabled state/tooltip live there. */
  trigger: React.ReactNode;

  // ── Source (read-only, §4.1) ──
  sourceThumbUrl: string;
  sourceValue: string;
  /** The source came from the DEFAULT value ⇒ badge. */
  sourceIsDefault: boolean;

  // ── References ──
  referenceImages: PickedReferenceImage[];
  onRemoveReference: (index: number) => void;
  /** Opens the native file dialog — the hidden <input> lives OUTSIDE this component (see header). */
  onAttachClick: () => void;
  provenanceStatus: InpaintProvenanceStatus;
  candidates: ReferenceImageCandidate[];
  aiRequestId: string | null;
  onPickCandidate: (candidate: ReferenceImageCandidate) => void;

  // ── Prompt / submit ──
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  /** false ⇒ [➤] disabled (no source image or a run is already in flight). */
  canSubmit: boolean;
}

export function GenerateValueImagePopover({
  open,
  onOpenChange,
  trigger,
  sourceThumbUrl,
  sourceValue,
  sourceIsDefault,
  referenceImages,
  onRemoveReference,
  onAttachClick,
  provenanceStatus,
  candidates,
  aiRequestId,
  onPickCandidate,
  prompt,
  onPromptChange,
  onSubmit,
  canSubmit,
}: GenerateValueImagePopoverProps) {
  const capped = referenceImages.length >= PARAMETRIC_REF_MAX;
  const statusText = PROVENANCE_STATUS_TEXT[provenanceStatus];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        style={PARAMETRIC_PORTAL_MENU_STYLE}
        className="w-80 border-[var(--swap-modal-border-strong)] p-3 text-[var(--swap-modal-text-primary)]"
      >
        {/* Ảnh gốc — read-only (§4.1 chốt 2026-07-28: auto chain, no picker). */}
        <div className="mb-2 flex items-center gap-2 rounded-md bg-[var(--swap-modal-surface-hover)] p-1.5">
          {/* Conditional: `<img src="">` makes some browsers re-request the PAGE url. */}
          {sourceThumbUrl.length > 0 && (
            <img
              src={sourceThumbUrl}
              alt="Ảnh gốc"
              className="h-8 w-8 shrink-0 rounded object-cover"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--swap-modal-text-secondary)]">
            Ảnh gốc: «{sourceValue}»
          </span>
          {sourceIsDefault && (
            <span className="shrink-0 rounded bg-[var(--swap-modal-accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              Default
            </span>
          )}
        </div>

        {/* Ref chips + counter */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {referenceImages.map((img, idx) => (
            <span
              key={img.id ?? `${img.label}-${idx}`}
              className="flex items-center gap-1 rounded-md bg-[var(--swap-modal-accent-soft)] px-2 py-1 text-xs text-[var(--swap-modal-text-secondary)]"
            >
              <span className="max-w-[120px] truncate">{img.label}</span>
              <button
                type="button"
                onClick={() => onRemoveReference(idx)}
                aria-label={`Bỏ ảnh tham khảo ${img.label}`}
                className="rounded hover:text-[var(--swap-modal-text-primary)]"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          <span className="ml-auto tabular-nums text-[11px] text-[var(--swap-modal-text-muted)]">
            ({referenceImages.length}/{PARAMETRIC_REF_MAX})
          </span>
        </div>

        <div className="flex gap-2">
          <Textarea
            value={prompt}
            maxLength={PARAMETRIC_PROMPT_MAX}
            onChange={(e) => onPromptChange(e.target.value)}
            placeholder="Chỉ dẫn thêm (tuỳ chọn)…"
            aria-label="Chỉ dẫn thêm"
            className="min-h-[60px] flex-1 resize-none border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-sm text-[var(--swap-modal-text-primary)] placeholder:text-[var(--swap-modal-text-muted)]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (canSubmit) onSubmit();
              }
            }}
          />
          <div className="flex shrink-0 flex-col gap-1.5">
            {/* Nested picker — Upload from device + the refs of the source image's own AI call. */}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={ICON_BUTTON_CLASS}
                  disabled={capped}
                  aria-label="Đính kèm ảnh tham khảo"
                  title={capped ? `Tối đa ${PARAMETRIC_REF_MAX} ảnh tham khảo` : 'Đính kèm ảnh'}
                >
                  <Paperclip className="h-4 w-4" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                style={PARAMETRIC_PORTAL_MENU_STYLE}
                className="w-64 border-[var(--swap-modal-border-strong)] p-2 text-[var(--swap-modal-text-primary)]"
              >
                {/* ALWAYS present — the upload path never depends on the provenance lookup. */}
                <button
                  type="button"
                  onClick={() => {
                    log.debug('onAttachClick', 'open file dialog');
                    onAttachClick();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-[var(--swap-modal-surface-hover)]"
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  <span>Upload from device</span>
                </button>

                <div className="my-2 border-t border-[var(--swap-modal-border)]" />
                <p className="mb-1 px-1 text-[11px] uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
                  Ảnh tham khảo lần sinh trước
                </p>

                {provenanceStatus === 'ready' ? (
                  <div className="grid max-h-48 grid-cols-3 gap-2 overflow-y-auto px-1 pb-1">
                    {candidates.map((candidate) => {
                      const picked = referenceImages.some(
                        (im) => im.id === `prov:${aiRequestId}:${candidate.index}`,
                      );
                      const disabled = picked || capped;
                      return (
                        <button
                          key={`${aiRequestId}:${candidate.index}`}
                          type="button"
                          disabled={disabled}
                          aria-disabled={disabled}
                          title={`Ảnh #${candidate.index}`}
                          onClick={() => {
                            log.debug('onPickCandidate', 'pick provenance ref', {
                              index: candidate.index,
                            });
                            onPickCandidate(candidate);
                          }}
                          className="relative aspect-square overflow-hidden rounded-md border border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <img
                            src={candidate.url}
                            alt={`Ảnh #${candidate.index}`}
                            className="h-full w-full object-cover"
                            // A purged blob must leave the neutral tile, not a broken-image glyph.
                            onLoad={(e) => {
                              e.currentTarget.style.visibility = '';
                            }}
                            onError={(e) => {
                              e.currentTarget.style.visibility = 'hidden';
                            }}
                          />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className={MUTED_LINE_CLASS}>{statusText}</p>
                )}
              </PopoverContent>
            </Popover>

            <button
              type="button"
              className={ICON_BUTTON_CLASS}
              disabled={!canSubmit}
              aria-label="Sinh ảnh"
              title="Sinh ảnh (Enter)"
              onClick={onSubmit}
            >
              <Send className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
