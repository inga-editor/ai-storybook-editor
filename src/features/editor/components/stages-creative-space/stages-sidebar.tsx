// stages-sidebar.tsx - Left sidebar listing all stages with filter, add, drag-reorder, and rename.

import { useState, useMemo, useCallback } from "react";
import { Filter, Plus, CirclePlus, Library } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StagesSidebarItem } from "./stages-sidebar-item";
import { CreateAssetDialog } from "@/features/editor/components/shared-components/create-asset-dialog";
import {
  useStages,
  useSnapshotActions,
} from "@/stores/snapshot-store/selectors";
import { useCurrentBook } from "@/stores/book-store";
import { useLocations } from "@/stores/location-store";
import { BASE_VARIANT_KEY, BASE_VARIANT_NAME } from "@/constants/variant-constants";
import type { Stage } from "@/types/stage-types";
import { cn } from "@/utils/utils";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "StagesSidebar");

interface StagesSidebarProps {
  stageKeys: string[];
  selectedStageKey: string | null;
  /** USER select (row click / arrow-nav) → set display = session target (lockless entity save). */
  onStageSelect: (key: string) => void;
  /** Collab save-session gate (ADR-044 addendum 2, lockless): only the SELECTED item may be
   *  renamed/deleted or have its location edited (its session is held). */
  editable: boolean;
  /** Called after deleting the held stage so the space can drop the lock (→ release-save). */
  onEntityDeleted: (key: string) => void;
}

/** Build a blank Stage record ready for addStage */
function buildNewStage(name: string, key: string, order: number): Stage {
  return {
    order,
    name,
    key,
    location_id: "",
    variants: [
      {
        name: BASE_VARIANT_NAME,
        key: BASE_VARIANT_KEY,
        type: 0,
        visual_description: "",
        temporal: { era: "", season: "", weather: "", time_of_day: "" },
        sensory: {
          atmosphere: "",
          soundscape: "",
          lighting: "",
          color_palette: "",
        },
        emotional: { mood: "" },
        illustrations: [],
        image_references: [],
      },
    ],
    sounds: [],
  };
}

export function StagesSidebar({
  stageKeys,
  selectedStageKey,
  onStageSelect,
  editable,
  onEntityDeleted,
}: StagesSidebarProps) {
  const allStages = useStages();
  const { addStage, updateStage, deleteStage, reorderStages } =
    useSnapshotActions();
  const currentBook = useCurrentBook();
  const locations = useLocations();

  // UI state
  const [expandedStageKey, setExpandedStageKey] = useState<string | null>(null);
  const [editingNameKey, setEditingNameKey] = useState<string | null>(null);
  const [isAddPopoverOpen, setIsAddPopoverOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false);
  const [filterLocationId, setFilterLocationId] = useState<string | null>(null);
  const [filterStory, setFilterStory] = useState<string | null>(null);

  // Drag state
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);

  // Filter active indicator
  const isFilterActive = filterLocationId !== null || filterStory !== null;

  // Filtered stage keys: filter by location_id if set
  const filteredStageKeys = useMemo(() => {
    if (filterLocationId === null) return stageKeys;
    return stageKeys.filter((key) => {
      const stage = allStages.find((s) => s.key === key);
      return stage?.location_id === filterLocationId;
    });
  }, [stageKeys, allStages, filterLocationId]);

  // === Handlers ===

  const handleToggle = useCallback((key: string) => {
    setExpandedStageKey((prev) => (prev === key ? null : key));
  }, []);

  const handleCreateFromScratch = useCallback(() => {
    log.info("handleCreateFromScratch", "opening create modal");
    setIsAddPopoverOpen(false);
    setIsCreateModalOpen(true);
  }, []);

  const handleConfirmCreate = useCallback(
    (name: string, key: string) => {
      log.info("handleConfirmCreate", "creating stage", { key });
      const maxOrder = allStages.reduce((max, s) => Math.max(max, s.order), -1);
      const newStage = buildNewStage(name, key, maxOrder + 1);
      addStage(newStage);
      onStageSelect(newStage.key);
      setExpandedStageKey(newStage.key);
    },
    [allStages, addStage, onStageSelect]
  );

  const handleDeleteStage = useCallback(
    (key: string) => {
      // Collab gate: delete is an owned-node mutation → only the SELECTED+held stage may be deleted.
      // After delete, notify the space to drop the lock so the held session release-saves.
      if (!editable || key !== selectedStageKey) {
        log.debug("handleDeleteStage", "blocked — stage not held", { key });
        return;
      }
      log.info("handleDeleteStage", "deleting stage", { key });
      deleteStage(key);
      onEntityDeleted(key);
      if (expandedStageKey === key) setExpandedStageKey(null);
      if (editingNameKey === key) setEditingNameKey(null);
    },
    [deleteStage, onEntityDeleted, editable, selectedStageKey, expandedStageKey, editingNameKey]
  );

  const handleRenameStage = useCallback(
    (key: string, newName: string) => {
      // Collab gate: rename mutates the entity node → only the SELECTED+held stage.
      if (!editable || key !== selectedStageKey) {
        log.debug("handleRenameStage", "blocked — stage not held", { key });
        setEditingNameKey(null);
        return;
      }
      const trimmed = newName.trim();
      if (trimmed) {
        log.debug("handleRenameStage", "renaming", { key, newName: trimmed });
        updateStage(key, { name: trimmed });
      }
      setEditingNameKey(null);
    },
    [updateStage, editable, selectedStageKey]
  );

  const handleDrop = useCallback(
    (toFilteredIndex: number) => {
      if (dragFromIndex === null || dragFromIndex === toFilteredIndex) {
        setDragFromIndex(null);
        return;
      }
      // Map filtered indices to full-array indices for correct reorder
      const fromKey = filteredStageKeys[dragFromIndex];
      const toKey = filteredStageKeys[toFilteredIndex];
      const fromFull = stageKeys.indexOf(fromKey);
      const toFull = stageKeys.indexOf(toKey);
      if (fromFull !== -1 && toFull !== -1) {
        log.info("handleDrop", "reordering stages", {
          from: fromFull,
          to: toFull,
        });
        reorderStages(fromFull, toFull);
      }
      setDragFromIndex(null);
    },
    [dragFromIndex, filteredStageKeys, stageKeys, reorderStages]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filteredStageKeys.length === 0) return;
      const currentIndex = selectedStageKey
        ? filteredStageKeys.indexOf(selectedStageKey)
        : -1;

      switch (e.key) {
        case "ArrowUp": {
          e.preventDefault();
          const prevIndex =
            currentIndex > 0 ? currentIndex - 1 : filteredStageKeys.length - 1;
          onStageSelect(filteredStageKeys[prevIndex]);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const nextIndex =
            currentIndex < filteredStageKeys.length - 1 ? currentIndex + 1 : 0;
          onStageSelect(filteredStageKeys[nextIndex]);
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (selectedStageKey) {
            handleToggle(selectedStageKey);
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          setExpandedStageKey(null);
          break;
        }
        case "F2": {
          e.preventDefault();
          if (selectedStageKey) {
            setEditingNameKey(selectedStageKey);
          }
          break;
        }
      }
    },
    [filteredStageKeys, selectedStageKey, onStageSelect, handleToggle]
  );

  const existingStageKeys = allStages.map((s) => s.key);

  return (
    <>
    <aside
      className="flex flex-col h-full border-r min-w-[280px] max-w-[320px] w-1/4"
      role="navigation"
      aria-label="Stages sidebar"
    >
      {/* Header */}
      <div className="flex items-center justify-between h-11 px-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          {/* Filter popover */}
          <Popover
            open={isFilterPopoverOpen}
            onOpenChange={setIsFilterPopoverOpen}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-7 w-7", isFilterActive && "text-blue-500")}
                aria-label="Filter stages"
              >
                <Filter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56">
              <div className="space-y-3">
                <p className="text-sm font-medium">Filter</p>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Location
                  </label>
                  <Select
                    value={filterLocationId ?? "__all__"}
                    onValueChange={(v) => {
                      setFilterLocationId(v === "__all__" ? null : v);
                      log.debug("filterLocationId changed", "filter", { v });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All Locations" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Locations</SelectItem>
                      {locations.map((loc) => (
                        <SelectItem key={loc.id} value={loc.id}>
                          {loc.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Appeared in Story
                  </label>
                  <Select
                    value={filterStory ?? "__all__"}
                    onValueChange={(v) => {
                      setFilterStory(v === "__all__" ? null : v);
                      log.debug("filterStory changed", "filter", { v });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All Stories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Stories</SelectItem>
                      {currentBook && (
                        <SelectItem value={currentBook.id}>
                          {currentBook.title}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <span className="text-sm font-semibold">Stages</span>
        </div>

        {/* Add popover */}
        <Popover open={isAddPopoverOpen} onOpenChange={setIsAddPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Add stage"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52">
            <div className="space-y-1">
              <Button
                variant="ghost"
                className="w-full justify-start text-sm gap-2 px-2"
                onClick={handleCreateFromScratch}
              >
                <CirclePlus className="h-4 w-4 shrink-0" />
                Create from Scratch
              </Button>
              <Button
                variant="ghost"
                className="w-full justify-start text-sm gap-2 px-2"
                disabled
              >
                <Library className="h-4 w-4 shrink-0" />
                Import from Library
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Stage list */}
      <div
        className="flex-1 overflow-y-auto p-2 space-y-1"
        role="list"
        aria-label="Stages list"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {filteredStageKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-center">
            <p className="text-sm text-muted-foreground mb-2">No stages yet</p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreateFromScratch}
            >
              <Plus className="h-3 w-3 mr-1" /> Add Stage
            </Button>
          </div>
        ) : (
          filteredStageKeys.map((key, index) => (
            <StagesSidebarItem
              key={key}
              stageKey={key}
              index={index}
              isSelected={key === selectedStageKey}
              isExpanded={key === expandedStageKey}
              isEditingName={key === editingNameKey}
              // Per-item collab gate: only the SELECTED+held stage is editable.
              editable={editable && key === selectedStageKey}
              onToggle={() => handleToggle(key)}
              onSelect={() => onStageSelect(key)}
              onStartRename={() => setEditingNameKey(key)}
              onFinishRename={(name) => handleRenameStage(key, name)}
              onDelete={() => handleDeleteStage(key)}
              onDragStart={() => setDragFromIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(index)}
              onDragEnd={() => setDragFromIndex(null)}
            />
          ))
        )}
      </div>
    </aside>
    <CreateAssetDialog
      open={isCreateModalOpen}
      onOpenChange={setIsCreateModalOpen}
      title="Create Stage"
      description="Add a new stage to the story."
      namePlaceholder="e.g. Forest"
      existingKeys={existingStageKeys}
      onCreate={handleConfirmCreate}
    />
    </>
  );
}
