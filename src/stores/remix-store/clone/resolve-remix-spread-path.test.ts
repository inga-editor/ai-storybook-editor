// resolve-remix-spread-path.test.ts — Branch walker unit tests + PARITY vs the
// live player walker (resolveBookSequence) on an all-default fixture.

import { describe, it, expect } from 'vitest';
import { resolveRemixSpreadPath } from './resolve-remix-spread-path';
import { resolveBookSequence } from '@/features/editor/components/playable-spread-view/resolve-book-sequence';
import type { BaseSpread } from '@/types/spread-types';
import type { Section } from '@/types/illustration-types';
import type { PlayableSpread } from '@/types/playable-types';
import type { RemixBranchChoice } from '@/types/remix';

// ── fixture helpers ───────────────────────────────────────────────────────────

function sp(id: string, extra: Partial<BaseSpread> = {}): BaseSpread {
  return { id, pages: [{ number: 1 }], images: [], textboxes: [], ...extra } as unknown as BaseSpread;
}

function branchSpread(id: string, branches: { section_id: string; is_default: boolean }[]): BaseSpread {
  return sp(id, { branch_setting: { branches } });
}

function section(id: string, start: string, end: string, next?: string | null): Section {
  return { id, title: id, start_spread_id: start, end_spread_id: end, next_spread_id: next ?? undefined };
}

const ids = (r: { ordered: BaseSpread[] }) => r.ordered.map((s) => s.id);

// ── linear (no branches) ──────────────────────────────────────────────────────

describe('resolveRemixSpreadPath — linear', () => {
  it('follows array order when there are no branches/sections', () => {
    const r = resolveRemixSpreadPath([sp('a'), sp('b'), sp('c')], [], []);
    expect(ids(r)).toEqual(['a', 'b', 'c']);
    expect(r.truncatedByCycle).toBe(false);
    expect(r.truncatedByCap).toBe(false);
  });

  it('follows section.next_spread_id when current is a section end', () => {
    const spreads = [sp('a'), sp('skip'), sp('b')];
    const sections = [section('sec', 'a', 'a', 'b')]; // a ends sec → jump to b (skip omitted)
    const r = resolveRemixSpreadPath(spreads, sections, []);
    expect(ids(r)).toEqual(['a', 'b']);
  });
});

// ── branch choice ─────────────────────────────────────────────────────────────

describe('resolveRemixSpreadPath — branch choice', () => {
  const spreads = [
    branchSpread('s1', [
      { section_id: 'sec_a', is_default: true },
      { section_id: 'sec_b', is_default: false },
    ]),
    sp('sA'),
    sp('sB'),
  ];
  const sections = [section('sec_a', 'sA', 'sA', null), section('sec_b', 'sB', 'sB', null)];

  it('picks the chosen non-default branch', () => {
    const choices: RemixBranchChoice[] = [{ spread_id: 's1', section_id: 'sec_b' }];
    expect(ids(resolveRemixSpreadPath(spreads, sections, choices))).toEqual(['s1', 'sB']);
  });

  it('falls back to the default branch when no choice is present', () => {
    expect(ids(resolveRemixSpreadPath(spreads, sections, []))).toEqual(['s1', 'sA', 'sB']);
  });

  it('falls back to default when the choice section_id is dangling', () => {
    const choices: RemixBranchChoice[] = [{ spread_id: 's1', section_id: 'nope' }];
    // dangling → default sec_a → sA (then array order → sB)
    expect(ids(resolveRemixSpreadPath(spreads, sections, choices))).toEqual(['s1', 'sA', 'sB']);
  });

  it('when the branch section itself is missing, progresses via array order (kept robust)', () => {
    // sections omit sec_a/sec_b entirely → branch resolves to no start → fall through
    const r = resolveRemixSpreadPath(spreads, [], []);
    expect(ids(r)).toEqual(['s1', 'sA', 'sB']);
  });
});

// ── guardrails ────────────────────────────────────────────────────────────────

describe('resolveRemixSpreadPath — guardrails', () => {
  it('truncates on a branch/section cycle (visited guard)', () => {
    const spreads = [sp('a'), sp('b')];
    const sections = [section('sec', 'a', 'b', 'a')]; // b → a → cycle
    const r = resolveRemixSpreadPath(spreads, sections, []);
    expect(ids(r)).toEqual(['a', 'b']);
    expect(r.truncatedByCycle).toBe(true);
  });

  it('truncates at the max-spreads cap', () => {
    const spreads = [sp('a'), sp('b'), sp('c'), sp('d')];
    const r = resolveRemixSpreadPath(spreads, [], [], { maxSpreads: 2 });
    expect(ids(r)).toEqual(['a', 'b']);
    expect(r.truncatedByCap).toBe(true);
  });

  it('honours an explicit startSpreadId', () => {
    const r = resolveRemixSpreadPath([sp('a'), sp('b'), sp('c')], [], [], { startSpreadId: 'b' });
    expect(ids(r)).toEqual(['b', 'c']);
  });
});

// ── PARITY vs resolveBookSequence (all-default) ───────────────────────────────

describe('resolveRemixSpreadPath — parity vs resolveBookSequence (all-default)', () => {
  it('emits the same ordered spread ids as the player walker', () => {
    const spreads = [
      branchSpread('s0', [
        { section_id: 'sec_a', is_default: true },
        { section_id: 'sec_b', is_default: false },
      ]),
      sp('sA1'),
      sp('sA2'),
      sp('sB1'),
    ];
    const sections = [section('sec_a', 'sA1', 'sA2'), section('sec_b', 'sB1', 'sB1')];

    const remix = resolveRemixSpreadPath(spreads, sections, []); // all-default (no choices)
    const player = resolveBookSequence(spreads as unknown as PlayableSpread[], sections, {
      edition: 'classic',
    });

    expect(ids(remix)).toEqual(player.ordered.map((s) => s.spreadId));
    expect(ids(remix)).toEqual(['s0', 'sA1', 'sA2', 'sB1']);
  });
});
