// parts-sidebar.tsx — Left list shared by all 4 tabs (design README §3.1). Renders the parts in
// creation order (= lottie layer order, head = topmost). Each item: kind icon (▣ normal / ∅ null)
// + label + hover-reveal ⚙/🗑 + a versions subgrid (2-col thumbs, v1..vn badges, selected = accent).
// Click item → select. ⚙ → PartConfigPopover (Name + Parent). Presentational — the shell owns state.

import { useState } from 'react';
import { Settings, Trash2, Square, Circle, Crop } from 'lucide-react';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { LottiePart } from './extract-lottie-modal-types';
import { LOTTIE_MODAL_LAYOUT } from './extract-lottie-modal-constants';
import { PartConfigPopover } from './part-config-popover';

const log = createLogger('Editor', 'PartsSidebar');

export interface PartsSidebarProps {
  parts: LottiePart[];
  activePartId: string | null;
  disabled?: boolean;
  onSelectPart: (id: string) => void;
  onDeletePart: (id: string) => void;
  onConfigSave: (id: string, patch: { name: string; parentId: string | null }) => void;
  onSelectVersion: (partId: string, versionId: string) => void;
  /** Click on the empty area below the parts list → deselect (→ back to the original image). */
  onDeselect: () => void;
}

export function PartsSidebar({
  parts,
  activePartId,
  disabled = false,
  onSelectPart,
  onDeletePart,
  onConfigSave,
  onSelectVersion,
  onDeselect,
}: PartsSidebarProps) {
  // At most one config popover open at a time (opening one closes the others).
  const [openConfigId, setOpenConfigId] = useState<string | null>(null);

  return (
    <aside
      className="flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)]"
      style={{ width: LOTTIE_MODAL_LAYOUT.leftSidebar }}
      aria-label="Parts"
    >
      <div
        className="flex shrink-0 items-center border-b border-[var(--swap-modal-border)] px-4"
        style={{ height: LOTTIE_MODAL_LAYOUT.stageHeaderH }}
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
          Parts
        </span>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        // Click on the empty area below the list (not on a part row) → deselect.
        onClick={(e) => e.target === e.currentTarget && onDeselect()}
      >
        {parts.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--swap-modal-text-muted)]">
            Chưa có part nào — tạo part ở panel bên phải.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {parts.map((part) => {
              const isActive = part.id === activePartId;
              const isNull = part.kind === 'null';
              const KindIcon = isNull ? Circle : part.kind === 'manual' ? Crop : Square;
              return (
                <li key={part.id}>
                  <PartConfigPopover
                    part={part}
                    parts={parts}
                    open={openConfigId === part.id}
                    onOpenChange={(next) => setOpenConfigId(next ? part.id : null)}
                    onSave={(patch) => onConfigSave(part.id, patch)}
                  >
                    <div
                      className={cn(
                        'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                        isActive
                          ? 'bg-[var(--swap-modal-selection)]'
                          : 'hover:bg-[var(--swap-modal-surface-hover)]',
                        disabled && 'cursor-not-allowed opacity-60',
                      )}
                      onClick={() => {
                        if (disabled) return;
                        onSelectPart(part.id);
                      }}
                    >
                      <KindIcon
                        className={cn(
                          'h-4 w-4 shrink-0',
                          isNull
                            ? 'text-[var(--swap-modal-text-muted)] opacity-50'
                            : 'text-[var(--swap-modal-text-secondary)]',
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--swap-modal-text-primary)]">
                        {part.name}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          aria-label={`Configure ${part.name}`}
                          title="Configure"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenConfigId((cur) => (cur === part.id ? null : part.id));
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded text-[var(--swap-modal-text-muted)] hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)]"
                        >
                          <Settings className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${part.name}`}
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            log.debug('onDelete', 'delete part', { id: part.id });
                            onDeletePart(part.id);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded text-[var(--swap-modal-text-muted)] hover:bg-red-600 hover:text-white"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </PartConfigPopover>

                  {/* Versions subgrid (normal parts only) */}
                  {!isNull && (
                    <div className="mt-1 pl-6 pr-1">
                      {part.versions.length === 0 ? (
                        <p className="py-1 text-[11px] italic text-[var(--swap-modal-text-muted)]">
                          Chưa crop
                        </p>
                      ) : (
                        <div className="grid grid-cols-2 gap-1.5">
                          {part.versions.map((v, i) => {
                            const selected = v.id === part.selectedVersionId;
                            return (
                              <button
                                key={v.id}
                                type="button"
                                onClick={() => {
                                  // Clicking a version thumbnail also activates its part and makes
                                  // that version the selected (final) result.
                                  onSelectPart(part.id);
                                  onSelectVersion(part.id, v.id);
                                }}
                                className={cn(
                                  'relative aspect-square overflow-hidden rounded-md border bg-[var(--swap-modal-surface-hover)]',
                                  selected
                                    ? 'border-[var(--swap-modal-accent)] ring-1 ring-[var(--swap-modal-accent)]'
                                    : 'border-[var(--swap-modal-border)] hover:border-[var(--swap-modal-border-strong)]',
                                )}
                                aria-label={`Version ${i + 1}`}
                                aria-pressed={selected}
                              >
                                <img
                                  src={v.media_url}
                                  alt={`Version ${i + 1}`}
                                  className="h-full w-full object-contain"
                                />
                                <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">
                                  v{i + 1}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
