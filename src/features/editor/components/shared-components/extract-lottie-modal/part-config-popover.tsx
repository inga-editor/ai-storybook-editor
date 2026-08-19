// part-config-popover.tsx — Config popover anchored under a PartsSidebar item (design README §3.1).
// Two fields: Name (empty → keep old) + Parent select (None + every OTHER part incl null, minus
// this part's own descendants so a cycle can't be formed). Portalled → must redeclare
// SWAP_MODAL_TOKENS + a clearing z-index so its `var(--swap-modal-*)` reads resolve (memory:
// portaled popover loses swap-modal CSS vars). Presentational — the sidebar owns open/onSave.

import { useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createLogger } from '@/utils/logger';
import type { LottiePart } from './extract-lottie-modal-types';
import { SWAP_MODAL_TOKENS, Z_INDEX } from './extract-lottie-modal-constants';

const log = createLogger('Editor', 'PartConfigPopover');

const POPOVER_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const SELECT_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const NONE_VALUE = '__none__';

/** All parts that are descendants of `rootId` (walking `parentId` upward from each part). Those
 *  must be excluded from the parent options — reparenting `rootId` under one would form a cycle. */
function descendantIds(rootId: string, parts: LottiePart[]): Set<string> {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const out = new Set<string>();
  for (const p of parts) {
    let cur: LottiePart | undefined = p;
    const seen = new Set<string>();
    while (cur && cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      if (cur.parentId === rootId) {
        out.add(p.id);
        break;
      }
      cur = byId.get(cur.parentId);
    }
  }
  return out;
}

export interface PartConfigPopoverProps {
  part: LottiePart;
  parts: LottiePart[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: { name: string; parentId: string | null }) => void;
  /** Anchor node (the sidebar item row) the popover attaches to. */
  children: React.ReactNode;
}

export function PartConfigPopover({
  part,
  parts,
  open,
  onOpenChange,
  onSave,
  children,
}: PartConfigPopoverProps) {
  // Keyed by `part.id` + `open` at mount so re-opening always re-seeds from the live part.
  const [name, setName] = useState(part.name);
  const [parentId, setParentId] = useState<string | null>(part.parentId);

  const excluded = descendantIds(part.id, parts);
  const parentOptions = parts.filter((p) => p.id !== part.id && !excluded.has(p.id));

  const handleSave = () => {
    const trimmed = name.trim();
    // Empty name → keep the existing name (mirror mock — never commit an empty label).
    onSave({ name: trimmed || part.name, parentId });
    log.debug('handleSave', 'config saved', { partId: part.id, parentId });
    onOpenChange(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(part.name);
          setParentId(part.parentId);
        }
        onOpenChange(next);
      }}
    >
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        style={POPOVER_CONTENT_STYLE}
        className="w-64 border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-card-bg)] p-3 text-[var(--swap-modal-text-primary)]"
      >
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
          className="mb-3 w-full rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] px-2 py-1.5 text-sm text-[var(--swap-modal-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--swap-modal-accent)]"
          aria-label="Part name"
        />

        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
          Parent
        </label>
        <Select
          value={parentId ?? NONE_VALUE}
          onValueChange={(v) => setParentId(v === NONE_VALUE ? null : v)}
        >
          <SelectTrigger
            className="mb-3 w-full border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)]"
            aria-label="Parent part"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={SELECT_CONTENT_STYLE}>
            <SelectItem value={NONE_VALUE}>None</SelectItem>
            {parentOptions.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--swap-modal-text-secondary)] hover:bg-[var(--swap-modal-surface-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md bg-[var(--swap-modal-accent)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--swap-modal-accent-hover)]"
          >
            Save
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
