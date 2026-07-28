// lineup-constants.ts — static config + pure helpers for SketchLineupSpace (design README §2).
//
// DRY: `KindGroupConfig` / `ZOOM` are REUSED from the Base space and re-exported here so lineup
// files import from one place. `KIND_GROUPS` is DERIVED (not re-exported verbatim) — see
// LINEUP_WIRED_KINDS below. `LineupEntry` lives in @/types/sketch (store + feature both consume
// it — see the type's doc comment).
//
// 2026-07-25 multi-tab persist: tab caps + the pure tab/entry helpers (refOf / toTabEntry /
// nextTabName / the toggle payload builders) live here so the root's write handlers stay thin
// and each payload shape is unit-testable without React (see lineup-tab-helpers.test.ts).

import type {
  BaseEntityCollection,
  BaseKind,
  LineupEntry,
  SketchLineupEntry,
  SketchLineupTab,
} from '@/types/sketch';
import { KIND_ENTITY_SOURCE, lineupEntryRef, lineupPersistKind } from '@/types/sketch';
import {
  KIND_GROUPS as BASE_KIND_GROUPS,
  ZOOM,
  type KindGroupConfig,
} from '../sketch-base-creative-space/sketch-base-constants';

export { ZOOM };
export type { KindGroupConfig, BaseKind, LineupEntry };

/**
 * Kinds whose lineup wiring is COMPLETE — the ONE place that decides whether the lineup sidebar
 * shows a group. Rendering a group is only safe when every downstream seam agrees; a kind missing
 * from any of them renders a group that silently misbehaves. Phase 07 collapsed three of those
 * seams INTO this list so they can no longer drift apart:
 *   • `KIND_GROUPS` (below) — what the sidebar renders.
 *   • `ALL_KINDS` (below, consumed by the space's `grantedKinds`) — absent ⇒ the group shows
 *     "you do not have edit rights" TO THE BOOK OWNER.
 *   • `allEntries` (sketch-lineup-creative-space) — now derived from `KIND_GROUPS`; absent ⇒
 *     checked rows never reach the canvas or the rtype-12 tab persist (silent drop).
 * The ONE seam that stays separate is the wire vocabulary `LINEUP_ENTRY_KINDS`
 * (sketch-coerce-helpers) — it is deliberately NOT widened; see `toTabEntry` below.
 *
 * ⚡2026-07-28: `alter_characters` IS wired (Phase 07). Alter rows are deliberately selectable —
 * comparing an alter's height against the primary cast is the whole point of casting.
 */
export const LINEUP_WIRED_KINDS: readonly BaseKind[] = ['characters', 'props', 'alter_characters'];

/** Base-space group configs, narrowed to the kinds this space has fully wired (labels stay DRY). */
export const KIND_GROUPS: KindGroupConfig[] = BASE_KIND_GROUPS.filter((g) =>
  LINEUP_WIRED_KINDS.includes(g.kind),
);

/** Every kind the space can edit (what the OWNER gets). Derived — see LINEUP_WIRED_KINDS. */
export const ALL_KINDS: ReadonlySet<BaseKind> = new Set(LINEUP_WIRED_KINDS);

/** Collaborator grant key for a kind — a key of `access_rights.steps.sketch.resources`
 *  (`STEP_RESOURCES.sketch`). It is the REAL collection, so an alter is gated by the `characters`
 *  grant (Phase 01 — alter introduces no new grant). */
export const grantKeyOf = (kind: BaseKind): BaseEntityCollection =>
  KIND_ENTITY_SOURCE[kind].collection;

// ── Tab caps (design 02-01/03 — mapping constants) ───────────────────────────────────────────
export const LINEUP_TAB_LIMIT = 12;
export const LINEUP_TAB_NAME_MAX = 60;
export const LINEUP_TAB_LABEL_MAX_PX = 180;

/** Canonical ref of a PERSISTED entry — must mint the exact same string as `LineupEntry.ref`
 *  (`useSketchLineupEntries`), or checkbox derive/uncheck would silently mismatch. Both go through
 *  `lineupEntryRef`, so a stored `characters` entry and the alter ROW it came from agree. */
export const refOf = (e: SketchLineupEntry): string =>
  lineupEntryRef(e.kind, e.entity_key, e.variant_key);

/**
 * View-model → persisted entry (snake_case snapshot contract).
 *
 * ⚡ UI 3 kinds → WIRE 2 kinds: `alter_characters` is written as `characters`. The rtype-12
 * coercer (`LINEUP_ENTRY_KINDS`) drops any other value on load, so persisting the UI kind would be
 * silent data loss. Nothing is lost by narrowing: the alter/story split is re-derived from the
 * entity's `actor_role` at read time (`useSketchLineupEntries`), never from the stored kind — so
 * an alter still lands in the Alter group after a reload.
 */
export const toTabEntry = (e: LineupEntry): SketchLineupEntry => ({
  kind: lineupPersistKind(e.kind),
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

/** Default expanded state — every group open (design README §2.2). */
export const DEFAULT_EXPANDED_GROUPS: Record<BaseKind, boolean> = {
  characters: true,
  props: true,
  alter_characters: true,
};
