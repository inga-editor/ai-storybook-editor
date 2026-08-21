// sketch-normalize.ts — read-boundary normalizers for the `snapshots.sketch` JSONB column.
// Extracted from sketch-slice.ts (2026-07-17, ADR-047) so the slice keeps state+CRUD only.
// Element-level coercers live in sketch-coerce-helpers.ts; the taxonomy + anomaly contract in
// sketch-resource-registry.ts (single source).
//
// Serves BOTH read boundaries:
//   • full snapshot load  → `normalizeSketch` (fetchSnapshot / initSnapshot via loadSketch)
//   • realtime peer merge → `coerceSketchNode` (content-sync-store fetchSyncNode)
//
// DATA-SAFETY CONTRACT (rev 2026-07-17b — ADR-047):
// An unexpected shape NEVER **silently** replaces existing data with empty. Every transform is
// classified (single source: the taxonomy table in `sketch-resource-registry.ts`):
//  - ABSENT (null/undefined) → default empty, NO anomaly (a new book is not an incident).
//  - CONVERT (lossless)      → applied automatically, log `debug` only (e.g. `parseHeightCm`,
//    the object-map/bare-array styles salvages, legacy `crop` → crops[0]).
//  - RESET (lossy)           → the typed tree gets a SAFE PLACEHOLDER, the original blob goes to
//    `sketchQuarantine`, and the resource is marked DEGRADED ⇒ every save into that subtree is
//    BLOCKED (phase-04) until the user consents (phase-03 modal). Consent only reopens the save
//    path — nothing is written to the DB at consent time (ADR-043: the next normal held-session
//    save persists it).
//
// History: a removed `isLegacySketchShape()` judged the WHOLE blob from `spreads[0]` and returned
// DEFAULT_SKETCH on a false positive — wiping styles/characters/props in memory; the next
// release-save persisted the wipe. SILENT reset is gone for good. Reset WITH consent is
// legitimate and deliberate — do NOT "fix" it back to "never reset" (see ADR-047).
//
// PURE module: no UI imports. Anomalies flow to the caller via `SketchAnomalyReporter`.

import type {
  Sketch,
  SketchEntity,
  SketchSpread,
  SketchSpreadImage,
  SketchSpreadIllustration,
  SketchPageType,
  SketchBase,
  SketchBaseSheet,
} from '@/types/sketch';
import { createLogger } from '@/utils/logger';
import {
  describeResource,
  noopAnomalyReporter,
  type SketchAnomalyReporter,
  type SketchResourceKey,
} from './sketch-resource-registry';
import {
  asEntityArray,
  asStageArray,
  coerceEntity,
  coerceLineupTabs,
  coerceStage,
  coerceStyle,
  isPlainObject,
  typeNameOf,
  ENTITY_KINDS,
  type SketchEntityCollection,
} from './sketch-coerce-helpers';

// Re-export the anomaly/degraded contract at its historical import path (types.ts, content-sync,
// consent store, tests all import from here).
export type {
  SketchAnomaly,
  SketchAnomalyReporter,
  SketchDegradedEntry,
  SketchDegradedIntake,
} from './sketch-resource-registry';

const log = createLogger('Store', 'SketchNormalize');

/** ⚡REV 2026-08-21 — an empty base workspace is an EMPTY MAP (dynamic group keys; no fixed sheets).
 *  A new book simply has no groups yet — the base space never reads `undefined.styles` because
 *  every access seeds a node on write. */
export function emptyBase(): SketchBase {
  return {};
}

/** The `base.<groupKey>` resource key for one group (dynamic — every key is a valid group). */
const sheetResourceOf = (groupKey: string): SketchResourceKey =>
  `base.${groupKey}` as SketchResourceKey;

export const DEFAULT_SKETCH: Sketch = {
  id: null,
  base: emptyBase(),
  characters: [],
  props: [],
  stages: [],
  spreads: [],
  lineups: [],
};

/**
 * Stale top-level keys from the pre-3847f27 sketch JSONB.
 *
 * They are NOT part of the `Sketch` type, so they are dropped from the in-memory model and will
 * not survive the next whole-node save — hence they are REPORTED (`cls:'report'` → toast) rather
 * than dropped silently. They never trigger a reset and never block saves (taxonomy D3): they
 * cannot be mapped to any saveable resource, and under save-by-resource they actually survive.
 */
const LEGACY_SKETCH_KEYS = ['dummy_id', 'character_sheets', 'prop_sheets'] as const;

/**
 * Fault-isolation wrapper: one resource's read/normalize throwing must never kill the whole
 * load (per-resource isolation is user acceptance criterion #1). A throw is treated as a lossy
 * reset of THAT resource only — placeholder + degraded — while every sibling normalizes
 * untouched. `raw` is usually unavailable here (the getter itself threw), so the quarantine
 * entry is omitted.
 */
function safeResource<T>(
  resource: SketchResourceKey,
  fn: () => T,
  fallback: T,
  onAnomaly: SketchAnomalyReporter,
): T {
  try {
    return fn();
  } catch (err) {
    onAnomaly({
      resource,
      cls: 'reset',
      path: resource,
      message: `${describeResource(resource)} — dữ liệu gây lỗi khi đọc (${err instanceof Error ? err.message : String(err)})`,
    });
    return fallback;
  }
}

/** Build a sheet node from a raw object, carrying `kind`/`name` PRESENCE-GATED (legacy nodes have
 *  neither → derived on read; new nodes keep them). Never invents kind/name (no JSONB churn). */
function sheetNode(
  raw: Record<string, unknown>,
  styles: SketchBaseSheet['styles'],
): SketchBaseSheet {
  const node: SketchBaseSheet = { styles };
  if (raw.kind === 'characters' || raw.kind === 'props') node.kind = raw.kind;
  if (typeof raw.name === 'string') node.name = raw.name;
  return node;
}

/**
 * A raw sheet blob → SketchBaseSheet.
 *
 *  - ABSENT (null/undefined) → `{ styles: [] }`. A book with no sheet yet — legitimate, NOT an
 *    anomaly (crying wolf on every new book trains users to ignore the real warning).
 *  - VALID (`styles` is an array) → passed through untouched.
 *  - SALVAGEABLE (bare array in the slot / object-map styles) → recovered element-coerced,
 *    reported as `convert` (lossless).
 *  - MALFORMED → `cls:'reset'`: `{ styles: [] }` placeholder + the raw slot quarantined + the
 *    sheet degraded, so the empty can never reach the DB without consent.
 *
 * NOTE: only the `styles` key is carried — `SketchBaseSheet` has no other field (types/sketch.ts),
 * so an unknown sibling key IS dropped here (silently: it is unreadable by any current code).
 */
function normalizeSheet(
  raw: unknown,
  resource: SketchResourceKey,
  onAnomaly: SketchAnomalyReporter,
): SketchBaseSheet {
  if (raw == null) return { styles: [] }; // legitimately new — no anomaly

  // A bare array parked in the sheet slot is almost certainly the styles[] itself → salvage it
  // rather than throw the user's styles away.
  if (Array.isArray(raw)) {
    onAnomaly({
      resource,
      cls: 'convert',
      path: resource,
      message: `${resource} là array thay vì object (đã giữ nguyên ${raw.length} style)`,
    });
    return { styles: raw.map(coerceStyle) };
  }

  if (!isPlainObject(raw)) {
    onAnomaly({
      resource,
      cls: 'reset',
      path: resource,
      message: `${resource} có kiểu "${typeNameOf(raw)}" thay vì object`,
      raw,
    });
    return { styles: [] };
  }

  const styles = raw.styles;
  if (Array.isArray(styles)) return sheetNode(raw, styles as SketchBaseSheet['styles']); // keep as-is
  if (styles == null) return sheetNode(raw, []); // sheet exists but has no style yet — legitimate

  // An object-map of styles (`{"0":{…},"1":{…}}`) is a REAL risk here, not a hypothetical: sketch
  // subtrees are written positionally through the collab gateway (`resolve_snapshot_path`), and a
  // positional jsonb_set write onto a missing/'{}' path leaves exactly this shape. Recover it
  // (ordered by V8's integer-key ascending iteration) instead of blanking the user's styles.
  if (isPlainObject(styles)) {
    const values = Object.values(styles);
    if (values.length > 0 && values.every(isPlainObject)) {
      onAnomaly({
        resource,
        cls: 'convert',
        path: `${resource}.styles`,
        message: `${resource}.styles là object-map thay vì array (đã giữ nguyên ${values.length} style)`,
      });
      return sheetNode(raw, values.map(coerceStyle));
    }
  }

  // `styles` holds something that cannot be represented as a style array — the exact shape behind
  // the reported production loss. Placeholder + quarantine (the WHOLE sheet slot, so nothing that
  // was stored next to it is thrown away) + degraded, until the user decides.
  onAnomaly({
    resource,
    cls: 'reset',
    path: `${resource}.styles`,
    message: `${resource}.styles có kiểu "${typeNameOf(styles)}" thay vì array`,
    raw,
  });
  return { styles: [] };
}

/**
 * The base workspace — ⚡REV 2026-08-21 a DYNAMIC group map. Absent → `{}` (new book); non-object →
 * ONE coarse `base` reset (unattributable to a group); otherwise EVERY key normalizes ISOLATED and
 * is KEPT (never whitelisted — the ADR-047 data-loss footgun: an unknown key is a valid group).
 */
function normalizeBase(raw: unknown, onAnomaly: SketchAnomalyReporter): SketchBase {
  if (raw == null) return emptyBase(); // legitimately new — no anomaly
  if (!isPlainObject(raw)) {
    onAnomaly({
      resource: 'base',
      cls: 'reset',
      path: 'base',
      message: `base có kiểu "${typeNameOf(raw)}" thay vì object`,
      raw,
    });
    return emptyBase();
  }
  const base: SketchBase = {};
  for (const groupKey of Object.keys(raw)) {
    const resource = sheetResourceOf(groupKey);
    base[groupKey] = safeResource(
      resource,
      () => normalizeSheet(raw[groupKey], resource, onAnomaly),
      { styles: [] },
      onAnomaly,
    );
  }
  return base;
}

/** One entity collection (`characters`/`props`). Absent → []; malformed → reset. */
function entityArrayAt(
  raw: Record<string, unknown>,
  key: SketchEntityCollection,
  onAnomaly: SketchAnomalyReporter,
): SketchEntity[] {
  const v = raw[key];
  if (v == null) return []; // legitimately new — no anomaly
  return asEntityArray(v, onAnomaly, key);
}

const VALID_PAGE_TYPES: readonly SketchPageType[] = ['left', 'right', 'full'];
function isValidPageType(v: unknown): v is SketchPageType {
  return typeof v === 'string' && (VALID_PAGE_TYPES as readonly string[]).includes(v);
}

/**
 * Back-compat per-spread normalizer for the PER-PAGE versioned `images[]` model (1..2 images,
 * keyed by unique page `type`):
 *  - already-new shape (`images` is an array) → ensure each element has a valid unique `type`,
 *    inferring from `pages` order for legacy single-backdrop rows that predate `type`; dedupe by
 *    type (keep first). NO length clamp — 'full' → 1, 'left'+'right' → 2.
 *  - legacy scalar `media_url: string` → wrap as ONE image with the first page's type.
 *  - no image at all → `images: []`.
 * `pages` / `textboxes` always default to []. Non-object rows keep their (empty) slot and are
 * reported as a reset — a spreads[] element is never legitimately a non-object.
 * Dedupe is CONDITIONAL (D8): dropping a duplicate that carries NO illustrations loses nothing
 * (`convert`); dropping one WITH illustrations is lossy (`reset` — consent required).
 */
export function normalizeSketchSpread(
  raw: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
): SketchSpread {
  if (!isPlainObject(raw)) {
    // Nothing salvageable, but keep the slot so the remaining spreads stay positionally correct.
    // The element's id is unreadable → coarse 'spreads' resource (fail-safe block).
    onAnomaly({
      resource: 'spreads',
      cls: 'reset',
      path: 'spreads[]',
      message: `spreads[] có phần tử kiểu "${typeNameOf(raw)}" thay vì object`,
      raw,
    });
    return { id: '', images: [], pages: [], textboxes: [] };
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  const spreadResource: SketchResourceKey = id ? `spreads/${id}` : 'spreads';
  const pages = Array.isArray(raw.pages) ? (raw.pages as SketchSpread['pages']) : [];
  const textboxes = Array.isArray(raw.textboxes) ? (raw.textboxes as SketchSpread['textboxes']) : [];

  // Ordered page types drive `type` inference for legacy images (single backdrop, no `type`).
  // Fall back to ['full'] when pages are absent so inference always has a target.
  const pageTypes = pages.map((p) => p?.type).filter(isValidPageType);
  const fallbackTypes: SketchPageType[] = pageTypes.length > 0 ? pageTypes : ['full'];

  let images: SketchSpreadImage[];
  if (Array.isArray(raw.images)) {
    const seen = new Set<SketchPageType>();
    const built: SketchSpreadImage[] = [];
    (raw.images as Array<Partial<SketchSpreadImage>>).forEach((img, i) => {
      const type: SketchPageType = isValidPageType(img?.type)
        ? img.type
        : fallbackTypes[i] ?? fallbackTypes[fallbackTypes.length - 1] ?? 'full';
      if (seen.has(type)) {
        // Dedupe by page type (keep first). D8: classify by what the DROPPED element carries.
        const droppedIllustrations = Array.isArray(img?.illustrations) ? img.illustrations : [];
        if (droppedIllustrations.length > 0) {
          onAnomaly({
            resource: spreadResource,
            cls: 'reset',
            path: `spreads/${id || '?'}.images`,
            message: `spread "${id || '?'}" có 2 ảnh trùng trang "${type}" — ảnh trùng chứa ${droppedIllustrations.length} phiên bản sẽ bị bỏ`,
            raw,
          });
        } else {
          onAnomaly({
            resource: spreadResource,
            cls: 'convert',
            path: `spreads/${id || '?'}.images`,
            message: `spread "${id || '?'}" có 2 ảnh trùng trang "${type}" — ảnh trùng rỗng, đã bỏ`,
          });
        }
        return;
      }
      seen.add(type);
      built.push({
        id: typeof img?.id === 'string' ? img.id : crypto.randomUUID(),
        type,
        illustrations: Array.isArray(img?.illustrations)
          ? (img.illustrations as SketchSpreadIllustration[])
          : [],
      });
    });
    images = built;
  } else if (typeof raw.media_url === 'string') {
    images = [
      {
        id: crypto.randomUUID(),
        type: fallbackTypes[0],
        illustrations: [
          { media_url: raw.media_url, created_time: new Date().toISOString(), is_selected: true },
        ],
      },
    ];
  } else {
    images = [];
  }

  return { id, images, pages, textboxes };
}

/**
 * Normalize a raw `snapshots.sketch` JSONB blob into the canonical Sketch shape, PER-RESOURCE:
 * base.character_sheet · base.prop_sheet · characters · props · stages · spreads each normalize
 * (and fail) independently — corruption in one never affects the others (deep-equal isolation is
 * the acceptance criterion, see sketch-normalize.test.ts). ABSENT/CONVERT/RESET rules: see the
 * DATA-SAFETY CONTRACT at the top of this file. reset/report anomalies also `log.warn` (never
 * debug — a debug-only wipe is how the incident stayed invisible); convert logs `debug`.
 */
export function normalizeSketch(
  raw: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
): Sketch {
  const report: SketchAnomalyReporter = (anomaly) => {
    if (anomaly.cls === 'convert') {
      log.debug('normalizeSketch', 'lossless convert applied', {
        resource: anomaly.resource,
        path: anomaly.path,
        message: anomaly.message,
      });
    } else {
      // Never log the raw blob (may carry book content) — type name only.
      log.warn('normalizeSketch', 'unexpected sketch shape — placeholder used, data quarantined, NOT persisted', {
        resource: anomaly.resource,
        cls: anomaly.cls,
        path: anomaly.path,
        message: anomaly.message,
        rawType: typeNameOf(anomaly.raw),
      });
    }
    onAnomaly(anomaly);
  };

  if (raw == null) return DEFAULT_SKETCH; // no sketch yet — legitimate, NOT an anomaly
  if (!isPlainObject(raw)) {
    report({
      resource: 'sketch',
      cls: 'reset',
      path: 'sketch',
      message: `sketch có kiểu "${typeNameOf(raw)}" thay vì object`,
      raw,
    });
    return DEFAULT_SKETCH;
  }

  const legacyKeys = LEGACY_SKETCH_KEYS.filter((k) => k in raw);
  if (legacyKeys.length > 0) {
    // Not a reset — just a heads-up that these stale keys are not carried by the Sketch type
    // and will not survive the next save.
    report({
      resource: 'sketch',
      cls: 'report',
      path: 'sketch',
      message: `sketch còn key cũ không dùng nữa: ${legacyKeys.join(', ')}`,
    });
  }

  // `raw.base` may itself be a throwing getter — read it ONCE under guard; a failure there
  // cannot be attributed narrower than "both sheets" (there is no 'base' resource key).
  const base = (() => {
    let rawBase: unknown;
    try {
      rawBase = raw.base;
    } catch (err) {
      report({
        resource: 'base',
        cls: 'reset',
        path: 'base',
        message: `base — dữ liệu gây lỗi khi đọc (${err instanceof Error ? err.message : String(err)})`,
      });
      return emptyBase();
    }
    return normalizeBase(rawBase, report);
  })();

  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    base,
    characters: safeResource('characters', () => entityArrayAt(raw, 'characters', report), [], report),
    props: safeResource('props', () => entityArrayAt(raw, 'props', report), [], report),
    stages: safeResource(
      'stages',
      () => {
        // 2026-07-18 stage rework: dedicated coercers (per-stage base.styles[] + 2-cell sheets);
        // OLD-shape stage blobs migrate here (text kept, variant images reset — cls 'convert').
        const v = raw.stages;
        if (v == null) return []; // legitimately new — no anomaly
        return asStageArray(v, report);
      },
      [],
      report,
    ),
    spreads: safeResource(
      'spreads',
      () => {
        const spreads = raw.spreads;
        if (spreads == null) return [];
        if (!Array.isArray(spreads)) {
          report({
            resource: 'spreads',
            cls: 'reset',
            path: 'spreads',
            message: `spreads có kiểu "${typeNameOf(spreads)}" thay vì array`,
            raw: spreads,
          });
          return [];
        }
        return spreads.map((s) => normalizeSketchSpread(s, report));
      },
      [],
      report,
    ),
    // Lineup tabs are CONFIG (no artwork) → FAIL-OPEN by design (plan Validation S1):
    // NOT `safeResource` — `lineups` is deliberately NOT a SketchResourceKey, so a failure
    // here must never quarantine/degrade (a coarse 'sketch' reset would block EVERY step-1
    // write). Local try/catch → [] + a `cls:'report'` heads-up under the existing 'sketch' key.
    lineups: (() => {
      try {
        return coerceLineupTabs(raw.lineups, report);
      } catch (err) {
        report({
          resource: 'sketch',
          cls: 'report',
          path: 'lineups',
          message: `sketch.lineups — dữ liệu gây lỗi khi đọc (${err instanceof Error ? err.message : String(err)}) — đã dùng danh sách rỗng`,
        });
        return [];
      }
    })(),
  };
}

/**
 * MERGE-BOUNDARY coercer for the realtime content-sync path (column `sketch`).
 *
 * A peer's sync event refetches a SUB-NODE straight from DB jsonb (never through
 * `normalizeSketch`). Every addressable sketch sub-tree is covered (2026-07-17 — previously only
 * the entity kinds; `base`/`spreads` passed through UNVALIDATED and could crash downstream):
 *   ['characters'] / ['characters','2'] → entity array / node (rtype 3/4)
 *   ['stages'] / ['stages','1']          → stage array / node (rtype 5 — 2026-07-18 stage shape)
 *   ['base'] / ['base','character_sheet'] → base workspace / one sheet (rtype 11)
 *   ['spreads'] / ['spreads','0']        → spread collection / node (rtype 6)
 *   ['lineups']                          → lineup tabs whole array (rtype 12 — 2026-07-25)
 * Deeper paths (page image / textbox child writes) pass through — leaf payloads the canvas
 * validates itself. `null`/`undefined` pass through (remove semantics). Cheap, and idempotent
 * once ids exist (a legacy image missing `id` is minted one on first pass only).
 * A `reset` finding means the merged value is a PLACEHOLDER; the caller (fetchSyncNode) marks
 * the resource degraded through the same consent machinery as the load path.
 */
export function coerceSketchNode(
  path: string[],
  value: unknown,
  onAnomaly: SketchAnomalyReporter = noopAnomalyReporter,
): unknown {
  if (value == null) return value; // null → remove; undefined → rpc error (caller skips)
  const head = path[0];

  if (head === 'stages') {
    if (path.length === 1) return asStageArray(value, onAnomaly);
    if (path.length === 2) return coerceStage(value, onAnomaly);
    return value;
  }

  if (ENTITY_KINDS.includes(head)) {
    const kind = head as SketchEntityCollection;
    if (path.length === 1) return asEntityArray(value, onAnomaly, kind);
    if (path.length === 2) return coerceEntity(value, onAnomaly, kind);
    return value;
  }

  if (head === 'base') {
    if (path.length === 1) return normalizeBase(value, onAnomaly);
    // rtype-11 node grain: one group sheet (dynamic key — `base.<groupKey>`).
    if (path.length === 2) return normalizeSheet(value, sheetResourceOf(path[1]), onAnomaly);
    return value;
  }

  if (head === 'lineups') {
    // rtype 12 writes the WHOLE `sketch.lineups` array (collection-scope column-root) —
    // the only addressable grain is path ['lineups']. Fail-open coercer (see normalizeSketch).
    return path.length === 1 ? coerceLineupTabs(value, onAnomaly) : value;
  }

  if (head === 'spreads') {
    if (path.length === 1) {
      if (!Array.isArray(value)) {
        // Returning the garbage would either no-op (reconcile) or corrupt state (whole-replace);
        // returning [] + degraded keeps the placeholder/quarantine/save-block invariants.
        onAnomaly({
          resource: 'spreads',
          cls: 'reset',
          path: 'spreads',
          message: `spreads có kiểu "${typeNameOf(value)}" thay vì array`,
          raw: value,
        });
        return [];
      }
      return value.map((s) => normalizeSketchSpread(s, onAnomaly));
    }
    if (path.length === 2) return normalizeSketchSpread(value, onAnomaly);
    return value;
  }

  return value;
}
