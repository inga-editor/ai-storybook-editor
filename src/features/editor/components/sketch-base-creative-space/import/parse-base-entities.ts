// parse-base-entities.ts — Excel → base entities for ALL THREE kinds (character + prop + alter
// character) in ONE pass (design sketch-base-creative-space/05-import-base-entities.md).
//
// ⚡2026-07-28 — the OPTIONAL `Alter Characters` tab reuses `parseBaseEntities` VERBATIM (same 8
// columns, same `character` key column); the only difference is the `actor_role: 1` stamp applied
// after parsing, and that its rows are APPENDED to the same `characters[]` array. Two consequences
// this module owns:
//   • sheet lookup is NORMALIZED (trim + lowercase) — an optional tab that misses by casing is
//     SILENT data loss, so `Alter characters` / ` ALTER CHARACTERS ` must still match;
//   • one character key may not exist under two roles → BLOCKING error (a collision makes every
//     `by key` lookup ambiguous and lets the later row's `actor_role` win, i.e. a story character
//     silently becomes an alter or vice-versa).
//
// PURE by design (Phase 07 test seam): this module reads + parses + validates only. It NEVER
// confirms, toasts, or writes the store — the root component owns the confirm-replace
// AlertDialog + `setSketchBaseEntities` + `autoSaveSnapshot`. The fully-pure `parseWorkbook`
// operates on an already-read ArrayBuffer so it unit-tests without any File I/O; only
// `importBaseEntities` touches the lazy-imported xlsx runtime + `File.arrayBuffer()`.
//
// COLUMN MAPPING (authoritative 4-column path — flagged Phase 01): each Excel column maps to
// its OWN variant field. `description` is NOT collapsed into `visual_design` (design-03 §72 /
// design-05 §4). Empty cell → '' (the variant is still kept).

import { createLogger } from '@/utils/logger';
import type { ActorRole, BaseKind, SketchEntity, SketchVariant } from '@/types/sketch';
import { KIND_ENTITY_SOURCE, filterEntitiesOfKind, isEntityOfKind } from '@/types/sketch';
import { parseHeightCm } from '@/utils/parse-height-cm';
import { COL, IMPORT_SHEETS, REF_IN_TEXT_RE, REF_RE } from './parse-base-entities.constants';

const log = createLogger('Editor', 'ParseBaseEntities');

/** Issue strings are rendered verbatim in a toast → never list more keys than this. */
const MAX_LISTED_KEYS = 10;

/** Collected validation results. `errors` block commit; `warnings` are advisory. */
export interface ImportIssues {
  errors: string[];
  warnings: string[];
}

/** Bulk-import payload for `setSketchBaseEntities({ characters, props })`. `characters` carries
 *  BOTH the story cast and the alter cast (`actor_role: 1`) — there is no third array. */
export interface BaseImportResult {
  characters: SketchEntity[];
  props: SketchEntity[];
}

export interface BaseImportParse {
  result: BaseImportResult;
  issues: ImportIssues;
  /**
   * Which tabs the workbook ACTUALLY contained (normalized match). Drives the commit-time merge:
   * an absent OPTIONAL tab means "this workbook says nothing about that kind", NOT "delete it" —
   * see `resolveImportedCharacters`.
   */
  sheetsPresent: Record<BaseKind, boolean>;
}

/** A header-keyed sheet row: keys lowercased+trimmed, values coerced to trimmed strings. */
export type BaseSheetRow = Record<string, string>;

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
 * first-seen. Rows with an empty key column are skipped. Each of the four text columns maps to
 * its own variant field (description → description, height → height, …); an absent cell → ''.
 */
export function parseBaseEntities(rows: BaseSheetRow[], keyColumn: string): SketchEntity[] {
  const byKey = new Map<string, SketchEntity>();
  for (const row of rows) {
    const key = row[keyColumn] ?? '';
    if (!key) continue;
    let entity = byKey.get(key);
    if (!entity) {
      entity = { key, variants: [] };
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
 * Validate one kind's parsed entities against its rows (pure). Errors block commit; warnings are
 * advisory (design §6). `knownKeys` is the char∪prop union so cross-kind `@ref`s resolve
 * (kept verbatim, warn-only). Mutates the shared `issues`.
 *  - error:  duplicate variant key within an entity.
 *  - warn:   not exactly one `base` variant; `ref` column ≠ own `@key/variant`;
 *            inline `@ref` unresolved within char∪prop; `height` cell non-empty but unparseable.
 */
export function validateBaseImport(
  entities: SketchEntity[],
  rows: BaseSheetRow[],
  kind: BaseKind,
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

    // warn: inline @ref unresolved within char∪prop (cross-kind kept verbatim)
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
      log.warn('validateBaseImport', 'height unparseable', { kind, rowKey, variantKey });
      issues.warnings.push(
        `Dòng "${rowKey}" (${kind}) variant "${variantKey}": height "${heightCell}" không parse được → bỏ trống.`,
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
      issues.warnings.push(`Dòng "${rowKey}" (${kind}): cột ref "${refCell}" không khớp @${rowKey}/${variantKey}.`);
    }
  }
}

/** Canonical form used to match a workbook tab against `IMPORT_SHEETS[].sheet`. */
export function normalizeSheetName(name: string): string {
  return name.trim().toLowerCase();
}

/** Looser form used ONLY to detect a NEAR-MISS tab name (`AlterCharacters`, `Alter-Characters`,
 *  `alter_characters`) so the miss can be reported instead of being silent. NEVER used to match. */
function looseSheetName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Index a workbook's tab names by their normalized form (`normalizeSheetName`), so tab matching
 * tolerates casing + surrounding whitespace (`Alter characters`, `" ALTER CHARACTERS "`).
 *
 * WHY normalized and not exact: the alter tab is OPTIONAL, so an exact-match miss produces no
 * error at all — the user sees "import succeeded" with zero alter entities and no way to tell why.
 *
 * First occurrence wins on a normalized collision (two tabs differing only in casing/whitespace).
 * That drop is SURFACED, not just logged: pass `issues` and the loser becomes a user-visible
 * warning — an unreported drop is the same silent-loss failure this normalization exists to fix.
 */
export function buildSheetNameIndex(
  sheetNames: readonly string[],
  issues?: ImportIssues,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of sheetNames) {
    const norm = normalizeSheetName(name);
    const winner = index.get(norm);
    if (winner !== undefined) {
      log.warn('buildSheetNameIndex', 'tab name collides after normalize — first one wins', { norm });
      issues?.warnings.push(
        `Có 2 sheet trùng tên sau khi chuẩn hoá: "${winner}" và "${name}". Chỉ "${winner}" được đọc.`,
      );
      continue;
    }
    index.set(norm, name);
  }
  return index;
}

/**
 * BLOCKING: a character key must identify exactly ONE role. `characters[]` holds the story cast and
 * the alter cast in one array, so a key present in BOTH the `Characters` and `Alter Characters` tabs
 * makes every `by key` lookup ambiguous and lets whichever row is written last decide `actor_role` —
 * a story character silently becoming an alter (or vice-versa) with no type/runtime/server error.
 * That is precisely the failure this feature exists to prevent, so it is an error, not a warning.
 *
 * Comparison is case-insensitive because `@ref` resolution already lowercases keys — `Miu` and `miu`
 * collide there too. Keys colliding under the SAME role are NOT flagged: `Miu`+`miu` inside ONE tab
 * IS reachable (`parseBaseEntities` groups by exact key) but that ambiguity predates this feature,
 * and blocking it would newly reject workbooks that import fine today. Out of scope, not impossible.
 */
export function validateCharacterKeyRoles(characters: SketchEntity[], issues: ImportIssues): void {
  const byKey = new Map<string, { display: string; roles: Set<ActorRole> }>();
  for (const entity of characters) {
    const norm = entity.key.toLowerCase();
    let slot = byKey.get(norm);
    if (!slot) {
      slot = { display: entity.key, roles: new Set<ActorRole>() };
      byKey.set(norm, slot);
    }
    slot.roles.add(entity.actor_role ?? 0);
  }
  const collisions = [...byKey.values()].filter((s) => s.roles.size > 1).map((s) => s.display);
  if (collisions.length === 0) return;
  // key only — never the row text (design §Bảo mật).
  log.error('validateCharacterKeyRoles', 'character key used by both tabs', { keys: collisions });
  // Cap the list: this string is rendered verbatim in a toast, and a workbook that duplicates the
  // whole cast would push the actionable instruction off the end of it.
  const shown = collisions.slice(0, MAX_LISTED_KEYS).map((k) => `"${k}"`).join(', ');
  const rest = collisions.length - MAX_LISTED_KEYS;
  issues.errors.push(
    `Key nhân vật bị trùng giữa 2 tab: ${shown}${rest > 0 ? ` và ${rest} key khác` : ''}. ` +
      `Mỗi key phải là duy nhất trong toàn bộ nhân vật.`,
  );
}

/**
 * Build the exact `setSketchBaseEntities({ characters, props })` payload, given a parse and the
 * `characters[]` currently in the store. THE seam that decides what an import destroys.
 *
 * `setSketchBaseEntities` WHOLE-REPLACES `characters[]`, and the story cast + alter cast share it:
 *   • `Characters` is REQUIRED (absent ⇒ blocking error) ⇒ the workbook always fully specifies the
 *     story cast ⇒ whole-replace is correct for it ("import replaces the cast").
 *   • `Alter Characters` is OPTIONAL ⇒ an absent tab means the workbook says NOTHING about alters,
 *     not "delete them". Replacing anyway would wipe the alter cast that `base.alter_character_sheet`
 *     still points at. A tab that is PRESENT but empty is an explicit empty cast and does clear them
 *     — the array this returns is written to the gateway as ONE column-root whole-array replace
 *     (`commitImport` → `saveEntityCollection`, rtype 14), so a removal here IS a deletion in the DB. (Before
 *     2026-07-28 the commit flushed entity-by-entity, which could neither create a new key nor
 *     delete a dropped one; that gap is closed.)
 *
 * A preserved alter whose key was re-used by the imported story cast is DROPPED (+ warn): the
 * workbook is authoritative for the keys it declares, and keeping both would recreate exactly the
 * ambiguity `validateCharacterKeyRoles` blocks. Pure — never mutates `existing`.
 */
export function resolveImportCommit(
  parsed: BaseImportParse,
  existing: readonly SketchEntity[],
): BaseImportResult {
  const { characters, props } = parsed.result;
  if (parsed.sheetsPresent.alter_characters) return { characters, props };

  const importedKeys = new Set(characters.map((e) => e.key.toLowerCase()));
  const kept: SketchEntity[] = [];
  let dropped = 0;
  for (const entity of existing) {
    if (!isEntityOfKind(entity, 'alter_characters')) continue; // story cast → fully replaced
    if (importedKeys.has(entity.key.toLowerCase())) {
      dropped += 1;
      continue;
    }
    kept.push(entity);
  }
  if (dropped > 0) {
    log.warn('resolveImportCommit', 'alter dropped — key re-used by the imported story cast', {
      kept: kept.length,
      dropped,
    });
  } else if (kept.length > 0) {
    log.info('resolveImportCommit', 'alter tab absent — existing alter cast preserved', {
      kept: kept.length,
    });
  }
  return { characters: [...characters, ...kept], props };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Copy for the replace-confirm dialog. Derived from `sheetsPresent`, NOT hardcoded: an import that
 * carries an `Alter Characters` tab DESTROYS the existing alter cast, so the consent text has to
 * say so — and when the tab is absent it must NOT threaten a deletion `resolveImportCommit` will
 * not perform. A dialog naming only "character and prop" is consent for the wrong operation. Pure.
 */
export function describeImportReplacement(parsed: BaseImportParse): string {
  const story = filterEntitiesOfKind(parsed.result.characters, 'characters').length;
  const alter = filterEntitiesOfKind(parsed.result.characters, 'alter_characters').length;
  const from = `${plural(story, 'character')} and ${plural(parsed.result.props.length, 'prop')}`;
  if (!parsed.sheetsPresent.alter_characters) {
    return (
      `This replaces all existing character and prop base entities with ${from} from the file, ` +
      `and resets their base sheets (generated images + locked style). ` +
      `Your existing alter characters are kept — this file has no "Alter Characters" tab. ` +
      `This cannot be undone.`
    );
  }
  return (
    `This replaces all existing character, prop AND alter character base entities with ${from} ` +
    `and ${plural(alter, 'alter character')} from the file, and resets their base sheets ` +
    `(generated images + locked style). This cannot be undone.`
  );
}

/**
 * PURE parse of an already-read workbook (ArrayBuffer) → { result, issues, sheetsPresent }. No File
 * I/O, no store/confirm/toast side-effects — the Phase 07 unit-test seam. A missing REQUIRED sheet
 * or a missing required column (key + variant) is a blocking error (aborts before per-entity
 * validation, so we never import half a book); a missing OPTIONAL sheet only warns. The four text
 * columns are optional (empty → '').
 */
export function parseWorkbook(data: ArrayBuffer | Uint8Array, XLSX: typeof import('xlsx')): BaseImportParse {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const wb = XLSX.read(bytes, { type: 'array' });

  const result: BaseImportResult = { characters: [], props: [] };
  const issues: ImportIssues = { errors: [], warnings: [] };
  const parsedByKind: Partial<Record<BaseKind, { rows: BaseSheetRow[]; keyColumn: string }>> = {};
  const countsByKind: Partial<Record<BaseKind, number>> = {};
  const sheetsPresent: Record<BaseKind, boolean> = {
    characters: false,
    props: false,
    alter_characters: false,
  };
  // Tab lookup is normalized (trim + lowercase) for EVERY kind — one rule, no per-tab special case.
  const sheetIndex = buildSheetNameIndex(wb.SheetNames, issues);

  for (const { kind, sheet, keyColumn, actorRole, optional } of IMPORT_SHEETS) {
    const actualName = sheetIndex.get(normalizeSheetName(sheet));
    const ws = actualName ? wb.Sheets[actualName] : undefined;
    if (!ws) {
      if (optional) {
        // Normal for a book with no alter cast — but it is ALSO what a typo'd tab name looks like,
        // and the miss is otherwise invisible (optional ⇒ no error). `warn` so the log tells the
        // two apart, PLUS a user-visible warning when a NEAR-MISS tab exists (`AlterCharacters`,
        // `Alter-Characters` — normalization alone can't rescue those, but naming them can).
        const nearMiss = wb.SheetNames.find((n) => looseSheetName(n) === looseSheetName(sheet));
        log.warn('parseWorkbook', 'optional sheet not found — skipped', { kind, sheet, hasNearMiss: !!nearMiss });
        if (nearMiss) {
          issues.warnings.push(
            `Không đọc sheet "${nearMiss}" — tên sheet phải là "${sheet}". Không có nhân vật thay thế nào được import.`,
          );
        }
        continue;
      }
      log.warn('parseWorkbook', 'sheet not found', { kind, sheet, sheets: wb.SheetNames });
      issues.errors.push(`Không tìm thấy sheet "${sheet}" trong file.`);
      continue;
    }
    // header:1 → first row = headers (for missing required-column detection)
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }) as unknown[][];
    const headerCells = (matrix[0] ?? []).map((c) => cellStr(c).toLowerCase());
    const missing = [keyColumn, COL.VARIANT].filter((col) => !headerCells.includes(col));
    if (missing.length > 0) {
      log.warn('parseWorkbook', 'missing required columns', { kind, sheet, missing, headerCells });
      issues.errors.push(`Sheet "${sheet}" thiếu cột bắt buộc: ${missing.join(', ')}.`);
      continue;
    }
    // Set only once the tab is USABLE: `sheetsPresent` drives a DESTRUCTIVE decision
    // (`resolveImportCommit`), so a present-but-malformed tab must not read as "the workbook
    // specified an empty alter cast" — it fails safe towards preserving what is already there.
    sheetsPresent[kind] = true;
    const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Array<Record<string, unknown>>;
    const rows = rawRows.map(normalizeRow);
    const parsed = parseBaseEntities(rows, keyColumn);
    // ⚡ The ONE difference between the primary and alter tabs: stamp the role AFTER parsing, from
    // the sheet config. `parseBaseEntities` stays role-agnostic (no second parser, no role param).
    // `actorRole === undefined` ⇒ nothing stamped — an absent field already means 0.
    const entities =
      actorRole === undefined ? parsed : parsed.map((e) => ({ ...e, actor_role: actorRole }));
    // Keyed by the real COLLECTION (`setSketchBaseEntities` takes `{characters, props}`), not by
    // kind — `alter_characters` has no bucket of its own. MERGE (append), never assign: the
    // Characters and Alter Characters tabs BOTH feed `characters[]`, primary first (IMPORT_SHEETS
    // order) so the committed array reads the same way the sidebar groups do.
    result[KIND_ENTITY_SOURCE[kind].collection].push(...entities);
    countsByKind[kind] = entities.length;
    parsedByKind[kind] = { rows, keyColumn };
  }

  // Sheet-level errors → abort before per-entity validation (don't import half a book).
  // Cross-tab key uniqueness runs at the same level and for the same reason: a collision makes the
  // `knownKeys` map below ambiguous, so every `@ref` warning derived from it could name the wrong
  // entity. Blocking here keeps the reported issues trustworthy.
  if (issues.errors.length === 0) validateCharacterKeyRoles(result.characters, issues);
  if (issues.errors.length === 0) {
    const knownKeys = new Map<string, SketchEntity>(
      [...result.characters, ...result.props].map((e) => [e.key.toLowerCase(), e]),
    );
    for (const { kind } of IMPORT_SHEETS) {
      const parsed = parsedByKind[kind];
      if (parsed) {
        // Filtered by kind, so the alter rows are validated as their own group even though they
        // live in the merged `characters[]`. `knownKeys` stays the full char∪prop∪alter union →
        // a cross-kind `@ref` pointing at an alter resolves without a second pass.
        const parsedEntities = filterEntitiesOfKind(
          result[KIND_ENTITY_SOURCE[kind].collection],
          kind,
        );
        validateBaseImport(parsedEntities, parsed.rows, kind, parsed.keyColumn, knownKeys, issues);
      }
    }
  }

  log.info('parseWorkbook', 'done', {
    characters: countsByKind.characters ?? 0,
    alterCharacters: countsByKind.alter_characters ?? 0,
    props: countsByKind.props ?? 0,
    alterSheetPresent: sheetsPresent.alter_characters,
    errorCount: issues.errors.length,
    warningCount: issues.warnings.length,
  });
  return { result, issues, sheetsPresent };
}

/**
 * Read an .xlsx File → { result, issues } (thin side-effect-free wrapper around `parseWorkbook`).
 * Lazy-imports xlsx so SheetJS stays out of the initial bundle. Does NOT confirm/toast/write the
 * store — the root component owns the commit (parse-only, mirror of parseSketchEntitiesFromFile).
 */
export async function importBaseEntities(file: File): Promise<BaseImportParse> {
  log.info('importBaseEntities', 'start', { fileName: file.name, size: file.size });
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  return parseWorkbook(buf, XLSX);
}
