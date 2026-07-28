// item-slot-section.tsx - Slot UI for the Objects image toolbar: the read-only body row
// (`ItemSlotSection`) and the footer icon button (`ItemSlotToolbarButton`).
// Design ref: component/editor-page/objects-creative-space/03-image-toolbar.md §4.9
//
// The button is NOT the shared `ToolbarIconButton`: it needs a state-dependent tooltip
// (distinct from its aria-label) and a status badge, neither of which the shared
// component exposes. Its classes mirror the shared button (plus `relative` for the badge,
// minus the unused `disabled:*` rules) so the footer stays visually uniform — do NOT widen
// the shared API for this one case.
//
// The row NEVER mutates anything: it renders the descriptor produced by
// `describeItemSlot()` (see item-slot-modal/item-slot-logic.ts) and forwards a click
// to the same handler as the footer Slot button (shortcut, not a second code path).
// Must be rendered inside a `TooltipProvider` — the toolbar already provides one.

import { AlertTriangle, Variable } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createLogger } from '@/utils/logger';
import type { ItemSlotDescriptor } from '@/features/editor/components/objects-creative-space/item-slot-modal';

const log = createLogger('Editor', 'ItemSlotSection');

const DANGLING_HINT = 'Config đã đổi — mở Slot để sửa';
const BOTH_FIELDS_HINT = 'Item mang cả 2 slot — cần dọn';
const SLOT_ARIA_LABEL = 'Configure slot';

export interface ItemSlotSectionProps {
  /** From `describeItemSlot()` — `null` means the item carries no slot yet. */
  descriptor: ItemSlotDescriptor | null;
  onClick: () => void;
}

export function ItemSlotSection({ descriptor, onClick }: ItemSlotSectionProps) {
  // Warning wins over dangling: corrupt data is the more urgent thing to surface.
  const hint = descriptor?.hasBothFields
    ? BOTH_FIELDS_HINT
    : descriptor?.isDangling
      ? DANGLING_HINT
      : undefined;

  const suffix = descriptor
    ? descriptor.type === 'parametric'
      ? `(${descriptor.count} variants)`
      : `(${descriptor.count} actors)`
    : null;

  // The visible state is colour + tooltip only, both invisible to AT — so the accessible
  // name spells out label, count and anomaly. It also disambiguates this row from the
  // footer Slot button, which keeps the terse "Configure slot" name.
  const ariaLabel = descriptor
    ? `${SLOT_ARIA_LABEL} — ${descriptor.label} ${suffix ?? ''}${hint ? ` — ${hint}` : ''}`
    : `${SLOT_ARIA_LABEL} — chưa có slot`;

  function handleClick() {
    // Entry-point marker: the toolbar logs the actual open, this says it came from the row.
    log.debug('handleClick', 'slot section shortcut', {
      slotType: descriptor?.type ?? 'none',
      isDangling: !!descriptor?.isDangling,
    });
    onClick();
  }

  const trigger = (
    <button
      type="button"
      onClick={handleClick}
      aria-label={ariaLabel}
      className="flex flex-1 items-center gap-1.5 h-7 min-w-0 rounded-lg border border-border bg-secondary px-2 text-left text-sm transition-colors hover:bg-muted"
    >
      {descriptor?.hasBothFields && (
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-destructive" />
      )}
      <span
        className={`truncate ${
          descriptor
            ? descriptor.isDangling || descriptor.hasBothFields
              ? 'text-destructive'
              : 'text-foreground'
            : 'text-muted-foreground'
        }`}
      >
        {descriptor ? descriptor.label : '—'}
      </span>
      {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
    </button>
  );

  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground w-14 shrink-0">Slot</Label>
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {hint}
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
    </div>
  );
}

export interface ItemSlotToolbarButtonProps {
  descriptor: ItemSlotDescriptor | null;
  /** False when the parent passed no `onConfigureSlot` — button stays enabled, tooltip says so. */
  hasHandler: boolean;
  onClick: () => void;
}

/**
 * Footer Slot button. Never hidden, never disabled (never-hide-disabled-UI convention):
 * with no handler wired it still opens a "Coming soon" toast, same as Edit/Extract.
 */
export function ItemSlotToolbarButton({
  descriptor,
  hasHandler,
  onClick,
}: ItemSlotToolbarButtonProps) {
  const tooltip = !hasHandler
    ? 'Coming soon'
    : descriptor?.hasBothFields
      ? BOTH_FIELDS_HINT
      : descriptor
        ? 'Slot đã init — Edit modal coming soon'
        : SLOT_ARIA_LABEL;

  const badgeClass = descriptor?.hasBothFields || descriptor?.isDangling
    ? 'bg-destructive'
    : 'bg-primary';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={SLOT_ARIA_LABEL}
          className="relative p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
        >
          <Variable className="w-4 h-4" />
          {descriptor && (
            <span
              aria-hidden="true"
              className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${badgeClass}`}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
