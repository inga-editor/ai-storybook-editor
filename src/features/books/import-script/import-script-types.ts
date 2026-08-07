// import-script-types.ts — Intermediate parse-model interfaces for the client-side
// "Import Script" flow (Excel → sketch snapshot). Target is SKETCH (design
// `books-page/07-01-import-script-excel.md`). Pure types — no logic.
//
// NOTE: Flow / branch / lane / storyboard-cell types were removed — the new template
// imports into `snapshot.sketch` (no branches), and spread parsing lives in the shared
// `sketch-spread-excel.ts` module (its own intermediate types).

/** One catalog entity row (1 row = 1 variant). Each Excel column maps to its OWN field —
 *  `description` is NEVER collapsed into `visual_design` (design 05 §4 / snapshot structure). */
export interface ParsedEntityRow {
  entity_type: 'character' | 'prop' | 'stage';
  key: string;               // 'kid'
  variant_key: string;       // 'base' | 'hero'
  ref: string;               // '@kid/base' (cross-check only)
  description: string;       // Excel "description"
  visual_design: string;     // Excel "visual_design"
  art_language: string;      // Excel "art_language"
  /** Raw Excel "height" text ('1.05 m', '110cm'…) — parsed to cm at projection time.
   *  Always '' for stages (SketchStageVariant has no height). */
  height: string;
}

/**
 * Book metadata collected by the import modal (the file carries content only,
 * never book format/dimension/artstyle). Shape matches `CreateBookParams`.
 */
export interface ImportModalMeta {
  title: string;
  format_id: string;
  dimension: number;
  target_audience: number;
  artstyle_id: string | null;
  sketchstyle_id: string | null;
  original_language: string;
  /** Project scope — imported books were previously created unscoped (project_id NULL)
   *  → invisible in the project-scoped list. Now threaded from NewInternationalBookModal. */
  project_id: string | null;
  /** International (master) edition flag — the project-scope import path always sets `true`. */
  is_international: boolean;
}

/** Result contract returned by `importScript` to the modal caller. */
export interface ImportScriptResult {
  ok: boolean;
  bookId?: string;
  errors: string[];
  warnings: string[];
}
