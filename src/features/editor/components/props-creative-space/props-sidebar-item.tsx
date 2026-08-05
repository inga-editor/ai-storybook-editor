// props-sidebar-item.tsx - Single accordion item in props sidebar
// Shows prop name (inline rename), category, type selectors, and drag handle.

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
import { usePropByKey } from "@/stores/snapshot-store/selectors";
import { useAssetCategories } from "@/stores/asset-category-store";
import { PROP_TYPE_OPTIONS } from "@/constants/prop-constants";
import { cn } from "@/utils/utils";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "PropsSidebarItem");

interface PropsSidebarItemProps {
  propKey: string;
  index: number;
  isSelected: boolean;
  isExpanded: boolean;
  isEditingName: boolean;
  /** Collab save-session gate (ADR-044 addendum 2, lockless): this item is the SELECTED prop (its
   *  session is held). When false the category/type edits + rename/delete affordances are disabled.
   *  Expand/select + drag stay enabled (select re-targets the session). */
  editable: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onFinishRename: (name: string) => void;
  onDelete: () => void;
  onUpdateCategory: (categoryId: string) => void;
  onUpdateType: (type: string) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

export function PropsSidebarItem({
  propKey,
  isSelected,
  isExpanded,
  isEditingName,
  editable,
  onToggle,
  onSelect,
  onStartRename,
  onFinishRename,
  onDelete,
  onUpdateCategory,
  onUpdateType,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: PropsSidebarItemProps) {
  const prop = usePropByKey(propKey);
  const assetCategories = useAssetCategories();
  const [editValue, setEditValue] = useState(prop?.name ?? "");
  const [isDragging, setIsDragging] = useState(false);

  // Build category options from real DB data (value=UUID, label=name)
  const categoryOptions = useMemo(
    () => assetCategories.map((c) => ({ value: c.id, label: c.name })),
    [assetCategories]
  );

  // Sync editValue when entering rename mode. The rename COMMIT is gated on `editable` in the parent
  // (true whenever this row is the selected item — its session is held).
  function handleStartRename(e: React.MouseEvent) {
    e.stopPropagation();
    setEditValue(prop?.name ?? "");
    onStartRename();
  }

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.effectAllowed = "move";
    setIsDragging(true);
    log.debug("handleDragStart", "drag started", { propKey });
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
    >
      <Collapsible open={isExpanded} onOpenChange={handleCollapsibleChange}>
        <CollapsibleTrigger asChild>
          <div className="flex items-start gap-1.5 px-2 py-1.5 cursor-pointer select-none">
            {/* Drag handle */}
            <GripVertical className="mt-1 h-3.5 w-3.5 text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing" />

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
                      if (e.key === "Enter") onFinishRename(editable ? editValue : (prop?.name ?? ""));
                      if (e.key === "Escape") onFinishRename(prop?.name ?? "");
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
                      onFinishRename(prop?.name ?? "");
                    }}
                    aria-label="Cancel rename"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <span className="text-sm font-medium truncate block">
                  {prop?.name ?? "Unnamed"}
                </span>
              )}
              <span className="text-xs text-muted-foreground">@{propKey}</span>
            </div>

            {/* Rename button — visible on hover */}
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
          <div className="px-3 pb-3 space-y-3">
            <Separator />

            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Basic Info
            </p>

            {/* Category */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Category</label>
              <SearchableDropdown
                options={categoryOptions}
                value={prop?.category_id ?? null}
                onChange={(val) => {
                  log.debug("onUpdateCategory", "category changed", {
                    propKey,
                    val,
                  });
                  onUpdateCategory(val);
                }}
                placeholder="Select category..."
                disabled={!editable}
              />
            </div>

            {/* Type */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Type</label>
              <Select
                value={prop?.type ?? "narrative"}
                onValueChange={(val) => {
                  log.debug("onUpdateType", "type changed", { propKey, val });
                  onUpdateType(val);
                }}
                disabled={!editable}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROP_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
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
                    title={editable ? undefined : "Click this prop to edit"}
                    aria-label="Delete prop"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Prop</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete &ldquo;{prop?.name}
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
