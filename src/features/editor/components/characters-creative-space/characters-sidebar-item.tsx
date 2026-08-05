// characters-sidebar-item.tsx - Single accordion item in characters sidebar
// Shows character name (inline rename), BasicInfoPanel and PersonalityPanel (expandable sections), drag handle.

import { useState, useMemo } from "react";
import {
  GripVertical,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Copy,
  Check,
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SearchableDropdown } from "@/components/ui/searchable-dropdown";
import { Separator } from "@/components/ui/separator";
import {
  useCharacterByKey,
  useSnapshotActions,
} from "@/stores/snapshot-store/selectors";
import { useAssetCategories } from "@/stores/asset-category-store";
import { GENDER_OPTIONS } from "@/constants/character-constants";
import { cn } from "@/utils/utils";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "CharactersSidebarItem");

// Static dropdown options for the role field. GENDER_OPTIONS moved to
// @/constants/character-constants (SSOT — the parametric-slot gender axis in
// objects-creative-space derives its domain from the SAME vocabulary).
const ROLE_OPTIONS = [
  { value: "protagonist", label: "Protagonist" },
  { value: "antagonist", label: "Antagonist" },
  { value: "supporting", label: "Supporting" },
  { value: "minor", label: "Minor" },
] as const;

// Personality field definitions for loop rendering (keeps file under 500 lines)
const PERSONALITY_FIELDS: Array<{
  key: keyof import("@/types/character-types").CharacterPersonality;
  label: string;
  placeholder: string;
}> = [
  { key: "core_essence", label: "Core Essence", placeholder: "Describe core personality..." },
  { key: "flaws", label: "Flaws", placeholder: "Describe character flaws..." },
  { key: "emotions", label: "Emotions", placeholder: "Describe emotional traits..." },
  { key: "reactions", label: "Reactions", placeholder: "Describe typical reactions..." },
  { key: "desires", label: "Desires", placeholder: "Describe desires..." },
  { key: "likes", label: "Likes", placeholder: "Describe likes..." },
  { key: "fears", label: "Fears", placeholder: "Describe fears..." },
  { key: "contradictions", label: "Contradictions", placeholder: "Describe contradictions..." },
];

interface CharactersSidebarItemProps {
  characterKey: string;
  index: number;
  isSelected: boolean;
  isExpanded: boolean;
  isEditingName: boolean;
  /** Collab save-session gate (ADR-044 addendum 2, lockless): this item is the SELECTED character
   *  (its session is held). When false the basic-info/personality edits + rename/delete affordances
   *  are disabled/greyed. Expand/select + drag stay enabled (select re-targets the session). */
  editable: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onFinishRename: (name: string) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

export function CharactersSidebarItem({
  characterKey,
  isSelected,
  isExpanded,
  isEditingName,
  editable,
  onToggle,
  onSelect,
  onStartRename,
  onFinishRename,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: CharactersSidebarItemProps) {
  const character = useCharacterByKey(characterKey);
  const { updateCharacter } = useSnapshotActions();
  const assetCategories = useAssetCategories();

  const [editValue, setEditValue] = useState(character?.name ?? "");
  const [isDragging, setIsDragging] = useState(false);
  const [isBasicInfoOpen, setIsBasicInfoOpen] = useState(true);
  const [isPersonalityOpen, setIsPersonalityOpen] = useState(false);

  // Build category options from real DB data (value=UUID, label=name)
  const categoryOptions = useMemo(
    () => assetCategories.map((c) => ({ value: c.id, label: c.name })),
    [assetCategories]
  );

  // Sync editValue when entering rename mode. The rename COMMIT is gated on `editable` in the parent
  // (true whenever this row is the selected item — its session is held).
  function handleStartRename(e: React.MouseEvent) {
    e.stopPropagation();
    setEditValue(character?.name ?? "");
    onStartRename();
  }

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.effectAllowed = "move";
    setIsDragging(true);
    log.debug("handleDragStart", "drag started", { characterKey });
    onDragStart();
  }

  function handleDragEnd() {
    setIsDragging(false);
    onDragEnd();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    onDrop();
  }

  function handleCollapsibleChange() {
    onToggle();
    if (!isExpanded) onSelect();
  }

  // Basic info field update helpers (spread existing to preserve other fields)
  function handleGenderChange(gender: string) {
    if (!character || !editable) return;
    log.debug("handleGenderChange", "gender changed", { characterKey, gender });
    updateCharacter(characterKey, {
      basic_info: { ...character.basic_info, gender },
    });
  }

  // Controlled (write-on-change) so an undo/redo store restore is reflected in the field — an
  // uncontrolled defaultValue would keep the stale typed value until remount. Capture's debounce
  // coalesces the keystrokes into one undo checkpoint (ADR-045), matching gender/category/role.
  function handleAgeChange(age: string) {
    if (!character || !editable) return;
    log.debug("handleAgeChange", "age changed", { characterKey });
    updateCharacter(characterKey, {
      basic_info: { ...character.basic_info, age },
    });
  }

  function handleCategoryChange(category_id: string) {
    if (!character || !editable) return;
    log.debug("handleCategoryChange", "category changed", { characterKey, category_id });
    updateCharacter(characterKey, {
      basic_info: { ...character.basic_info, category_id },
    });
  }

  function handleRoleChange(role: string) {
    if (!character || !editable) return;
    log.debug("handleRoleChange", "role changed", { characterKey, role });
    updateCharacter(characterKey, {
      basic_info: { ...character.basic_info, role },
    });
  }

  function handlePersonalityChange(
    field: keyof import("@/types/character-types").CharacterPersonality,
    value: string
  ) {
    if (!character || !editable) return;
    log.debug("handlePersonalityChange", "personality field changed", { characterKey, field });
    updateCharacter(characterKey, {
      personality: { ...character.personality, [field]: value },
    });
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragOver={onDragOver}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
      className={cn(
        "group rounded-md border transition-colors",
        isSelected ? "bg-accent border-accent" : "bg-card hover:bg-accent/50",
        isDragging && "opacity-50"
      )}
      role="listitem"
    >
      <Collapsible open={isExpanded} onOpenChange={handleCollapsibleChange}>
        <CollapsibleTrigger asChild>
          <div
            className="flex items-start gap-1.5 px-2 py-1.5 cursor-pointer select-none"
            aria-expanded={isExpanded}
            aria-label={`Character: ${character?.name ?? characterKey}`}
          >
            {/* Drag handle */}
            <GripVertical
              className="mt-1 h-3.5 w-3.5 text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing"
              aria-roledescription="sortable"
            />

            {/* Expand/collapse chevron */}
            {isExpanded ? (
              <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0" />
            )}

            {/* Name + key column */}
            <div className="flex-1 min-w-0">
              {isEditingName ? (
                <div className="flex items-center gap-1">
                  <Input
                    className="h-7 text-sm flex-1"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onFinishRename(editValue);
                      if (e.key === "Escape")
                        onFinishRename(character?.name ?? "");
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFinishRename(editValue);
                    }}
                    aria-label="Accept rename"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFinishRename(character?.name ?? "");
                    }}
                    aria-label="Cancel rename"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <span className="text-sm font-medium truncate block">
                  {character?.name ?? "Unnamed"}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                @{characterKey}
              </span>
            </div>

            {/* Rename button — visible on hover (only when not editing) */}
            {!isEditingName && (
              <Button
                variant="ghost"
                size="icon"
                className="mt-0.5 h-5 w-5 transition-opacity shrink-0 opacity-0 group-hover:opacity-100"
                onClick={handleStartRename}
                tabIndex={-1}
                aria-label="Edit name"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            )}
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-2">
            <Separator />

            {/* === BasicInfoPanel === */}
            <Collapsible open={isBasicInfoOpen} onOpenChange={setIsBasicInfoOpen}>
              <CollapsibleTrigger asChild>
                <button
                  className="flex items-center gap-1 w-full text-left"
                  aria-expanded={isBasicInfoOpen}
                  aria-controls={`basic-info-${characterKey}`}
                >
                  {isBasicInfoOpen ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Basic Info
                  </p>
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent
                id={`basic-info-${characterKey}`}
                className="pt-2"
              >
                <div className="grid grid-cols-2 gap-2">
                  {/* Gender */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      Gender
                    </label>
                    <Select
                      value={character?.basic_info.gender ?? ""}
                      onValueChange={handleGenderChange}
                      disabled={!editable}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {GENDER_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Age */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Age</label>
                    <Input
                      className="h-8"
                      value={character?.basic_info.age ?? ""}
                      placeholder="e.g. 25"
                      disabled={!editable}
                      onChange={(e) => handleAgeChange(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>

                  {/* Category */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      Category
                    </label>
                    <SearchableDropdown
                      options={categoryOptions}
                      value={character?.basic_info.category_id ?? null}
                      onChange={handleCategoryChange}
                      placeholder="Select category..."
                      disabled={!editable}
                    />
                  </div>

                  {/* Role */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      Role
                    </label>
                    <Select
                      value={character?.basic_info.role ?? ""}
                      onValueChange={handleRoleChange}
                      disabled={!editable}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            <Separator />

            {/* === PersonalityPanel === */}
            <Collapsible
              open={isPersonalityOpen}
              onOpenChange={setIsPersonalityOpen}
            >
              <CollapsibleTrigger asChild>
                <button
                  className="flex items-center gap-1 w-full text-left"
                  aria-expanded={isPersonalityOpen}
                  aria-controls={`personality-${characterKey}`}
                >
                  {isPersonalityOpen ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Personality
                  </p>
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent
                id={`personality-${characterKey}`}
                className="pt-2 space-y-2"
              >
                {PERSONALITY_FIELDS.map(({ key, label, placeholder }) => (
                  <div key={key} className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      {label}
                    </label>
                    <Textarea
                      className="text-xs resize-none min-h-[56px]"
                      value={character?.personality[key] ?? ""}
                      placeholder={placeholder}
                      disabled={!editable}
                      onChange={(e) => handlePersonalityChange(key, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>

            <Separator />

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 text-xs"
                disabled
              >
                <Copy className="h-3 w-3 mr-1" /> Add to Library
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={!editable}
                    title={editable ? undefined : "Click this character to edit"}
                    aria-label="Delete character"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Character</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete &ldquo;{character?.name}
                      &rdquo;? This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onDelete}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
