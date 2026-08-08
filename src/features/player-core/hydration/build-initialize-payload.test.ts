// build-initialize-payload.test.ts — playback InitializePayload builder.
import { describe, it, expect } from 'vitest';
import type { PlayableSpread } from '@/types/playable-types';
import { buildInitializePayload } from './build-initialize-payload';

const spreads = [{ id: 'sp-1' }, { id: 'sp-2' }] as unknown as PlayableSpread[];

function base() {
  return {
    sessionId: 'share:book-1',
    spreads,
    availableEditions: { classic: true, dynamic: true, interactive: true },
    languages: [{ name: 'English', code: 'en_US' }],
    originalLanguage: 'en_US',
  };
}

describe('buildInitializePayload', () => {
  it('returns null when no spreads', () => {
    expect(buildInitializePayload({ ...base(), spreads: [] })).toBeNull();
  });

  it('picks highest-available edition + first language, first spread by default', () => {
    const p = buildInitializePayload(base());
    expect(p).not.toBeNull();
    expect(p!.edition).toBe('interactive');
    expect(p!.language).toBe('en_US');
    expect(p!.startSpreadId).toBe('sp-1');
    expect(p!.sessionId).toBe('share:book-1');
  });

  it('falls back dynamic then classic when interactive disabled', () => {
    expect(
      buildInitializePayload({
        ...base(),
        availableEditions: { classic: true, dynamic: true },
      })!.edition,
    ).toBe('dynamic');
    expect(
      buildInitializePayload({
        ...base(),
        availableEditions: { classic: true },
      })!.edition,
    ).toBe('classic');
  });

  it('language falls back to originalLanguage when languages empty', () => {
    expect(
      buildInitializePayload({ ...base(), languages: [], originalLanguage: 'vi_VN' })!.language,
    ).toBe('vi_VN');
  });

  it('language falls back to en_US only when originalLanguage nullish (defensive)', () => {
    expect(
      buildInitializePayload({
        ...base(),
        languages: [],
        originalLanguage: undefined as unknown as string,
      })!.language,
    ).toBe('en_US');
  });

  it('applies languageOverride (player init option)', () => {
    expect(buildInitializePayload({ ...base(), languageOverride: 'fr_FR' })!.language).toBe(
      'fr_FR',
    );
  });

  it('applies editionOverride when ∈ enabled editions', () => {
    expect(
      buildInitializePayload({
        ...base(),
        availableEditions: { classic: true, dynamic: true, interactive: true },
        editionOverride: 'classic',
      })!.edition,
    ).toBe('classic');
  });

  it('IGNORES editionOverride outside enabled editions → default', () => {
    // interactive disabled, override asks for it → falls back to highest available (dynamic)
    expect(
      buildInitializePayload({
        ...base(),
        availableEditions: { classic: true, dynamic: true },
        editionOverride: 'interactive',
      })!.edition,
    ).toBe('dynamic');
  });

  it('applies startSpreadId override', () => {
    expect(
      buildInitializePayload({ ...base(), startSpreadId: 'sp-2' })!.startSpreadId,
    ).toBe('sp-2');
  });
});
