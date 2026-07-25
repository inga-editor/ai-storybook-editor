// lineup-constants.ts — static config + pure helpers for SketchLineupSpace (design README §2).
//
// DRY: `KindGroupConfig` / `KIND_GROUPS` / `ZOOM` are REUSED from the Base space (same two groups,
// same zoom bounds) and only re-exported here so lineup files import from one place. `LineupEntry`
// lives in @/types/sketch (store + feature both consume it — see the type's doc comment).
//
// 2026-07-25 multi-tab persist: tab caps + the pure tab/entry helpers (refOf / toTabEntry /
// nextTabName / the toggle payload builders) live here so the root's write handlers stay thin
// and each payload shape is unit-testable without React (see lineup-tab-helpers.test.ts).

import type { BaseKind, LineupEntry, SketchLineupEntry, SketchLineupTab } from '@/types/sketch';
import { KIND_GROUPS, ZOOM, type KindGroupConfig } from '../sketch-base-creative-space/sketch-base-constants';

export { KIND_GROUPS, ZOOM };
export type { KindGroupConfig, BaseKind, LineupEntry };

// ── Tab caps (design 02-01/03 — mapping constants) ───────────────────────────────────────────
export const LINEUP_TAB_LIMIT = 12;
export const LINEUP_TAB_NAME_MAX = 60;
export const LINEUP_TAB_LABEL_MAX_PX = 180;

/** Canonical ref of a PERSISTED entry — must mint the exact same string as `LineupEntry.ref`
 *  (`useSketchLineupEntries`), or checkbox derive/uncheck would silently mismatch. */
export const refOf = (e: SketchLineupEntry): string => `${e.kind}:@${e.entity_key}/${e.variant_key}`;

/** View-model → persisted entry (snake_case snapshot contract). */
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

/** Default expanded state — both groups open (design README §2.2). */
export const DEFAULT_EXPANDED_GROUPS: Record<BaseKind, boolean> = { characters: true, props: true };
