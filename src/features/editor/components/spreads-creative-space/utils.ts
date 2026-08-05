// utils.ts - Types, constants, and helpers for spreads creative space sidebar

import { getTextboxContentForLanguage } from "@/features/editor/utils/textbox-helpers";
import { LAYER_CONFIG, LAYER_ORDER } from "@/constants/spread-constants";
import { DEFAULT_TYPOGRAPHY } from "@/constants/config-constants";
import { mapTypographyToTextbox } from "@/constants/book-defaults";
import type { LucideIcon } from "lucide-react";
import { Image, Type, PanelBottom } from "lucide-react";
import type {
  BaseSpread,
  SpreadImage,
  SpreadTextbox,
} from "@/types/canvas-types";
import type { TypographySettings } from "@/types/editor";

// === Types ===

// NOTE: `shape` is NO LONGER a SCENE-space item type (ADR-044 addendum 2 · Phase 06, 2026-08-05).
// Shapes are a RETOUCH-owned key edited only in the OBJECTS space (sole writer rtype 10). Existing
// `spread.shapes[]` data stays in the snapshot but is not rendered/editable here.
export type SpreadElementType = "raw_image" | "raw_textbox" | "page";

export interface ElementListEntry {
  id: string;
  type: SpreadElementType;
  title: string;
  zIndex: number;
}

export interface SelectedItem {
  type: SpreadElementType;
  id: string;
}

type LayerRange = (typeof LAYER_CONFIG)[keyof typeof LAYER_CONFIG];

export interface LayerGroup {
  layer: LayerRange;
  entries: ElementListEntry[];
}

// === Constants ===

/** Element types that can be added via the "+" button (excludes page backgrounds) */
export const ADDABLE_ELEMENT_TYPES: SpreadElementType[] = [
  "raw_image",
  "raw_textbox",
];

export const ALL_ELEMENT_TYPES: SpreadElementType[] = [
  "page",
  "raw_image",
  "raw_textbox",
];

/** Virtual layer for page backgrounds (below all real layers) */
const BACKGROUND_LAYER = { min: -1, max: 0, label: "Background", types: ["page"] as const };

/** Map illustration element types to layer config (different from objects: 'textbox' not 'text') */
export const ILLUSTRATION_LAYER_MAP: Record<SpreadElementType, LayerRange> = {
  page: BACKGROUND_LAYER as unknown as LayerRange,
  raw_image: LAYER_CONFIG.MEDIA,
  raw_textbox: LAYER_CONFIG.TEXT,
};

export const ELEMENT_TYPE_CONFIG: Record<
  SpreadElementType,
  { icon: LucideIcon; label: string }
> = {
  page: { icon: PanelBottom, label: "Page" },
  raw_image: { icon: Image, label: "Image" },
  raw_textbox: { icon: Type, label: "Textbox" },
};

export const NEW_ELEMENT_DEFAULTS = {
  image: {
    title: "Untitled Image",
    geometry: { x: 35, y: 20, w: 30, h: 40 },
    aspect_ratio: "1:1",
    setting: undefined,
    art_note: "",
    visual_description: "",
    image_references: [],
    final_hires_media_url: undefined,
    illustrations: [],
  },
};

/** Create default textbox using book.typography[langCode] when available, else DEFAULT_TYPOGRAPHY. */
export function createDefaultTextbox(
  langCode: string,
  bookTypography: Record<string, TypographySettings> | null
): SpreadTextbox {
  const typo = mapTypographyToTextbox(bookTypography?.[langCode] ?? DEFAULT_TYPOGRAPHY);
  return {
    id: crypto.randomUUID(),
    [langCode]: {
      text: "",
      geometry: { x: 20, y: 20, w: 25, h: 5 },
      typography: typo,
    },
  };
}

// === Helpers ===

/** Resolve z-index: use array position within layer range */
function resolveZIndex(positionInArray: number, layer: LayerRange): number {
  return Math.min(layer.min + positionInArray, layer.max);
}

/** Build flat list of all elements from a spread, sorted descending by z-index */
export function buildElementList(
  spread: BaseSpread,
  langCode: string
): ElementListEntry[] {
  const entries: ElementListEntry[] = [];

  // Page backgrounds (z-index 0, below all layers)
  spread.pages.forEach((page, i) => {
    const pageLabel = spread.pages.length === 1
      ? `Page ${page.number}`
      : i === 0 ? `Page ${page.number} (Left)` : `Page ${page.number} (Right)`;
    entries.push({
      id: `page-${i}`,
      type: "page",
      title: pageLabel,
      zIndex: i,
    });
  });

  (spread.raw_images ?? []).forEach((img, i) => {
    entries.push({
      id: img.id,
      type: "raw_image",
      title: (img as SpreadImage).title || `Image ${i + 1}`,
      zIndex: resolveZIndex(i, LAYER_CONFIG.MEDIA),
    });
  });

  (spread.raw_textboxes ?? []).forEach((tb, i) => {
    const result = getTextboxContentForLanguage(
      tb as unknown as Record<string, unknown>,
      langCode
    );
    const text = result?.content?.text;
    const title = text
      ? text.length > 20
        ? text.slice(0, 20) + "\u2026"
        : text
      : "Empty Textbox";
    entries.push({
      id: tb.id,
      type: "raw_textbox",
      title,
      zIndex: resolveZIndex(i, LAYER_CONFIG.TEXT),
    });
  });

  // NOTE: `spread.shapes[]` is intentionally NOT listed here — shapes are a RETOUCH-owned key edited
  // only in the OBJECTS space (ADR-044 addendum 2 · Phase 06). Data remains in the snapshot.

  return entries.sort((a, b) => b.zIndex - a.zIndex);
}

/** Group entries by layer (TEXT -> OBJECTS -> MEDIA -> BACKGROUND), removing empty groups */
export function groupEntriesByLayer(entries: ElementListEntry[]): LayerGroup[] {
  const groups: LayerGroup[] = [
    ...LAYER_ORDER.map((layer) => ({ layer, entries: [] as ElementListEntry[] })),
    { layer: BACKGROUND_LAYER as unknown as LayerRange, entries: [] as ElementListEntry[] },
  ];

  for (const entry of entries) {
    const layer = ILLUSTRATION_LAYER_MAP[entry.type];
    if (!layer) continue;
    const group = groups.find((g) => g.layer === layer);
    group?.entries.push(entry);
  }

  for (const group of groups) {
    group.entries.sort((a, b) => b.zIndex - a.zIndex);
  }

  return groups.filter((g) => g.entries.length > 0);
}

/** Filter entries by element type set */
export function filterElementList(
  entries: ElementListEntry[],
  elementFilter: Set<SpreadElementType>,
  allElements: boolean
): ElementListEntry[] {
  if (allElements) return entries;
  return entries.filter((entry) => elementFilter.has(entry.type));
}
