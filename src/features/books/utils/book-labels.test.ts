import { describe, expect, it } from 'vitest';
import {
  languageLabel,
  languageInitials,
  countryLabel,
  editionLabel,
} from './book-labels';

describe('languageLabel', () => {
  it('maps a known code to its display name', () => {
    expect(languageLabel('vi_VN')).toBe('Tiếng Việt');
    expect(languageLabel('en_US')).toBe('English');
  });

  it('falls back to the raw code for an unknown language', () => {
    expect(languageLabel('xx_YY')).toBe('xx_YY');
  });
});

describe('languageInitials', () => {
  it('takes the first two chars uppercased', () => {
    expect(languageInitials('vi_VN')).toBe('VI');
    expect(languageInitials('en_US')).toBe('EN');
  });

  it('empty code → "?"', () => {
    expect(languageInitials('')).toBe('?');
  });
});

describe('countryLabel', () => {
  it('maps a known ISO code to a display name', () => {
    expect(countryLabel('VN')).toBe('Vietnam');
    expect(countryLabel('US')).toBe('United States');
  });

  it('falls back to the raw code for an unknown country', () => {
    expect(countryLabel('ZZ')).toBe('ZZ');
  });
});

describe('editionLabel', () => {
  it('international → "International"', () => {
    expect(editionLabel(true, [])).toBe('International');
  });

  it('0 countries → "Localization"', () => {
    expect(editionLabel(false, [])).toBe('Localization');
  });

  it('1 country → "Localization - {Country}"', () => {
    expect(editionLabel(false, [{ code: 'US' }])).toBe('Localization - United States');
  });

  it('multiple countries → first + "+N"', () => {
    expect(editionLabel(false, [{ code: 'US' }, { code: 'JP' }, { code: 'VN' }])).toBe(
      'Localization - United States +2',
    );
  });
});
