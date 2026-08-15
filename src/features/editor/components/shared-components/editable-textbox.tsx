// editable-textbox.tsx - Shared utility component for editable text
"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/utils/utils";
import type { SpreadTextboxContent, WordTiming } from "@/types/spread-types";
import { COLORS, DIMMED_BY_OVERLAP_OPACITY } from "@/constants/spread-constants";
import { useZoomLevel } from "@/stores/editor-settings-store";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "EditableTextbox");

// Codepoint ranges that should emit one token per character (no inter-word
// whitespace). Mirrors `_CJK_RANGES` in
// `ai-storybook-python-api/src/services/alignment_aggregator.py` — must stay in
// sync so word-span count matches `wordTimings.length` from /api/text/narrate-script.
// Korean (Hangul) is intentionally excluded: modern orthography uses spaces
// between eojeol, so the default whitespace split produces natural word units.
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x2ffff], // CJK Ext B–F (supplementary planes)
];

function isCjkCodePoint(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

type WordSegment =
  | { kind: "word"; text: string }
  | { kind: "whitespace"; text: string };

/**
 * Tokenize for Read-Along word spans. Parity with API
 * `_iter_word_tokens` (alignment_aggregator.py):
 *   - whitespace runs: emitted as `whitespace` (no word index)
 *   - each CJK codepoint: one `word` token
 *   - runs of non-CJK non-whitespace: one `word` token
 *
 * Iterates by codepoint via `Array.from` so astral-plane CJK (Ext B+) counts
 * as a single token rather than two surrogate halves.
 */
function tokenizeForWordSpans(text: string): WordSegment[] {
  const chars = Array.from(text);
  const segments: WordSegment[] = [];
  let i = 0;
  while (i < chars.length) {
    if (/^\s$/.test(chars[i])) {
      const start = i;
      while (i < chars.length && /^\s$/.test(chars[i])) i++;
      segments.push({
        kind: "whitespace",
        text: chars.slice(start, i).join(""),
      });
      continue;
    }
    const cp = chars[i].codePointAt(0)!;
    if (isCjkCodePoint(cp)) {
      segments.push({ kind: "word", text: chars[i] });
      i++;
      continue;
    }
    const start = i;
    while (
      i < chars.length &&
      !/^\s$/.test(chars[i]) &&
      !isCjkCodePoint(chars[i].codePointAt(0)!)
    ) {
      i++;
    }
    segments.push({ kind: "word", text: chars.slice(start, i).join("") });
  }
  return segments;
}

interface EditableTextboxProps {
  textboxContent: SpreadTextboxContent;
  index: number;
  zIndex?: number;
  isSelected: boolean;
  isSelectable: boolean; // Controls click selection behavior
  isEditable: boolean; // Controls double-click edit mode
  /** Controlled edit mode — when provided, parent owns the editing state */
  isEditing?: boolean;
  /** Render at reduced opacity — used for raw/background layer items in objects space */
  dimmed?: boolean;
  /** Show persistent item border (dashed gray outline) — only in retouch/objects space */
  showItemBorder?: boolean;
  /** Canvas-level controlled hover (ADR-029 smart hit-test). */
  isHoveredByCanvas?: boolean;
  /** ADR-029 dim — set true when this textbox fully covers a selected item with lower z. */
  dimmedByOverlap?: boolean;
  /** Stable id forwarded onto the rendered element for natural-target resolution. */
  itemId?: string;
  onSelect: (rect?: DOMRect) => void;
  onTextChange: (text: string) => void;
  onEditingChange: (isEditing: boolean) => void;
  /** Word-level timing data — when present, renders words in <span> elements for Read-Along */
  wordTimings?: WordTiming[];
}

export function EditableTextbox({
  textboxContent,
  index,
  zIndex,
  isSelected,
  isSelectable,
  isEditable,
  isEditing: controlledIsEditing,
  dimmed,
  showItemBorder,
  isHoveredByCanvas,
  dimmedByOverlap = false,
  itemId,
  onSelect,
  onTextChange,
  onEditingChange,
  wordTimings,
}: EditableTextboxProps) {
  const { text, geometry, typography } = textboxContent;
  const zoomLevel = useZoomLevel();
  const [internalIsEditing, setInternalIsEditing] = useState(false);
  const [isHoveredLocal, setIsHoveredLocal] = useState(false);
  const isHovered = isHoveredByCanvas ?? isHoveredLocal;
  const useLocalHover = isHoveredByCanvas === undefined;
  const editableRef = useRef<HTMLDivElement>(null);

  const isControlled = controlledIsEditing !== undefined;
  const effectiveIsEditing = isControlled
    ? controlledIsEditing!
    : internalIsEditing;
  // Track previous controlled value to detect transitions
  const prevEditingRef = useRef<boolean>(effectiveIsEditing);

  // Side-effect helpers — separated so both controlled and uncontrolled paths reuse them

  const applyEnterEditModeSideEffects = useCallback(() => {
    requestAnimationFrame(() => {
      if (editableRef.current) {
        editableRef.current.innerText = text;
        editableRef.current.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        if (editableRef.current.childNodes.length > 0) {
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
    });
  }, [text]);

  const applyExitEditModeSideEffects = useCallback(
    (save: boolean) => {
      if (save && editableRef.current) {
        const newText = editableRef.current.innerText;
        if (newText !== text) {
          onTextChange(newText);
        }
      }
    },
    [text, onTextChange]
  );

  // Controlled transitions: parent flips isEditing → apply side effects here
  useEffect(() => {
    if (!isControlled) return;
    const wasEditing = prevEditingRef.current;
    if (!wasEditing && controlledIsEditing === true) {
      applyEnterEditModeSideEffects();
    }
    if (wasEditing && controlledIsEditing === false) {
      applyExitEditModeSideEffects(true);
    }
    prevEditingRef.current = !!controlledIsEditing;
  }, [
    controlledIsEditing,
    isControlled,
    applyEnterEditModeSideEffects,
    applyExitEditModeSideEffects,
  ]);

  const enterEditMode = useCallback(() => {
    if (isControlled) {
      // Parent owns state — notify to flip prop; side effects run in useEffect above
      onEditingChange(true);
    } else {
      setInternalIsEditing(true);
      onEditingChange(true);
      applyEnterEditModeSideEffects();
    }
  }, [isControlled, onEditingChange, applyEnterEditModeSideEffects]);

  const exitEditMode = useCallback(
    (save: boolean) => {
      if (isControlled) {
        applyExitEditModeSideEffects(save);
        onEditingChange(false);
      } else {
        applyExitEditModeSideEffects(save);
        setInternalIsEditing(false);
        onEditingChange(false);
      }
    },
    [isControlled, applyExitEditModeSideEffects, onEditingChange]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (isSelectable && !effectiveIsEditing) {
        log.info("handleClick", "textbox clicked", { index });
        const rect = e.currentTarget.getBoundingClientRect();
        onSelect(rect);
      }
    },
    [isSelectable, effectiveIsEditing, onSelect, index]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isEditable) {
        enterEditMode();
      }
    },
    [isEditable, enterEditMode]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isSelected && !effectiveIsEditing && e.key === "Enter") {
        e.preventDefault();
        enterEditMode();
      }
      if (effectiveIsEditing) {
        if (e.key === "Escape") {
          exitEditMode(false);
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          exitEditMode(true);
        }
        // Prevent Delete/Backspace from bubbling to canvas (which would delete the item)
        if (e.key === "Delete" || e.key === "Backspace") {
          e.stopPropagation();
        }
      }
    },
    [isSelected, effectiveIsEditing, enterEditMode, exitEditMode]
  );

  const handleBlur = useCallback(() => {
    if (effectiveIsEditing) {
      exitEditMode(true);
    }
  }, [effectiveIsEditing, exitEditMode]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const plainText = e.clipboardData.getData("text/plain");

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(plainText));

    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  // Map typography to CSS — scale pixel-based values by zoom factor
  const zoomFactor = zoomLevel / 100;
  const typographyStyle: React.CSSProperties = {
    fontFamily: typography?.family || "inherit",
    fontSize: typography?.size
      ? `${typography.size * zoomFactor}px`
      : "inherit",
    fontWeight: typography?.weight || "normal",
    fontStyle: typography?.style || "normal",
    textAlign: typography?.textAlign || "left",
    lineHeight: typography?.lineHeight || 1.5,
    letterSpacing: typography?.letterSpacing
      ? `${typography.letterSpacing * zoomFactor}px`
      : "inherit",
    color: typography?.color || "inherit",
    textDecoration: typography?.decoration || "none",
    textTransform: typography?.textTransform || "none",
  };

  const isEmpty = !text;
  const baseOpacity = dimmed ? 0.2 : 1;
  const effectiveOpacity = dimmedByOverlap ? DIMMED_BY_OVERLAP_OPACITY : baseOpacity;

  /** Render text with per-word <span> elements for Read-Along highlighting.
   *  Token order/count must match wordTimings emitted by /api/text/narrate-script. */
  const renderTextWithWordSpans = (textContent: string): React.ReactNode => {
    const segments = tokenizeForWordSpans(textContent);
    let wordIndex = 0;
    return segments.map((seg, i) => {
      if (seg.kind === "whitespace") {
        return <span key={`ws-${i}`}>{seg.text}</span>;
      }
      const idx = wordIndex++;
      return (
        <span
          key={`w-${idx}`}
          data-word-index={idx}
          className="read-along-word"
        >
          {seg.text}
        </span>
      );
    });
  };

  return (
    <div
      {...(isSelectable && {
        role: "textbox",
        "aria-label": `Textbox ${index + 1}`,
        "aria-multiline": "true",
      })}
      data-textbox
      data-item-id={itemId}
      data-rotation={Number.isFinite(geometry.rotation) ? geometry.rotation : 0}
      tabIndex={isSelectable ? 0 : -1}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={useLocalHover ? () => setIsHoveredLocal(true) : undefined}
      onMouseLeave={useLocalHover ? () => setIsHoveredLocal(false) : undefined}
      className={cn(
        "absolute overflow-hidden transition-opacity",
        isSelectable && "cursor-pointer",
        !isSelected &&
          (showItemBorder || isHovered) &&
          "outline-dashed outline-1"
      )}
      style={{
        left: `${geometry.x}%`,
        top: `${geometry.y}%`,
        width: `${geometry.w}%`,
        height: `${geometry.h}%`,
        transform: `rotate(${Number.isFinite(geometry.rotation) ? geometry.rotation : 0}deg)`,
        transformOrigin: "center center",
        willChange: "transform",
        zIndex,
        opacity: effectiveOpacity,
        transition: "opacity 150ms ease-out",
        outlineColor: !isSelected
          ? isHovered
            ? COLORS.ITEM_BORDER_HOVER
            : COLORS.ITEM_BORDER_TEXTBOX
          : undefined,
        ...typographyStyle,
      }}
    >
      {effectiveIsEditing ? (
        <div
          ref={editableRef}
          contentEditable
          suppressContentEditableWarning
          onBlur={handleBlur}
          onPaste={handlePaste}
          className="w-full h-full outline-none break-words"
          style={{ backgroundColor: COLORS.EDIT_MODE_BG }}
        />
      ) : isEmpty ? (
        <div
          className="w-full h-full flex items-center justify-center italic"
          style={{ color: COLORS.PLACEHOLDER_TEXT }}
        >
          Click to add text
        </div>
      ) : (
        <div className="w-full h-full whitespace-pre-wrap break-words">
          {wordTimings && wordTimings.length > 0
            ? renderTextWithWordSpans(text)
            : text}
        </div>
      )}
    </div>
  );
}

export default EditableTextbox;
