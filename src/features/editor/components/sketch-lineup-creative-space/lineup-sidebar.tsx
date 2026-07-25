// lineup-sidebar.tsx — left sidebar of SketchLineupSpace (design 01). Header = tri-state select-all
// checkbox + title "Lineup" + ＋ New tab (2026-07-25 multi-tab — the ＋ mirrors the tab strip's).
// Two collapsible groups (Character / Prop); each row = ONE variant (base INCLUDED, unlike the
// Variants space) with a checkbox.
//
// Rows lacking a locked crop or a height render DISABLED + greyed + ⓘ reason tooltip — never
// filtered out (memory: never-hide-disabled-ui): the WHY + where-to-fix must stay discoverable.
// Same rule for the 2026-07-25 write gates: a peer lock (`disabled`) or an ungranted kind
// (`grantedKinds` — the FE mitigation of the gateway's characters∨props OR-gate over-permit)
// greys the affected checkboxes with a reason, never hides them.
//
// Checked state is DERIVED from the active tab's entries (lifted to the root); no destructive
// action / hotkey here (memory: sidebars don't own destructive hotkeys — unchecking IS the
// removal).

import { useId, useMemo } from 'react';
import { ChevronDown, ChevronRight, Info, Plus } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { BaseKind, LineupEntry } from '@/types/sketch';
import {
  LINEUP_TAB_LIMIT,
  disabledReason,
  rowLabel,
  selectable,
  type KindGroupConfig,
} from './lineup-constants';

const log = createLogger('Editor', 'LineupSidebar');

interface LineupSidebarProps {
  groups: KindGroupConfig[];
  entriesByKind: Record<BaseKind, LineupEntry[]>;
  checkedRefs: ReadonlySet<string>;
  expandedGroups: Record<BaseKind, boolean>;
  /** Peer-lock (or otherwise write-blocked) → every WRITE affordance greyed; browse stays live. */
  disabled: boolean;
  /** Holder name for the peer-lock tooltip (null → generic). Only read when `disabled`. */
  lockHolderName: string | null;
  /** false at the 12-tab cap → ＋ greyed with a reason (never hidden). */
  canCreateTab: boolean;
  /** Kinds the viewer may EDIT (UX gate for the gateway OR-gate over-permit — signed-off
   *  Validation S1). Owner/full grant → both kinds present. */
  grantedKinds: ReadonlySet<BaseKind>;
  onToggleEntry: (entry: LineupEntry, checked: boolean) => void;
  /** true = add every missing GRANTED selectable entry; false = drop selectable members
   *  (dangling kept — the root builds the exact payload). */
  onToggleAll: (checked: boolean) => void;
  onToggleGroup: (kind: BaseKind) => void;
  onCreateTab: () => void;
}

export function LineupSidebar({
  groups,
  entriesByKind,
  checkedRefs,
  expandedGroups,
  disabled,
  lockHolderName,
  canCreateTab,
  grantedKinds,
  onToggleEntry,
  onToggleAll,
  onToggleGroup,
  onCreateTab,
}: LineupSidebarProps) {
  // Select-all tri-state (design 01 §2.3) — derived from the GRANTED selectable entries only:
  // disabled rows (no image/height) and ungranted kinds are inert, so they must not hold
  // "all checked" hostage.
  const { allChecked, someChecked, hasSelectable } = useMemo(() => {
    const selectableEntries = groups
      .filter((g) => grantedKinds.has(g.kind))
      .flatMap((g) => entriesByKind[g.kind].filter(selectable));
    const checkedCount = selectableEntries.filter((e) => checkedRefs.has(e.ref)).length;
    return {
      allChecked: selectableEntries.length > 0 && checkedCount === selectableEntries.length,
      someChecked: checkedCount > 0,
      hasSelectable: selectableEntries.length > 0,
    };
  }, [groups, entriesByKind, checkedRefs, grantedKinds]);

  const handleToggleAll = () => {
    // Anything short of "all checked" → select all; only a full set clears (design 01 §2.3).
    const next = !allChecked;
    log.info('handleToggleAll', 'select-all toggled', { next, allChecked, someChecked });
    onToggleAll(next);
  };

  const peerReason = disabled ? `🔒 ${lockHolderName ?? 'Another editor'} is editing the Lineup` : null;

  return (
    <aside
      className="flex h-full w-1/4 min-w-[260px] max-w-[340px] flex-col border-r"
      role="navigation"
      aria-label="Lineup sidebar"
    >
      {/* Header: select-all + title + ＋ New tab (2026-07-25). */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Checkbox
          checked={allChecked}
          indeterminate={someChecked && !allChecked}
          disabled={disabled || !hasSelectable}
          onCheckedChange={handleToggleAll}
          aria-label="Select all variants"
        />
        <span className="flex-1 text-sm font-semibold">Lineup</span>
        <button
          type="button"
          aria-label="New tab"
          disabled={disabled || !canCreateTab}
          title={
            peerReason ?? (!canCreateTab ? `Tab limit reached (${LINEUP_TAB_LIMIT})` : 'New tab')
          }
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground',
            disabled || !canCreateTab ? 'opacity-50' : 'hover:bg-muted/60 hover:text-foreground',
          )}
          onClick={onCreateTab}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2" role="tree" aria-label="Lineup variants">
        {groups.map((group) => (
          <LineupKindGroup
            key={group.kind}
            group={group}
            entries={entriesByKind[group.kind]}
            expanded={expandedGroups[group.kind]}
            checkedRefs={checkedRefs}
            granted={grantedKinds.has(group.kind)}
            peerReason={peerReason}
            onToggleEntry={onToggleEntry}
            onToggleGroup={onToggleGroup}
          />
        ))}
      </div>
    </aside>
  );
}

function LineupKindGroup({
  group,
  entries,
  expanded,
  checkedRefs,
  granted,
  peerReason,
  onToggleEntry,
  onToggleGroup,
}: {
  group: KindGroupConfig;
  entries: LineupEntry[];
  expanded: boolean;
  checkedRefs: ReadonlySet<string>;
  granted: boolean;
  peerReason: string | null;
  onToggleEntry: (entry: LineupEntry, checked: boolean) => void;
  onToggleGroup: (kind: BaseKind) => void;
}) {
  const { kind, title, noun } = group;
  // Kind not granted → the whole group greys (UX mitigation of the OR-gate over-permit); the
  // group stays expandable so the rows remain discoverable (never hidden).
  const grantReason = granted
    ? null
    : `You do not have edit rights for ${title.toLowerCase()}s in the Sketch step`;

  return (
    <div className="mb-1" role="group">
      <div className="flex items-center gap-1 rounded-md px-1 hover:bg-muted/50">
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm font-medium',
            !granted && 'opacity-50',
          )}
          aria-expanded={expanded}
          title={grantReason ?? undefined}
          onClick={() => onToggleGroup(kind)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate">{title}</span>
        </button>
      </div>

      {expanded && (
        <div className="mt-0.5 space-y-0.5 pl-4">
          {entries.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No {noun}s imported yet</p>
          ) : (
            entries.map((entry) => (
              <LineupRow
                key={entry.ref}
                entry={entry}
                checked={checkedRefs.has(entry.ref)}
                blockedReason={peerReason ?? grantReason}
                onToggleEntry={onToggleEntry}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LineupRow({
  entry,
  checked,
  blockedReason,
  onToggleEntry,
}: {
  entry: LineupEntry;
  checked: boolean;
  /** Peer-lock or ungranted-kind reason; null = writes allowed (row may still self-disable). */
  blockedReason: string | null;
  onToggleEntry: (entry: LineupEntry, checked: boolean) => void;
}) {
  // Blocked (lock/grant) reason FIRST — it gates even selectable rows; else the row's own reason.
  const reason = blockedReason ?? disabledReason(entry);
  const isDisabled = reason != null;
  const label = rowLabel(entry);
  const reasonId = useId();

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5',
        isDisabled ? 'opacity-50' : 'hover:bg-muted/50',
      )}
      aria-disabled={isDisabled}
    >
      <Checkbox
        checked={checked}
        disabled={isDisabled}
        onCheckedChange={(next) => onToggleEntry(entry, next)}
        aria-label={label}
        aria-describedby={reason ? reasonId : undefined}
      />
      <span className={cn('min-w-0 flex-1 truncate text-sm', isDisabled && 'text-muted-foreground')} title={label}>
        {label}
      </span>
      {/* ⓘ carries the WHY + where to fix. The icon (NOT the disabled checkbox, which is inert to
          hover) is what surfaces the native title on hover; the sr-only twin is what `aria-describedby`
          above resolves to, so a screen reader gets the reason from the checkbox itself instead of
          having to stumble onto the icon. NOT role="tooltip" — a tooltip must be referenced by its
          trigger, and a standalone one is an orphan node. */}
      {reason && (
        <span title={reason}>
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        </span>
      )}
    </div>
  );
}
