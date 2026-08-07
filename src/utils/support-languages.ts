// Pure helpers for the book localization config: translation_status recompute,
// support-language map merge-preserve, and support-country normalization.
//
// PURE TS — no React, no store, no I/O. Safe to unit-test without jsdom.
// Never logs textbox content (user story text = PII). Only counts/status.
//
// Rule per-step (design §4.5): status is computed over the textbox set of the
// book's current step —
//   step 1 → sketch.spreads[].textboxes
//   step 2 → illustration.spreads[].raw_textboxes
//   step 3 → illustration.spreads[].textboxes  (default)
//
// Textbox shape (SpreadTextbox / SketchTextbox) has an index signature whose
// value union includes non-language slots (`id`, `title`, `z-index`,
// `player_visible`, `editor_visible`). Reading `tb[lang].text` MUST go through
// the type-guard below, mirroring `isSketchTextboxContent` in types/sketch.ts.

import { dequal } from 'dequal';
import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'SupportLanguages');

// ── Types (API contract — consumed by P02 Config UI + P03 save engine) ──────

export type TranslationStatus = 0 | 1 | 2;

/** Per-language translation state, keyed by language_key (e.g. 'en_US'). */
export type SupportLanguagesMap = Record<string, { translation_status: TranslationStatus }>;

/** A support-country entry (ISO 3166-1 alpha-2, uppercase). */
export interface SupportCountryEntry {
  code: string;
}

/** Structural subset of `Book` the recompute needs. A full `Book` satisfies it. */
export interface RecomputeBookInput {
  step: number;
  original_language: string;
  support_languages?: SupportLanguagesMap | null;
}

/** Minimal snapshot shape — only the two roots the per-step selector walks. */
export interface SupportLanguagesSnapshot {
  illustration?: unknown;
  sketch?: unknown;
}

/** A textbox with a language-content slot (post type-guard). */
type LanguageContent = { text: string; [key: string]: unknown };

// ── Internal navigation helpers (defensive — tolerate any snapshot shape) ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Flatten `spreads[].{field}` textbox arrays across a snapshot root. */
function collectTextboxes(root: unknown, field: string): Record<string, unknown>[] {
  if (!isRecord(root)) return [];
  const spreads = root.spreads;
  if (!Array.isArray(spreads)) return [];
  const out: Record<string, unknown>[] = [];
  for (const spread of spreads) {
    if (!isRecord(spread)) continue;
    const boxes = spread[field];
    if (!Array.isArray(boxes)) continue; // tolerate missing array on this spread
    for (const tb of boxes) {
      if (isRecord(tb)) out.push(tb);
    }
  }
  return out;
}

// ── Type-guard accessor (mirror of getSketchTextboxContent) ─────────────────

/**
 * The language-content entry for `langKey`, or `null` when the slot is absent
 * or a non-language value (`id`/`title`/`z-index`/`player_visible` → string /
 * boolean / number). MUST be an object AND carry a string `text` — never cast.
 */
export function getTextboxLanguageContent(
  tb: Record<string, unknown>,
  langKey: string,
): LanguageContent | null {
  const value = tb[langKey];
  if (!isRecord(value)) return null;
  if (typeof value.text !== 'string') {
    log.debug('getTextboxLanguageContent', 'non-string text in language slot', { langKey });
    return null;
  }
  return value as LanguageContent;
}

// ── Per-step textbox selector (generic — all 3 steps) ───────────────────────

/**
 * The textbox set the status is computed over, per the book's step.
 * Tolerates missing snapshot roots / spreads / arrays → returns [].
 */
export function selectTextboxesByStep(
  step: number,
  snapshot: SupportLanguagesSnapshot,
): Record<string, unknown>[] {
  switch (step) {
    case 1:
      return collectTextboxes(snapshot.sketch, 'textboxes');
    case 2:
      return collectTextboxes(snapshot.illustration, 'raw_textboxes');
    case 3:
      return collectTextboxes(snapshot.illustration, 'textboxes');
    default:
      log.debug('selectTextboxesByStep', 'step outside 1-3, defaulting to step 3', { step });
      return collectTextboxes(snapshot.illustration, 'textboxes');
  }
}

/** True when a textbox has non-empty (trimmed) text for the given language. */
function hasText(tb: Record<string, unknown>, langKey: string): boolean {
  const content = getTextboxLanguageContent(tb, langKey);
  return content !== null && content.text.trim().length > 0;
}

// ── recomputeSupportLanguages (design §4.5) ─────────────────────────────────

/**
 * Recompute translation_status for each language ALREADY present in the map,
 * over the current step's textbox set. Never auto-adds languages found only in
 * content. `original_language` is invariant status 2. Returns the new map, or
 * `null` when unchanged (diff-gate via dequal → caller skips the DB write).
 */
export function recomputeSupportLanguages(
  book: RecomputeBookInput,
  snapshot: SupportLanguagesSnapshot,
): SupportLanguagesMap | null {
  const prev: SupportLanguagesMap = book.support_languages ?? {};
  const original = book.original_language;
  const textboxes = selectTextboxesByStep(book.step, snapshot);

  // Denominator = textboxes carrying non-empty ORIGINAL text.
  const denominator = textboxes.reduce((n, tb) => (hasText(tb, original) ? n + 1 : n), 0);

  const next: SupportLanguagesMap = {};
  for (const langKey of Object.keys(prev)) {
    if (langKey === original) {
      next[langKey] = { translation_status: 2 }; // invariant — never recompute
      continue;
    }
    const translated = textboxes.reduce((n, tb) => (hasText(tb, langKey) ? n + 1 : n), 0);
    let status: TranslationStatus;
    if (denominator === 0) status = 0;
    else if (translated === denominator) status = 2;
    else if (translated > 0) status = 1;
    else status = 0;
    next[langKey] = { translation_status: status };
  }

  // Keep the original-language invariant even if it was absent from prev.
  if (!(original in prev)) {
    next[original] = { translation_status: 2 };
  }

  return dequal(next, prev) ? null : next;
}

// ── mergeSupportLanguages (design §3.3) ─────────────────────────────────────

/**
 * Merge-preserve: keep prior status for retained keys, seed new keys at 0, drop
 * unselected keys, force `originalKey` to status 2 (always present). Preserves
 * selection order and dedupes.
 */
export function mergeSupportLanguages(
  prev: SupportLanguagesMap | null | undefined,
  selectedKeys: string[],
  originalKey: string,
): SupportLanguagesMap {
  const source = prev ?? {};
  const next: SupportLanguagesMap = {};
  for (const key of selectedKeys) {
    if (key in next) continue; // dedupe, keep first-occurrence order
    next[key] = source[key] ?? { translation_status: 0 };
  }
  next[originalKey] = { translation_status: 2 }; // invariant — always present
  return next;
}

// ── toSupportCountries ──────────────────────────────────────────────────────

/**
 * Normalize country codes → `{ code }[]`. Uppercases, dedupes by uppercased
 * value, preserves first-occurrence order.
 */
export function toSupportCountries(codes: string[]): SupportCountryEntry[] {
  const seen = new Set<string>();
  const out: SupportCountryEntry[] = [];
  for (const raw of codes) {
    const code = raw.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code });
  }
  return out;
}
