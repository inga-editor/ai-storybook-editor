// cast-tab.test.tsx — Behaviour of the Cast tab (CharactersSection + MemoriesSection).
//
// Rendered through a small stateful harness that mirrors the modal's wiring:
// `castRows` are derived from the current preset + the draft (upsert/patch via the
// real draft helpers), so these tests exercise the true integration path:
//   • change preset → rows change but draft entries are KEPT by key (round-trip)
//   • toggle OFF → row dimmed (opacity-40), choices preserved
//   • human_id null → visual dropdown + trait checkboxes disabled
//   • memories OFF → radios disabled but the `style` value is kept
//   • memories payload keeps shape { is_enabled, style, photos[] }

import { useMemo, useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { CastTab } from './cast-tab';
import { upsertCharacterChoice, patchMemories } from '../remix-config-draft-helpers';
import { TRAIT_TYPES } from '@/constants/trait-constants';
import type { Human } from '@/types/human';
import type { RemixCharacterEntry } from '@/types/editor';
import type { RemixConfig } from '@/types/remix';
import type { RemixCastRow } from '../remix-config-modal';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const bookChar = (key: string, name: string): RemixCharacterEntry => ({
  key,
  name,
  is_enabled: true,
  traits: TRAIT_TYPES.map((type) => ({ type, is_enabled: true })),
});

const BOOK_CHARS: RemixCharacterEntry[] = [
  bookChar('leela', 'Leela'),
  bookChar('didi', 'Didi'),
  bookChar('owl', 'Owl'),
];

const HUMANS: Human[] = [
  {
    id: 'h1',
    sourceName: 'Alice',
    displayName: {},
    gender: null,
    country: null,
    description: null,
    visualProfiles: [
      {
        clientId: 'vp1',
        name: 'Teen',
        age: 16,
        type: 'full_body',
        rawImages: ['u'],
        nobgImage: null,
        convertedImage: null,
        traits: TRAIT_TYPES.map((type) => ({
          type,
          description: type === 'face' ? 'desc' : null,
          image_url: null,
        })),
      },
    ],
    voiceProfiles: [],
    createdAt: '',
  },
];

const CAST_BY_PRESET: Record<'A' | 'B', string[]> = {
  A: ['leela', 'didi'],
  B: ['owl'],
};

const INITIAL_CONFIG: RemixConfig = {
  story: { presets: [], branches: [], pool_spreads: [] },
  characters: [],
  memories: {
    is_enabled: true,
    style: 'styled',
    photos: [{ key: 'p1', is_enabled: true, media_url: null }],
  },
  voices: [],
  languages: [],
};

/** Harness: reproduces the modal's draft ownership + castRows derivation so the
 *  test drives the real CastTab → sections → rows → draft-helper path. Draft
 *  slices are surfaced as JSON in hidden <pre>s the assertions read. */
function Harness() {
  const [preset, setPreset] = useState<'A' | 'B'>('A');
  const [draft, setDraft] = useState<RemixConfig>(INITIAL_CONFIG);

  const bookByKey = useMemo(
    () => new Map(BOOK_CHARS.map((c) => [c.key, c])),
    [],
  );
  const draftByKey = useMemo(
    () => new Map(draft.characters.map((c) => [c.key, c])),
    [draft.characters],
  );
  const castRows = useMemo<RemixCastRow[]>(
    () =>
      CAST_BY_PRESET[preset].map((key) => ({
        key,
        bookEntry: bookByKey.get(key),
        draftEntry: draftByKey.get(key),
      })),
    [preset, bookByKey, draftByKey],
  );

  return (
    <>
      <button onClick={() => setPreset('A')}>preset-a</button>
      <button onClick={() => setPreset('B')}>preset-b</button>
      <pre data-testid="draft-memories">{JSON.stringify(draft.memories)}</pre>
      <pre data-testid="draft-characters">{JSON.stringify(draft.characters)}</pre>
      <CastTab
        castRows={castRows}
        humans={HUMANS}
        memories={draft.memories}
        showMemories
        onUpsertCharacter={(key, patch) =>
          setDraft((prev) => upsertCharacterChoice(prev, key, patch))
        }
        onMemoriesChange={(patch) => setDraft((prev) => patchMemories(prev, patch))}
      />
    </>
  );
}

const readMemories = () =>
  JSON.parse(screen.getByTestId('draft-memories').textContent ?? '{}');
const rowOf = (name: string): HTMLElement =>
  screen.getByRole('switch', { name: `Toggle ${name}` }).closest(
    '.flex-nowrap',
  ) as HTMLElement;

describe('CastTab', () => {
  beforeEach(() => cleanup());

  it('renders one row per effective-cast key', () => {
    render(<Harness />);
    expect(screen.getByText('@leela')).toBeInTheDocument();
    expect(screen.getByText('@didi')).toBeInTheDocument();
    expect(screen.queryByText('@owl')).not.toBeInTheDocument();
  });

  it('changes rows on preset change but KEEPS draft entries by key', () => {
    render(<Harness />);
    // Configure Leela: toggle OFF.
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Leela' }));
    expect(
      screen.getByRole('switch', { name: 'Toggle Leela' }),
    ).toHaveAttribute('aria-checked', 'false');

    // Preset B → Leela gone, Owl shown.
    fireEvent.click(screen.getByText('preset-b'));
    expect(screen.queryByText('@leela')).not.toBeInTheDocument();
    expect(screen.getByText('@owl')).toBeInTheDocument();

    // Back to preset A → Leela's OFF choice restored (entry kept by key).
    fireEvent.click(screen.getByText('preset-a'));
    expect(
      screen.getByRole('switch', { name: 'Toggle Leela' }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('dims the row (opacity-40) when toggled OFF', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Leela' }));
    expect(rowOf('Leela')).toHaveClass('opacity-40');
  });

  it('disables the visual dropdown and trait checkboxes when no human is picked', () => {
    render(<Harness />);
    const row = rowOf('Leela');
    // Two comboboxes per row: [0] human (enabled), [1] visual (disabled — no
    // human picked → cascade off).
    const combos = within(row).getAllByRole('combobox');
    expect(combos).toHaveLength(2);
    expect(combos[0]).not.toBeDisabled();
    expect(combos[1]).toBeDisabled();
    expect(within(row).getByRole('checkbox', { name: 'Face' })).toBeDisabled();
  });

  it('keeps the memory style value but disables the radios when the toggle is OFF', () => {
    render(<Harness />);
    // Master toggle ON initially → radios interactive, 'Animated Style' selected.
    const animated = screen.getByRole('radio', { name: 'Animated Style' });
    expect(animated).toBeChecked();
    expect(animated).not.toBeDisabled();

    // Turn OFF "Use real photos".
    fireEvent.click(screen.getByRole('switch', { name: 'Use real photos' }));

    // Radios disabled, but the style value is preserved (still 'styled').
    expect(screen.getByRole('radio', { name: 'Animated Style' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Animated Style' })).toBeChecked();

    const mem = readMemories();
    expect(mem.is_enabled).toBe(false);
    expect(mem.style).toBe('styled');
    expect(Array.isArray(mem.photos)).toBe(true);
    expect(mem.photos).toHaveLength(1);
  });

  it('emits a memories payload of shape { is_enabled, style, photos[] }', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'Real Style' }));
    const mem = readMemories();
    expect(mem).toEqual({
      is_enabled: true,
      style: 'real',
      photos: [{ key: 'p1', is_enabled: true, media_url: null }],
    });
  });
});
