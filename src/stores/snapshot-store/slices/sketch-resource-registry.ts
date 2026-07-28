// sketch-resource-registry.ts — LEAF registry mapping a sketch normalize finding to the
// save-addressable resource it belongs to (ADR-047 consent-gated normalization).
//
// Two coordinate systems meet here:
//   • the NORMALIZER reports anomalies by JSON path ("base.character_sheet.styles"), but
//   • the collab gateway saves by LockTarget tuple (step, resource_type, resource_id, locale) —
//     `saveResource` has NO path param (the path→node resolve is server-side).
// The registry translates: each `SketchResourceKey` yields a predicate over LockTarget so the
// save-block layer (phase-04) can refuse exactly the writes that touch a degraded subtree.
//
// ── Taxonomy (single source — every normalize transform belongs to exactly ONE class) ─────────
// | Transform                                              | Class                        |
// |--------------------------------------------------------|------------------------------|
// | raw == null → DEFAULT_SKETCH                           | ABSENT (no anomaly)          |
// | base == null → 2 empty sheets                          | ABSENT (no anomaly)          |
// | sheet == null → {styles:[]}                            | ABSENT (no anomaly)          |
// | sheet.styles == null → []                              | ABSENT (no anomaly)          |
// | entity collection == null → []                         | ABSENT (no anomaly)          |
// | height "1.1m" → 110 (parseHeightCm)                    | convert (D1 — warn on fail)  |
// | legacy `crop` → crops[0]                               | convert (silent)             |
// | media_url string → images[0]                           | convert (silent)             |
// | image missing `type` → inferred from pages order       | convert (silent)             |
// | styles object-map {"0":…} → array (salvage)            | convert (reported)           |
// | bare array in sheet slot → {styles: array} (salvage)   | convert (reported)           |
// | dedupe images by page type — dropped has NO real data  | convert (D8 conditional)     |
// | dedupe images by page type — dropped HAS illustrations | reset  (D8 conditional)      |
// | sketch non-object → DEFAULT_SKETCH                     | reset                        |
// | base non-object → 2 empty sheets                       | reset (both sheets)          |
// | sheet non-object → {styles:[]}                         | reset                        |
// | styles wrong type → {styles:[]}                        | reset  ← the reported bug    |
// | entity collection non-array → []                       | reset                        |
// | entity element non-object → {key:'',variants:[]}       | reset                        |
// | spreads non-array → []                                 | reset                        |
// | spreads[] element non-object → empty slot              | reset (coarse — id unknown)  |
// | LEGACY_SKETCH_KEYS (dummy_id…) present                 | report (toast only, D3)      |
//
// convert = lossless/auto (no consent, no save-block). reset = lossy → quarantine + degraded +
// save-block until the user consents (phase-03 modal). report = heads-up toast, nothing blocked.
//
// NOT a security boundary: the gateway (lock precondition + access_rights) stays the authority.
// This registry only powers a client-side DATA-SAFETY guard — never treat it as access control.

import type { LockTarget } from '@/stores/resource-lock-store/types';

/** How a normalize transform is classified (see taxonomy table above). */
export type AnomalyClass = 'convert' | 'reset' | 'report';

/**
 * One unexpected-shape finding, addressed to the resource it belongs to.
 * `resource` keys the save-block (phase-04) and the consent modal (phase-03); `path` is the
 * precise location for logs/support; `raw` carries the original blob ONLY for `cls:'reset'`
 * (it becomes the quarantine payload — never logged, never rendered).
 */
export interface SketchAnomaly {
  resource: SketchResourceKey;
  cls: AnomalyClass;
  path: string;
  message: string;
  raw?: unknown;
}

/** The normalizers stay PURE — they never import a toast/UI module. Every anomaly flows to the
 *  caller (`snapshot-store/index.ts` loadSketch / content-sync fetchSyncNode). */
export type SketchAnomalyReporter = (anomaly: SketchAnomaly) => void;

export const noopAnomalyReporter: SketchAnomalyReporter = () => {};

/** One DEGRADED resource as stored in the slice (`sketchDegraded`). The quarantined raw blob
 *  lives separately in `sketchQuarantine[resource]`; `sig` is its short content hash — the
 *  consent-storage key component (accept decisions are remembered per resource+sig, D11). */
export interface SketchDegradedEntry {
  resource: SketchResourceKey;
  path: string;
  message: string;
  sig: string;
}

/** Intake shape for `markSketchDegraded` — the entry plus the raw blob to quarantine. */
export type SketchDegradedIntake = SketchDegradedEntry & { raw?: unknown };

/**
 * Identifies ONE sketch resource at the grain the gateway can save it.
 * Node-grain keys address a single saveable node; the bare collection keys (and 'sketch')
 * are COARSE — they block every write of that resource type (fail-safe, not fail-open).
 */
export type SketchResourceKey =
  | 'sketch' // root — coarse: blocks every step-1 write
  | 'base.character_sheet'
  | 'base.prop_sheet'
  | 'base.alter_character_sheet' // ⚡ 2026-07-28 — 3rd base sheet (alter characters)
  | `characters/${string}` // node-grain: entity key
  | `props/${string}`
  | `stages/${string}`
  | 'characters'
  | 'props'
  | 'stages' // collection-grain — coarse: blocks every write of that rtype
  | `spreads/${string}` // node-grain: spread id
  | 'spreads'; // collection-grain — coarse

/** The base-sheet subset of the resource keys (one per `BaseKind` sheet node). */
export type SketchSheetResourceKey =
  | 'base.character_sheet'
  | 'base.prop_sheet'
  | 'base.alter_character_sheet';

export function isSheetResourceKey(key: SketchResourceKey): key is SketchSheetResourceKey {
  return (
    key === 'base.character_sheet' ||
    key === 'base.prop_sheet' ||
    key === 'base.alter_character_sheet'
  );
}

/** step=1 rtypes per entity collection (mirrors ResourceType: 3 character · 4 prop · 5 stage). */
const ENTITY_RTYPE: Record<'characters' | 'props' | 'stages', number> = {
  characters: 3,
  props: 4,
  stages: 5,
};

/** rtype 11 base_sheet resource_ids (ADR-046). Mirrors `BASE_SHEET_ID` (types/sketch.ts) — the
 *  resource key is just the sheet node prefixed with `base.`. */
const SHEET_RESOURCE_ID: Record<SketchSheetResourceKey, string> = {
  'base.character_sheet': 'character_sheet',
  'base.prop_sheet': 'prop_sheet',
  'base.alter_character_sheet': 'alter_character_sheet',
};

/**
 * Build the LockTarget predicate for one degraded resource key.
 *
 * All sketch writes are step=1; any other step never matches. Grain rules:
 *  - 'sketch'            → EVERY step-1 write (root corruption — nothing is trustworthy).
 *  - sheet keys          → rtype 11 with the matching sheet resource_id.
 *  - '{kind}/{key}'      → rtype 3/4/5 with the exact entity key.
 *  - bare '{kind}'       → rtype 3/4/5, ANY resource_id (collection unreadable → every entity
 *                          of that kind is untrustworthy).
 *  - 'spreads/{id}'      → rtype 6 with the exact spread id, PLUS ALL rtype 1/2 (page image /
 *                          textbox) writes. Rtype 1/2 resource_ids are child ids — the parent
 *                          spread is NOT derivable from the LockTarget alone, so they are blocked
 *                          coarsely whenever any spread is degraded (fail-safe trade-off).
 *  - bare 'spreads'      → rtype 6 + 1 + 2, ANY resource_id.
 */
export function resourceKeyToLockPredicate(key: SketchResourceKey): (t: LockTarget) => boolean {
  if (key === 'sketch') return (t) => t.step === 1;

  if (isSheetResourceKey(key)) {
    const rid = SHEET_RESOURCE_ID[key];
    return (t) => t.step === 1 && t.resource_type === 11 && t.resource_id === rid;
  }

  if (key === 'characters' || key === 'props' || key === 'stages') {
    const rtype = ENTITY_RTYPE[key];
    return (t) => t.step === 1 && t.resource_type === rtype;
  }

  if (key === 'spreads') {
    return (t) =>
      t.step === 1 && (t.resource_type === 6 || t.resource_type === 1 || t.resource_type === 2);
  }

  const slash = key.indexOf('/');
  const kind = key.slice(0, slash) as 'characters' | 'props' | 'stages' | 'spreads';
  const id = key.slice(slash + 1);

  if (kind === 'spreads') {
    return (t) =>
      t.step === 1 &&
      // The 'spreads' SENTINEL resource_id (rtype 6) is the whole-collection replace-all path
      // (Excel import via runLockedCollectionSave) — it would silently overwrite the quarantined
      // spread without consent, so a node-grain degraded spread blocks it too (fail-safe).
      ((t.resource_type === 6 && (t.resource_id === id || t.resource_id === 'spreads')) ||
        // Child writes (page image rtype 1 / textbox rtype 2) target the CHILD id, not the spread
        // id — unattributable client-side, so block them all while any spread is degraded.
        t.resource_type === 1 ||
        t.resource_type === 2);
  }

  const rtype = ENTITY_RTYPE[kind];
  return (t) => t.step === 1 && t.resource_type === rtype && t.resource_id === id;
}

const KIND_LABEL: Record<'characters' | 'props' | 'stages', { one: string; many: string }> = {
  characters: { one: 'Nhân vật', many: 'Danh sách nhân vật' },
  props: { one: 'Đạo cụ', many: 'Danh sách đạo cụ' },
  stages: { one: 'Bối cảnh', many: 'Danh sách bối cảnh' },
};

/** Vietnamese display label for a resource (consent-modal row title). */
export function describeResource(key: SketchResourceKey): string {
  switch (key) {
    case 'sketch':
      return 'Toàn bộ dữ liệu sketch';
    case 'base.character_sheet':
      return 'Bộ style nhân vật (character sheet)';
    case 'base.prop_sheet':
      return 'Bộ style đạo cụ (prop sheet)';
    case 'base.alter_character_sheet':
      return 'Bộ style nhân vật thay thế (alter character sheet)';
    case 'characters':
    case 'props':
    case 'stages':
      return KIND_LABEL[key].many;
    case 'spreads':
      return 'Danh sách trang vẽ (spreads)';
  }
  const slash = key.indexOf('/');
  const kind = key.slice(0, slash);
  const id = key.slice(slash + 1);
  if (kind === 'spreads') return `Trang vẽ (spread) "${id}"`;
  return `${KIND_LABEL[kind as 'characters' | 'props' | 'stages'].one} "${id}"`;
}

/** Vietnamese "what a reset destroys" line for a resource (consent-modal row body — the user
 *  must see exactly WHAT is lost before agreeing, per the direct instruction). */
export function describeResetImpact(key: SketchResourceKey): string {
  switch (key) {
    case 'sketch':
      return 'Reset sẽ xoá TOÀN BỘ dữ liệu sketch của sách này (styles, nhân vật, đạo cụ, bối cảnh, trang vẽ).';
    case 'base.character_sheet':
      return 'Reset sẽ xoá toàn bộ style đã tạo của bộ style nhân vật.';
    case 'base.prop_sheet':
      return 'Reset sẽ xoá toàn bộ style đã tạo của bộ style đạo cụ.';
    case 'base.alter_character_sheet':
      return 'Reset sẽ xoá toàn bộ style đã tạo của bộ style nhân vật thay thế.';
    case 'characters':
      return 'Reset sẽ xoá toàn bộ danh sách nhân vật của sketch.';
    case 'props':
      return 'Reset sẽ xoá toàn bộ danh sách đạo cụ của sketch.';
    case 'stages':
      return 'Reset sẽ xoá toàn bộ danh sách bối cảnh của sketch.';
    case 'spreads':
      return 'Reset sẽ xoá toàn bộ danh sách trang vẽ của sketch.';
  }
  const slash = key.indexOf('/');
  const kind = key.slice(0, slash);
  const id = key.slice(slash + 1);
  if (kind === 'spreads') return `Reset sẽ xoá nội dung không đọc được của trang vẽ "${id}".`;
  const label = KIND_LABEL[kind as 'characters' | 'props' | 'stages'].one.toLowerCase();
  return `Reset sẽ xoá ${label} "${id}" khỏi sketch.`;
}
