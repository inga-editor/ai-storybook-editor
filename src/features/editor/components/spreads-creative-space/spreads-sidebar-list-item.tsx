// spreads-sidebar-list-item.tsx - Individual item row in spreads (illustration) sidebar
// Simpler than objects-sidebar-list-item: no visibility toggles, only rename action.
"use client";

import { Pencil, Check, GripVertical } from "lucide-react";
import { cn } from "@/utils/utils";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ELEMENT_TYPE_CONFIG, type ElementListEntry } from "./utils";

interface SpreadsSidebarListItemProps {
  entry: ElementListEntry;
  isSelected: boolean;
  /** Whether the active spread's SCENE lock is held (ADR-044). Gates drag-reorder + rename here;
   *  when false the row is display-only (greyed affordances, never hidden). */
  isEditable: boolean;
  editingId: string | null;
  onSelect: () => void;
  onEditStart: () => void;
  onRenameConfirm: () => void;
  editValue: string;
  onEditValueChange: (v: string) => void;
  dragIndex: number | null;
  index: number;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

export function SpreadsSidebarListItem({
  entry,
  isSelected,
  isEditable,
  editingId,
  onSelect,
  onEditStart,
  onRenameConfirm,
  editValue,
  onEditValueChange,
  dragIndex,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: SpreadsSidebarListItemProps) {
  const isEditing = editingId === entry.id;
  const isPage = entry.type === "page";
  // Textbox title is auto-derived, page backgrounds are fixed — renaming disabled
  const isRenameable = entry.type !== "raw_textbox" && !isPage;
  // Drag-reorder is an in-spread SCENE edit → only for raw_image/raw_textbox while the lock is held.
  const isDraggable = !isPage && isEditable;
  // The reorder handle is shown (never hidden) for non-page rows, but greyed/disabled when the
  // spread is not held.
  const showGrip = !isPage;
  const gripDisabled = !isEditable;
  const gripTitle = !isEditable ? "Click this spread to edit" : "Drag to reorder";
  const config = ELEMENT_TYPE_CONFIG[entry.type];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "group flex items-center h-12 px-2 gap-1.5 cursor-pointer transition-colors text-sm",
        isSelected ? "bg-accent/80" : "hover:bg-muted/50",
        dragIndex === index && "opacity-40"
      )}
      onClick={onSelect}
      draggable={isDraggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart(index);
      }}
      onDragOver={(e) => {
        e.dataTransfer.dropEffect = "move";
        onDragOver(e);
      }}
      onDrop={() => onDrop(index)}
      onDragEnd={onDragEnd}
      role="option"
      aria-selected={isSelected}
    >
      {/* Drag handle (hidden only for pages). Greyed/disabled when the spread is not held. */}
      {showGrip && (
        <span title={gripTitle} className="flex-shrink-0 inline-flex">
          <GripVertical
            className={cn(
              "w-3.5 h-3.5",
              gripDisabled
                ? "text-muted-foreground/50 opacity-40 cursor-not-allowed"
                : "text-muted-foreground opacity-0 group-hover:opacity-100"
            )}
            aria-hidden="true"
          />
        </span>
      )}

      {/* Type icon */}
      <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />

      {/* Name / Inline edit */}
      {isEditing && isRenameable ? (
        <div className="flex-1 flex items-center gap-1 min-w-0">
          <input
            type="text"
            value={editValue}
            onChange={(e) => onEditValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameConfirm();
              if (e.key === "Escape") onRenameConfirm();
            }}
            className="flex-1 min-w-0 text-sm px-1 py-0.5 border rounded bg-background"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRenameConfirm();
            }}
            className="p-0.5 rounded hover:bg-muted"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <span className="flex-1 truncate min-w-0">{entry.title}</span>
      )}

      {/* Hover actions — rename. Disabled + greyed when the spread is not held (2-state, never hidden). */}
      {isRenameable && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditStart();
                }}
                disabled={!isEditable}
                className={cn(
                  "p-0.5 rounded",
                  isEditable ? "hover:bg-muted" : "opacity-40 cursor-not-allowed"
                )}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {isEditable ? "Rename" : "Click this spread to edit"}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
