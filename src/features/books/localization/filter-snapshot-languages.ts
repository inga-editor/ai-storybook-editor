// filter-snapshot-languages.ts — Pure, non-mutating language filter for a cloned
// snapshot (localization clone, design 09 §2.3). Multilang textboxes have the shape
// `{ id, title?, "z-index"?, player_visible?, ..., [language_key]: content }`. When
// cloning an international book into a localization we keep ONLY the language keys the
// user picked and drop every other language — WITHOUT touching any literal key.
//
// The strict `^[a-z]{2}_[A-Z]{2}$` regex is the safety boundary: it matches ONLY
// language codes (vi_VN, en_US, …), so literal keys (id/title/z-index/player_visible/
// editor_visible) can never be swallowed. Applied at 3 sites:
//   - sketch.spreads[].textboxes
//   - illustration.spreads[].raw_textboxes
//   - illustration.spreads[].textboxes
// All other snapshot columns (docs/characters/props/stages/dummies) are copied verbatim
// by the caller, not here.

/** Language-key discriminator. Deliberately strict so literal keys survive. Matches the
 *  `xx_XX` locale shape of every SUPPORTED_LANGUAGES code. Assumption: no script-suffixed
 *  locales (e.g. `zh_Hant`, `sr_Latn`) are in use — such a key would fail this test and be
 *  copied verbatim (safe: no data loss, but it would not be language-filtered). Widen the
 *  regex here if script-suffixed locales are ever added to SUPPORTED_LANGUAGES. */
const LANGUAGE_KEY_RE = /^[a-z]{2}_[A-Z]{2}$/;

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return a shallow copy of one textbox keeping every literal key verbatim and only the
 * language keys present in `allowed`. Selected-but-absent languages produce NO fake key.
 * Never mutates the input.
 */
export function filterTextboxLanguages<T extends UnknownRecord>(textbox: T, allowed: Set<string>): T {
  const next: UnknownRecord = {};
  for (const [key, value] of Object.entries(textbox)) {
    if (LANGUAGE_KEY_RE.test(key)) {
      if (allowed.has(key)) next[key] = value; // kept language
      // else: drop unselected language
    } else {
      next[key] = value; // literal key (id/title/z-index/player_visible/…) — verbatim
    }
  }
  return next as T;
}

/** Map textboxes on a value if it is an array; otherwise return it untouched. */
function mapTextboxes(value: unknown, allowed: Set<string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((tb) => (isPlainObject(tb) ? filterTextboxLanguages(tb, allowed) : tb));
}

/** Filter sketch.spreads[].textboxes; tolerant of missing sketch/spreads/textboxes. */
function filterSketch(sketch: unknown, allowed: Set<string>): unknown {
  if (!isPlainObject(sketch) || !Array.isArray(sketch.spreads)) return sketch;
  return {
    ...sketch,
    spreads: sketch.spreads.map((spread) => {
      if (!isPlainObject(spread)) return spread;
      return { ...spread, textboxes: mapTextboxes(spread.textboxes, allowed) };
    }),
  };
}

/** Filter illustration.spreads[].{raw_textboxes,textboxes}; tolerant of missing paths. */
function filterIllustration(illustration: unknown, allowed: Set<string>): unknown {
  if (!isPlainObject(illustration) || !Array.isArray(illustration.spreads)) return illustration;
  return {
    ...illustration,
    spreads: illustration.spreads.map((spread) => {
      if (!isPlainObject(spread)) return spread;
      const next: UnknownRecord = { ...spread };
      if (Array.isArray(next.raw_textboxes)) next.raw_textboxes = mapTextboxes(next.raw_textboxes, allowed);
      if (Array.isArray(next.textboxes)) next.textboxes = mapTextboxes(next.textboxes, allowed);
      return next;
    }),
  };
}

export interface FilterableSnapshot {
  sketch?: unknown;
  illustration?: unknown;
}

/**
 * Produce filtered `sketch` + `illustration` for a snapshot, keeping only `languageKeys`
 * in every textbox. Missing sketch/illustration/spreads never throw. Does not mutate input.
 */
export function filterSnapshotLanguages(
  snapshot: FilterableSnapshot,
  languageKeys: string[],
): { sketch: unknown; illustration: unknown } {
  const allowed = new Set(languageKeys);
  return {
    sketch: filterSketch(snapshot?.sketch, allowed),
    illustration: filterIllustration(snapshot?.illustration, allowed),
  };
}
