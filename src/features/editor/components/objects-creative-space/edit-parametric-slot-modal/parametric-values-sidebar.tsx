// parametric-values-sidebar.tsx — LEFT column "VALUES" of EditParametricSlotModal
// (design §1.1 / §2.4). Lists domain ∪ item values as a `listbox`; the shell owns the
// selection state and the ↑/↓ hotkeys, this component only renders + reports clicks.
//
// Empty domain (axis deleted/disabled in Config while the item still carries values) is a
// first-class state, not an error: the dangling rows stay visible and a banner points at
// Config › Parametric Slot (§4.3).

import { useEffect, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { LEFT_SIDEBAR_WIDTH_PX } from './parametric-slot-modal-constants';
import { ParametricValueRow } from './parametric-value-row';
import type { ParametricValueRowData } from './parametric-slot-utils';

const log = createLogger('Editor', 'ParametricValuesSidebar');

export interface ParametricValuesSidebarProps {
  rows: ParametricValueRowData[];
  selectedValue: string | null;
  /** false ⇒ the axis has no configured value left; every row shown is dangling. */
  hasDomain: boolean;
  canEdit: boolean;
  /** Value whose ⋮ menu is open (only one at a time), or null. */
  openMenuValue: string | null;
  onOpenMenuValueChange: (value: string | null) => void;
  onSelect: (value: string) => void;
  onSetDefault: (value: string) => void;
  onClearImages: (value: string) => void;
}

export function ParametricValuesSidebar({
  rows,
  selectedValue,
  hasDomain,
  canEdit,
  openMenuValue,
  onOpenMenuValueChange,
  onSelect,
  onSetDefault,
  onClearImages,
}: ParametricValuesSidebarProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the ↑/↓-driven selection visible (the `age` axis can be 101 rows tall). DOM side
  // effect only — no setState in an effect (React 19 lints that).
  useEffect(() => {
    if (!selectedValue) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-value="${CSS.escape(selectedValue)}"]`,
    );
    if (!el) {
      log.debug('scrollSelectedIntoView', 'row not rendered, skip', { value: selectedValue });
      return;
    }
    el.scrollIntoView({ block: 'nearest' });
  }, [selectedValue]);

  return (
    <aside
      className="flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)]"
      style={{ width: LEFT_SIDEBAR_WIDTH_PX }}
      aria-label="Values"
    >
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
          Values
        </span>
        {rows.length > 0 && (
          <span className="text-xs text-[var(--swap-modal-text-muted)]">{rows.length}</span>
        )}
      </div>

      {!hasDomain && (
        <p className="mx-3 mb-2 shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <TriangleAlert className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          Axis không còn trong config — mở Config › Parametric Slot để bật lại, hoặc Remove
          slot. Generate/Upload đang tắt.
        </p>
      )}

      <div
        ref={listRef}
        role="listbox"
        aria-label="Parametric values"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3"
      >
        {rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-[var(--swap-modal-text-muted)]">
            Axis này chưa có giá trị nào. Thêm giá trị ở Config › Parametric Slot.
          </p>
        ) : (
          rows.map((row) => (
            <ParametricValueRow
              key={row.value}
              row={row}
              isSelected={row.value === selectedValue}
              menuOpen={openMenuValue === row.value}
              onMenuOpenChange={(open) => onOpenMenuValueChange(open ? row.value : null)}
              canEdit={canEdit}
              onSelect={onSelect}
              onSetDefault={onSetDefault}
              onClearImages={onClearImages}
            />
          ))
        )}
      </div>
    </aside>
  );
}
