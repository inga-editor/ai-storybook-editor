// parse-base-entities.ts — Excel → base entities for EVERY character + prop group in ONE pass
// (design sketch-base-creative-space/05-import-base-entities.md, ⚡REV 2026-08-21).
//
// TAB DISCOVERY IS BY NAME RULE (no fixed tab list): every workbook tab whose name matches a
// `GROUP_TAB_RULES` entry becomes ONE base group. A tab matching BOTH rules is ambiguous (error);
// a tab matching neither is skipped (Stages / Storyboard / Flow / Book / lang tabs). Each matched
// tab's `group_key = normalizeGroupKey(tabName)` is stamped onto every entity it produces
// (`entity.group`) — there is NO `actor_role` anymore ("Alter Characters" is a plain character
// group whose key is `alter_characters`). ≥1 character tab AND ≥1 prop tab are required.
//
// PURE by design (test seam): this module reads + parses + validates only. It NEVER confirms,
// toasts, or writes the store — the root component owns the confirm-replace AlertDialog +
// `setSketchBaseEntities` + the collab persist chain. The fully-pure `parseWorkbook` operates on an
// already-read ArrayBuffer so it unit-tests without any File I/O; only `importBaseEntities` touches
// the lazy-imported xlsx runtime + `File.arrayBuffer()`.
//
// COLUMN MAPPING (authoritative 4-column path): each Excel column maps to its OWN variant field.
// `description` is NOT collapsed into `visual_design` (design-05 §4). Empty cell → '' (variant kept).

import { createLogger } from '@/utils/logger';
import type { BaseGroup, SheetKind, SketchEntity, SketchVariant } from '@/types/sketch';
import { normalizeGroupKey } from '@/types/sketch';
import { parseHeightCm } from '@/utils/parse-height-cm';
import { COL, GROUP_TAB_RULES, REF_IN_TEXT_RE, REF_RE } from './parse-base-entities.constants';

const log = createLogger('Editor', 'ParseBaseEntities');

/** Issue strings are rendered verbatim in a toast → never list more keys than this. */
const MAX_LISTED_KEYS = 10;

/** Collected validation results. `errors` block commit; `warnings` are advisory. */
export interface ImportIssues {
  errors: string[];
  warnings: string[];
}

/**
 * Bulk-import payload for `setSketchBaseEntities({ characters, props, sheetGroups })`. `characters`
 * carries EVERY character group (each entity tagged with its `group`); `props` every prop group.
 * `sheetGroups` is the COMPLETE new set of base groups — one entry per matched tab, driving the
 * sheet-node reset/delete at commit.
 */
export interface BaseImportResult {
  characters: SketchEntity[];
  props: SketchEntity[];
  sheetGroups: BaseGroup[];
}

export interface BaseImportParse {
  result: BaseImportResult;
  issues: ImportIssues;
  /** Display names of every tab that matched a group rule (discovery order). Drives the summary
   *  copy + the "N groups" toast; the authoritative group data lives in `result.sheetGroups`. */
  tabs: string[];
}

/** A header-keyed sheet row: keys lowercased+trimmed, values coerced to trimmed strings. */
export type BaseSheetRow = Record<string, string>;

/** One discovered tab: its display name, normalized group key, kind, and key column. */
interface DiscoveredTab {
  tabName: string;
  groupKey: string;
  kind: SheetKind;
  keyColumn: string;
}

/** Coerce any raw cell value to a trimmed string ('' for null/undefined). */
function cellStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** Normalize a raw header-keyed row → lowercase+trim keys, trimmed string values.
 *  Makes column lookup robust to header casing / surrounding whitespace. */
export function normalizeRow(raw: Record<string, unknown>): BaseSheetRow {
  const out: BaseSheetRow = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.trim().toLowerCase()] = cellStr(v);
  }
  return out;
}

/**
 * Group normalized rows by key column → SketchEntity[]. One row = one variant; entity order =
 * first-seen. Rows with an empty key column are skipped. Every entity carries `group = groupKey`
 * (⚡REV 2026-08-21 — the tab's normalized key). Each of the four text columns maps to its own
 * variant field (description → description, height → height, …); an absent cell → ''.
 */
export function parseBaseEntities(rows: BaseSheetRow[], keyColumn: string, groupKey: string): SketchEntity[] {
  const byKey = new Map<string, SketchEntity>();
  for (const row of rows) {
    const key = row[keyColumn] ?? '';
    if (!key) continue;
    let entity = byKey.get(key);
    if (!entity) {
      entity = { key, group: groupKey, variants: [] };
      byKey.set(key, entity);
    }
    const variant: SketchVariant = {
      key: row[COL.VARIANT] ?? '',
      description: row[COL.DESCRIPTION] ?? '',
      // ⚡ 2026-07-17: height is a NUMBER of cm — "1.1m"→110, "20-30cm"→30 (max), fail/empty→null.
      // A cell that fails to parse only drops the height; the variant is still imported (the
      // advisory warning is raised by validateBaseImport, which owns `issues`).
      height: parseHeightCm(row[COL.HEIGHT]),
      visual_design: row[COL.VISUAL_DESIGN] ?? '',
      art_language: row[COL.ART_LANGUAGE] ?? '',
    };
    entity.variants.push(variant);
  }
  return [...byKey.values()];
}

/** Extract inline `@key/variant` refs from a free-text field. */
function extractInlineRefs(text: string): Array<{ key: string; variant: string }> {
  const refs: Array<{ key: string; variant: string }> = [];
  for (const m of text.matchAll(REF_IN_TEXT_RE)) {
    if (m.groups) refs.push({ key: m.groups.key, variant: m.groups.variant });
  }
  return refs;
}

/** The text fields that may carry inline `@ref` mentions. `height` is EXCLUDED — it parses to a
 *  number of cm (2026-07-17), so it can no longer hold a `@key/variant` mention. */
function refBearingFields(v: SketchVariant): string[] {
  return [v.description, v.visual_design, v.art_language];
}

/**
 * Validate one group's parsed entities against its rows (pure). Errors block commit; warnings are
 * advisory (design §6). `knownKeys` is the char∪prop union (across ALL groups) so cross-group
 * `@ref`s resolve (kept verbatim, warn-only). Mutates the shared `issues`. `kindLabel` names the
 * group in messages.
 *  - error:  duplicate variant key within an entity.
 *  - warn:   not exactly one `base` variant; `ref` column ≠ own `@key/variant`;
 *            inline `@ref` unresolved within char∪prop; `height` cell non-empty but unparseable.
 */
export function validateBaseImport(
  entities: SketchEntity[],
  rows: BaseSheetRow[],
  kindLabel: string,
  keyColumn: string,
  knownKeys: Map<string, SketchEntity>,
  issues: ImportIssues,
): void {
  for (const entity of entities) {
    // error: duplicate variant key within one entity (breaks @ref identity)
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const v of entity.variants) {
      if (seen.has(v.key)) dups.add(v.key);
      seen.add(v.key);
    }
    if (dups.size > 0) {
      issues.errors.push(`Entity "${entity.key}": variant key trùng: ${[...dups].join(', ')}`);
    }

    // warn: exactly one `base`
    const baseCount = entity.variants.filter((v) => v.key === 'base').length;
    if (baseCount !== 1) {
      issues.warnings.push(`Entity "${entity.key}": cần đúng 1 variant "base" (thấy ${baseCount}).`);
    }

    // warn: inline @ref unresolved within char∪prop (cross-group kept verbatim)
    for (const v of entity.variants) {
      for (const field of refBearingFields(v)) {
        for (const ref of extractInlineRefs(field)) {
          const target = knownKeys.get(ref.key.toLowerCase());
          if (!target) {
            issues.warnings.push(
              `Entity "${entity.key}" variant "${v.key}": @${ref.key}/${ref.variant} không khớp entity nào (giữ nguyên).`,
            );
          } else if (!target.variants.some((tv) => tv.key.toLowerCase() === ref.variant.toLowerCase())) {
            issues.warnings.push(
              `Entity "${entity.key}" variant "${v.key}": @${ref.key}/${ref.variant} — "${ref.key}" không có variant "${ref.variant}".`,
            );
          }
        }
      }
    }
  }

  for (const row of rows) {
    const rowKey = row[keyColumn] ?? '';
    if (!rowKey) continue;

    // warn: `height` cell has content but no measurable number → imported as empty (variant kept)
    const heightCell = row[COL.HEIGHT] ?? '';
    if (heightCell && parseHeightCm(heightCell) === null) {
      const variantKey = row[COL.VARIANT] ?? '';
      log.warn('validateBaseImport', 'height unparseable', { kindLabel, rowKey, variantKey });
      issues.warnings.push(
        `Dòng "${rowKey}" (${kindLabel}) variant "${variantKey}": height "${heightCell}" không parse được → bỏ trống.`,
      );
    }

    // warn: `ref` column should equal the row's own `@key/variant`
    const refCell = row[COL.REF] ?? '';
    if (!refCell) continue;
    const m = REF_RE.exec(refCell);
    const variantKey = row[COL.VARIANT] ?? '';
    const matches =
      m?.groups &&
      m.groups.key.toLowerCase() === rowKey.toLowerCase() &&
      m.groups.variant.toLowerCase() === variantKey.toLowerCase();
    if (!matches) {
      issues.warnings.push(`Dòng "${rowKey}" (${kindLabel}): cột ref "${refCell}" không khớp @${rowKey}/${variantKey}.`);
    }
  }
}

/**
 * BLOCKING: every entity key must be UNIQUE across ALL tabs of the same kind. Every character group
 * shares one `sketch.characters[]` array (props likewise), so two tabs each declaring `hero` collide
 * — every `by key` lookup becomes ambiguous, and `@ref` resolution (which lowercases keys) could
 * name the wrong entity. Comparison is case-insensitive to match that resolution. `collectionLabel`
 * names the offending collection in the message.
 */
export function validateEntityKeyUniqueness(
  entities: SketchEntity[],
  collectionLabel: string,
  issues: ImportIssues,
): void {
  const byKey = new Map<string, { display: string; count: number }>();
  for (const entity of entities) {
    const norm = entity.key.toLowerCase();
    const slot = byKey.get(norm);
    if (slot) slot.count += 1;
    else byKey.set(norm, { display: entity.key, count: 1 });
  }
  const collisions = [...byKey.values()].filter((s) => s.count > 1).map((s) => s.display);
  if (collisions.length === 0) return;
  // key only — never the row text (design §Bảo mật).
  log.error('validateEntityKeyUniqueness', 'key used by two tabs of the same kind', {
    collectionLabel,
    keys: collisions,
  });
  const shown = collisions.slice(0, MAX_LISTED_KEYS).map((k) => `"${k}"`).join(', ');
  const rest = collisions.length - MAX_LISTED_KEYS;
  issues.errors.push(
    `Key ${collectionLabel} bị trùng giữa các tab: ${shown}${rest > 0 ? ` và ${rest} key khác` : ''}. ` +
      `Mỗi key phải là duy nhất trong toàn bộ ${collectionLabel}.`,
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Copy for the replace-confirm dialog (⚡REV 2026-08-21 — per-group whole-replace). An import
 * REPLACES the entire cast, DELETES any group missing from the file, and RESETS every group's base
 * sheet (generated images + locked style) — the consent text must name all three. Pure.
 */
export function describeImportReplacement(parsed: BaseImportParse): string {
  const chars = parsed.result.characters.length;
  const props = parsed.result.props.length;
  const groups = parsed.result.sheetGroups.length;
  return (
    `This replaces all base entities with ${plural(chars, 'character')} and ${plural(props, 'prop')} ` +
    `across ${plural(groups, 'group')} from the file, deletes groups missing from the file, and ` +
    `resets base sheets (generated images + locked style). This cannot be undone.`
  );
}

/**
 * PURE parse of an already-read workbook (ArrayBuffer) → { result, issues, tabs }. No File I/O, no
 * store/confirm/toast side-effects — the unit-test seam.
 *
 * Discovery: scan EVERY tab, match `GROUP_TAB_RULES` by name. A tab matching both rules is ambiguous
 * (error); a tab matching neither is skipped. Two tabs whose names normalize to the same group key
 * are an error. ≥1 character tab AND ≥1 prop tab are required (missing a kind → error for that kind).
 * A present-but-empty tab still yields a `sheetGroups` entry (its base node is reset on commit).
 * Any error aborts before per-group entity validation (never import half a book).
 */
export function parseWorkbook(data: ArrayBuffer | Uint8Array, XLSX: typeof import('xlsx')): BaseImportParse {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const wb = XLSX.read(bytes, { type: 'array' });

  const result: BaseImportResult = { characters: [], props: [], sheetGroups: [] };
  const issues: ImportIssues = { errors: [], warnings: [] };

  // ── Discovery: match every tab name against the rules ──────────────────────────────────────
  const tabs: DiscoveredTab[] = [];
  for (const name of wb.SheetNames) {
    const matches = GROUP_TAB_RULES.filter((r) => r.match.test(name));
    if (matches.length === 0) continue; // Stages / Storyboard / Flow / Book / lang — skipped
    if (matches.length > 1) {
      log.warn('parseWorkbook', 'ambiguous tab — matches character AND prop', { name });
      issues.errors.push(`Tab "${name}" khớp cả Character lẫn Prop — không xác định được loại.`);
      continue;
    }
    const groupKey = normalizeGroupKey(name);
    if (tabs.some((t) => t.groupKey === groupKey)) {
      log.warn('parseWorkbook', 'duplicate group key after normalize', { name, groupKey });
      issues.errors.push(`2 tab cùng group key "${groupKey}" sau khi chuẩn hoá tên.`);
      continue;
    }
    tabs.push({ tabName: name, groupKey, kind: matches[0].kind, keyColumn: matches[0].keyColumn });
  }
  if (!tabs.some((t) => t.kind === 'characters')) {
    issues.errors.push('Không tìm thấy tab Character nào trong file.');
  }
  if (!tabs.some((t) => t.kind === 'props')) {
    issues.errors.push('Không tìm thấy tab Prop nào trong file.');
  }

  // ── Parse each discovered tab ───────────────────────────────────────────────────────────────
  const parsedByTab = new Map<string, { rows: BaseSheetRow[]; keyColumn: string; kind: SheetKind }>();
  for (const t of tabs) {
    const ws = wb.Sheets[t.tabName];
    // header:1 → first row = headers (for missing required-column detection)
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }) as unknown[][];
    const headerCells = (matrix[0] ?? []).map((c) => cellStr(c).toLowerCase());
    const missing = [t.keyColumn, COL.VARIANT].filter((col) => !headerCells.includes(col));
    if (missing.length > 0) {
      log.warn('parseWorkbook', 'missing required columns', { tab: t.tabName, missing, headerCells });
      issues.errors.push(`Tab "${t.tabName}" thiếu cột bắt buộc: ${missing.join(', ')}.`);
      // Still register the group so its sheet node is reset — an empty/malformed tab is a valid
      // (empty) group; the blocking error above prevents the destructive commit either way.
      result.sheetGroups.push({ group_key: t.groupKey, kind: t.kind, name: t.tabName });
      continue;
    }
    const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Array<Record<string, unknown>>;
    const rows = rawRows.map(normalizeRow);
    const entities = parseBaseEntities(rows, t.keyColumn, t.groupKey);
    result[t.kind].push(...entities);
    result.sheetGroups.push({ group_key: t.groupKey, kind: t.kind, name: t.tabName });
    parsedByTab.set(t.tabName, { rows, keyColumn: t.keyColumn, kind: t.kind });
  }

  // Sheet-level errors → abort before per-entity validation (don't import half a book). Cross-tab
  // key uniqueness runs at the same level and for the same reason: a collision makes the `knownKeys`
  // map below ambiguous, so every `@ref` warning derived from it could name the wrong entity.
  if (issues.errors.length === 0) {
    validateEntityKeyUniqueness(result.characters, 'characters', issues);
    validateEntityKeyUniqueness(result.props, 'props', issues);
  }
  if (issues.errors.length === 0) {
    const knownKeys = new Map<string, SketchEntity>(
      [...result.characters, ...result.props].map((e) => [e.key.toLowerCase(), e]),
    );
    for (const t of tabs) {
      const parsed = parsedByTab.get(t.tabName);
      if (!parsed) continue;
      // Filter the aggregated array back down to THIS tab's group so its rows validate against
      // their own entities; `knownKeys` stays the full char∪prop union so cross-group `@ref`s
      // resolve without a second pass.
      const groupEntities = result[t.kind].filter((e) => e.group === t.groupKey);
      validateBaseImport(groupEntities, parsed.rows, t.tabName, parsed.keyColumn, knownKeys, issues);
    }
  }

  log.info('parseWorkbook', 'done', {
    tabs: tabs.map((t) => t.groupKey),
    characters: result.characters.length,
    props: result.props.length,
    errorCount: issues.errors.length,
    warningCount: issues.warnings.length,
  });
  return { result, issues, tabs: tabs.map((t) => t.tabName) };
}

/**
 * Read an .xlsx File → { result, issues, tabs } (thin side-effect-free wrapper around
 * `parseWorkbook`). Lazy-imports xlsx so SheetJS stays out of the initial bundle. Does NOT
 * confirm/toast/write the store — the root component owns the commit (parse-only).
 */
export async function importBaseEntities(file: File): Promise<BaseImportParse> {
  log.info('importBaseEntities', 'start', { fileName: file.name, size: file.size });
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  return parseWorkbook(buf, XLSX);
}
