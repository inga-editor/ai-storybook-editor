// stages-sidebar-item.tsx - Single accordion item in stages sidebar
// Shows stage name (inline rename), location selector, and drag handle.

import { useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import { useStageByKey, useSnapshotActions } from "@/stores/snapshot-store/selectors";
import { useLocations, useLocationsLoading } from "@/stores/location-store";
import { cn } from "@/utils/utils";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "StagesSidebarItem");

interface StagesSidebarItemProps {
  stageKey: string;
  index: number;
  isSelected: boolean;
  isExpanded: boolean;
  isEditingName: boolean;
  /** Collab save-session gate (ADR-044 addendum 2, lockless): this item is the SELECTED stage (its
   *  session is held). When false the location edit + rename/delete affordances are disabled.
   *  Expand/select + drag stay enabled (select re-targets the session). */
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

export function StagesSidebarItem({
  stageKey,
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
}: StagesSidebarItemProps) {
  const stage = useStageByKey(stageKey);
  const { updateStage } = useSnapshotActions();
  const locations = useLocations();
  const isLocationsLoading = useLocationsLoading();
  const [editValue, setEditValue] = useState(stage?.name ?? "");
  const [isDragging, setIsDragging] = useState(false);

  // Sync editValue when entering rename mode. The rename COMMIT is gated on `editable` in the parent
  // (true whenever this row is the selected item — its session is held).
  function handleStartRename(e: React.MouseEvent) {
    e.stopPropagation();
    setEditValue(stage?.name ?? "");
    onStartRename();
  }

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.effectAllowed = "move";
    setIsDragging(true);
    log.debug("handleDragStart", "drag started", { stageKey });
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

  // Sentinel for "no location selected" — Radix Select requires non-empty strings
  const LOCATION_NONE = "__none__";

  // Build location options
  const locationOptions = [
    { value: LOCATION_NONE, label: "Select location..." },
    ...locations.map((loc) => ({ value: loc.id, label: loc.name })),
  ];

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
                      if (e.key === "Enter") onFinishRename(editValue);
                      if (e.key === "Escape") onFinishRename(stage?.name ?? "");
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
                      onFinishRename(stage?.name ?? "");
                    }}
                    aria-label="Cancel rename"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <span className="text-sm font-medium truncate block">
                  {stage?.name ?? "Unnamed"}
                </span>
              )}
              <span className="text-xs text-muted-foreground">@{stageKey}</span>
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

            {/* Location */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Location</label>
              <Select
                value={stage?.location_id || LOCATION_NONE}
                disabled={isLocationsLoading || !editable}
                onValueChange={(val) => {
                  if (!editable) return; // collab gate
                  const locationId = val === LOCATION_NONE ? "" : val;
                  log.debug("onUpdateLocation", "location changed", {
                    stageKey,
                    locationId,
                  });
                  updateStage(stageKey, { location_id: locationId });
                }}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {locationOptions.map((opt) => (
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
                    title={editable ? undefined : "Click this stage to edit"}
                    aria-label="Delete stage"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Stage</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete &ldquo;{stage?.name}
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
