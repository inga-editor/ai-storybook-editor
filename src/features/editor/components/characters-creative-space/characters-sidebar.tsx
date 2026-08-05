// characters-sidebar.tsx - Left sidebar listing all characters with filter, add, drag-reorder, and rename.

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
import { CharactersSidebarItem } from "./characters-sidebar-item";
import { CreateAssetDialog } from "@/features/editor/components/shared-components/create-asset-dialog";
import {
  useCharacters,
  useSnapshotActions,
} from "@/stores/snapshot-store/selectors";
import { useCurrentBook } from "@/stores/book-store";
import {
  useAssetCategories,
  useAssetCategoryActions,
} from "@/stores/asset-category-store";
import { CATEGORY_FILTER_OPTIONS } from "@/constants/prop-constants";
import { BASE_VARIANT_KEY, BASE_VARIANT_NAME } from "@/constants/variant-constants";
import type { Character } from "@/types/character-types";
import { cn } from "@/utils/utils";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "CharactersSidebar");

interface CharactersSidebarProps {
  characterKeys: string[];
  selectedCharacterKey: string | null;
  /** USER select (row click / arrow-nav) → set display = session target (lockless entity save). */
  onCharacterSelect: (key: string) => void;
  /** Collab save-session gate (ADR-044 addendum 2, lockless): only the SELECTED item may be
   *  renamed/deleted or have its basic-info/personality edited (its session is held). */
  editable: boolean;
  /** Called after deleting the held character so the space can drop the lock (→ release-save). */
  onEntityDeleted: (key: string) => void;
}

/** Build a blank Character record ready for addCharacter */
function buildNewCharacter(name: string, key: string, order: number): Character {
  return {
    order,
    name,
    key,
    basic_info: {
      description: "",
      gender: "",
      age: "",
      category_id: "",
      role: "",
    },
    personality: {
      core_essence: "",
      flaws: "",
      emotions: "",
      reactions: "",
      desires: "",
      likes: "",
      fears: "",
      contradictions: "",
    },
    variants: [
      {
        name: BASE_VARIANT_NAME,
        key: BASE_VARIANT_KEY,
        type: 0,
        appearance: {
          height: 0,
          hair: "",
          eyes: "",
          face: "",
          build: "",
        },
        visual_description: "",
        illustrations: [],
        image_references: [],
      },
    ],
    voice_setting: null,
  };
}

export function CharactersSidebar({
  characterKeys,
  selectedCharacterKey,
  onCharacterSelect,
  editable,
  onEntityDeleted,
}: CharactersSidebarProps) {
  const allCharacters = useCharacters();
  const { addCharacter, updateCharacter, deleteCharacter, reorderCharacters } =
    useSnapshotActions();
  const currentBook = useCurrentBook();
  const assetCategories = useAssetCategories();
  const { fetchCategories } = useAssetCategoryActions();

  // Fetch asset categories on mount
  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  // UI state
  const [expandedCharacterKey, setExpandedCharacterKey] = useState<
    string | null
  >(null);
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

  // Filtered character keys: resolve basic_info.category_id (UUID) → type (1-4) for comparison
  const filteredCharacterKeys = useMemo(() => {
    if (filterCategory === null) return characterKeys;
    return characterKeys.filter((key) => {
      const character = allCharacters.find((c) => c.key === key);
      if (!character || !character.basic_info.category_id) return false;
      const catType = categoryTypeMap.get(character.basic_info.category_id);
      return catType === filterCategory;
    });
  }, [characterKeys, allCharacters, filterCategory, categoryTypeMap]);

  // === Handlers ===

  const handleToggle = useCallback(
    (key: string) => {
      setExpandedCharacterKey((prev) => (prev === key ? null : key));
      onCharacterSelect(key);
    },
    [onCharacterSelect]
  );

  const handleCreateFromScratch = useCallback(() => {
    log.info("handleCreateFromScratch", "opening create modal");
    setIsAddPopoverOpen(false);
    setIsCreateModalOpen(true);
  }, []);

  const handleConfirmCreate = useCallback(
    (name: string, key: string) => {
      log.info("handleConfirmCreate", "creating character", { key });
      const maxOrder = allCharacters.reduce((max, c) => Math.max(max, c.order), -1);
      const newCharacter = buildNewCharacter(name, key, maxOrder + 1);
      addCharacter(newCharacter);
      onCharacterSelect(newCharacter.key);
      setExpandedCharacterKey(newCharacter.key);
    },
    [allCharacters, addCharacter, onCharacterSelect]
  );

  const handleDeleteCharacter = useCallback(
    (key: string) => {
      // Collab gate: delete is an owned-node mutation → only the SELECTED+held character may be
      // deleted. After delete, notify the space to drop the lock so the held session release-saves.
      if (!editable || key !== selectedCharacterKey) {
        log.debug("handleDeleteCharacter", "blocked — character not held", { key });
        return;
      }
      log.info("handleDeleteCharacter", "deleting character", { key });
      deleteCharacter(key);
      onEntityDeleted(key);
      if (expandedCharacterKey === key) setExpandedCharacterKey(null);
      if (editingNameKey === key) setEditingNameKey(null);
    },
    [deleteCharacter, onEntityDeleted, editable, selectedCharacterKey, expandedCharacterKey, editingNameKey]
  );

  const handleRenameCharacter = useCallback(
    (key: string, newName: string) => {
      // Collab gate: rename mutates the entity node → only the SELECTED+held character.
      if (!editable || key !== selectedCharacterKey) {
        log.debug("handleRenameCharacter", "blocked — character not held", { key });
        setEditingNameKey(null);
        return;
      }
      const trimmed = newName.trim();
      if (trimmed) {
        log.debug("handleRenameCharacter", "renaming", { key, newName: trimmed });
        updateCharacter(key, { name: trimmed });
      }
      setEditingNameKey(null);
    },
    [updateCharacter, editable, selectedCharacterKey]
  );

  const handleDrop = useCallback(
    (toFilteredIndex: number) => {
      if (dragFromIndex === null || dragFromIndex === toFilteredIndex) {
        setDragFromIndex(null);
        return;
      }
      // Map filtered indices to full-array indices for correct reorder
      const fromKey = filteredCharacterKeys[dragFromIndex];
      const toKey = filteredCharacterKeys[toFilteredIndex];
      const fromFull = characterKeys.indexOf(fromKey);
      const toFull = characterKeys.indexOf(toKey);
      if (fromFull !== -1 && toFull !== -1) {
        log.info("handleDrop", "reordering characters", {
          from: fromFull,
          to: toFull,
        });
        reorderCharacters(fromFull, toFull);
      }
      setDragFromIndex(null);
    },
    [dragFromIndex, filteredCharacterKeys, characterKeys, reorderCharacters]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filteredCharacterKeys.length === 0) return;
      const currentIndex = selectedCharacterKey
        ? filteredCharacterKeys.indexOf(selectedCharacterKey)
        : -1;

      switch (e.key) {
        case "ArrowUp": {
          e.preventDefault();
          const prevIndex =
            currentIndex > 0
              ? currentIndex - 1
              : filteredCharacterKeys.length - 1;
          onCharacterSelect(filteredCharacterKeys[prevIndex]);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const nextIndex =
            currentIndex < filteredCharacterKeys.length - 1
              ? currentIndex + 1
              : 0;
          onCharacterSelect(filteredCharacterKeys[nextIndex]);
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (selectedCharacterKey) {
            handleToggle(selectedCharacterKey);
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          setExpandedCharacterKey(null);
          break;
        }
        case "F2": {
          e.preventDefault();
          if (selectedCharacterKey) {
            setEditingNameKey(selectedCharacterKey);
          }
          break;
        }
      }
    },
    [filteredCharacterKeys, selectedCharacterKey, onCharacterSelect, handleToggle]
  );

  const existingCharacterKeys = allCharacters.map((c) => c.key);

  return (
    <>
    <aside
      className="flex flex-col h-full border-r min-w-[280px] max-w-[320px] w-1/4"
      role="navigation"
      aria-label="Characters sidebar"
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
                aria-label="Filter characters"
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

          <span className="text-sm font-semibold">Characters</span>
        </div>

        {/* Add popover */}
        <Popover open={isAddPopoverOpen} onOpenChange={setIsAddPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Add character"
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

      {/* Character list */}
      <div
        className="flex-1 overflow-y-auto p-2 space-y-1"
        role="list"
        aria-label="Characters list"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {filteredCharacterKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-center">
            <p className="text-sm text-muted-foreground mb-2">
              No characters yet
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreateFromScratch}
            >
              <Plus className="h-3 w-3 mr-1" /> Add Character
            </Button>
          </div>
        ) : (
          filteredCharacterKeys.map((key, index) => (
            <CharactersSidebarItem
              key={key}
              characterKey={key}
              index={index}
              isSelected={key === selectedCharacterKey}
              isExpanded={key === expandedCharacterKey}
              isEditingName={key === editingNameKey}
              // Per-item collab gate: only the SELECTED+held character is editable.
              editable={editable && key === selectedCharacterKey}
              onToggle={() => handleToggle(key)}
              onSelect={() => onCharacterSelect(key)}
              onStartRename={() => setEditingNameKey(key)}
              onFinishRename={(name) => handleRenameCharacter(key, name)}
              onDelete={() => handleDeleteCharacter(key)}
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
      title="Create Character"
      description="Add a new character to the story."
      namePlaceholder="e.g. Hero"
      existingKeys={existingCharacterKeys}
      onCreate={handleConfirmCreate}
    />
    </>
  );
}
