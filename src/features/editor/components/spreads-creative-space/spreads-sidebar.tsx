// spreads-sidebar.tsx - Left sidebar listing all elements in a selected illustration spread
// Simpler than objects-sidebar: only element type filter (no asset type), 3 element types.
// Drag reorder works by replacing the raw array in the spread (no z-index arithmetic).
"use client";

import { useState, useMemo, useCallback } from "react";
import { Plus, Filter } from "lucide-react";
import { cn } from "@/utils/utils";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  useSnapshotActions,
} from "@/stores/snapshot-store/selectors";
import { useSnapshotStore } from "@/stores/snapshot-store";
import { useBookShape, useBookStepTypography } from "@/stores/book-store";
import { FALLBACK_SHAPE } from "@/constants/book-defaults";
import { createLogger } from "@/utils/logger";
import { toastLockRequired } from "@/utils/collab-save-toasts";
import { useLanguageCode } from "@/stores/editor-settings-store";
import { SpreadsSidebarListItem } from "./spreads-sidebar-list-item";
import {
  buildElementList,
  filterElementList,
  groupEntriesByLayer,
  ALL_ELEMENT_TYPES,
  ADDABLE_ELEMENT_TYPES,
  ELEMENT_TYPE_CONFIG,
  NEW_ELEMENT_DEFAULTS,
  createDefaultTextbox,
  type SpreadElementType,
  type ElementListEntry,
  type LayerGroup,
  type SelectedItem,
} from "./utils";
import type { SpreadImage, SpreadShape } from "@/types/canvas-types";

const log = createLogger("Editor", "SpreadsSidebar");

// === Props ===

interface SpreadsSidebarProps {
  selectedSpreadId: string;
  selectedItemId: SelectedItem | null;
  onItemSelect: (item: SelectedItem | null) => void;
  /** Whether THIS editor holds the active spread's SCENE lock (ADR-044 lock-on-click). Gates every
   *  in-spread edit here (add / rename / reorder); when false the sidebar is display-only (greyed,
   *  never hidden). */
  isEditable: boolean;
  /** First-click lock gate (`runWithLock` from `useSaveSession`): runs the action immediately when
   *  the SCENE lock is held, else acquires the lock and defers the action until HELD. Add-element
   *  routes through this so the "+" flow auto-locks instead of toasting. */
  runWithLock?: (action: () => void) => void;
}

// === Inline sub-components ===

/** Filter popover: element type only (no asset type for illustration spreads) */
function FilterPopoverContent({
  elementFilter,
  allElements,
  onToggleElement,
  onToggleAllElements,
}: {
  elementFilter: Set<SpreadElementType>;
  allElements: boolean;
  onToggleElement: (type: SpreadElementType) => void;
  onToggleAllElements: () => void;
}) {
  return (
    <div className="space-y-4 text-sm">
      <p className="font-semibold text-base">Filter</p>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-blue-500 uppercase tracking-wider">
          By Element Type
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allElements}
            onChange={onToggleAllElements}
            className="rounded w-4 h-4 accent-blue-500"
          />
          All Elements
        </label>
        {ALL_ELEMENT_TYPES.map((type) => {
          const config = ELEMENT_TYPE_CONFIG[type];
          return (
            <label key={type} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allElements || elementFilter.has(type)}
                onChange={() => onToggleElement(type)}
                className="rounded w-4 h-4 accent-blue-500"
              />
              <config.icon className="w-4 h-4 text-muted-foreground" />
              {config.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Add element popover: image, textbox, shape */
function AddElementPopoverContent({
  onAdd,
}: {
  onAdd: (type: SpreadElementType) => void;
}) {
  return (
    <div className="py-1">
      {ADDABLE_ELEMENT_TYPES.map((type) => {
        const config = ELEMENT_TYPE_CONFIG[type];
        return (
          <button
            key={type}
            type="button"
            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm hover:bg-muted transition-colors rounded-sm"
            onClick={() => onAdd(type)}
          >
            <config.icon className="w-4 h-4 text-muted-foreground" />
            {config.label}
          </button>
        );
      })}
    </div>
  );
}

// === Main Component ===

export function SpreadsSidebar({
  selectedSpreadId,
  selectedItemId,
  onItemSelect,
  isEditable,
  runWithLock,
}: SpreadsSidebarProps) {
  // Defensive: guard against illustration being undefined during store init
  const spread = useSnapshotStore(
    (s) => s.illustration?.spreads?.find((sp) => sp.id === selectedSpreadId)
  );
  const actions = useSnapshotActions();
  const langCode = useLanguageCode();
  const bookShape = useBookShape();
  const bookTypography = useBookStepTypography('illustration');

  // Local UI state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Filter state (all checked by default)
  const [elementFilter, setElementFilter] = useState<Set<SpreadElementType>>(
    new Set(ALL_ELEMENT_TYPES)
  );
  const [allElements, setAllElements] = useState(true);

  // Drag state
  const [dragLayerLabel, setDragLayerLabel] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Build + filter element list
  const allEntries = useMemo(() => {
    if (!spread) return [];
    return buildElementList(spread, langCode);
  }, [spread, langCode]);

  const filteredEntries = useMemo(
    () => filterElementList(allEntries, elementFilter, allElements),
    [allEntries, elementFilter, allElements]
  );

  const layerGroups = useMemo(
    () => groupEntriesByLayer(filteredEntries),
    [filteredEntries]
  );

  const isFilterActive = !allElements;

  // === Handlers ===

  const handleItemClick = useCallback(
    (entry: ElementListEntry) => {
      onItemSelect({ type: entry.type, id: entry.id });
    },
    [onItemSelect]
  );

  const handleEditStart = useCallback((entry: ElementListEntry) => {
    // Textbox title is auto-derived — renaming not supported
    if (entry.type === "raw_textbox") return;
    // Lock-on-click gate: renaming is an in-spread edit → require the SCENE lock.
    if (!isEditable) {
      log.debug("handleEditStart", "blocked — spread not held", { id: entry.id });
      toastLockRequired();
      return;
    }
    setEditingItemId(entry.id);
    setEditValue(entry.title);
  }, [isEditable]);

  const handleRenameConfirm = useCallback(() => {
    if (!editingItemId || !editValue.trim()) {
      setEditingItemId(null);
      return;
    }
    // Defense-in-depth: a lock loss while the inline editor is open must not persist.
    if (!isEditable) {
      log.debug("handleRenameConfirm", "blocked — spread not held", { editingItemId });
      toastLockRequired();
      setEditingItemId(null);
      return;
    }
    const entry = allEntries.find((e) => e.id === editingItemId);
    if (!entry) {
      setEditingItemId(null);
      return;
    }

    log.debug("handleRenameConfirm", "renaming", {
      id: entry.id,
      type: entry.type,
      title: editValue,
    });

    const titleUpdate = { title: editValue.trim() };
    if (entry.type === "raw_image") {
      actions.updateRawImage(
        selectedSpreadId,
        entry.id,
        titleUpdate as Partial<SpreadImage>
      );
    } else if (entry.type === "shape") {
      actions.updateRetouchShape(
        selectedSpreadId,
        entry.id,
        titleUpdate as Partial<SpreadShape>
      );
    }

    setEditingItemId(null);
  }, [editingItemId, editValue, allEntries, actions, selectedSpreadId, isEditable]);

  // === Drag and drop handlers ===

  const handleDragStart = useCallback((index: number, layerLabel: string) => {
    setDragIndex(index);
    setDragLayerLabel(layerLabel);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  /**
   * Reorder by replacing the spread's raw array for the element type. All entries within a layer
   * share the same type (raw_image / raw_textbox), so we splice the spread's source array directly
   * and call updateIllustrationSpread — an in-spread SCENE edit captured by the held session on
   * release. `shapes` is NO LONGER reorderable here: it is a RETOUCH-owned key, so a scene rtype-6
   * merge would DROP the reorder (SCENE_OWNED_KEYS excludes `shapes`). Shape ordering belongs to the
   * Objects space now — shape rows are non-draggable (ADR-044 §Revision 2026-07-10).
   */
  const handleLayerDrop = useCallback(
    (targetIndex: number, group: LayerGroup) => {
      if (
        dragIndex === null ||
        dragIndex === targetIndex ||
        dragLayerLabel !== group.layer.label
      ) {
        setDragIndex(null);
        setDragLayerLabel(null);
        return;
      }

      if (!spread) return;

      // Lock-on-click gate: reorder is an in-spread edit → require the SCENE lock.
      if (!isEditable) {
        log.debug("handleLayerDrop", "blocked — spread not held", { layer: group.layer.label });
        toastLockRequired();
        setDragIndex(null);
        setDragLayerLabel(null);
        return;
      }

      log.info("handleLayerDrop", "reordering within layer", {
        layer: group.layer.label,
        from: dragIndex,
        to: targetIndex,
      });

      // Map visual group indices back to source-array positions via entry IDs,
      // because group entries are z-index-sorted while raw arrays are insertion-ordered.
      const draggedEntry = group.entries[dragIndex];
      const targetEntry = group.entries[targetIndex];
      if (!draggedEntry || !targetEntry) return;

      const entryType = draggedEntry.type;

      if (entryType === "raw_image") {
        const arr = [...(spread.raw_images ?? [])];
        const fromIdx = arr.findIndex((i) => i.id === draggedEntry.id);
        const toIdx = arr.findIndex((i) => i.id === targetEntry.id);
        if (fromIdx === -1 || toIdx === -1) return;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        actions.updateIllustrationSpread(selectedSpreadId, { raw_images: arr });
      } else if (entryType === "raw_textbox") {
        const arr = [...(spread.raw_textboxes ?? [])];
        const fromIdx = arr.findIndex((t) => t.id === draggedEntry.id);
        const toIdx = arr.findIndex((t) => t.id === targetEntry.id);
        if (fromIdx === -1 || toIdx === -1) return;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        actions.updateIllustrationSpread(selectedSpreadId, {
          raw_textboxes: arr,
        });
      }
      // NOTE: no `shape` branch — shape reorder intentionally removed (see doc-comment above).

      setDragIndex(null);
      setDragLayerLabel(null);
    },
    [dragIndex, dragLayerLabel, spread, actions, selectedSpreadId, isEditable]
  );

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragLayerLabel(null);
  }, []);

  // NOT lock-gated itself — callers must only invoke it while the SCENE lock is HELD (mutating
  // earlier bakes the element into the session baseline → clean diff → silently unsaved).
  const performAddElement = useCallback(
    (type: SpreadElementType) => {
      log.info("performAddElement", "adding", { type });

      if (type === "raw_image") {
        const newId = crypto.randomUUID();
        actions.addRawImage(selectedSpreadId, {
          id: newId,
          ...NEW_ELEMENT_DEFAULTS.image,
        } as SpreadImage);
        onItemSelect({ type, id: newId });
      } else if (type === "shape") {
        const newId = crypto.randomUUID();
        const shapeDef = bookShape ?? FALLBACK_SHAPE;
        actions.addRetouchShape(selectedSpreadId, {
          id: newId,
          ...NEW_ELEMENT_DEFAULTS.shape,
          fill: shapeDef.fill,
          outline: shapeDef.outline,
        } as SpreadShape);
        onItemSelect({ type, id: newId });
      } else if (type === "raw_textbox") {
        const defaults = createDefaultTextbox(langCode, bookTypography);
        const newId = defaults.id;
        actions.addRawTextbox(selectedSpreadId, defaults);
        onItemSelect({ type, id: newId });
      }

      setIsAddOpen(false);
    },
    [actions, selectedSpreadId, langCode, bookShape, bookTypography, onItemSelect]
  );

  // First-click lock gate: route the add through runWithLock so the first click acquires the SCENE
  // lock and the add runs once HELD (legacy toast gate only when no gate is wired).
  const handleAddElement = useCallback(
    (type: SpreadElementType) => {
      if (runWithLock) {
        runWithLock(() => performAddElement(type));
        return;
      }
      if (!isEditable) {
        log.debug("handleAddElement", "blocked — spread not held", { type });
        toastLockRequired();
        setIsAddOpen(false);
        return;
      }
      performAddElement(type);
    },
    [isEditable, performAddElement, runWithLock]
  );

  // Eager-acquire on "+" click (popover open): start acquiring immediately so the lock is already
  // HELD by the time the user picks an element type (no-op action just warms the lock).
  const handleAddOpenChange = useCallback(
    (open: boolean) => {
      // Without a gate the popover stays lock-gated (legacy behavior).
      if (!runWithLock && !isEditable) return;
      setIsAddOpen(open);
      if (open && !isEditable) runWithLock?.(() => {});
    },
    [isEditable, runWithLock]
  );

  // Filter toggles
  const handleToggleElement = useCallback((type: SpreadElementType) => {
    setAllElements(false);
    setElementFilter((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      if (next.size === ALL_ELEMENT_TYPES.length) setAllElements(true);
      return next;
    });
  }, []);

  const handleToggleAllElements = useCallback(() => {
    setAllElements((prev) => {
      if (!prev) setElementFilter(new Set(ALL_ELEMENT_TYPES));
      else setElementFilter(new Set());
      return !prev;
    });
  }, []);

  if (!spread) return null;

  return (
    <nav
      className="w-[280px] flex flex-col h-full border-r bg-background"
      role="listbox"
      aria-label="Elements list"
    >
      {/* Header with Filter & Add popovers */}
      <div className="flex items-center h-14 px-3 border-b gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "p-1 rounded hover:bg-muted transition-colors",
                isFilterActive && "text-blue-500"
              )}
              aria-label="Toggle filter"
            >
              <Filter className="w-4 h-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={8} className="w-56">
            <FilterPopoverContent
              elementFilter={elementFilter}
              allElements={allElements}
              onToggleElement={handleToggleElement}
              onToggleAllElements={handleToggleAllElements}
            />
          </PopoverContent>
        </Popover>

        <span className="flex-1 font-semibold text-sm">Elements</span>

        {/* Add element — 2-state (never hidden): disabled + greyed when the spread is not held. */}
        <Popover open={isAddOpen} onOpenChange={handleAddOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "p-1 rounded transition-colors",
                isEditable || runWithLock
                  ? "hover:bg-muted"
                  : "opacity-40 cursor-not-allowed"
              )}
              aria-label="Add element"
              // First-click gate: with runWithLock wired the "+" is always clickable — the click
              // itself acquires the SCENE lock (legacy disable only without the gate).
              disabled={!isEditable && !runWithLock}
              title={isEditable || runWithLock ? "Add element" : "Click this spread to edit"}
            >
              <Plus className="w-4 h-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="w-48 p-1">
            <AddElementPopoverContent onAdd={handleAddElement} />
          </PopoverContent>
        </Popover>
      </div>

      {/* Body */}
      {filteredEntries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {allEntries.length === 0 ? "No elements" : "No matching elements"}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {layerGroups.map((group) => (
            <div key={group.layer.label}>
              {/* Layer divider — no visibility toggle for illustration elements */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/60 border-y border-border/50 select-none">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.layer.label}
                </span>
              </div>

              {/* Items */}
              {group.entries.map((entry, index) => (
                <SpreadsSidebarListItem
                  key={entry.id}
                  entry={entry}
                  index={index}
                  isSelected={selectedItemId?.id === entry.id}
                  isEditable={isEditable}
                  editingId={editingItemId}
                  editValue={editValue}
                  onEditValueChange={setEditValue}
                  onSelect={() => handleItemClick(entry)}
                  onEditStart={() => handleEditStart(entry)}
                  onRenameConfirm={handleRenameConfirm}
                  dragIndex={
                    dragLayerLabel === group.layer.label ? dragIndex : null
                  }
                  onDragStart={(idx) => handleDragStart(idx, group.layer.label)}
                  onDragOver={handleDragOver}
                  onDrop={(idx) => handleLayerDrop(idx, group)}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

export default SpreadsSidebar;
