// parametric-versions-panel.tsx — RIGHT sidebar of the Visuals tab (01-visuals-tab.md §3.2):
// title + counter, `[⬆]` upload, `[+]` generate popover, and the 2-col version grid with
// hover 🔍 (zoom) / ⋮ (Xoá version). ⛔ NO "Edit" entry — editing an image goes through the item
// toolbar → EditImageModal (chốt 2026-07-28: no nested modals).
//
// ⚡ Both hidden `<input type="file">` live HERE, in the panel body, deliberately OUTSIDE every
// PopoverContent: a popover closing unmounts its subtree and CANCELS the native file dialog the
// user just opened. Do not "tidy" them into the popover.
//
// Order = `illustrations[]` (newest-first via prependIllustration) — never re-sorted by
// `created_time`, which would diverge from the array the server persists.

import { MoreVertical, Plus, Search, Star, Upload } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ImageZoomDialog } from '@/components/ui/image-zoom-preview';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { Illustration } from '@/types/prop-types';
import { ParametricConfirmDialog } from './parametric-confirm-dialog';
import { GenerateValueImagePopover } from './generate-value-image-popover';
import {
  HEADER_HEIGHT_PX,
  PARAMETRIC_DISABLE_TOOLTIP,
  PARAMETRIC_PORTAL_MENU_STYLE,
} from './parametric-slot-modal-constants';
import { PARAMETRIC_UPLOAD_ACCEPT } from './parametric-generate-utils';
import type { VisualsTabController } from './use-visuals-tab';

const log = createLogger('Editor', 'ParametricVersionsPanel');

const HEADER_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] disabled:cursor-not-allowed disabled:opacity-40';

export interface ParametricVersionsPanelProps {
  selectedValue: string;
  defaultValue: string | null;
  versions: Illustration[];
  canEdit: boolean;
  controller: VisualsTabController;
  /** Which grid tile's ⋮ menu is open (lifted so only one opens at a time). */
  openMenuIdx: number | null;
  onOpenMenuIdxChange: (idx: number | null) => void;
}

export function ParametricVersionsPanel({
  selectedValue,
  defaultValue,
  versions,
  canEdit,
  controller,
  openMenuIdx,
  onOpenMenuIdxChange,
}: ParametricVersionsPanelProps) {
  const {
    source,
    isGenerating,
    uploadDisabledReason,
    generateDisabledReason,
    uploadInputRef,
    onUploadClick,
    onUploadFileSelected,
    popoverOpen,
    setPopoverOpen,
    prompt,
    setPrompt,
    refImages,
    refInputRef,
    onAttachClick,
    onRefFilesSelected,
    onRemoveReference,
    onPickProvenanceRef,
    provenance,
    onGenerate,
    zoomSrc,
    setZoomSrc,
    onSelectVersion,
    onRequestDeleteVersion,
    pendingDeleteIdx,
    cancelDeleteVersion,
    confirmDeleteVersion,
  } = controller;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b border-[var(--swap-modal-border)] px-4"
        style={{ height: HEADER_HEIGHT_PX }}
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
          Versions
          {versions.length > 0 && (
            <span className="ml-1 tabular-nums normal-case">({versions.length})</span>
          )}
        </span>
        <div className="flex-1" />

        <button
          type="button"
          className={HEADER_BUTTON_CLASS}
          disabled={uploadDisabledReason !== null}
          aria-disabled={uploadDisabledReason !== null}
          aria-label="Upload ảnh cho giá trị này"
          title={
            uploadDisabledReason
              ? PARAMETRIC_DISABLE_TOOLTIP[uploadDisabledReason]
              : 'Upload ảnh (PNG/JPEG/WebP ≤10MB)'
          }
          onClick={onUploadClick}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
        </button>

        <GenerateValueImagePopover
          open={popoverOpen}
          onOpenChange={setPopoverOpen}
          trigger={
            <button
              type="button"
              className={cn(
                HEADER_BUTTON_CLASS,
                'border-transparent bg-[var(--swap-modal-accent)] text-white hover:bg-[var(--swap-modal-accent-hover)]',
              )}
              disabled={generateDisabledReason !== null}
              aria-disabled={generateDisabledReason !== null}
              aria-busy={isGenerating}
              aria-label="Sinh ảnh cho giá trị này"
              title={
                generateDisabledReason
                  ? PARAMETRIC_DISABLE_TOOLTIP[generateDisabledReason]
                  : 'Sinh ảnh cho giá trị này'
              }
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          }
          sourceThumbUrl={source?.url ?? ''}
          sourceValue={source?.sourceValue ?? ''}
          sourceIsDefault={!!source && source.sourceValue === defaultValue}
          referenceImages={refImages}
          onRemoveReference={onRemoveReference}
          onAttachClick={onAttachClick}
          provenanceStatus={provenance.status}
          candidates={provenance.candidates}
          aiRequestId={provenance.aiRequestId}
          onPickCandidate={onPickProvenanceRef}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={onGenerate}
          canSubmit={generateDisabledReason === null}
        />
      </div>

      <div
        role="listbox"
        aria-label={`Versions của giá trị ${selectedValue}`}
        className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3"
      >
        {versions.length > 0 ? (
          versions.map((version, index) => (
            <div
              key={`${version.media_url}-${index}`}
              role="option"
              aria-selected={version.is_selected === true}
              className={cn(
                'group relative aspect-square overflow-hidden rounded-md bg-[var(--swap-modal-card-bg)] transition-all',
                version.is_selected
                  ? 'ring-2 ring-[var(--swap-modal-accent)]'
                  : 'ring-1 ring-[var(--swap-modal-border)] hover:ring-[var(--swap-modal-border-strong)]',
              )}
            >
              <button
                type="button"
                aria-label={`Chọn version ${index + 1}`}
                onClick={() => onSelectVersion(index)}
                className="absolute inset-0 h-full w-full"
              >
                <img
                  src={version.media_url}
                  alt={`Version ${index + 1}`}
                  // Full-resolution originals: the `age` axis reaches 101 values × n versions.
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-contain"
                />
              </button>

              {/* ★ is an INDICATOR, not a button — selection happens by clicking the tile. */}
              {version.is_selected && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-[var(--swap-modal-accent)] p-1"
                >
                  <Star className="h-3 w-3 fill-white text-white" />
                </span>
              )}

              <button
                type="button"
                aria-label={`Xem lớn version ${index + 1}`}
                onClick={() => {
                  log.debug('onZoom', 'open zoom preview', { index });
                  setZoomSrc(version.media_url);
                }}
                className="absolute right-8 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-[var(--swap-modal-accent)] focus:opacity-100 group-hover:opacity-100"
              >
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
              </button>

              <Popover
                open={openMenuIdx === index}
                onOpenChange={(next) => onOpenMenuIdxChange(next ? index : null)}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Thao tác version ${index + 1}`}
                    className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-[var(--swap-modal-surface-hover-strong)] focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreVertical className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  side="bottom"
                  style={PARAMETRIC_PORTAL_MENU_STYLE}
                  className="w-40 border-[var(--swap-modal-border)] p-1 text-[var(--swap-modal-text-primary)]"
                >
                  <button
                    type="button"
                    disabled={!canEdit}
                    className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-red-400 transition-colors hover:bg-[var(--swap-modal-surface-hover)] hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      log.debug('onDeleteVersion', 'menu action', { index });
                      onOpenMenuIdxChange(null);
                      onRequestDeleteVersion(index);
                    }}
                  >
                    Xoá version
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          ))
        ) : (
          <p className="col-span-2 px-2 py-8 text-center text-xs text-[var(--swap-modal-text-muted)]">
            Chưa có version — Upload hoặc [+] để sinh ảnh
          </p>
        )}
      </div>

      {/* ⚡ OUTSIDE every PopoverContent — see the file header. */}
      <input
        ref={uploadInputRef}
        type="file"
        accept={PARAMETRIC_UPLOAD_ACCEPT}
        className="hidden"
        onChange={onUploadFileSelected}
      />
      <input
        ref={refInputRef}
        type="file"
        accept={PARAMETRIC_UPLOAD_ACCEPT}
        multiple
        className="hidden"
        onChange={onRefFilesSelected}
      />

      <ImageZoomDialog
        open={zoomSrc !== null}
        onOpenChange={(next) => {
          if (!next) setZoomSrc(null);
        }}
        src={zoomSrc ?? ''}
        alt={`Version của giá trị ${selectedValue}`}
      />

      <ParametricConfirmDialog
        open={pendingDeleteIdx !== null}
        title="Xoá version cuối cùng?"
        description={`Giá trị «${selectedValue}» sẽ không còn ảnh nào. Giá trị vẫn được giữ lại trong danh sách.`}
        confirmLabel="Xoá version"
        onConfirm={confirmDeleteVersion}
        onCancel={cancelDeleteVersion}
      />
    </div>
  );
}
