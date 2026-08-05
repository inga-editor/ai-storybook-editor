// objects-sidebar.tsx - Left sidebar listing all objects in selected spread
// Items are grouped by z-index layers with dividers; drag is restricted within same layer.
"use client";

import { useState, useMemo, useCallback } from "react";
import { Plus } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  AddElementPopoverContent,
  LayerDivider,
} from "./objects-sidebar-popovers";
import {
  useRetouchSpreadById,
  useSnapshotActions,
} from "@/stores/snapshot-store/selectors";
import { usePlayEdition } from "@/stores/animation-playback-store";
import { useBookShape, useBookStepTypography } from "@/stores/book-store";
import { FALLBACK_SHAPE, mapTypographyToTextbox } from "@/constants/book-defaults";
import { DEFAULT_TYPOGRAPHY } from "@/constants/config-constants";
import { AUDIO_DEFAULTS } from "@/constants/spread-constants";
import { createLogger } from "@/utils/logger";
import { toastLockRequired } from "@/utils/collab-save-toasts";
import { useLanguageCode } from "@/stores/editor-settings-store";
import {
  ObjectListItem,
  type ObjectListEntry,
} from "./objects-sidebar-list-item";
import { CreateCompositeModal } from "./create-composite-modal";
import {
  buildObjectList,
  filterObjectList,
  groupEntriesByLayer,
  getLayerForType,
  type LayerGroup,
} from "./utils/object-list-builders";
import type { SelectedItem, ObjectElementType } from "./objects-creative-space";
import type {
  SpreadImage,
  SpreadTextbox,
  SpreadShape,
  SpreadVideo,
  SpreadAudio,
  SpreadAutoPic,
  SpreadAutoAudio,
} from "@/types/canvas-types";

const log = createLogger("Editor", "ObjectsSidebar");

const ALL_ELEMENT_TYPES: ObjectElementType[] = [
  "image",
  "textbox",
  "shape",
  "video",
  "audio",
  "auto_audio",
  "auto_pic",
];

/** Element types shown in the AddElement popover (composite is special — opens modal). */
const ADD_ELEMENT_TYPES: ObjectElementType[] = [
  "image",
  "textbox",
  "shape",
  "video",
  "audio",
  "auto_audio",
  "auto_pic",
  "composite",
];
// === Props ===

interface ObjectsSidebarProps {
  selectedSpreadId: string;
  selectedItemId: SelectedItem | null;
  onItemSelect: (item: SelectedItem | null) => void;
  /** Whether this editor holds the spread's retouch lock (ADR-044 lock-on-click). Item SELECTION is
   *  always allowed — it is the lock-acquiring interaction (parent acquires on onItemSelect). When
   *  false, mutating affordances (visibility toggle / reorder / rename / remove variant) are gated
   *  per-handler with a lock-required toast, matching SpreadsSidebar. Add-element instead AUTO-acquires
   *  via runWithLock and defers the add until the lock is held (mutating before acquire would bake
   *  the new element into the session baseline → never marked dirty → silently unsaved). Default true. */
  isEditable?: boolean;
  /** First-click lock gate (`useLockFirstAction` in the parent space): runs the action immediately
   *  when the retouch lock is held, else acquires the lock and defers the action until HELD. */
  runWithLock?: (action: () => void) => void;
}

// === Main Component ===

export function ObjectsSidebar({
  selectedSpreadId,
  selectedItemId,
  onItemSelect,
  isEditable = true,
  runWithLock,
}: ObjectsSidebarProps) {
  const spread = useRetouchSpreadById(selectedSpreadId);
  const actions = useSnapshotActions();
  const editorLangCode = useLanguageCode();
  const bookShape = useBookShape();
  const bookTypography = useBookStepTypography('retouch');
  const playEdition = usePlayEdition();

  // Local UI state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // Composite UX state
  const [expandedCompositeIds, setExpandedCompositeIds] = useState<Set<string>>(
    new Set()
  );
  // CreateCompositeModal open flag.
  const [isCreateCompositeOpen, setIsCreateCompositeOpen] = useState(false);
  // When set, the modal opens in edit mode for this composite. Cleared on close.
  const [editingCompositeId, setEditingCompositeId] = useState<string | null>(null);

  // Drag state: layerLabel tracks which layer the drag started in
  const [dragLayerLabel, setDragLayerLabel] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Build + filter object list
  const allEntries = useMemo(() => {
    if (!spread) return [];
    return buildObjectList(spread, editorLangCode);
  }, [spread, editorLangCode]);

  const filteredEntries = useMemo(
    () => filterObjectList(allEntries, new Set(ALL_ELEMENT_TYPES), true),
    [allEntries]
  );

  // Group filtered entries by layer (top z-index layer first)
  const layerGroups = useMemo(
    () => groupEntriesByLayer(filteredEntries),
    [filteredEntries]
  );

  // Composite candidate count: free image/auto_pic NOT yet in any composite.
  // Used to disable "Composite" entry in AddElement popover (need ≥ 2).
  const compositeCandidateCount = useMemo(() => {
    return allEntries.filter(
      (e) =>
        (e.type === "image" || e.type === "auto_pic") &&
        !e.parentCompositeId
    ).length;
  }, [allEntries]);

  // === Handlers ===

  const handleItemClick = useCallback(
    (entry: ObjectListEntry) => {
      // Composite group row → select composite itself
      if (entry.isComposite) {
        log.debug("handleItemClick", "composite group selected", {
          compositeId: entry.id,
        });
        onItemSelect({ type: "composite", id: entry.id });
        return;
      }
      // Composite child → resolve variant active per playEdition (fallback first)
      if (entry.parentCompositeId) {
        const composite = spread?.composites?.find(
          (c) => c.id === entry.parentCompositeId
        );
        if (composite) {
          const active =
            composite.variants.find((v) => v.edition === playEdition) ??
            composite.variants[0];
          if (active) {
            log.debug("handleItemClick", "composite child resolved variant", {
              compositeId: entry.parentCompositeId,
              variantId: active.id,
              edition: active.edition,
              playEdition,
            });
            onItemSelect({ type: active.type, id: active.id });
            return;
          }
        }
      }
      onItemSelect({ type: entry.type, id: entry.id });
    },
    [onItemSelect, spread, playEdition]
  );

  const handleToggleExpand = useCallback((compositeId: string) => {
    setExpandedCompositeIds((prev) => {
      const next = new Set(prev);
      if (next.has(compositeId)) next.delete(compositeId);
      else next.add(compositeId);
      log.debug("handleToggleExpand", "toggled", {
        compositeId,
        expanded: next.has(compositeId),
      });
      return next;
    });
  }, []);

  const handleRemoveFromComposite = useCallback(
    (compositeId: string, variantId: string) => {
      // Lock-on-click gate: in-spread edit → require the retouch lock.
      if (!isEditable) {
        log.debug("handleRemoveFromComposite", "blocked — spread not held", { compositeId });
        toastLockRequired();
        return;
      }
      const composite = spread?.composites?.find((c) => c.id === compositeId);
      if (!composite) {
        log.warn("handleRemoveFromComposite", "composite not found", {
          compositeId,
        });
        return;
      }
      // Will composite be auto-deleted? (Slice removes when < 2 variants.)
      const remaining = composite.variants.filter((v) => v.id !== variantId);
      const willAutoDelete = remaining.length < 2;
      if (willAutoDelete) {
        const ok = window.confirm(
          "Removing this variant will delete the composite (needs at least 2 variants). Continue?"
        );
        if (!ok) {
          log.debug("handleRemoveFromComposite", "user cancelled", {
            compositeId,
            variantId,
          });
          return;
        }
      }
      log.info("handleRemoveFromComposite", "removing variant", {
        compositeId,
        variantId,
        willAutoDelete,
      });
      actions.removeVariantFromComposite(
        selectedSpreadId,
        compositeId,
        variantId
      );
    },
    [spread, actions, selectedSpreadId, isEditable]
  );

  const handleVisibilityToggle = useCallback(
    (entry: ObjectListEntry) => {
      // Lock-on-click gate: in-spread edit → require the retouch lock.
      if (!isEditable) {
        log.debug("handleVisibilityToggle", "blocked — spread not held", { id: entry.id });
        toastLockRequired();
        return;
      }
      const newVisible = !entry.editorVisible;
      log.debug("handleVisibilityToggle", "toggling visibility", {
        id: entry.id,
        type: entry.type,
        newVisible,
      });

      const updates = { editor_visible: newVisible };
      switch (entry.type) {
        case "image":
          actions.updateRetouchImage(selectedSpreadId, entry.id, updates);
          break;
        case "textbox":
          actions.updateRetouchTextbox(
            selectedSpreadId,
            entry.id,
            updates as Partial<SpreadTextbox>
          );
          break;
        case "shape":
          actions.updateRetouchShape(selectedSpreadId, entry.id, updates);
          break;
        case "video":
          actions.updateRetouchVideo(selectedSpreadId, entry.id, updates);
          break;
        case "audio":
          actions.updateRetouchAudio(selectedSpreadId, entry.id, updates);
          break;
        case "auto_audio":
          actions.updateRetouchAutoAudio(selectedSpreadId, entry.id, updates);
          break;
        case "auto_pic":
          actions.updateRetouchAutoPic(selectedSpreadId, entry.id, updates);
          break;
        case "composite":
          // Slice cascades visibility to variant items automatically (Phase 1 D5).
          actions.updateRetouchComposite(selectedSpreadId, entry.id, updates);
          break;
        case "raw_image":
          actions.updateRawImage(selectedSpreadId, entry.id, updates);
          break;
        case "raw_textbox":
          actions.updateRawTextbox(
            selectedSpreadId,
            entry.id,
            updates as Partial<SpreadTextbox>
          );
          break;
      }
    },
    [actions, selectedSpreadId, isEditable]
  );

  const handleLayerVisibilityToggle = useCallback(
    (group: LayerGroup) => {
      // Lock-on-click gate: in-spread edit → require the retouch lock.
      if (!isEditable) {
        log.debug("handleLayerVisibilityToggle", "blocked — spread not held", {
          layer: group.layer.label,
        });
        toastLockRequired();
        return;
      }
      const layerEntries = allEntries.filter((e) => {
        const eLayer = getLayerForType(e.type);
        return eLayer?.label === group.layer.label;
      });
      const anyVisible = layerEntries.some((e) => e.editorVisible);
      const newVisible = !anyVisible;

      log.debug("handleLayerVisibilityToggle", "toggling layer", {
        layer: group.layer.label,
        count: layerEntries.length,
        newVisible,
      });

      for (const entry of layerEntries) {
        const updates = { editor_visible: newVisible };
        switch (entry.type) {
          case "image":
            actions.updateRetouchImage(selectedSpreadId, entry.id, updates);
            break;
          case "textbox":
            actions.updateRetouchTextbox(
              selectedSpreadId,
              entry.id,
              updates as Partial<SpreadTextbox>
            );
            break;
          case "shape":
            actions.updateRetouchShape(selectedSpreadId, entry.id, updates);
            break;
          case "video":
            actions.updateRetouchVideo(selectedSpreadId, entry.id, updates);
            break;
          case "audio":
            actions.updateRetouchAudio(selectedSpreadId, entry.id, updates);
            break;
          case "auto_audio":
            actions.updateRetouchAutoAudio(selectedSpreadId, entry.id, updates);
            break;
          case "auto_pic":
            actions.updateRetouchAutoPic(selectedSpreadId, entry.id, updates);
            break;
          case "composite":
            actions.updateRetouchComposite(selectedSpreadId, entry.id, updates);
            break;
          case "raw_image":
            actions.updateRawImage(selectedSpreadId, entry.id, updates);
            break;
          case "raw_textbox":
            actions.updateRawTextbox(
              selectedSpreadId,
              entry.id,
              updates as Partial<SpreadTextbox>
            );
            break;
        }
      }
    },
    [allEntries, actions, selectedSpreadId, isEditable]
  );

  const handlePlayerVisibilityToggle = useCallback(
    (entry: ObjectListEntry) => {
      // Lock-on-click gate: in-spread edit → require the retouch lock.
      if (!isEditable) {
        log.debug("handlePlayerVisibilityToggle", "blocked — spread not held", { id: entry.id });
        toastLockRequired();
        return;
      }
      const newVisible = !entry.playerVisible;
      log.debug("handlePlayerVisibilityToggle", "toggling player_visible", {
        id: entry.id,
        type: entry.type,
        newVisible,
      });

      const updates = { player_visible: newVisible };
      switch (entry.type) {
        case "image":
          actions.updateRetouchImage(selectedSpreadId, entry.id, updates);
          break;
        case "textbox":
          actions.updateRetouchTextbox(
            selectedSpreadId,
            entry.id,
            updates as Partial<SpreadTextbox>
          );
          break;
        case "shape":
          actions.updateRetouchShape(selectedSpreadId, entry.id, updates);
          break;
        case "video":
          actions.updateRetouchVideo(selectedSpreadId, entry.id, updates);
          break;
        case "audio":
          actions.updateRetouchAudio(selectedSpreadId, entry.id, updates);
          break;
        case "auto_audio":
          // player_visible locked false — toggle is no-op
          break;
        case "auto_pic":
          actions.updateRetouchAutoPic(selectedSpreadId, entry.id, updates);
          break;
        case "composite":
          actions.updateRetouchComposite(selectedSpreadId, entry.id, updates);
          break;
        case "raw_image":
          actions.updateRawImage(selectedSpreadId, entry.id, updates);
          break;
        case "raw_textbox":
          actions.updateRawTextbox(
            selectedSpreadId,
            entry.id,
            updates as Partial<SpreadTextbox>
          );
          break;
      }
    },
    [actions, selectedSpreadId, isEditable]
  );

  const handleEditStart = useCallback((entry: ObjectListEntry) => {
    if (entry.type === "textbox") return; // textbox title is auto-derived
    // Lock-on-click gate: rename / composite edit is an in-spread edit → require the retouch lock.
    if (!isEditable) {
      log.debug("handleEditStart", "blocked — spread not held", { id: entry.id });
      toastLockRequired();
      return;
    }
    // Composite groups don't rename inline — pencil opens the edit modal so the
    // user can also adjust variants/editions, not just the title.
    if (entry.type === "composite") {
      setEditingCompositeId(entry.id);
      setIsCreateCompositeOpen(true);
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
    switch (entry.type) {
      case "image":
        actions.updateRetouchImage(selectedSpreadId, entry.id, titleUpdate);
        break;
      case "video":
        actions.updateRetouchVideo(selectedSpreadId, entry.id, titleUpdate);
        break;
      case "audio":
        actions.updateRetouchAudio(selectedSpreadId, entry.id, titleUpdate);
        break;
      case "auto_audio":
        actions.updateRetouchAutoAudio(selectedSpreadId, entry.id, titleUpdate);
        break;
      case "shape":
        actions.updateRetouchShape(
          selectedSpreadId,
          entry.id,
          titleUpdate as Partial<SpreadShape>
        );
        break;
      case "auto_pic":
        actions.updateRetouchAutoPic(selectedSpreadId, entry.id, titleUpdate);
        break;
    }
    setEditingItemId(null);
  }, [editingItemId, editValue, allEntries, actions, selectedSpreadId, isEditable]);

  // === Layer-scoped DnD handlers ===

  const handleDragStart = useCallback((index: number, layerLabel: string) => {
    setDragIndex(index);
    setDragLayerLabel(layerLabel);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  /**
   * Handle drop within a specific layer group.
   * Reassigns z-index values within that layer's range only.
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

      // Lock-on-click gate: reorder is an in-spread edit → require the retouch lock.
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

      const reordered = [...group.entries];
      const [moved] = reordered.splice(dragIndex, 1);
      reordered.splice(targetIndex, 0, moved);

      const { min, max } = group.layer;
      const count = reordered.length;

      // Distribute z-index within layer range, highest first
      reordered.forEach((entry, idx) => {
        const newZIndex = Math.min(max, min + (count - 1 - idx));

        switch (entry.type) {
          case "image":
            actions.updateRetouchImage(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            });
            break;
          case "video":
            actions.updateRetouchVideo(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            });
            break;
          case "audio":
            actions.updateRetouchAudio(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            });
            break;
          case "auto_audio":
            actions.updateRetouchAutoAudio(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            });
            break;
          case "shape":
            actions.updateRetouchShape(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            } as Partial<SpreadShape>);
            break;
          case "textbox":
            actions.updateRetouchTextbox(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            } as Partial<SpreadTextbox>);
            break;
          case "auto_pic":
            actions.updateRetouchAutoPic(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            });
            break;
          case "composite":
            // Slice cascades z-index to variant children (image/auto_pic).
            actions.updateRetouchComposite(selectedSpreadId, entry.id, {
              "z-index": newZIndex,
            });
            break;
        }
      });

      setDragIndex(null);
      setDragLayerLabel(null);
    },
    [dragIndex, dragLayerLabel, actions, selectedSpreadId, isEditable]
  );

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragLayerLabel(null);
  }, []);

  // Add element with z-index within its layer range. NOT lock-gated itself — callers must only
  // invoke it while the retouch lock is HELD (mutating earlier bakes the element into the session
  // baseline → clean diff → silently unsaved).
  const performAddElement = useCallback(
    (type: ObjectElementType) => {
      log.info("performAddElement", "adding", { type });

      // Composite is created via dedicated modal (Phase 3) — short-circuit.
      if (type === "composite") {
        log.debug("performAddElement", "open create-composite modal");
        setIsCreateCompositeOpen(true);
        return;
      }

      // Determine z-index: top of its layer
      const layer = getLayerForType(type);
      let newZIndex: number = layer ? layer.min : 1;
      if (layer) {
        const sameLayerEntries = allEntries.filter((e) => {
          const eLayer = getLayerForType(e.type);
          return eLayer === layer;
        });
        if (sameLayerEntries.length > 0) {
          const maxInLayer = Math.max(...sameLayerEntries.map((e) => e.zIndex));
          newZIndex = Math.min(maxInLayer + 1, layer.max);
        }
      }

      const newId = crypto.randomUUID();

      switch (type) {
        case "image":
          actions.addRetouchImage(selectedSpreadId, {
            id: newId,
            title: "New Image",
            geometry: { x: 10, y: 10, w: 30, h: 30 },
            illustrations: [],
            "z-index": newZIndex,
            editor_visible: true,
            player_visible: true,
          } as SpreadImage);
          break;
        case "textbox": {
          const typo = mapTypographyToTextbox(bookTypography?.[editorLangCode] ?? DEFAULT_TYPOGRAPHY);
          actions.addRetouchTextbox(selectedSpreadId, {
            id: newId,
            title: "New Text",
            [editorLangCode]: {
              text: "",
              geometry: { x: 10, y: 10, w: 25, h: 5 },
              typography: typo,
            },
            editor_visible: true,
            player_visible: true,
          } as SpreadTextbox);
          break;
        }
        case "shape": {
          const shapeDef = bookShape ?? FALLBACK_SHAPE;
          actions.addRetouchShape(selectedSpreadId, {
            id: newId,
            type: "rectangle",
            geometry: { x: 10, y: 10, w: 20, h: 20 },
            fill: shapeDef.fill,
            outline: shapeDef.outline,
            editor_visible: true,
            player_visible: true,
          } as SpreadShape);
          break;
        }
        case "video":
          actions.addRetouchVideo(selectedSpreadId, {
            id: newId,
            title: "New Video",
            geometry: { x: 10, y: 10, w: 30, h: 20 },
            "z-index": newZIndex,
            editor_visible: true,
            player_visible: true,
            tags: [],
          } as SpreadVideo);
          break;
        case "audio":
          actions.addRetouchAudio(selectedSpreadId, {
            id: newId,
            title: AUDIO_DEFAULTS.AUDIO_TITLE,
            geometry: { x: 10, y: 10, w: 0, h: 0 },
            "z-index": newZIndex,
            editor_visible: true,
            player_visible: true,
            tags: [],
          } as SpreadAudio);
          break;
        case "auto_audio": {
          const autoAudioCount = allEntries.filter((e) => e.type === "auto_audio").length;
          actions.addRetouchAutoAudio(selectedSpreadId, {
            id: newId,
            title: AUDIO_DEFAULTS.AUTO_AUDIO_TITLE,
            geometry: { x: 1 + autoAudioCount * 2, y: 90 },
            "z-index": newZIndex,
            editor_visible: true,
            player_visible: false, // literal locked
            tags: [],
          } as SpreadAutoAudio);
          break;
        }
        case "auto_pic":
          actions.addRetouchAutoPic(selectedSpreadId, {
            id: newId,
            title: "New Auto Pic",
            geometry: { x: 10, y: 10, w: 30, h: 20 },
            "z-index": newZIndex,
            editor_visible: true,
            player_visible: true,
            tags: [],
          } as SpreadAutoPic);
          break;
      }

      // Auto-select newly added item
      onItemSelect({ type, id: newId });
    },
    [actions, selectedSpreadId, allEntries, editorLangCode, bookShape, bookTypography, onItemSelect]
  );

  // Eager-acquire on "+" click (popover open): start acquiring immediately so the lock is already
  // HELD by the time the user picks an element type. The queued action is a no-op — the actual add
  // still routes through runWithLock below (which runs sync once held / re-queues while acquiring).
  const handleAddOpenChange = useCallback(
    (open: boolean) => {
      setIsAddOpen(open);
      if (open && !isEditable) runWithLock?.(() => {});
    },
    [isEditable, runWithLock]
  );

  // First-click lock gate: adding before acquire would bake the element into the session baseline
  // (silently unsaved) — the gate defers the add until the lock is HELD.
  const handleAddElement = useCallback(
    (type: ObjectElementType) => {
      if (runWithLock) {
        runWithLock(() => performAddElement(type));
        return;
      }
      // No lock-gate wiring (legacy caller) — keep the explicit toast gate.
      if (!isEditable) {
        log.debug("handleAddElement", "blocked — spread not held", { type });
        toastLockRequired();
        return;
      }
      performAddElement(type);
    },
    [isEditable, performAddElement, runWithLock]
  );

  if (!spread) return null;

  return (
    <>
    <nav
      className="w-[280px] flex flex-col h-full border-r bg-background"
      role="listbox"
      aria-label="Objects list"
    >
      {/* Header with Add element popover */}
      <div className="flex items-center h-14 px-3 border-b gap-2">
        <span className="flex-1 font-semibold text-sm">Objects</span>

        <Popover open={isAddOpen} onOpenChange={handleAddOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="p-1 rounded hover:bg-muted transition-colors"
              aria-label="Add element"
            >
              <Plus className="w-4 h-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="w-48 p-1">
            <AddElementPopoverContent
              compositeCandidateCount={compositeCandidateCount}
              addElementTypes={ADD_ELEMENT_TYPES}
              onAdd={(type) => {
                handleAddElement(type);
                setIsAddOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>

      {filteredEntries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          No elements
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {layerGroups.map((group) => {
            const layerItems = allEntries.filter(
              (e) => getLayerForType(e.type)?.label === group.layer.label
            );
            const layerAllVisible =
              layerItems.length > 0 && layerItems.some((e) => e.editorVisible);
            return (
              <div key={group.layer.label}>
                <LayerDivider
                  label={group.layer.label}
                  allVisible={layerAllVisible}
                  onToggleVisibility={() =>
                    handleLayerVisibilityToggle(group)
                  }
                />
                {/* Items within this layer */}
                {group.entries.map((entry, index) => {
                  const isComposite = entry.isComposite === true;
                  const isExpanded =
                    isComposite && expandedCompositeIds.has(entry.id);
                  return (
                    <div key={entry.id}>
                      <ObjectListItem
                        entry={entry}
                        index={index}
                        isSelected={selectedItemId?.id === entry.id}
                        editingId={editingItemId}
                        editValue={editValue}
                        onEditValueChange={setEditValue}
                        onSelect={() => handleItemClick(entry)}
                        onVisibilityToggle={() => handleVisibilityToggle(entry)}
                        onPlayerVisibilityToggle={() =>
                          handlePlayerVisibilityToggle(entry)
                        }
                        onEditStart={() => handleEditStart(entry)}
                        onRenameConfirm={handleRenameConfirm}
                        dragIndex={
                          dragLayerLabel === group.layer.label ? dragIndex : null
                        }
                        onDragStart={(idx) =>
                          handleDragStart(idx, group.layer.label)
                        }
                        onDragOver={handleDragOver}
                        onDrop={(idx) => handleLayerDrop(idx, group)}
                        onDragEnd={handleDragEnd}
                        isExpanded={isExpanded}
                        onToggleExpand={
                          isComposite
                            ? () => handleToggleExpand(entry.id)
                            : undefined
                        }
                      />
                      {/* Composite children render (only when expanded). */}
                      {isComposite && isExpanded && entry.children?.map((child) => (
                        <ObjectListItem
                          key={`${entry.id}::${child.id}`}
                          entry={child}
                          index={-1}
                          isSelected={selectedItemId?.id === child.id}
                          editingId={editingItemId}
                          editValue={editValue}
                          onEditValueChange={setEditValue}
                          onSelect={() => handleItemClick(child)}
                          onVisibilityToggle={() => handleVisibilityToggle(child)}
                          onPlayerVisibilityToggle={() =>
                            handlePlayerVisibilityToggle(child)
                          }
                          onEditStart={() => handleEditStart(child)}
                          onRenameConfirm={handleRenameConfirm}
                          dragIndex={null}
                          onDragStart={() => undefined}
                          onDragOver={() => undefined}
                          onDrop={() => undefined}
                          onDragEnd={() => undefined}
                          onRemoveFromComposite={() =>
                            handleRemoveFromComposite(entry.id, child.id)
                          }
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </nav>
    <CreateCompositeModal
      open={isCreateCompositeOpen}
      spreadId={selectedSpreadId}
      onClose={() => {
        setIsCreateCompositeOpen(false);
        setEditingCompositeId(null);
      }}
      onCreated={(id) => onItemSelect({ type: "composite", id })}
      compositeToEdit={
        editingCompositeId
          ? spread?.composites?.find((c) => c.id === editingCompositeId)
          : undefined
      }
    />
    </>
  );
}

export default ObjectsSidebar;
