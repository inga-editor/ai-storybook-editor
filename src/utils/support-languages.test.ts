import { describe, it, expect } from 'vitest';
import {
  getTextboxLanguageContent,
  selectTextboxesByStep,
  recomputeSupportLanguages,
  mergeSupportLanguages,
  toSupportCountries,
  type SupportLanguagesMap,
  type RecomputeBookInput,
} from './support-languages';

// ── Fixture helpers ─────────────────────────────────────────────────────────

const content = (text: string) => ({ text, geometry: {}, typography: {} });

/** A textbox with the given per-language texts + non-language noise slots. */
const box = (langs: Record<string, string>): Record<string, unknown> => ({
  id: 'tb-1',
  title: 'noise',
  'z-index': 3,
  player_visible: true,
  ...Object.fromEntries(Object.entries(langs).map(([k, v]) => [k, content(v)])),
});

/** step-3 snapshot: illustration.spreads[].textboxes */
const illoSnapshot = (boxesPerSpread: Record<string, unknown>[][]) => ({
  illustration: { spreads: boxesPerSpread.map((textboxes) => ({ id: 's', textboxes })) },
});

const bookAt = (over: Partial<RecomputeBookInput>): RecomputeBookInput => ({
  step: 3,
  original_language: 'en_US',
  support_languages: {},
  ...over,
});

// ── getTextboxLanguageContent (type-guard) ──────────────────────────────────

describe('getTextboxLanguageContent', () => {
  it('returns content object for a valid language slot', () => {
    const tb = box({ en_US: 'Hello' });
    expect(getTextboxLanguageContent(tb, 'en_US')?.text).toBe('Hello');
  });

  it('returns null for absent language', () => {
    expect(getTextboxLanguageContent(box({ en_US: 'Hi' }), 'fr_FR')).toBeNull();
  });

  it('returns null for boolean slot (player_visible) — not language content', () => {
    expect(getTextboxLanguageContent(box({ en_US: 'Hi' }), 'player_visible')).toBeNull();
  });

  it('returns null for number slot (z-index)', () => {
    expect(getTextboxLanguageContent(box({ en_US: 'Hi' }), 'z-index')).toBeNull();
  });

  it('returns null for string slot (id/title)', () => {
    expect(getTextboxLanguageContent(box({ en_US: 'Hi' }), 'id')).toBeNull();
    expect(getTextboxLanguageContent(box({ en_US: 'Hi' }), 'title')).toBeNull();
  });
});

// ── selectTextboxesByStep ────────────────────────────────────────────────────

describe('selectTextboxesByStep', () => {
  const snapshot = {
    sketch: { spreads: [{ textboxes: [box({ en_US: 'sk' })] }] },
    illustration: {
      spreads: [
        { raw_textboxes: [box({ en_US: 'raw' })], textboxes: [box({ en_US: 't3a' }), box({ en_US: 't3b' })] },
      ],
    },
  };

  it('step 1 → sketch.spreads[].textboxes', () => {
    const r = selectTextboxesByStep(1, snapshot);
    expect(r).toHaveLength(1);
    expect(getTextboxLanguageContent(r[0], 'en_US')?.text).toBe('sk');
  });

  it('step 2 → illustration.spreads[].raw_textboxes', () => {
    const r = selectTextboxesByStep(2, snapshot);
    expect(r).toHaveLength(1);
    expect(getTextboxLanguageContent(r[0], 'en_US')?.text).toBe('raw');
  });

  it('step 3 → illustration.spreads[].textboxes', () => {
    expect(selectTextboxesByStep(3, snapshot)).toHaveLength(2);
  });

  it('unknown step defaults to step 3 set', () => {
    expect(selectTextboxesByStep(99, snapshot)).toHaveLength(2);
  });

  it('tolerates missing roots / spreads / arrays', () => {
    expect(selectTextboxesByStep(3, {})).toEqual([]);
    expect(selectTextboxesByStep(1, { sketch: {} })).toEqual([]);
    expect(selectTextboxesByStep(3, { illustration: { spreads: [{}] } })).toEqual([]);
  });
});

// ── recomputeSupportLanguages ────────────────────────────────────────────────

describe('recomputeSupportLanguages', () => {
  it('denominator 0 → all non-original languages become 0', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 }, vi_VN: { translation_status: 2 } } });
    // no original text anywhere → denominator 0
    const snap = illoSnapshot([[box({ vi_VN: 'chào' })]]);
    expect(recomputeSupportLanguages(book, snap)).toEqual({
      en_US: { translation_status: 2 },
      vi_VN: { translation_status: 0 },
    });
  });

  it('fully translated → 2', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 }, vi_VN: { translation_status: 1 } } });
    const snap = illoSnapshot([[box({ en_US: 'a', vi_VN: 'x' }), box({ en_US: 'b', vi_VN: 'y' })]]);
    expect(recomputeSupportLanguages(book, snap)).toEqual({
      en_US: { translation_status: 2 },
      vi_VN: { translation_status: 2 },
    });
  });

  it('partial translation → 1', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 }, vi_VN: { translation_status: 0 } } });
    const snap = illoSnapshot([[box({ en_US: 'a', vi_VN: 'x' }), box({ en_US: 'b' })]]);
    expect(recomputeSupportLanguages(book, snap)?.vi_VN).toEqual({ translation_status: 1 });
  });

  it('none translated but original present → 0', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 }, vi_VN: { translation_status: 2 } } });
    const snap = illoSnapshot([[box({ en_US: 'a' }), box({ en_US: 'b' })]]);
    expect(recomputeSupportLanguages(book, snap)?.vi_VN).toEqual({ translation_status: 0 });
  });

  it('whitespace-only text counts as empty', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 }, vi_VN: { translation_status: 2 } } });
    // original present twice; vi has one real + one whitespace → translated 1 of 2 → partial
    const snap = illoSnapshot([[box({ en_US: 'a', vi_VN: 'x' }), box({ en_US: 'b', vi_VN: '   ' })]]);
    expect(recomputeSupportLanguages(book, snap)?.vi_VN).toEqual({ translation_status: 1 });
  });

  it('original always 2 even with empty content', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 0 } } });
    const snap = illoSnapshot([[box({ vi_VN: 'only-vi' })]]);
    expect(recomputeSupportLanguages(book, snap)).toEqual({ en_US: { translation_status: 2 } });
  });

  it('does NOT auto-add a language present only in content', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 } } });
    const snap = illoSnapshot([[box({ en_US: 'a', fr_FR: 'bonjour' })]]);
    const r = recomputeSupportLanguages(book, snap);
    expect(r).toBeNull(); // en_US already 2, no other keys → unchanged
  });

  it('returns null when unchanged (diff-gate)', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 }, vi_VN: { translation_status: 2 } } });
    const snap = illoSnapshot([[box({ en_US: 'a', vi_VN: 'x' })]]);
    expect(recomputeSupportLanguages(book, snap)).toBeNull();
  });

  it('tolerates absent/null support_languages, seeding original invariant', () => {
    const snapEmpty = illoSnapshot([[box({ en_US: 'a' })]]);
    expect(recomputeSupportLanguages(bookAt({ support_languages: undefined }), snapEmpty)).toEqual({
      en_US: { translation_status: 2 },
    });
    expect(recomputeSupportLanguages(bookAt({ support_languages: null }), snapEmpty)).toEqual({
      en_US: { translation_status: 2 },
    });
  });

  it('step 1 / step 2 select the correct textbox set', () => {
    const map: SupportLanguagesMap = { en_US: { translation_status: 2 }, vi_VN: { translation_status: 0 } };
    const snap = {
      sketch: { spreads: [{ textboxes: [box({ en_US: 'a', vi_VN: 'x' })] }] }, // full translated
      illustration: { spreads: [{ raw_textboxes: [box({ en_US: 'a' })] }] }, // not translated
    };
    expect(recomputeSupportLanguages({ step: 1, original_language: 'en_US', support_languages: map }, snap)?.vi_VN)
      .toEqual({ translation_status: 2 });
    expect(recomputeSupportLanguages({ step: 2, original_language: 'en_US', support_languages: map }, snap))
      .toBeNull(); // vi stays 0 → unchanged
  });

  it('player_visible boolean slot is never mistaken for language content', () => {
    const book = bookAt({ support_languages: { en_US: { translation_status: 2 }, player_visible: { translation_status: 0 } } });
    const snap = illoSnapshot([[box({ en_US: 'a' })]]);
    // 'player_visible' key present in map is treated as a language key by name only;
    // its content in the box is boolean → getTextboxLanguageContent null → status 0 (unchanged).
    expect(recomputeSupportLanguages(book, snap)).toBeNull();
  });
});

// ── mergeSupportLanguages ────────────────────────────────────────────────────

describe('mergeSupportLanguages', () => {
  it('preserves prior status, seeds new keys at 0, forces original 2, drops unselected', () => {
    const prev: SupportLanguagesMap = {
      en_US: { translation_status: 2 },
      vi_VN: { translation_status: 1 },
      ja_JP: { translation_status: 2 }, // will be dropped (not selected)
    };
    const r = mergeSupportLanguages(prev, ['en_US', 'vi_VN', 'fr_FR'], 'en_US');
    expect(r).toEqual({
      en_US: { translation_status: 2 }, // original forced
      vi_VN: { translation_status: 1 }, // preserved
      fr_FR: { translation_status: 0 }, // seeded
    });
    expect(r.ja_JP).toBeUndefined();
  });

  it('dedupes selection and always includes original even if not selected', () => {
    const r = mergeSupportLanguages({}, ['vi_VN', 'vi_VN'], 'en_US');
    expect(r).toEqual({ vi_VN: { translation_status: 0 }, en_US: { translation_status: 2 } });
  });

  it('tolerates null prev', () => {
    expect(mergeSupportLanguages(null, ['en_US'], 'en_US')).toEqual({ en_US: { translation_status: 2 } });
  });
});

// ── toSupportCountries ───────────────────────────────────────────────────────

describe('toSupportCountries', () => {
  it('uppercases, dedupes keeping order', () => {
    expect(toSupportCountries(['vn', 'US', 'vn', 'jp'])).toEqual([
      { code: 'VN' },
      { code: 'US' },
      { code: 'JP' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(toSupportCountries([])).toEqual([]);
  });
});
