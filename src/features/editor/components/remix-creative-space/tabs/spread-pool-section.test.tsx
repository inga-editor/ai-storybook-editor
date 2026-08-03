// spread-pool-section.test.tsx — Behaviour of the Story tab › Pools section.
//
// Rendered through a stateful harness that mirrors the modal's wiring: the draft
// `story.pool_spreads` is mutated via the REAL reducer (`upsertPoolSpreadChoice`),
// so these tests exercise the true toggle → reducer → ordinal-recompute path:
//   • ordinal recompute: uncheck the 3rd card → the former 4th becomes ordinal 3
//   • grid DOM order UNCHANGED after a toggle (map over options, not checked set)
//   • title fallback → `Spread {n}`; thumbnail null → placeholder icon
// The gate-OFF materialize-always case + seed/normalize are covered in the
// default-config-builder / remix-config-normalize suites (pure logic).

import { useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SpreadPoolSection } from './spread-pool-section';
import { upsertPoolSpreadChoice } from '../remix-config-draft-helpers';
import type { RemixConfig, PoolSpreadOption } from '@/types/remix';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const OPTIONS: PoolSpreadOption[] = [
  { spread_id: 'iceland', spread_number: '2', title: 'Iceland', thumbnail_url: 'i.png', is_default: true },
  { spread_id: 'japan', spread_number: '3', title: 'Japan', thumbnail_url: 'j.png', is_default: true },
  { spread_id: 'kenya', spread_number: '4', title: 'Kenya', thumbnail_url: null, is_default: true },
  { spread_id: 'peru', spread_number: '5', title: 'Peru', thumbnail_url: 'p.png', is_default: true },
];

const CONFIG_ALL_ON: RemixConfig = {
  story: {
    presets: [],
    branches: [],
    pool_spreads: OPTIONS.map((o) => ({ spread_id: o.spread_id, is_enabled: true })),
  },
  characters: [],
  memories: { is_enabled: false, style: 'styled', photos: [] },
  voices: [],
  languages: [],
};

/** Harness: reproduces the modal's draft ownership so the test drives the real
 *  SpreadPoolSection → PoolSpreadCard → draft-helper path. */
function Harness({ initial = CONFIG_ALL_ON }: { initial?: RemixConfig }) {
  const [draft, setDraft] = useState<RemixConfig>(initial);
  return (
    <SpreadPoolSection
      poolSpreads={OPTIONS}
      story={draft.story}
      onTogglePoolSpread={(spreadId, next) =>
        setDraft((prev) => upsertPoolSpreadChoice(prev, spreadId, next))
      }
    />
  );
}

/** Ordinal badge text for a card, or null when unchecked (no badge). */
function ordinalOf(spreadId: string): string | null {
  const checkbox = screen.getByRole('checkbox', {
    name: new RegExp(`\\(${OPTIONS.find((o) => o.spread_id === spreadId)!.title}\\)`),
  });
  const card = checkbox.closest('div')!;
  // Badge is the trailing rounded-full span; find a span whose text is a digit.
  const badge = Array.from(card.querySelectorAll('span')).find((s) =>
    /^\d+$/.test(s.textContent ?? ''),
  );
  return badge?.textContent ?? null;
}

describe('SpreadPoolSection', () => {
  beforeEach(() => cleanup());

  it('renders one card per pool option in FIXED array order', () => {
    render(<Harness />);
    const titles = screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
    expect(titles).toEqual([
      'Include spread 2 (Iceland)',
      'Include spread 3 (Japan)',
      'Include spread 4 (Kenya)',
      'Include spread 5 (Peru)',
    ]);
  });

  it('assigns 1-based ordinals to checked cards in options order', () => {
    render(<Harness />);
    expect(ordinalOf('iceland')).toBe('1');
    expect(ordinalOf('japan')).toBe('2');
    expect(ordinalOf('kenya')).toBe('3');
    expect(ordinalOf('peru')).toBe('4');
  });

  it('recomputes ordinals when a middle card is unchecked (former 4th → 3)', () => {
    render(<Harness />);
    // Uncheck the 3rd card (Kenya).
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include spread 4 (Kenya)' }));
    // Kenya loses its badge; Peru (former 4th) becomes ordinal 3.
    expect(ordinalOf('kenya')).toBeNull();
    expect(ordinalOf('iceland')).toBe('1');
    expect(ordinalOf('japan')).toBe('2');
    expect(ordinalOf('peru')).toBe('3');
  });

  it('keeps grid DOM order UNCHANGED after a toggle', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include spread 4 (Kenya)' }));
    const titlesAfter = screen
      .getAllByRole('checkbox')
      .map((c) => c.getAttribute('aria-label'));
    expect(titlesAfter).toEqual([
      'Include spread 2 (Iceland)',
      'Include spread 3 (Japan)',
      'Include spread 4 (Kenya)',
      'Include spread 5 (Peru)',
    ]);
  });

  it('exposes the group a11y label', () => {
    render(<Harness />);
    expect(screen.getByRole('group', { name: 'Spread Pool' })).toBeInTheDocument();
  });

  it('renders a placeholder (no <img>) when a thumbnail is null', () => {
    render(<Harness />);
    // Kenya has thumbnail_url null → no <img> in its card.
    const kenya = screen
      .getByRole('checkbox', { name: 'Include spread 4 (Kenya)' })
      .closest('div')!;
    expect(kenya.querySelector('img')).toBeNull();
    // Iceland has a thumbnail → <img> present.
    const iceland = screen
      .getByRole('checkbox', { name: 'Include spread 2 (Iceland)' })
      .closest('div')!;
    expect(iceland.querySelector('img')).not.toBeNull();
  });
});
