// parse-base-entities.constants.ts — Mapping + column constants for the BASE-space Excel
// import (design sketch-base-creative-space/05-import-base-entities.md). Differs from the
// legacy single-column variants import (parse-sketch-entities.constants.ts):
//   • reads THREE sheets in one pass (Characters + Props + the OPTIONAL Alter Characters —
//     the base space merges all three kinds),
//   • FOUR text columns mapped 1:1 (description / height / visual_design / art_language),
//   • NO media_url (imagery is populated on generate, never imported),
//   • NO Stages sheet (the stage space is separate, untouched).

import type { ActorRole, BaseKind } from '@/types/sketch';

/** One Excel tab the base importer reads. */
export interface ImportSheetConfig {
  kind: BaseKind;
  /** CANONICAL tab name — used for display/log/error copy only. The workbook lookup itself is
   *  NORMALIZED (trim + lowercase, see `normalizeSheetName`), so `alter characters` and
   *  `" ALTER CHARACTERS "` still match. */
  sheet: string;
  /** Key column, lowercase to match the normalized (lowercased) header lookup in the parser. */
  keyColumn: string;
  /** Stamped onto EVERY entity parsed from this tab. Omitted ⇒ nothing is stamped — an absent
   *  `actor_role` already means 0, and writing an explicit `0` would bloat the JSONB and add
   *  noise to every collab diff. Only the alter tab sets it. */
  actorRole?: ActorRole;
  /** The tab may legitimately be missing (a book with no alter cast) ⇒ skip + `warn`, never a
   *  blocking error. Characters/Props stay REQUIRED: their absence means the file is not a base
   *  workbook at all. */
  optional?: boolean;
}

/**
 * Which sheet + key column to read per base kind.
 *
 * ⚡2026-07-28 — `alter_characters` is the 3rd entry: SAME 8 columns and SAME key column
 * (`character`) as the primary tab, so it reuses `parseBaseEntities` verbatim; the ONLY difference
 * is the `actorRole: 1` stamp applied after parsing. Its rows land in the SAME `sketch.characters[]`
 * array (there is no `alter_characters` collection) — see `KIND_ENTITY_SOURCE`.
 *
 * Order matters: it is the order rows are appended to `characters[]` (primary first, alter last).
 */
export const IMPORT_SHEETS: ImportSheetConfig[] = [
  { kind: 'characters', sheet: 'Characters', keyColumn: 'character' },
  { kind: 'props', sheet: 'Props', keyColumn: 'prop' },
  {
    kind: 'alter_characters',
    sheet: 'Alter Characters', // NOTE the space — matched case-insensitively after trim
    keyColumn: 'character', // the alter tab's key column is `character`, NOT `alter_character`
    actorRole: 1,
    optional: true,
  },
];

/** Non-key column names (lowercased — header lookup is case/space-insensitive). Each maps to
 *  its OWN variant field; `description` is NOT collapsed into `visual_design` (design-03 §72). */
export const COL = {
  REF: 'ref',
  VARIANT: 'variant',
  DESCRIPTION: 'description',
  HEIGHT: 'height',
  VISUAL_DESIGN: 'visual_design',
  ART_LANGUAGE: 'art_language',
} as const;

/** Whole-cell `@key/variant` (the `ref` column = a row's own canonical identity).
 *  Case-insensitive so capitalized Excel keys still parse (keys are kept verbatim). */
export const REF_RE = /^@(?<key>[a-z0-9_]+)\/(?<variant>[a-z0-9_]+)$/i;

/** Inline `@key/variant` occurrences inside any free-text field (global, unanchored). */
export const REF_IN_TEXT_RE = /@(?<key>[a-z0-9_]+)\/(?<variant>[a-z0-9_]+)/gi;
