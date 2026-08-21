// base-group-sidebar.tsx — left sidebar of SketchBaseSpace (design 01). Header "Base" + Excel
// import; N collapsible DYNAMIC groups (⚡REV 2026-08-21 — one per character/prop group, label =
// `base[group].name`; character groups before prop groups), each with edit-entity (✏) + add-style
// (＋) and a list of Style rows (select + lock). Lock is exclusive WITHIN a group's sheet (the
// groups are independent nodes); clicking an already-locked style re-sets itself (no-op).
//
// Collab (ADR-044 addendum 2 — LOCKLESS): entity/sheet domains no longer acquire a lock, so there is
// NO peer-lock badge and NO lock-based disable. The ＋ (add style) + each row's 🔒 (lock-style) seams
// disable only when the group is EMPTY. The Lock/LockOpen icons are the style-lock (is_selected)
// glyph, NOT collab. ✏ (edit entity text) stays enabled unless the group is empty.
//
// EMPTY GROUP (zero base entities — an ORPHAN sheet node whose entities were removed elsewhere): the
// group still RENDERS, with the "No entity in this group" hint, the ＋/✏ seams greyed, AND an
// OWNER-ONLY delete-group action (rtype 11 DELETE, owner-gated server-side). Never HIDDEN
// (never-hide-disabled-ui).
//
// OWNER-ONLY seams (BE 260821 + Validation S1): the Excel import (⬆) AND the delete-group (🗑) are
// owner-only — a non-owner sees them disabled + greyed with a reason tooltip, and no file picker /
// no API call fires. Owner = `currentBook.owner_id === currentUserId` (resolved by the root).

import { useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BaseGroup, SketchBaseStyle } from '@/types/sketch';
import type { BaseSheetGenerateOp } from '@/stores/snapshot-store/types';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import { EMPTY_GROUP_HINT, type SelectedStyleRef } from './sketch-base-constants';

const log = createLogger('Editor', 'BaseGroupSidebar');

/** Owner-gate tooltip copy (never-hide-disabled-ui — the WHY goes in the accessible name too). */
const IMPORT_OWNER_ONLY = 'Chỉ chủ sách mới nhập được từ Excel';
const DELETE_OWNER_ONLY = 'Chỉ chủ sách xoá được nhóm';

interface BaseGroupSidebarProps {
  groups: BaseGroup[];
  stylesByGroup: Record<string, SketchBaseStyle[]>;
  selectedStyle: SelectedStyleRef | null;
  expandedGroups: Record<string, boolean>;
  onSelectStyle: (group: string, index: number) => void;
  onToggleGroup: (group: string) => void;
  onAddStyle: (group: string) => void;
  onLockStyle: (group: string, index: number) => void;
  onEditEntity: (group: string) => void;
  onImport: (file: File) => void;
  /** Delete an ORPHAN group (0 entities). Owner-only — the button is disabled for non-owners. */
  onDeleteGroup: (group: string) => void;
  isImporting: boolean;
  /** Book owner → gates the import (⬆) + delete-group (🗑) seams (Validation S1 owner-only). */
  isOwner: boolean;
  /** In-flight generate ops keyed by GROUP → drives the per-row spinner (matches group+styleIndex). */
  generateOps: Record<string, BaseSheetGenerateOp | undefined>;
  /** Base-entity count per group_key. 0 → the group renders its empty hint + greys ＋/✏ + shows 🗑. */
  entityCountsByGroup: Record<string, number>;
}

export function BaseGroupSidebar({
  groups,
  stylesByGroup,
  selectedStyle,
  expandedGroups,
  onSelectStyle,
  onToggleGroup,
  onAddStyle,
  onLockStyle,
  onEditEntity,
  onImport,
  onDeleteGroup,
  isImporting,
  isOwner,
  generateOps,
  entityCountsByGroup,
}: BaseGroupSidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    if (!isOwner) return; // owner-only — no file picker for collaborators
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-selecting the SAME file still fires onChange.
    e.target.value = '';
    if (!file) return;
    log.info('handleFileChange', 'file selected', { fileName: file.name });
    onImport(file);
  };

  return (
    <aside
      className="flex h-full w-1/4 min-w-[260px] max-w-[340px] flex-col border-r"
      role="navigation"
      aria-label="Base sidebar"
    >
      {/* Header: title + Excel import (owner-only). A non-owner sees the button greyed + a reason
          tooltip, never hidden; `aria-disabled` (not the real attr) keeps it hoverable. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-semibold">Base</span>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7', !isOwner && 'cursor-not-allowed opacity-40')}
          onClick={handleImportClick}
          disabled={isImporting}
          aria-disabled={!isOwner}
          aria-busy={isImporting}
          aria-label={isOwner ? 'Import base entities from Excel' : `Import base entities from Excel — unavailable: ${IMPORT_OWNER_ONLY}`}
          title={isOwner ? 'Import base entities from Excel' : IMPORT_OWNER_ONLY}
        >
          {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((group) => (
          <SidebarGroupRow
            key={group.group_key}
            group={group}
            styles={stylesByGroup[group.group_key] ?? EMPTY_STYLES}
            // New/unseen groups default to EXPANDED (import must reveal its groups immediately).
            expanded={expandedGroups[group.group_key] ?? true}
            selectedStyle={selectedStyle}
            generateOps={generateOps}
            entityCount={entityCountsByGroup[group.group_key] ?? 0}
            isOwner={isOwner}
            onSelectStyle={onSelectStyle}
            onToggleGroup={onToggleGroup}
            onAddStyle={onAddStyle}
            onLockStyle={onLockStyle}
            onEditEntity={onEditEntity}
            onDeleteGroup={onDeleteGroup}
          />
        ))}
        {groups.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No base group yet — import base entities from Excel to begin.
          </p>
        )}
      </div>
    </aside>
  );
}

/** Stable empty fallback so a group with no styles entry doesn't churn the child props. */
const EMPTY_STYLES: SketchBaseStyle[] = [];

function SidebarGroupRow({
  group,
  styles,
  expanded,
  selectedStyle,
  generateOps,
  entityCount,
  isOwner,
  onSelectStyle,
  onToggleGroup,
  onAddStyle,
  onLockStyle,
  onEditEntity,
  onDeleteGroup,
}: {
  group: BaseGroup;
  styles: SketchBaseStyle[];
  expanded: boolean;
  selectedStyle: SelectedStyleRef | null;
  generateOps: Record<string, BaseSheetGenerateOp | undefined>;
  entityCount: number;
  isOwner: boolean;
  onSelectStyle: (group: string, index: number) => void;
  onToggleGroup: (group: string) => void;
  onAddStyle: (group: string) => void;
  onLockStyle: (group: string, index: number) => void;
  onEditEntity: (group: string) => void;
  onDeleteGroup: (group: string) => void;
}) {
  const { group_key: groupKey, name } = group;

  // Zero base entities → both mutation seams are dead ends: ＋ generates an empty sheet (the slice
  // refuses + toasts) and ✏ opens an entity editor with zero tabs. Grey both, say WHY, keep the
  // group visible — and offer the owner a way to delete the orphan node.
  const isEmpty = entityCount === 0;
  const hintId = `base-group-empty-${groupKey}`;
  const addTip = isEmpty ? EMPTY_GROUP_HINT : `Add ${name} style`;
  const editTip = isEmpty ? EMPTY_GROUP_HINT : `Edit ${name} entities`;
  const addLabel = isEmpty ? `Add ${name} style — unavailable: ${EMPTY_GROUP_HINT}` : addTip;
  const editLabel = isEmpty ? `Edit ${name} entities — unavailable: ${EMPTY_GROUP_HINT}` : editTip;

  return (
    <div className="mb-1">
      {/* Group header: chevron+name toggle (aria-expanded) + edit-entity + add-style */}
      <div className="flex items-center gap-1 rounded-md px-1 hover:bg-muted/50">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm font-medium"
          aria-expanded={expanded}
          aria-label={name}
          onClick={() => onToggleGroup(groupKey)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate">{name}</span>
        </button>
        {/* ✏ = edit entity text. Greyed only when the group has NO entity to edit. */}
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7', isEmpty && 'cursor-not-allowed opacity-40')}
          aria-disabled={isEmpty}
          aria-describedby={isEmpty ? hintId : undefined}
          onClick={() => {
            if (isEmpty) {
              log.debug('onEditEntity', 'blocked — group has no entity', { groupKey });
              return;
            }
            onEditEntity(groupKey);
          }}
          aria-label={editLabel}
          title={editTip}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        {/* ＋ = add-style seam — greyed + click-guarded when the group has no base entity to lay out. */}
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7', isEmpty && 'cursor-not-allowed opacity-40')}
          aria-disabled={isEmpty}
          aria-describedby={isEmpty ? hintId : undefined}
          onClick={() => {
            if (isEmpty) {
              log.debug('onAddStyle', 'blocked — group empty', { groupKey });
              return;
            }
            onAddStyle(groupKey);
          }}
          aria-label={addLabel}
          title={addTip}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {expanded && (
        <div className="mt-0.5 space-y-0.5 pl-4">
          {isEmpty ? (
            // Orphan group — rendered, never filtered out. Static hint (NOT a live region) + an
            // owner-only delete-group action.
            <div className="flex items-center justify-between gap-1 px-2 py-1.5">
              <p id={hintId} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {EMPTY_GROUP_HINT}
              </p>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive',
                  !isOwner && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
                )}
                aria-disabled={!isOwner}
                onClick={() => {
                  if (!isOwner) {
                    log.debug('onDeleteGroup', 'blocked — not the book owner', { groupKey });
                    return;
                  }
                  onDeleteGroup(groupKey);
                }}
                aria-label={isOwner ? `Delete group ${name}` : `Delete group ${name} — unavailable: ${DELETE_OWNER_ONLY}`}
                title={isOwner ? `Delete group ${name}` : DELETE_OWNER_ONLY}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ) : styles.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No style yet — ＋ to generate
            </p>
          ) : (
            styles.map((style, idx) => (
              <StyleRow
                key={idx}
                index={idx}
                isLocked={style.is_selected}
                isSelected={selectedStyle?.group === groupKey && selectedStyle.index === idx}
                isGenerating={generateOps[groupKey]?.styleIndex === idx}
                onSelect={() => onSelectStyle(groupKey, idx)}
                onLock={() => onLockStyle(groupKey, idx)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function StyleRow({
  index,
  isLocked,
  isSelected,
  isGenerating,
  onSelect,
  onLock,
}: {
  index: number;
  isLocked: boolean;
  isSelected: boolean;
  isGenerating: boolean;
  onSelect: () => void;
  onLock: () => void;
}) {
  const label = `Style ${index + 1}`;
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-md pr-1',
        isSelected ? 'bg-primary/10' : isLocked ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-muted/50',
      )}
    >
      {/* Row select = BROWSE (no lock) → always enabled. */}
      <button
        type="button"
        className={cn(
          'min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm',
          isSelected && 'font-medium text-foreground',
          // Locked = the final style — primary + semibold so it reads at a glance (twMerge:
          // these win over the selected classes above).
          isLocked && 'font-semibold text-primary',
        )}
        aria-current={isSelected ? 'true' : undefined}
        onClick={onSelect}
      >
        {label}
      </button>
      {isGenerating && (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-label={`${label} generating`}
        />
      )}
      {/* 🔒 lock-style = mark this style final (is_selected). */}
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-6 w-6',
          isLocked ? 'text-primary hover:text-primary' : 'text-muted-foreground',
        )}
        onClick={onLock}
        aria-pressed={isLocked}
        aria-label={isLocked ? `Unlock ${label}` : `Lock ${label}`}
        title={isLocked ? 'Locked style' : 'Lock as final style'}
      >
        {isLocked ? <Lock className="h-4 w-4 fill-primary/20" /> : <LockOpen className="h-4 w-4" />}
      </Button>
    </div>
  );
}
