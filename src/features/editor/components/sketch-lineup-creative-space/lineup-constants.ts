// lineup-constants.ts — static config + pure helpers for SketchLineupSpace (design README §2).
//
// ⚡REV 2026-08-21 — DYNAMIC GROUPS: the sidebar renders one collapsible group per
// `useSketchBaseGroups()` descriptor (N character/prop groups), NOT a fixed 3-kind list. The old
// `LINEUP_WIRED_KINDS` / `KIND_GROUPS` / `ALL_KINDS` seams (and the alter→characters narrowing)
// are gone — every group's `kind` is a self-describing `SheetKind` (`characters` | `props`), which
// is ALSO the persist vocabulary, so `toTabEntry`/`refOf` carry it straight through with no
// mapping. DRY: `ZOOM` is REUSED from the Base space. `LineupEntry` lives in @/types/sketch (store
// + feature both consume it).
//
// 2026-07-25 multi-tab persist: tab caps + the pure tab/entry helpers (refOf / toTabEntry /
// nextTabName / the toggle payload builders) live here so the root's write handlers stay thin
// and each payload shape is unit-testable without React (see lineup-tab-helpers.test.ts).

import type {
  BaseEntityCollection,
  LineupEntry,
  SheetKind,
  SketchLineupEntry,
  SketchLineupTab,
} from '@/types/sketch';
import { lineupEntryRef } from '@/types/sketch';
import { ZOOM } from '../sketch-base-creative-space/sketch-base-constants';

export { ZOOM };
export type { LineupEntry };

/** Collaborator grant key for a group's kind — a key of `access_rights.steps.sketch.resources`
 *  (`STEP_RESOURCES.sketch`). The lineup persist vocabulary IS the real collection, so the grant
 *  key is the kind itself (`characters` | `props`) — no per-group grant, no alter special case. */
export const grantKeyOf = (kind: SheetKind): BaseEntityCollection => kind;

// ── Tab caps (design 02-01/03 — mapping constants) ───────────────────────────────────────────
export const LINEUP_TAB_LIMIT = 12;
export const LINEUP_TAB_NAME_MAX = 60;
export const LINEUP_TAB_LABEL_MAX_PX = 180;

/** Canonical ref of a PERSISTED entry — must mint the exact same string as `LineupEntry.ref`, or
 *  checkbox derive/uncheck would silently mismatch. Both go through `lineupEntryRef`. */
export const refOf = (e: SketchLineupEntry): string =>
  lineupEntryRef(e.kind, e.entity_key, e.variant_key);

/**
 * View-model → persisted entry (snake_case snapshot contract). ⚡REV 2026-08-21 — the UI kind IS
 * the wire kind (both are `SheetKind`), so the group's kind flows straight through with no
 * narrowing. The rtype-12 vocabulary (`LINEUP_ENTRY_KINDS`) is these same two values.
 */
export const toTabEntry = (e: LineupEntry): SketchLineupEntry => ({
  kind: e.kind,
  entity_key: e.entityKey,
  variant_key: e.variantKey,
});

/**
 * Deterministic default name for a NEW tab: seed at `count + 1`, bump past collisions
 * ("Lineup 2" taken → "Lineup 3"). Deterministic on the CURRENT tabs only — Cancel + reopen
 * yields the same suggestion (design 03 §2.2).
 */
export function nextTabName(effectiveTabs: SketchLineupTab[]): string {
  const names = new Set(effectiveTabs.map((t) => t.name));
  let n = effectiveTabs.length + 1;
  while (names.has(`Lineup ${n}`)) n += 1;
  return `Lineup ${n}`;
}

// ── Toggle payload builders (pure — the exact entries[] each write hands the store) ──────────

/** Check/uncheck ONE row. Check appends (membership is append-order); uncheck removes by the
 *  kind-qualified ref so character `armor/base` never evicts prop `armor/base`. */
export function buildToggleEntries(
  base: SketchLineupEntry[],
  entry: LineupEntry,
  checked: boolean,
): SketchLineupEntry[] {
  return checked ? [...base, toTabEntry(entry)] : base.filter((e) => refOf(e) !== entry.ref);
}

/**
 * Select-all tri-state payload. Check → append every selectable row not yet a member (SIDEBAR
 * order — irrelevant for display, deterministic for diffs). Uncheck → drop ONLY entries that
 * resolve to a currently-selectable row; dangling/non-renderable members are KEPT (spec: never
 * auto-prune — cleanup is the user's explicit "Dọn").
 */
export function buildToggleAllEntries(
  base: SketchLineupEntry[],
  selectableEntries: LineupEntry[],
  checked: boolean,
): SketchLineupEntry[] {
  const selectableRefs = new Set(selectableEntries.map((e) => e.ref));
  if (!checked) return base.filter((e) => !selectableRefs.has(refOf(e)));
  const memberRefs = new Set(base.map(refOf));
  return [...base, ...selectableEntries.filter((e) => !memberRefs.has(e.ref)).map(toTabEntry)];
}

/** "Dọn" chip payload: keep ONLY members that currently render on the canvas (resolve to a
 *  selectable row) — everything the dangling counter counts is dropped. */
export function buildCleanupEntries(
  base: SketchLineupEntry[],
  selectableEntries: LineupEntry[],
): SketchLineupEntry[] {
  const selectableRefs = new Set(selectableEntries.map((e) => e.ref));
  return base.filter((e) => selectableRefs.has(refOf(e)));
}

/** Mint a fresh VIRTUAL tab (shown before any tab is persisted — id minted ONCE per space mount,
 *  see the root's useState initializer). */
export const mintVirtualTab = (): SketchLineupTab => ({
  id: crypto.randomUUID(),
  name: 'Lineup',
  entries: [],
});

/**
 * A variant can join the lineup only with BOTH a locked crop image AND a real-world height —
 * without either it cannot be placed on the shared ruler. Non-selectable rows still RENDER
 * (disabled + greyed + reason tooltip; memory: never-hide-disabled-ui).
 */
export const selectable = (entry: LineupEntry): boolean =>
  entry.imageUrl != null && entry.heightCm != null;

/**
 * Why a row is disabled + WHERE to fix it (design 01 §2.4). Both missing → both lines.
 * Returns null when the entry is selectable.
 */
export function disabledReason(entry: LineupEntry): string | null {
  const reasons: string[] = [];
  if (entry.imageUrl == null) reasons.push('No crop locked — lock one in the Base/Variants space');
  if (entry.heightCm == null) reasons.push('No height set — add it in the Edit modal (Base/Variants space)');
  return reasons.length > 0 ? reasons.join('\n') : null;
}

/** Sidebar row label — mock convention: "{entityKey}/{variantKey}", NO leading `@`. */
export const rowLabel = (entry: LineupEntry): string => `${entry.entityKey}/${entry.variantKey}`;

/** DISPLAY-ONLY mention (canvas captions/labels) — design keeps "@entity/variant"; the
 *  kind-prefixed `entry.ref` is IDENTITY only and must not leak into user-facing text
 *  (review M2 2026-07-25). */
export const mentionOf = (entry: LineupEntry): string => `@${entry.entityKey}/${entry.variantKey}`;

/** Singular noun for a group's empty-state hint ("No {noun}s imported yet"). */
export const nounForKind = (kind: SheetKind): string => (kind === 'props' ? 'prop' : 'character');
