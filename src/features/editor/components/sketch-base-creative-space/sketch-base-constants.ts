// sketch-base-constants.ts — static config + local UI-state shapes for SketchBaseSpace.
// Split out (Phase 05) so root/sidebar/content each stay < 500 lines, and so the Phase 06
// overlay modals can import the modal-state types without pulling in the whole root.

import type { BaseKind, SketchBaseStyle } from '@/types/sketch';
import { IMPORT_SHEETS } from './import/parse-base-entities.constants';

/** Per-kind labels for the three base groups (Character / Prop / Alter Character).
 *  Stage has NO base sheet. */
export interface KindGroupConfig {
  kind: BaseKind;
  /** Group header title. */
  title: string;
  /** Singular noun for the empty-state ("No {noun} sketch generated yet"). */
  noun: string;
  /** Excel sheet name read on import. */
  sheetName: string;
}

/** Fixed order: Character → Prop → Alter Character (design README §2.3 / §4.6 — alter LAST).
 *  Base workspace covers char + prop + alter only (no Stage).
 *  ⚡2026-07-28: `alter_characters` is NOT a new entity array — it reads `sketch.characters[]`
 *  filtered by `actor_role === 1` (KIND_ENTITY_SOURCE). It has its own SHEET node though
 *  (`base.alter_character_sheet`, BASE_SHEET_ID) → its own rtype-11 lock → generates in PARALLEL
 *  with the other two kinds. */
export const KIND_GROUPS: KindGroupConfig[] = [
  { kind: 'characters', title: 'Character', noun: 'character', sheetName: 'Characters' },
  { kind: 'props', title: 'Prop', noun: 'prop', sheetName: 'Props' },
  { kind: 'alter_characters', title: 'Alter Character', noun: 'alter character', sheetName: 'Alter Characters' },
];

/**
 * Sidebar hint shown when a group has NO base entity at all — the group still RENDERS (with its
 * ＋/✏ seams greyed), it is NEVER filtered out (convention: never-hide-disabled-ui).
 *
 * The copy is gated on whether the importer ACTUALLY reads that group's sheet (`IMPORT_SHEETS`):
 * telling a user to import a tab the parser ignores is a worse dead-end than saying nothing. The
 * gate is derived, not hardcoded — the moment the Alter Characters tab is added to the importer
 * this hint becomes actionable on its own, with no edit here.
 */
export function emptyEntitiesHint(group: KindGroupConfig): string {
  const importable = IMPORT_SHEETS.some((s) => s.kind === group.kind);
  return importable
    ? `No ${group.noun} yet — import the "${group.sheetName}" sheet from the Excel file`
    : `No ${group.noun} yet`;
}

/** Zoom bounds for the content-area preview. Applied as CSS width % (NOT transform:scale —
 *  see generate-canvas.tsx / memory: zoom-via-css-width) so overflow scroll metrics stay correct. */
export const ZOOM = { min: 25, max: 200, step: 5, default: 100 } as const;

/** Singular noun for a base kind (empty-state / edit-image title). */
export function nounForKind(kind: BaseKind): string {
  if (kind === 'props') return 'prop';
  return kind === 'alter_characters' ? 'alter character' : 'character';
}

// ── Local UI-state shapes (owned by the root; typed here so Phase 06 modals can import) ──

/** Which style the content area is showing. null = none yet (auto-select derives one in render). */
export interface SelectedStyleRef {
  kind: BaseKind;
  index: number;
}

/** GenerateStyleModal state — `add` appends a style, `regenerate` overwrites styles[styleIndex]. */
export interface GenerateModalState {
  kind: BaseKind;
  mode: 'add' | 'regenerate';
  styleIndex?: number;
}

/** EditBaseEntityModal state — edits the base-variant text of every entity in a kind. */
export interface EditEntityModalState {
  kind: BaseKind;
}

/** Shared EditImageModal binding target — `raw` edits the whole sheet, `crop` edits one entity crop.
 *  Consumed by the Phase 06 EditImageModal wiring (scope → illustrations + onUpdate + pathPrefix). */
export type EditImageTarget =
  | { kind: BaseKind; styleIndex: number; scope: 'raw' }
  | { kind: BaseKind; styleIndex: number; scope: 'crop'; entityKey: string };

/** Shared ExtractImageModal binding target — CROP scope only (reframe one entity crop → a new
 *  version of it). The raw multi-entity sheet has no single extract target, so it is excluded.
 *  Consumed by SketchBaseExtractImageModal (scope → the crop's illustrations + onCreateImages). */
export interface ExtractImageTarget {
  kind: BaseKind;
  styleIndex: number;
  entityKey: string;
}

/** Auto-select priority (design §2.3) — SAME fixed order as `KIND_GROUPS`: alter is LAST, so a
 *  book that only has alter styles still lands on one, but alter never steals the default view
 *  from the story cast. Derived from KIND_GROUPS so the two orders can never drift apart. */
const PICK_ORDER: readonly BaseKind[] = KIND_GROUPS.map((g) => g.kind);

/**
 * Auto-select the first available style for the content area. Per kind, in `PICK_ORDER`:
 * is_selected style → styles[0]; falls through to the next kind when that sheet is empty;
 * null = nothing generated in ANY sheet yet.
 * Pure — called from a `useMemo` in render (React 19: NO set-state-in-render).
 */
export function pickFirstAvailable(
  stylesByKind: Record<BaseKind, SketchBaseStyle[]>,
): SelectedStyleRef | null {
  for (const kind of PICK_ORDER) {
    const styles = stylesByKind[kind];
    const locked = styles.findIndex((s) => s.is_selected);
    if (locked >= 0) return { kind, index: locked };
    if (styles.length > 0) return { kind, index: 0 };
  }
  return null;
}
