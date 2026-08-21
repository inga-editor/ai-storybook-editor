// sketch-coerce-helpers.ts — ELEMENT-level coercers for the sketch read boundary (ADR-047).
// One raw element (variant / crop / entity / style) → its typed shape, defaults filled. Split out
// of sketch-normalize.ts (500-line rule): this module owns the per-element rules, the normalizer
// owns the per-RESOURCE orchestration (fault isolation, placeholders, quarantine classification).
//
// Taxonomy (single source: sketch-resource-registry.ts): everything here is ABSENT-default or
// lossless CONVERT — except a non-object element / wrong-typed `variants`, which is a LOSSY reset
// and is reported when the caller passes a reporter + kind.

import type {
  SketchEntity,
  SketchVariant,
  SketchVariantCrop,
  SketchBaseStyle,
  SketchLineupEntry,
  SketchLineupTab,
  SketchStage,
  SketchStageStyle,
  SketchStageVariant,
} from '@/types/sketch';
import { lineupEntryRef } from '@/types/sketch';
import type { Illustration } from '@/types/prop-types';
import { createLogger } from '@/utils/logger';
import { parseHeightCm } from '@/utils/parse-height-cm';
import {
  describeResource,
  noopAnomalyReporter,
  type SketchAnomalyReporter,
  type SketchResourceKey,
} from './sketch-resource-registry';

const log = createLogger('Store', 'SketchCoerce');

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const typeNameOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

export const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The entity collections under `sketch` sharing the char/prop variant shape. `stages` left this
 *  club with the 2026-07-18 rework — it routes through the dedicated stage coercers below. */
export type SketchEntityCollection = 'characters' | 'props';
export const ENTITY_KINDS: readonly string[] = [
  'characters',
  'props',
] satisfies SketchEntityCollection[];

/** Resource key for one entity: node-grain when the key is readable, else the coarse collection. */
export function entityResourceKey(
  kind: SketchEntityCollection | 'stages',
  key: string,
): SketchResourceKey {
  return key ? (`${kind}/${key}` as SketchResourceKey) : kind;
}

/** Coerce one raw variant-crop blob → SketchVariantCrop (positional cell; is_selected defaults
 *  to false, illustrations to []). */
export function coerceVariantCrop(raw: unknown): SketchVariantCrop {
  const r = isPlainObject(raw) ? raw : {};
  return {
    is_selected: Boolean(r.is_selected),
    illustrations: Array.isArray(r.illustrations) ? (r.illustrations as Illustration[]) : [],
  };
}

/** Coerce one raw variant → SketchVariant, filling the 3 required text fields when absent
 *  (backward-compat for blobs written before the 2026-07-13 restructure). raw_sheet parses the
 *  new `{ illustrations[], crops[] }` model; the legacy single `crop` blob (pre-2026-07-14) is
 *  mapped LOSSLESSLY into `crops[0]` (is_selected=true). char/prop only — stages coerce through
 *  `coerceStage` (2026-07-18 rework). */
export function coerceVariant(raw: unknown): SketchVariant {
  const r = isPlainObject(raw) ? raw : {};
  const v: SketchVariant = {
    key: asStr(r.key),
    description: asStr(r.description),
    visual_design: asStr(r.visual_design),
    art_language: asStr(r.art_language),
  };
  // MIGRATE (read-time, 2026-07-17): height went string → number|null (cm). Every load/merge runs
  // through here, so a legacy string blob ("~110cm") self-parses to 110; an already-number value is
  // idempotent; an unparseable one becomes null (the variant itself is never dropped). No DB
  // migration needed. Presence-gated: a variant with NO height field keeps none (stage variants have
  // no height at all — writing `height: null` onto every one of them would churn the blob).
  if ('height' in r) {
    const parsed = parseHeightCm(r.height);
    // D1 (consent plan): unparseable height is an accepted lossless-by-decision CONVERT, but the
    // original string IS dropped on the next save — never let that happen silently.
    if (r.height != null && parsed === null) {
      log.warn('coerceVariant', 'height unparseable — replaced with null (original dropped on next save)', {
        variantKey: v.key,
        preview: String(r.height).slice(0, 40),
      });
    }
    v.height = parsed;
  }
  // Legacy single-cell crop (pre-2026-07-14) → mapped into crops[0] below.
  const legacyCropIllustrations =
    isPlainObject(r.crop) && Array.isArray(r.crop.illustrations)
      ? (r.crop.illustrations as Illustration[])
      : null;
  if (isPlainObject(r.raw_sheet)) {
    const illustrations = Array.isArray(r.raw_sheet.illustrations)
      ? (r.raw_sheet.illustrations as Illustration[])
      : [];
    let crops: SketchVariantCrop[];
    if (Array.isArray(r.raw_sheet.crops)) {
      crops = r.raw_sheet.crops.map(coerceVariantCrop); // new positional model
    } else if (legacyCropIllustrations) {
      crops = [{ is_selected: true, illustrations: legacyCropIllustrations }]; // BACK-COMPAT
    } else {
      crops = [];
    }
    v.raw_sheet = { illustrations, crops };
  } else if (legacyCropIllustrations) {
    // Legacy blob carrying only `crop` (no raw_sheet).
    v.raw_sheet = { illustrations: [], crops: [{ is_selected: true, illustrations: legacyCropIllustrations }] };
  }
  return v;
}

/**
 * Coerce one raw entity → SketchEntity. Absent fields default (ABSENT/CONVERT); but a non-object
 * element or a wrong-typed `variants` is LOSSY — the payload cannot be represented — so it is
 * reported as a reset of that entity (coarse collection when the key is unreadable).
 */
export function coerceEntity(
  raw: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
  kind?: SketchEntityCollection,
): SketchEntity {
  if (!isPlainObject(raw)) {
    if (kind) {
      onAnomaly({
        resource: kind,
        cls: 'reset',
        path: `${kind}[]`,
        message: `${describeResource(kind)} có phần tử kiểu "${typeNameOf(raw)}" thay vì object`,
        raw,
      });
    }
    return { key: '', variants: [] };
  }
  const key = asStr(raw.key);
  if (kind && 'variants' in raw && raw.variants != null && !Array.isArray(raw.variants)) {
    onAnomaly({
      resource: entityResourceKey(kind, key),
      cls: 'reset',
      path: `${kind}/${key || '?'}.variants`,
      message: `variants của ${describeResource(entityResourceKey(kind, key))} có kiểu "${typeNameOf(raw.variants)}" thay vì array`,
      raw,
    });
  }
  const entity: SketchEntity = {
    key,
    variants: Array.isArray(raw.variants) ? raw.variants.map(coerceVariant) : [],
  };
  // ⚡REV 2026-08-21 — carry the group key through (PRESENCE-GATED: absent stays absent so a
  // pre-group book never churns the JSONB; `resolveEntityGroup` derives the group at read time).
  if (typeof raw.group === 'string' && raw.group !== '') entity.group = raw.group;
  // ⚠️ LEGACY carry-through — `actor_role` is still READ so `resolveEntityGroup` can derive the
  // group of a pre-group entity. Presence-gated (absent stays absent — no JSONB churn); never
  // re-stamped on write.
  if (raw.actor_role != null) entity.actor_role = coerceActorRole(raw.actor_role, key);
  return entity;
}

/** Any raw `actor_role` value → 0 | 1. Only a literal 1 (number/string/true) means ALTER; anything
 *  else falls back to the 0 default — unreadable values are logged, never guessed. */
function coerceActorRole(raw: unknown, entityKey: string): 0 | 1 {
  if (raw === 1 || raw === '1' || raw === true) return 1;
  if (raw === 0 || raw === '0' || raw === false || raw == null) return 0;
  log.warn('coerceActorRole', 'unreadable actor_role — treated as 0 (primary)', {
    entityKey,
    type: typeNameOf(raw),
  });
  return 0;
}

export function asEntityArray(
  v: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
  kind?: SketchEntityCollection,
): SketchEntity[] {
  if (!Array.isArray(v)) {
    if (kind) {
      onAnomaly({
        resource: kind,
        cls: 'reset',
        path: kind,
        message: `${kind} có kiểu "${typeNameOf(v)}" thay vì array`,
        raw: v,
      });
    }
    return [];
  }
  return v.map((el) => {
    try {
      return coerceEntity(el, onAnomaly, kind);
    } catch (err) {
      if (kind) {
        onAnomaly({
          resource: kind,
          cls: 'reset',
          path: `${kind}[]`,
          message: `${describeResource(kind)} có phần tử gây lỗi khi đọc (${err instanceof Error ? err.message : String(err)})`,
        });
      }
      return { key: '', variants: [] };
    }
  });
}

// ── Stage coercers (2026-07-18 BREAKING rework — per-stage base.styles[] + 2-cell sheets) ────

/** Coerce one raw stage style attempt → SketchStageStyle (never trust inner shapes). */
export function coerceStageStyle(raw: unknown): SketchStageStyle {
  const r = isPlainObject(raw) ? raw : {};
  return {
    style_prompt: asStr(r.style_prompt),
    is_selected: Boolean(r.is_selected),
    image_references: Array.isArray(r.image_references)
      ? (r.image_references as SketchStageStyle['image_references'])
      : [],
    illustrations: Array.isArray(r.illustrations) ? (r.illustrations as Illustration[]) : [],
    crops: Array.isArray(r.crops) ? r.crops.map(coerceVariantCrop) : [],
  };
}

/**
 * Coerce one raw stage variant → SketchStageVariant.
 *
 * MIGRATE (read-time, 2026-07-18 BREAKING): the OLD stage model (shared SketchVariant — direct
 * `illustrations[]`, no `crops`) is detected by the ABSENT `crops` field. Per the locked design
 * decision, old images are RESET (they don't fit the 2-cell sheet grid) while every text field is
 * KEPT — classified `convert` (deliberate, non-blocking), NEVER `reset`/quarantine (a routine
 * migration must not trip the ADR-047 consent modal). `height` (old shared shape) is dropped —
 * stages have none.
 */
export function coerceStageVariant(
  raw: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
  stageKey?: string,
): SketchStageVariant {
  const r = isPlainObject(raw) ? raw : {};
  const isNewShape = Array.isArray(r.crops);
  const oldIllustrations = Array.isArray(r.illustrations) ? r.illustrations : [];
  if (!isNewShape && oldIllustrations.length > 0) {
    onAnomaly({
      resource: stageKey ? (`stages/${stageKey}` as SketchResourceKey) : 'stages',
      cls: 'convert',
      path: `stages/${stageKey || '?'}.variants`,
      message: `variant "${asStr(r.key) || '?'}" mang ${oldIllustrations.length} ảnh theo model stage cũ — ảnh reset theo rework 2026-07-18 (text giữ nguyên)`,
    });
  }
  return {
    key: asStr(r.key),
    description: asStr(r.description),
    visual_design: asStr(r.visual_design),
    art_language: asStr(r.art_language),
    illustrations: isNewShape ? (oldIllustrations as Illustration[]) : [],
    crops: isNewShape ? (r.crops as unknown[]).map(coerceVariantCrop) : [],
  };
}

/**
 * Coerce one raw stage → SketchStage. `base` ABSENT (old-shape blob / new book) → `{styles: []}`
 * with no anomaly; `base.styles` object-map (positional gateway write onto a missing path) →
 * lossless salvage; wrong-typed `variants` → LOSSY reset of that stage (mirror coerceEntity).
 */
export function coerceStage(
  raw: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
): SketchStage {
  if (!isPlainObject(raw)) {
    onAnomaly({
      resource: 'stages',
      cls: 'reset',
      path: 'stages[]',
      message: `${describeResource('stages')} có phần tử kiểu "${typeNameOf(raw)}" thay vì object`,
      raw,
    });
    return { key: '', base: { styles: [] }, variants: [] };
  }
  const key = asStr(raw.key);
  let styles: SketchStageStyle[] = [];
  const rawBase = raw.base;
  if (isPlainObject(rawBase)) {
    const rawStyles = rawBase.styles;
    if (Array.isArray(rawStyles)) {
      styles = rawStyles.map(coerceStageStyle);
    } else if (isPlainObject(rawStyles) && Object.values(rawStyles).every(isPlainObject) && Object.values(rawStyles).length > 0) {
      // Object-map salvage ({"0":{…}}) — same real-world risk as the base workspace sheets.
      onAnomaly({
        resource: entityResourceKey('stages', key),
        cls: 'convert',
        path: `stages/${key || '?'}.base.styles`,
        message: `stages/${key || '?'}.base.styles là object-map thay vì array (đã giữ nguyên ${Object.values(rawStyles).length} style)`,
      });
      styles = Object.values(rawStyles).map(coerceStageStyle);
    } else if (rawStyles != null) {
      onAnomaly({
        resource: entityResourceKey('stages', key),
        cls: 'reset',
        path: `stages/${key || '?'}.base.styles`,
        message: `stages/${key || '?'}.base.styles có kiểu "${typeNameOf(rawStyles)}" thay vì array`,
        raw,
      });
    }
  } else if (rawBase != null) {
    onAnomaly({
      resource: entityResourceKey('stages', key),
      cls: 'reset',
      path: `stages/${key || '?'}.base`,
      message: `stages/${key || '?'}.base có kiểu "${typeNameOf(rawBase)}" thay vì object`,
      raw,
    });
  }
  if ('variants' in raw && raw.variants != null && !Array.isArray(raw.variants)) {
    onAnomaly({
      resource: entityResourceKey('stages', key),
      cls: 'reset',
      path: `stages/${key || '?'}.variants`,
      message: `variants của ${describeResource(entityResourceKey('stages', key))} có kiểu "${typeNameOf(raw.variants)}" thay vì array`,
      raw,
    });
  }
  return {
    key,
    base: { styles },
    variants: Array.isArray(raw.variants)
      ? raw.variants.map((v) => coerceStageVariant(v, onAnomaly, key))
      : [],
  };
}

export function asStageArray(
  v: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
): SketchStage[] {
  if (!Array.isArray(v)) {
    onAnomaly({
      resource: 'stages',
      cls: 'reset',
      path: 'stages',
      message: `stages có kiểu "${typeNameOf(v)}" thay vì array`,
      raw: v,
    });
    return [];
  }
  return v.map((el) => {
    try {
      return coerceStage(el, onAnomaly);
    } catch (err) {
      onAnomaly({
        resource: 'stages',
        cls: 'reset',
        path: 'stages[]',
        message: `${describeResource('stages')} có phần tử gây lỗi khi đọc (${err instanceof Error ? err.message : String(err)})`,
      });
      return { key: '', base: { styles: [] }, variants: [] };
    }
  });
}

/** Coerce one salvaged raw style blob → SketchBaseStyle, defaulting its 3 array fields.
 *  Mirrors `coerceEntity`'s philosophy: never trust a recovered element's inner shape. Without
 *  this, a salvaged non-style element reaches `styles[i].crops.find(...)` / `.illustrations
 *  .forEach(...)` in the base-workspace actions and throws. Only used on the SALVAGE paths —
 *  a well-formed `styles` array is passed through untouched. */
export function coerceStyle(raw: unknown): SketchBaseStyle {
  const r = isPlainObject(raw) ? raw : {};
  return {
    style_prompt: asStr(r.style_prompt),
    is_selected: Boolean(r.is_selected),
    image_references: Array.isArray(r.image_references)
      ? (r.image_references as SketchBaseStyle['image_references'])
      : [],
    illustrations: Array.isArray(r.illustrations) ? (r.illustrations as Illustration[]) : [],
    crops: Array.isArray(r.crops) ? (r.crops as SketchBaseStyle['crops']) : [],
  };
}

// ── Lineup tabs (sketch.lineups[] — rtype 12, 2026-07-25) ────────────────────────────────────

/** Entry kinds a persisted lineup tab may hold — anything else is DROPPED on load. Exported so the
 *  lineup sidebar's rendered groups can be pinned against it: a group whose kind is missing here
 *  would let the user check rows that silently vanish on the next snapshot load. */
export const LINEUP_ENTRY_KINDS: readonly string[] = ['characters', 'props'];
const LINEUP_TAB_NAME_MAX = 60; // mirror the modal's maxLength (defense-in-depth vs peer/DB data)

/**
 * Coerce a raw `sketch.lineups` blob → SketchLineupTab[] (peer/DB data — whitelist only).
 *
 * The lineup node is CONFIG (no artwork, cheap to rebuild) → deliberately FAIL-OPEN, never
 * quarantine/degrade (plan Validation S1 — `lineups` is NOT a SketchResourceKey):
 *  - ABSENT (null/undefined) → [] with NO anomaly (a book without tabs is legitimate).
 *  - non-array container → [] + ONE `cls:'report'` anomaly under the coarse 'sketch' key
 *    (heads-up toast; NOT 'reset' — a 'sketch' reset would block EVERY step-1 write).
 *  - garbage elements (non-object / unreadable id/name) → dropped, log debug only.
 *  - entries: whitelist {kind, entity_key, variant_key}; dedupe by the full triple (keep FIRST —
 *    append order preserved). Dangling entries (deleted entity/variant) are KEPT — schema-valid;
 *    render-time skip + manual cleanup is the contract.
 *  - duplicate tab ids → keep the first occurrence.
 */
export function coerceLineupTabs(
  raw: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
): SketchLineupTab[] {
  if (raw == null) return []; // legitimately new — no anomaly
  if (!Array.isArray(raw)) {
    onAnomaly({
      resource: 'sketch',
      cls: 'report',
      path: 'lineups',
      message: `sketch.lineups có kiểu "${typeNameOf(raw)}" thay vì array — đã dùng danh sách rỗng`,
    });
    return [];
  }
  const seenTabIds = new Set<string>();
  const tabs: SketchLineupTab[] = [];
  for (const el of raw) {
    if (!isPlainObject(el) || typeof el.id !== 'string' || el.id === '' || typeof el.name !== 'string') {
      log.debug('coerceLineupTabs', 'dropped malformed tab element', { type: typeNameOf(el) });
      continue;
    }
    if (seenTabIds.has(el.id)) {
      log.debug('coerceLineupTabs', 'dropped duplicate tab id (kept first)', { tabId: el.id });
      continue;
    }
    seenTabIds.add(el.id);
    const seenEntryRefs = new Set<string>();
    const entries: SketchLineupEntry[] = [];
    for (const e of Array.isArray(el.entries) ? el.entries : []) {
      if (
        !isPlainObject(e) ||
        typeof e.kind !== 'string' ||
        !LINEUP_ENTRY_KINDS.includes(e.kind) ||
        typeof e.entity_key !== 'string' ||
        typeof e.variant_key !== 'string'
      ) {
        log.debug('coerceLineupTabs', 'dropped malformed entry', { tabId: el.id });
        continue;
      }
      // Narrowed by the LINEUP_ENTRY_KINDS whitelist above (a `readonly string[]`, so `.includes`
      // cannot narrow the type on its own — this is the one cast, made once).
      const kind = e.kind as SketchLineupEntry['kind'];
      // Dedupe on the CANONICAL ref (same helper the sidebar rows + `refOf` use) — a hand-rolled
      // copy of the format here would silently stop deduping the day the format changes.
      const refKey = lineupEntryRef(kind, e.entity_key, e.variant_key);
      if (seenEntryRefs.has(refKey)) continue; // dedupe — keep first (append order preserved)
      seenEntryRefs.add(refKey);
      entries.push({ kind, entity_key: e.entity_key, variant_key: e.variant_key });
    }
    tabs.push({ id: el.id, name: el.name.trim().slice(0, LINEUP_TAB_NAME_MAX), entries });
  }
  return tabs;
}
