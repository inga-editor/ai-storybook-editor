// import-batch-modal.tsx — Dialog over the swap modal that lists the PREVIOUS
// stage's finals as a thumbnail grid (grouped by source batch) so the user can
// build a new batch for the Remove BG / Upscale stage (design 05-14).
//
// Trigger: ONLY the stage-header `Import` button + the empty-state CTA
// (validation S1 — the sidebar `[+]` never opens this dialog). Copy-on-build:
// the parent's `importStageBatch` snapshots the picked finals; later finals
// changes never reconcile into the built batch.
//
// Layering: portals INTO the swap modal's `[role=dialog]` ancestor (same
// pattern as SwapConfigReviewModal) so the ILS click-outside router keeps
// treating clicks as "inside"; `onEscapeKeyDown` stops propagation so Esc
// closes THIS dialog only — never the swap modal behind it.
//
// SECURITY: thumbnails are PII likenesses — alt is EMPTY, URLs never logged;
// a11y labels derive from tags only.

import { useCallback, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Check, ImageOff } from 'lucide-react';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { ImportFinalEntry } from '@/stores/remix-store/stage-finals';
import { Z_INDEX } from './swap-modal-constants';

const log = createLogger('Editor', 'ImportBatchModal');

export interface ImportBatchModalProps {
  /** Finals of the source stage (`PREV_STAGE[stage]`) — the caller resolves
   *  these from the stage adapter and passes them in (reactive: realtime job
   *  completions add entries while the dialog is open; keys are stable). */
  finals: ImportFinalEntry[];
  /** Import TARGET stage; the listed finals come from `PREV_STAGE[stage]`. */
  stage: 'rmbgs' | 'upscales';
  /** Cancel / backdrop / Esc — closes THIS dialog only. */
  onClose: () => void;
  /** OK → parent calls `importStageBatch(remixId, stage, keys)`; the parent
   *  closes the dialog on success and keeps it open on error (toast). */
  onConfirm: (selectedKeys: ReadonlySet<string>) => void;
}

interface SourceBatchGroup {
  id: string;
  name: string;
  order: number;
  entries: ImportFinalEntry[];
}

/** a11y cell label from tags (no URLs — PII): "leela / casual" or 'crop'. */
function cellLabelOf(entry: ImportFinalEntry): string {
  const tag = entry.tags[0];
  if (!tag) return 'crop';
  return tag.variant_key ? `${tag.object_key} / ${tag.variant_key}` : tag.object_key;
}

export function ImportBatchModal({
  finals,
  stage,
  onClose,
  onConfirm,
}: ImportBatchModalProps) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  // Portal into the enclosing swap modal (see file header) — callback ref, no
  // useEffect+setState (React 19 lint).
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const markerRef = useCallback((el: HTMLSpanElement | null) => {
    setContainer(el ? (el.closest('[role="dialog"]') as HTMLElement | null) : null);
  }, []);

  const groups = useMemo<SourceBatchGroup[]>(() => {
    const byId = new Map<string, SourceBatchGroup>();
    for (const entry of finals) {
      let group = byId.get(entry.sourceBatch.id);
      if (!group) {
        group = {
          id: entry.sourceBatch.id,
          name: entry.sourceBatch.name,
          order: entry.sourceBatch.order,
          entries: [],
        };
        byId.set(entry.sourceBatch.id, group);
      }
      group.entries.push(entry);
    }
    return [...byId.values()].sort((a, b) => a.order - b.order);
  }, [finals]);

  const total = finals.length;
  const selectedCount = selectedKeys.size;
  const allChecked = total > 0 && selectedCount === total;
  const indeterminate = selectedCount > 0 && selectedCount < total;

  const toggleKey = (cropKey: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(cropKey)) next.delete(cropKey);
      else next.add(cropKey);
      log.debug('toggleKey', 'final toggled', { stage, cropKey, size: next.size });
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedKeys((prev) => {
      const next =
        prev.size === total ? new Set<string>() : new Set(finals.map((f) => f.cropKey));
      log.debug('toggleAll', 'check-all toggled', { stage, size: next.size });
      return next;
    });
  };

  const handleConfirm = () => {
    if (selectedCount === 0) return;
    log.info('handleConfirm', 'confirm import selection', {
      stage,
      selected: selectedCount,
      total,
    });
    onConfirm(selectedKeys);
  };

  log.debug('render', 'import dialog', { stage, total, selectedCount });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          log.debug('onOpenChange', 'close import dialog', { stage });
          onClose();
        }
      }}
    >
      <span ref={markerRef} className="hidden" aria-hidden="true" />
      <DialogContent
        container={container}
        aria-labelledby="import-batch-modal-title"
        // `[&>button]:hidden` — drop the built-in top-right ✕ (it overlaps the
        // header's Check-all control); Cancel/Esc/backdrop already close.
        className="flex max-h-[85vh] w-[min(960px,95vw)] max-w-[960px] flex-col gap-0 border-[var(--swap-modal-border)] bg-[var(--swap-modal-card-bg)] p-0 text-[var(--swap-modal-text-primary)] [&>button]:hidden"
        style={{ zIndex: Z_INDEX.reviewModal }}
        // ILS contract: this dialog OWNS its Escape — stop propagation so the
        // document-bubble hotkey listener never routes it to the swap modal.
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header: title left, check-all right */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--swap-modal-border)] px-5 py-3.5">
          <DialogTitle
            id="import-batch-modal-title"
            className="text-base font-semibold text-[var(--swap-modal-text-primary)]"
          >
            Import Images
          </DialogTitle>
          <DialogDescription className="sr-only">
            Pick finals from the previous stage to build a new batch.
          </DialogDescription>
          {total > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--swap-modal-text-secondary)]">
              Check all
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = indeterminate;
                }}
                onChange={toggleAll}
                aria-checked={indeterminate ? 'mixed' : allChecked}
                className="h-4 w-4 accent-[var(--swap-modal-accent)]"
              />
            </label>
          )}
        </div>

        {/* Body: grouped grid (scrolls) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {total === 0 ? (
            // Defense — the Import affordances are disabled when finals are
            // empty; this only shows on a race (finals pruned while open).
            <p className="py-10 text-center text-sm text-[var(--swap-modal-text-muted)]">
              No finals available — run the previous stage first.
            </p>
          ) : (
            groups.map((group) => (
              <section
                key={group.id}
                role="group"
                aria-label={group.name}
                className="mb-5 last:mb-0"
              >
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--swap-modal-text-muted)]">
                  {group.name}
                </h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
                  {group.entries.map((entry) => (
                    <ImportCell
                      key={entry.cropKey}
                      entry={entry}
                      checked={selectedKeys.has(entry.cropKey)}
                      onToggle={toggleKey}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--swap-modal-border)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--swap-modal-border-strong)] px-3 py-1.5 text-sm text-[var(--swap-modal-text-secondary)] transition-colors hover:bg-[var(--swap-modal-surface-hover)] hover:text-[var(--swap-modal-text-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selectedCount === 0}
            aria-disabled={selectedCount === 0 || undefined}
            onClick={handleConfirm}
            className="rounded-md bg-[var(--swap-modal-accent)] px-4 py-1.5 text-sm font-medium text-[var(--swap-modal-bg)] transition-colors hover:bg-[var(--swap-modal-accent-hover)] disabled:pointer-events-none disabled:opacity-40"
          >
            OK
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── ImportCell — one square thumbnail + top-right checkbox ───────────────────

interface ImportCellProps {
  entry: ImportFinalEntry;
  checked: boolean;
  onToggle: (cropKey: string) => void;
}

function ImportCell({ entry, checked, onToggle }: ImportCellProps) {
  const [errored, setErrored] = useState(false);
  return (
    <label
      className={cn(
        'group relative block cursor-pointer overflow-hidden rounded-lg border-2 transition-colors',
        checked
          ? 'border-[var(--swap-modal-accent)]'
          : 'border-transparent hover:border-white/25',
      )}
      style={{ aspectRatio: '1' }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(entry.cropKey)}
        aria-label={cellLabelOf(entry)}
        className="sr-only"
      />
      {errored ? (
        <span className="flex h-full w-full items-center justify-center bg-[var(--swap-modal-surface)]">
          <ImageOff className="h-5 w-5 text-white/50" aria-hidden="true" />
        </span>
      ) : (
        <img
          src={entry.media_url}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded border transition-colors',
          checked
            ? 'border-[var(--swap-modal-accent)] bg-[var(--swap-modal-accent)] text-white'
            : 'border-white/70 bg-black/60 text-transparent',
        )}
      >
        <Check className="h-3.5 w-3.5" />
      </span>
    </label>
  );
}
