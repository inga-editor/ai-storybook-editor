import { describe, expect, it } from 'vitest';
import { languageLabel, shortCodes } from './project-language';

describe('languageLabel', () => {
  it('maps a known code to its name', () => {
    expect(languageLabel('vi_VN')).toBe('Vietnamese');
    expect(languageLabel('en_US')).toBe('English');
  });

  it('returns the raw key for an unknown code', () => {
    expect(languageLabel('xx_YY')).toBe('xx_YY');
  });

  it('returns empty string for null', () => {
    expect(languageLabel(null)).toBe('');
  });
});

describe('shortCodes', () => {
  it('null support_languages → []', () => {
    expect(shortCodes(null, 'vi_VN')).toEqual([]);
  });

  it('cuts to the short form and hoists the original language first', () => {
    const support = {
      en_US: { translation_status: 0 as const },
      vi_VN: { translation_status: 1 as const },
      ja_JP: { translation_status: 0 as const },
    };
    expect(shortCodes(support, 'vi_VN')).toEqual(['vi', 'en', 'ja']);
  });

  it('dedupes when the original is already present', () => {
    const support = {
      vi_VN: { translation_status: 0 as const },
      en_US: { translation_status: 0 as const },
    };
    expect(shortCodes(support, 'vi_VN')).toEqual(['vi', 'en']);
  });

  it('no original language → order follows support keys', () => {
    const support = {
      en_US: { translation_status: 0 as const },
      ja_JP: { translation_status: 0 as const },
    };
    expect(shortCodes(support, null)).toEqual(['en', 'ja']);
  });
});
