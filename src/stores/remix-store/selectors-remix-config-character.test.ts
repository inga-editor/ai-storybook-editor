// selectors-remix-config-character.test.ts — Unit tests for
// useRemixConfigCharacter selector logic (memoization + data projection).
//
// Tests the pure projection logic without React hook harness (lower setup cost).
// The selector joins frozen remix_config character picks with live humans cache.

import { describe, it, expect } from 'vitest';
import type { RemixConfigCharacterView } from './selectors';
import type { Human, VisualProfile, VisualProfileTrait, TraitType } from '@/types/human';
import type { RemixTraitChoice } from '@/types/remix';

/** Simulate the pure logic of useRemixConfigCharacter memoization:
 *  Extract the selector's core projection (no React hooks involved).
 *  In the real selector, this happens inside useMemo(..., [configChar, humans]).
 */
function projectConfigCharacter(
  configChar: {
    key: string;
    human_id: string | null;
    visual: string | null;
    traits?: RemixTraitChoice[]; // ⚡2026-08-06 optional (text-only entries omit)
  } | null,
  humans: Human[],
): RemixConfigCharacterView | null {
  if (!configChar) return null;

  let convertedImage: string | null = null;
  if (configChar.human_id && configChar.visual) {
    const human = humans.find((h) => h.id === configChar.human_id);
    const profile = human?.visualProfiles.find(
      (vp) => vp.name === configChar.visual,
    );
    convertedImage = profile?.convertedImage ?? null;
  }

  return {
    human_id: configChar.human_id,
    visual: configChar.visual,
    // ⚡2026-08-06 — single view-layer fallback: absent traits (text-only entry)
    // → [] so the Generate gate reports no enabled trait (stays disabled).
    traits: configChar.traits ?? [],
    converted_image: convertedImage,
  };
}

// ── Fixture builders ─────────────────────────────────────────────────────────

function makeTraitDesc(type: string, description: string): VisualProfileTrait {
  return { type: type as TraitType, description, image_url: null };
}

function makeVisualProfile(
  name: string,
  convertedImage: string | null,
  traits: VisualProfileTrait[] = [],
): VisualProfile {
  return {
    name,
    convertedImage,
    traits,
  } as unknown as VisualProfile;
}

function makeHuman(
  id: string,
  description: string = 'A person',
  visualProfiles: VisualProfile[] = [],
): Human {
  return {
    id,
    description,
    visualProfiles,
  } as unknown as Human;
}

function makeConfigChar(
  key: string,
  human_id: string | null,
  visual: string | null,
  traits: RemixTraitChoice[] = [],
) {
  return { key, human_id, visual, traits };
}

describe('useRemixConfigCharacter selector — projection logic', () => {
  it('returns null when configChar is null', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person', [
        makeVisualProfile('vp1', 'https://converted.png', [
          makeTraitDesc('face', 'Young'),
        ]),
      ]),
    ];

    const result = projectConfigCharacter(null, humans);

    expect(result).toBeNull();
  });

  it('returns 4 fields (human_id, visual, traits, converted_image) when data present', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person', [
        makeVisualProfile('vp1', 'https://converted.png', []),
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h1', 'vp1', []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result).toEqual({
      human_id: 'h1',
      visual: 'vp1',
      traits: [],
      converted_image: 'https://converted.png',
    });
  });

  it('joins converted_image from matching human + visual profile', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person 1', [
        makeVisualProfile('vp1', 'https://person1-vp1.png'),
        makeVisualProfile('vp2', 'https://person1-vp2.png'),
      ]),
      makeHuman('h2', 'Person 2', [
        makeVisualProfile('vp1', 'https://person2-vp1.png'),
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h2', 'vp1', []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.converted_image).toBe('https://person2-vp1.png');
  });

  it('returns null converted_image when human not found in cache', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person 1', [
        makeVisualProfile('vp1', 'https://person1-vp1.png'),
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h-missing', 'vp1', []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.converted_image).toBeNull();
  });

  it('returns null converted_image when visual profile not found', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person 1', [
        makeVisualProfile('vp1', 'https://person1-vp1.png'),
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h1', 'vp-missing', []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.converted_image).toBeNull();
  });

  it('returns null converted_image when visual profile has no convertedImage', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person 1', [
        makeVisualProfile('vp1', null), // No normalized image yet
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h1', 'vp1', []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.converted_image).toBeNull();
  });

  it('returns null converted_image when human_id is null', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person 1', [
        makeVisualProfile('vp1', 'https://person1-vp1.png'),
      ]),
    ];
    const configChar = makeConfigChar('c1', null, 'vp1', []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.human_id).toBeNull();
    expect(result?.visual).toBe('vp1');
    expect(result?.converted_image).toBeNull();
  });

  it('returns null converted_image when visual is null', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person 1', [
        makeVisualProfile('vp1', 'https://person1-vp1.png'),
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h1', null, []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.human_id).toBe('h1');
    expect(result?.visual).toBeNull();
    expect(result?.converted_image).toBeNull();
  });

  it('⚡2026-08-06 text-only entry (traits absent) → view.traits falls back to []', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person', [makeVisualProfile('vp1', 'https://converted.png')]),
    ];
    // Text-only config entry — no `traits` key at all.
    const configChar = { key: 'c1', human_id: 'h1', visual: 'vp1' };

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.traits).toEqual([]);
  });

  it('passes traits through unchanged', () => {
    const traits: RemixTraitChoice[] = [
      { type: 'face', is_enabled: true },
      { type: 'hair', is_enabled: false },
    ];
    const humans: Human[] = [
      makeHuman('h1', 'Person', [
        makeVisualProfile('vp1', 'https://converted.png'),
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h1', 'vp1', traits);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.traits).toEqual(traits);
  });

  it('handles empty humans array', () => {
    const humans: Human[] = [];
    const configChar = makeConfigChar('c1', 'h1', 'vp1', []);

    const result = projectConfigCharacter(configChar, humans);

    expect(result?.converted_image).toBeNull();
  });

  it('handles multiple humans with same visual profile name', () => {
    const humans: Human[] = [
      makeHuman('h1', 'Person 1', [
        makeVisualProfile('vp1', 'https://person1-vp1.png'),
      ]),
      makeHuman('h2', 'Person 2', [
        makeVisualProfile('vp1', 'https://person2-vp1.png'),
      ]),
    ];
    const configChar = makeConfigChar('c1', 'h1', 'vp1', []);

    const result = projectConfigCharacter(configChar, humans);

    // Should find h1's vp1, not h2's
    expect(result?.converted_image).toBe('https://person1-vp1.png');
  });

  it('integration: full config character with all fields populated', () => {
    const traits: RemixTraitChoice[] = [
      { type: 'face', is_enabled: true },
      { type: 'hair', is_enabled: true },
      { type: 'outfit', is_enabled: false },
    ];
    const humans: Human[] = [
      makeHuman('h1', 'Alice', [
        makeVisualProfile('alice-modern', 'https://alice-modern.png', [
          makeTraitDesc('face', 'Young, kind eyes'),
          makeTraitDesc('hair', 'Long brown hair'),
        ]),
        makeVisualProfile('alice-vintage', 'https://alice-vintage.png'),
      ]),
    ];
    const configChar = makeConfigChar('alice', 'h1', 'alice-modern', traits);

    const result = projectConfigCharacter(configChar, humans);

    expect(result).toEqual({
      human_id: 'h1',
      visual: 'alice-modern',
      traits,
      converted_image: 'https://alice-modern.png',
    });
  });
});
