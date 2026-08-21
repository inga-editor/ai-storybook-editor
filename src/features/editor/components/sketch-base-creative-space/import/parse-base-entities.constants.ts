// parse-base-entities.constants.ts — Mapping + column constants for the BASE-space Excel
// import (design sketch-base-creative-space/05-import-base-entities.md). ⚡REV 2026-08-21 —
// tab discovery is by NAME RULE (no fixed tab list): every tab whose name contains `character`
// is a character group, every tab whose name contains `prop` is a prop group. Each matching tab
// is ONE group (`group_key = normalizeGroupKey(tabName)`). Differs from the legacy single-column
// variants import (parse-sketch-entities.constants.ts):
//   • N DYNAMIC groups discovered by rule (base space merges every char + prop group),
//   • FOUR text columns mapped 1:1 (description / height / visual_design / art_language),
//   • NO media_url (imagery is populated on generate, never imported),
//   • NO Stages sheet (the stage space is separate, untouched).

import type { SheetKind } from '@/types/sketch';

/** One tab-name discovery rule. A tab matching a rule becomes a group of `kind`, read via its
 *  `keyColumn`. A tab matching BOTH rules (name contains `character` AND `prop`) is ambiguous → a
 *  blocking error; a tab matching NEITHER is skipped (Stages / Storyboard / Flow / Book / lang). */
export interface GroupTabRule {
  match: RegExp;
  kind: SheetKind;
  keyColumn: string;
}

/**
 * ⚡REV 2026-08-21 — discovery replaces the old static `IMPORT_SHEETS`. Order is not significant
 * (a tab matches at most one rule, else it is ambiguous). `alter_characters` is gone — an "Alter
 * Characters" tab is just another character group (its normalized key is `alter_characters`).
 */
export const GROUP_TAB_RULES: GroupTabRule[] = [
  { match: /character/i, kind: 'characters', keyColumn: 'character' },
  { match: /prop/i, kind: 'props', keyColumn: 'prop' },
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
