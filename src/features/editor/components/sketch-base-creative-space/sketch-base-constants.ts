// sketch-base-constants.ts — static config + local UI-state shapes for SketchBaseSpace.
// ⚡REV 2026-08-21 (group model): the base workspace is N DYNAMIC groups (one sheet node per
// character/prop group), NOT the old 3 hard kinds. The static `KIND_GROUPS` / `KindGroupConfig` /
// `nounForKind`-per-BaseKind tables are GONE — the group list comes from `useSketchBaseGroups()`,
// each descriptor is a `BaseGroup { group_key, kind, name }`, and every local UI-state shape is
// keyed by `group` (the group key), never a kind enum.

import type { SheetKind, BaseGroup, SketchBaseStyle } from '@/types/sketch';

/** Sidebar group descriptor = the store's `BaseGroup` verbatim (no per-space redefine). */
export type SidebarGroup = BaseGroup;

/** Singular noun for a group's `SheetKind` (edit-image title fallback). Group empty-states prefer
 *  the group NAME (see BaseSheetContentArea `noun`); this is only for the two real kinds. */
export function nounForKind(kind: SheetKind): string {
  return kind === 'props' ? 'prop' : 'character';
}

/** Sidebar hint for a group with ZERO base entities — an ORPHAN sheet node (its entities were
 *  removed elsewhere, or it was seeded empty). The group still RENDERS with this hint + an
 *  owner-only delete-group action (never-hide-disabled-ui); it is NEVER filtered out. */
export const EMPTY_GROUP_HINT = 'No entity in this group';

/** Zoom bounds for the content-area preview. Applied as CSS width % (NOT transform:scale —
 *  see generate-canvas.tsx / memory: zoom-via-css-width) so overflow scroll metrics stay correct. */
export const ZOOM = { min: 25, max: 200, step: 5, default: 100 } as const;

// ── Local UI-state shapes (owned by the root; typed here so the overlay modals can import) ──

/** Which style the content area is showing. null = none yet (auto-select derives one in render). */
export interface SelectedStyleRef {
  group: string;
  index: number;
}

/** GenerateStyleModal state — `add` appends a style, `regenerate` overwrites styles[styleIndex]. */
export interface GenerateModalState {
  group: string;
  mode: 'add' | 'regenerate';
  styleIndex?: number;
}

/** EditBaseEntityModal state — edits the base-variant text of every entity in a group. */
export interface EditEntityModalState {
  group: string;
}

/** Shared EditImageModal binding target — `raw` edits the whole sheet, `crop` edits one entity crop.
 *  Consumed by the SketchBaseEditImageModal connector (scope → illustrations + onUpdate + pathPrefix). */
export type EditImageTarget =
  | { group: string; styleIndex: number; scope: 'raw' }
  | { group: string; styleIndex: number; scope: 'crop'; entityKey: string };

/** Shared ExtractImageModal binding target — CROP scope only (reframe one entity crop → a new
 *  version of it). The raw multi-entity sheet has no single extract target, so it is excluded. */
export interface ExtractImageTarget {
  group: string;
  styleIndex: number;
  entityKey: string;
}

/**
 * Auto-select the first available style for the content area, walking the groups in their given
 * order (`useSketchBaseGroups` already sorts character groups before prop groups). Per group:
 * the is_selected (locked) style → styles[0]; falls through to the next group when empty; null =
 * nothing generated in ANY group yet. Pure — called from a `useMemo` in render (React 19: NO
 * set-state-in-render).
 */
export function pickFirstAvailable(
  groups: BaseGroup[],
  stylesByGroup: Record<string, SketchBaseStyle[]>,
): SelectedStyleRef | null {
  for (const g of groups) {
    const styles = stylesByGroup[g.group_key] ?? [];
    const locked = styles.findIndex((s) => s.is_selected);
    if (locked >= 0) return { group: g.group_key, index: locked };
    if (styles.length > 0) return { group: g.group_key, index: 0 };
  }
  return null;
}
