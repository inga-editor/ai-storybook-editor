// props-sidebar.tsx - Left sidebar listing all props with filter, add, drag-reorder, and rename.

import { useState, useMemo, useCallback, useEffect } from "react";
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
import { PropsSidebarItem } from "./props-sidebar-item";
import { CreateAssetDialog } from "@/features/editor/components/shared-components/create-asset-dialog";
import {
  useProps,
  useSnapshotActions,
} from "@/stores/snapshot-store/selectors";
import { useCurrentBook } from "@/stores/book-store";
import {
  useAssetCategories,
  useAssetCategoryActions,
} from "@/stores/asset-category-store";
import { CATEGORY_FILTER_OPTIONS } from "@/constants/prop-constants";
import { BASE_VARIANT_KEY, BASE_VARIANT_NAME } from "@/constants/variant-constants";
import type { Prop } from "@/types/prop-types";
import { cn } from "@/utils/utils";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "PropsSidebar");

interface PropsSidebarProps {
  propKeys: string[];
  selectedPropKey: string | null;
  /** USER select (row click / arrow-nav) → set display = session target (lockless entity save). */
  onPropSelect: (key: string) => void;
  /** Collab save-session gate (ADR-044 addendum 2, lockless): only the SELECTED item may be
   *  renamed/deleted or have its category/type edited (its session is held). */
  editable: boolean;
  /** Called after deleting the held prop so the space can drop the lock (→ release-save). */
  onEntityDeleted: (key: string) => void;
}

/** Build a blank Prop record ready for addProp */
function buildNewProp(name: string, key: string, order: number): Prop {
  return {
    order,
    name,
    key,
    category_id: "",
    type: "narrative",
    variants: [
      {
        name: BASE_VARIANT_NAME,
        key: BASE_VARIANT_KEY,
        type: 0,
        visual_description: "",
        illustrations: [],
        image_references: [],
      },
    ],
    sounds: [],
  };
}

export function PropsSidebar({
  propKeys,
  selectedPropKey,
  onPropSelect,
  editable,
  onEntityDeleted,
}: PropsSidebarProps) {
  const allProps = useProps();
  const { addProp, updateProp, deleteProp, reorderProps } =
    useSnapshotActions();
  const currentBook = useCurrentBook();
  const assetCategories = useAssetCategories();
  const { fetchCategories } = useAssetCategoryActions();

  // Fetch asset categories on mount
  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  // UI state
  const [expandedPropKey, setExpandedPropKey] = useState<string | null>(null);
  const [editingNameKey, setEditingNameKey] = useState<string | null>(null);
  const [isAddPopoverOpen, setIsAddPopoverOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false);
  const [filterCategory, setFilterCategory] = useState<number | null>(null);
  const [filterStory, setFilterStory] = useState<string | null>(null);

  // Drag state
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);

  // Filter active indicator
  const isFilterActive = filterCategory !== null || filterStory !== null;

  // Build lookup: category UUID → asset_categories.type for filter resolution
  const categoryTypeMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const cat of assetCategories) {
      map.set(cat.id, cat.type);
    }
    return map;
  }, [assetCategories]);

  // Filtered prop keys: resolve category_id (UUID) → type (1-4) for comparison
  const filteredPropKeys = useMemo(() => {
    if (filterCategory === null) return propKeys;
    return propKeys.filter((key) => {
      const prop = allProps.find((p) => p.key === key);
      if (!prop || !prop.category_id) return false;
      const catType = categoryTypeMap.get(prop.category_id);
      return catType === filterCategory;
    });
  }, [propKeys, allProps, filterCategory, categoryTypeMap]);

  // === Handlers ===

  const handleToggle = useCallback((key: string) => {
    setExpandedPropKey((prev) => (prev === key ? null : key));
  }, []);

  const handleCreateFromScratch = useCallback(() => {
    log.info("handleCreateFromScratch", "opening create modal");
    setIsAddPopoverOpen(false);
    setIsCreateModalOpen(true);
  }, []);

  const handleConfirmCreate = useCallback(
    (name: string, key: string) => {
      log.info("handleConfirmCreate", "creating prop", { key });
      const maxOrder = allProps.reduce((max, p) => Math.max(max, p.order), -1);
      const newProp = buildNewProp(name, key, maxOrder + 1);
      addProp(newProp);
      onPropSelect(newProp.key);
      setExpandedPropKey(newProp.key);
    },
    [allProps, addProp, onPropSelect]
  );

  const handleDeleteProp = useCallback(
    (key: string) => {
      // Collab gate: only the SELECTED+held prop may be deleted. After delete, notify the space to
      // drop the lock so the held session release-saves the (now removed) node.
      if (!editable || key !== selectedPropKey) {
        log.debug("handleDeleteProp", "blocked — prop not held", { key });
        return;
      }
      log.info("handleDeleteProp", "deleting prop", { key });
      deleteProp(key);
      onEntityDeleted(key);
      if (expandedPropKey === key) setExpandedPropKey(null);
      if (editingNameKey === key) setEditingNameKey(null);
    },
    [deleteProp, onEntityDeleted, editable, selectedPropKey, expandedPropKey, editingNameKey]
  );

  const handleRenameProp = useCallback(
    (key: string, newName: string) => {
      if (!editable || key !== selectedPropKey) {
        log.debug("handleRenameProp", "blocked — prop not held", { key });
        setEditingNameKey(null);
        return;
      }
      const trimmed = newName.trim();
      if (trimmed) {
        log.debug("handleRenameProp", "renaming", { key, newName: trimmed });
        updateProp(key, { name: trimmed });
      }
      setEditingNameKey(null);
    },
    [updateProp, editable, selectedPropKey]
  );

  const handleUpdateCategory = useCallback(
    (key: string, categoryId: string) => {
      if (!editable || key !== selectedPropKey) {
        log.debug("handleUpdateCategory", "blocked — prop not held", { key });
        return;
      }
      log.debug("handleUpdateCategory", "updating category", {
        key,
        categoryId,
      });
      updateProp(key, { category_id: categoryId });
    },
    [updateProp, editable, selectedPropKey]
  );

  const handleUpdateType = useCallback(
    (key: string, type: string) => {
      if (!editable || key !== selectedPropKey) {
        log.debug("handleUpdateType", "blocked — prop not held", { key });
        return;
      }
      log.debug("handleUpdateType", "updating type", { key, type });
      updateProp(key, { type: type as Prop["type"] });
    },
    [updateProp, editable, selectedPropKey]
  );

  const handleDrop = useCallback(
    (toIndex: number) => {
      if (dragFromIndex !== null && dragFromIndex !== toIndex) {
        log.info("handleDrop", "reordering props", {
          from: dragFromIndex,
          to: toIndex,
        });
        reorderProps(dragFromIndex, toIndex);
      }
      setDragFromIndex(null);
    },
    [dragFromIndex, reorderProps]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filteredPropKeys.length === 0) return;
      const currentIndex = selectedPropKey
        ? filteredPropKeys.indexOf(selectedPropKey)
        : -1;

      switch (e.key) {
        case "ArrowUp": {
          e.preventDefault();
          const prevIndex =
            currentIndex > 0 ? currentIndex - 1 : filteredPropKeys.length - 1;
          onPropSelect(filteredPropKeys[prevIndex]);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const nextIndex =
            currentIndex < filteredPropKeys.length - 1 ? currentIndex + 1 : 0;
          onPropSelect(filteredPropKeys[nextIndex]);
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (selectedPropKey) {
            handleToggle(selectedPropKey);
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          setExpandedPropKey(null);
          break;
        }
        case "F2": {
          e.preventDefault();
          if (selectedPropKey) {
            setEditingNameKey(selectedPropKey);
          }
          break;
        }
      }
    },
    [filteredPropKeys, selectedPropKey, onPropSelect, handleToggle]
  );

  const existingPropKeys = allProps.map((p) => p.key);

  return (
    <>
    <aside
      className="flex flex-col h-full border-r min-w-[280px] max-w-[320px] w-1/4"
      role="navigation"
      aria-label="Props sidebar"
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
                aria-label="Filter props"
              >
                <Filter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56">
              <div className="space-y-3">
                <p className="text-sm font-medium">Filter</p>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Category
                  </label>
                  <Select
                    value={
                      filterCategory !== null
                        ? String(filterCategory)
                        : "__all__"
                    }
                    onValueChange={(v) => {
                      setFilterCategory(v === "__all__" ? null : Number(v));
                      log.debug("filterCategory changed", "filter", { v });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All Categories" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORY_FILTER_OPTIONS.map((opt) => (
                        <SelectItem
                          key={
                            opt.value !== null ? String(opt.value) : "__all__"
                          }
                          value={
                            opt.value !== null ? String(opt.value) : "__all__"
                          }
                        >
                          {opt.label}
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

          <span className="text-sm font-semibold">Props</span>
        </div>

        {/* Add popover */}
        <Popover open={isAddPopoverOpen} onOpenChange={setIsAddPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Add prop"
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

      {/* Prop list */}
      <div
        className="flex-1 overflow-y-auto p-2 space-y-1"
        role="list"
        aria-label="Props list"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {filteredPropKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-center">
            <p className="text-sm text-muted-foreground mb-2">No props yet</p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreateFromScratch}
            >
              <Plus className="h-3 w-3 mr-1" /> Add Prop
            </Button>
          </div>
        ) : (
          filteredPropKeys.map((key, index) => (
            <PropsSidebarItem
              key={key}
              propKey={key}
              index={index}
              isSelected={key === selectedPropKey}
              isExpanded={key === expandedPropKey}
              isEditingName={key === editingNameKey}
              // Per-item collab gate: only the SELECTED+held prop is editable.
              editable={editable && key === selectedPropKey}
              onToggle={() => handleToggle(key)}
              onSelect={() => onPropSelect(key)}
              onStartRename={() => setEditingNameKey(key)}
              onFinishRename={(name) => handleRenameProp(key, name)}
              onDelete={() => handleDeleteProp(key)}
              onUpdateCategory={(catId) => handleUpdateCategory(key, catId)}
              onUpdateType={(type) => handleUpdateType(key, type)}
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
      title="Create Prop"
      description="Add a new prop to the story."
      namePlaceholder="e.g. Sword"
      existingKeys={existingPropKeys}
      onCreate={handleConfirmCreate}
    />
    </>
  );
}
