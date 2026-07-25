// inpaint-reference-picker.tsx — Presentational reference-image picker for the Inpaint tab
// (design 04-inpaint-tab.md §1 / §8.2 / §8.5). ONE unified list (cap = `max`) fed by two sources:
//   • Upload from device       → `onOpenUpload` (the hidden <input> lives here, wired to `onFilesSelected`)
//   • Refs of the previous gen → `onPick(candidate)` over the provenance grid (§8.3)
//
// ⚡2026-07-25 REDESIGN: the grid source moved from "parent-resolved prop variants" (synchronous
// store read) to "the reference images of the AI call that PRODUCED the selected version", which is
// ASYNCHRONOUS. So the popover now renders FIVE states (idle / loading / ready / empty / error —
// §8.2) instead of silently hiding the grid, and "⬆ Upload from device" renders in ALL of them: the
// feature never dies because a lookup failed (memory: feedback_never_hide_disabled_ui).
//
// Pure presentation — NO store, no state beyond the local Popover `open` flag; `useInpaintTabState`
// owns every value + handler. Split into its own file to keep inpaint-tab.tsx under the 500-loc cap.
//
// ⚠️ Logging exception (docs/logging-convention.md §2 asks for a `debug` line per switch branch):
// `renderProvenanceSection()` runs on EVERY render, so a log there would spam once per pointer-move
// while the brush is dragged. Every provenance transition is already logged at the data layer by
// `use-inpaint-provenance` (start / done / cache hit / lookup failed). Do NOT "fix" this by adding
// render-time logs — the only compliant way would be an effect, which breaks the React 19 rule this
// component is deliberately built around. `debug` is logged in the three event handlers instead.

import { useState } from 'react';
import { Plus, X, Check, Upload, AlertTriangle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { createLogger } from '@/utils/logger';
import { Z_INDEX, SWAP_MODAL_TOKENS } from './edit-image-modal-constants';
import type { PickedReferenceImage, ReferenceImageCandidate } from './edit-image-modal-utils';
import type { InpaintProvenanceSource, InpaintProvenanceStatus } from './use-inpaint-provenance';

const log = createLogger('Editor', 'InpaintReferencePicker');

// PopoverContent renders in a Radix Portal (attached to <body>) — OUTSIDE the DialogContent subtree
// that defines the `--swap-modal-*` CSS vars. So we must (a) redeclare SWAP_MODAL_TOKENS on the
// portaled content itself or every `var(--swap-modal-*)` inside resolves to nothing (transparent bg
// + dark text), and (b) set the z so it paints above the full-screen modal (z 4000). The panel bg
// uses the OPAQUE card token (`--swap-modal-surface` is near-transparent — fine layered over the
// modal, but a floating portal has no backdrop behind it).
const POPOVER_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';
const TILE_CLASS =
  'flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-muted)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] disabled:cursor-not-allowed disabled:opacity-40';
const GRID_CLASS = 'grid max-h-48 grid-cols-3 gap-2 overflow-y-auto px-1 pb-1';
const MUTED_LINE_CLASS = 'px-2 text-[11px] leading-snug text-[var(--swap-modal-text-muted)]';

/** §3 — the ONLY provenance messages the user ever sees; the raw backend message is never echoed. */
const PROVENANCE_ERROR_MESSAGE: Record<string, string> = {
  NOT_FOUND: 'Không có dữ liệu lần sinh trước',
  FORBIDDEN: 'Bạn không có quyền xem refs của ảnh này',
  // Editor sessions outlive the access token, so an expired JWT is the 3rd-likeliest failure here.
  // Say what actually unblocks it — [Thử lại] re-sends the SAME dead token and can never succeed.
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn — tải lại trang để xem refs',
};
const PROVENANCE_ERROR_FALLBACK = 'Không tải được refs';
/** Fallback path when the failure carried NO envelope code (a bare 401 `{detail:…}`, an HTML 502, a
 *  network abort). The hook then stores `errorCode = String(httpStatus)`, which misses the table
 *  above — so map by raw status instead of dropping straight to the generic line. */
const HTTP_STATUS_TO_ERROR_CODE: Record<number, string> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
};

/** Caption stand-in when the log row has no `operation` (the column is NULLABLE server-side even
 *  though the API types it as a plain string) — never render the literal "null"/"". */
const SOURCE_OPERATION_FALLBACK = 'Lần sinh trước';

const STATUS_EMPTY_TEXT = 'Lần sinh trước không có ảnh tham khảo';
const STATUS_IDLE_TEXT = 'Ảnh này không có dữ liệu nguồn';
const STATUS_LOADING_TEXT = 'Đang tải…';

function provenanceErrorMessage(errorCode?: string, httpStatus?: number): string {
  const byCode = errorCode ? PROVENANCE_ERROR_MESSAGE[errorCode] : undefined;
  if (byCode) return byCode;
  const mappedCode = httpStatus === undefined ? undefined : HTTP_STATUS_TO_ERROR_CODE[httpStatus];
  return (mappedCode && PROVENANCE_ERROR_MESSAGE[mappedCode]) || PROVENANCE_ERROR_FALLBACK;
}

/** ISO-8601 → `dd/MM` (mock §1). Defensive: `createdAt` can arrive empty/garbage, and a caption of
 *  "Invalid Date" is worse than no date at all. */
function formatSourceDate(iso: string): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

/** `{operation} · {dd/MM}` — either half may be missing (nullable columns), so degrade gracefully. */
function formatSourceCaption(source: InpaintProvenanceSource): string {
  const operation = source.operation?.trim() || SOURCE_OPERATION_FALLBACK;
  const date = formatSourceDate(source.createdAt);
  return date ? `${operation} · ${date}` : operation;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Tooltip: the client-side positional label + whatever metadata the ref actually carries (§8.5 —
 *  `ref_files[]` has no role/label, and mimeType/bytes are both optional). */
function candidateTitle(candidate: ReferenceImageCandidate): string {
  const parts = [`Ảnh #${candidate.index}`];
  if (candidate.mimeType) parts.push(candidate.mimeType);
  if (typeof candidate.bytes === 'number' && candidate.bytes > 0) parts.push(formatBytes(candidate.bytes));
  return parts.join(' · ');
}

export interface InpaintReferencePickerProps {
  /** Current picked list (upload + provenance, GỘP). */
  images: PickedReferenceImage[];
  /** Combined cap (INPAINT_REF_MAX). */
  max: number;
  /** Hidden <input type=file> ref owned by the picker hook. */
  fileInputRef: React.Ref<HTMLInputElement>;
  /** Open the native file dialog (refs.openPicker). */
  onOpenUpload: () => void;
  /** Hidden input change handler (refs.handleFilesSelected). */
  onFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Remove one picked item by index (refs.removeImage). */
  onRemove: (index: number) => void;
  // ── Provenance (§8.3) — the async grid source, replacing the old bare `candidates` prop ──
  /** Drives which of the 5 popover bodies renders (§8.2). */
  provenanceStatus: InpaintProvenanceStatus;
  /** Refs of the previous generate; `[]` in every non-`ready` state. */
  candidates: ReferenceImageCandidate[];
  /** Resolved id — the `prov:{aiRequestId}:{index}` dedupe key is built from it. */
  aiRequestId: string | null;
  /** true ⇒ the id came from an ANCESTOR version → caption line "(từ bản gốc)". */
  resolvedFromAncestor: boolean;
  /** Caption metadata of the original call (absent while loading / on error / when idle). */
  source?: InpaintProvenanceSource;
  /** Normalized failure code ('NOT_FOUND' / 'FORBIDDEN' / 'UNEXPECTED' / a stringified status). */
  errorCode?: string;
  /** Raw http status of the failure (0 = network) — the reliable 404/403 signal when no code came. */
  httpStatus?: number;
  /** Convert-on-add a picked provenance ref (fetch URL → base64 → append). */
  onPick: (c: ReferenceImageCandidate) => void;
  /** Re-run the lookup for the current id, bypassing the cache ([Thử lại]). */
  onRetry: () => void;
}

export function InpaintReferencePicker({
  images,
  max,
  fileInputRef,
  onOpenUpload,
  onFilesSelected,
  onRemove,
  provenanceStatus,
  candidates,
  aiRequestId,
  resolvedFromAncestor,
  source,
  errorCode,
  httpStatus,
  onPick,
  onRetry,
}: InpaintReferencePickerProps) {
  const [open, setOpen] = useState(false);
  const capped = images.length >= max;

  const handleUploadClick = () => {
    log.debug('handleUploadClick', 'open file dialog');
    setOpen(false); // the native file dialog takes over — a popover left open would hang behind it
    onOpenUpload();
  };

  // The popover deliberately stays OPEN after a pick: picking is the multi-select gesture here, and
  // the tile's disabled + ✓ acknowledgement (§8.2) is only observable while the grid is on screen.
  const handlePick = (candidate: ReferenceImageCandidate) => {
    log.debug('handlePick', 'pick provenance candidate', { index: candidate.index });
    onPick(candidate);
  };

  const handleRetry = () => {
    log.debug('handleRetry', 'retry provenance lookup', { aiRequestId });
    onRetry();
  };

  /** The whole "refs of the previous generate" block: section header → caption/badge lines → one of
   *  the 5 status bodies (§8.2). Rendered AFTER (and independently of) the Upload row, which is why
   *  Upload survives every state. */
  const renderProvenanceSection = () => {
    let body: React.ReactNode;
    switch (provenanceStatus) {
      case 'loading':
        body = (
          <>
            <div className={GRID_CLASS} aria-hidden>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="aspect-square animate-pulse rounded-md bg-[var(--swap-modal-surface-hover-strong)]"
                />
              ))}
            </div>
            <p className={`mt-1 ${MUTED_LINE_CLASS}`}>{STATUS_LOADING_TEXT}</p>
          </>
        );
        break;

      case 'ready':
        body = (
          <div className={GRID_CLASS}>
            {candidates.map((candidate) => {
              const picked = images.some((im) => im.id === `prov:${aiRequestId}:${candidate.index}`);
              const disabled = picked || capped;
              return (
                <button
                  // Key carries the SOURCE CALL identity, not just the ordinal: switching to a
                  // version with a different `aiRequestId` must REMOUNT the tile. Reusing one node
                  // across calls would (a) keep the imperative `visibility` below stuck from a
                  // previous broken ref and (b) collide when the BE hands back a duplicate `index`
                  // (the API documents it as best-effort — dedupe/cap can shift it).
                  key={`${aiRequestId}:${candidate.index}`}
                  type="button"
                  disabled={disabled}
                  aria-disabled={disabled}
                  title={candidateTitle(candidate)}
                  onClick={() => !disabled && handlePick(candidate)}
                  className="relative aspect-square overflow-hidden rounded-md border border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface-hover)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <img
                    src={candidate.url}
                    alt={`Ảnh #${candidate.index}`}
                    className="h-full w-full object-cover"
                    // A purged/expired blob must leave the neutral tile bg, not a broken-image glyph.
                    // The pair is deliberate and self-healing: `onLoad` CLEARS the hide, so a later
                    // successful load on this node (a [Thử lại] refetch of the same id) becomes
                    // visible again. Imperative rather than state because the picker must stay
                    // presentational — React would otherwise never diff an inline `style` back.
                    onLoad={(e) => {
                      e.currentTarget.style.visibility = '';
                    }}
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                  <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">
                    #{candidate.index}
                  </span>
                  {picked && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Check className="h-4 w-4 text-white" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        );
        break;

      case 'empty':
        body = <p className={MUTED_LINE_CLASS}>{STATUS_EMPTY_TEXT}</p>;
        break;

      case 'error':
        body = (
          <div className="px-2">
            <p className="text-[11px] leading-snug text-[var(--swap-modal-text-muted)]">
              {provenanceErrorMessage(errorCode, httpStatus)}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-1 text-[11px] font-semibold text-[var(--swap-modal-accent)] underline-offset-2 hover:underline"
            >
              Thử lại
            </button>
          </div>
        );
        break;

      case 'idle':
      default:
        body = <p className={MUTED_LINE_CLASS}>{STATUS_IDLE_TEXT}</p>;
        break;
    }

    // `skippedCount` only exists once a response landed (ready/empty). Surfacing it matters: the BE
    // drops `ref_files[]` entries that never got a `url`, so a short grid would otherwise read as
    // data loss (§8.2 F9). It never blocks picking and never toasts.
    const showSkipped =
      !!source && source.skippedCount > 0 && (provenanceStatus === 'ready' || provenanceStatus === 'empty');

    // Suppress a caption that degraded to the bare fallback (no operation AND no usable date) — it
    // would just echo the section header one line above it.
    const caption = source ? formatSourceCaption(source) : '';
    const showCaption = !!caption && caption !== SOURCE_OPERATION_FALLBACK;

    return (
      <>
        <div className="my-2 border-t border-[var(--swap-modal-border)]" />
        <p className="mb-1 px-2 text-[11px] uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
          Ảnh tham khảo lần sinh trước
        </p>
        {showCaption && (
          <p className="mb-1 truncate px-2 text-[11px] text-[var(--swap-modal-text-secondary)]">
            {caption}
          </p>
        )}
        {resolvedFromAncestor && <p className={`mb-1 ${MUTED_LINE_CLASS}`}>(từ bản gốc)</p>}
        {showSkipped && (
          <p className={`mb-1 ${MUTED_LINE_CLASS}`}>({source.skippedCount} ảnh không tải được)</p>
        )}
        {/* The ORIGINAL call failed — its inputs are still perfectly valid images, so this is a note,
            never a gate: every ref below stays pickable (§8.2). */}
        {source?.status === 'error' && (
          <p className="mb-1 flex items-center gap-1 px-2 text-[11px] text-[var(--swap-modal-text-secondary)]">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>Lần sinh này đã lỗi</span>
          </p>
        )}
        {body}
      </>
    );
  };

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
            {/* ALWAYS first + ALWAYS present — the upload path is independent of the lookup (§8.2). */}
            <button
              type="button"
              onClick={handleUploadClick}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-[var(--swap-modal-surface-hover)]"
            >
              <Upload className="h-4 w-4" />
              <span>Upload from device</span>
            </button>

            {renderProvenanceSection()}
          </PopoverContent>
        </Popover>
      </div>

      {/* Hidden file input owned by the picker hook (multiple, whitelist accept). */}
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
