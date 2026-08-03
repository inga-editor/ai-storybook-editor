// resolve-remix-spread-path.test.ts — Branch walker unit tests + PARITY vs the
// live player walker (resolveBookSequence) on an all-default fixture.

import { describe, it, expect } from 'vitest';
import { resolveRemixSpreadPath, filterPoolSpreads } from './resolve-remix-spread-path';
import { resolveBookSequence } from '@/features/editor/components/playable-spread-view/resolve-book-sequence';
import type { BaseSpread, SpreadPool } from '@/types/spread-types';
import type { Section } from '@/types/illustration-types';
import type { PlayableSpread } from '@/types/playable-types';
import type { RemixBranchChoice, RemixPoolSpreadChoice } from '@/types/remix';

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

// ── filterPoolSpreads ─────────────────────────────────────────────────────────

function poolSpread(id: string, pool: SpreadPool): BaseSpread {
  return sp(id, { pool });
}

describe('filterPoolSpreads', () => {
  it('always keeps normal spreads (pool undefined / is_true=false), even with no choices', () => {
    const ordered = [sp('a'), sp('b'), poolSpread('c', { is_true: false, is_default: false })];
    expect(filterPoolSpreads(ordered, []).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a pool spread when its choice is_enabled=true', () => {
    const ordered = [sp('a'), poolSpread('p', { is_true: true, is_default: false })];
    const choices: RemixPoolSpreadChoice[] = [{ spread_id: 'p', is_enabled: true }];
    expect(filterPoolSpreads(ordered, choices).map((s) => s.id)).toEqual(['a', 'p']);
  });

  it('excludes a pool spread when its choice is_enabled=false', () => {
    const ordered = [sp('a'), poolSpread('p', { is_true: true, is_default: true }), sp('b')];
    const choices: RemixPoolSpreadChoice[] = [{ spread_id: 'p', is_enabled: false }];
    expect(filterPoolSpreads(ordered, choices).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('missing entry → fallback keeps when pool.is_default=true (P5 dangling)', () => {
    const ordered = [poolSpread('p', { is_true: true, is_default: true })];
    expect(filterPoolSpreads(ordered, []).map((s) => s.id)).toEqual(['p']);
  });

  it('missing entry → fallback excludes when pool.is_default=false (P5 dangling)', () => {
    const ordered = [poolSpread('p', { is_true: true, is_default: false }), sp('b')];
    expect(filterPoolSpreads(ordered, []).map((s) => s.id)).toEqual(['b']);
  });

  it('is_true=false ∧ is_default=true → kept as a normal spread (rule P1)', () => {
    const ordered = [poolSpread('p', { is_true: false, is_default: true })];
    // choice with is_enabled=false must NOT remove it — it is not a pool spread.
    const choices: RemixPoolSpreadChoice[] = [{ spread_id: 'p', is_enabled: false }];
    expect(filterPoolSpreads(ordered, choices).map((s) => s.id)).toEqual(['p']);
  });

  it('preserves relative order after filtering', () => {
    const ordered = [
      sp('a'),
      poolSpread('p1', { is_true: true, is_default: false }),
      sp('b'),
      poolSpread('p2', { is_true: true, is_default: false }),
      sp('c'),
    ];
    const choices: RemixPoolSpreadChoice[] = [
      { spread_id: 'p1', is_enabled: false },
      { spread_id: 'p2', is_enabled: true },
    ];
    expect(filterPoolSpreads(ordered, choices).map((s) => s.id)).toEqual(['a', 'b', 'p2', 'c']);
  });
});

// ── P3: walk-BEFORE-filter — pool spread that is ALSO a branch spread ──────────

describe('filterPoolSpreads — P3 walk-before-filter', () => {
  it('an excluded pool spread that is also a branch spread still resolves its branch; later spreads survive', () => {
    // s1 is a branch spread (default → sec_a start sA) AND a pool spread. When it
    // is excluded, its branch must STILL be walked so sA/sB remain in the output.
    const spreads = [
      sp('s1', {
        branch_setting: { branches: [{ section_id: 'sec_a', is_default: true }] },
        pool: { is_true: true, is_default: false },
      }),
      sp('sA'),
      sp('sB'),
    ];
    const sections = [section('sec_a', 'sA', 'sA', 'sB')];

    // 1) walk resolves the branch topology fully.
    const path = resolveRemixSpreadPath(spreads, sections, []);
    expect(ids(path)).toEqual(['s1', 'sA', 'sB']);

    // 2) filter drops only s1 from the OUTPUT list; sA/sB reached via s1's branch survive.
    const choices: RemixPoolSpreadChoice[] = [{ spread_id: 's1', is_enabled: false }];
    expect(filterPoolSpreads(path.ordered, choices).map((s) => s.id)).toEqual(['sA', 'sB']);
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
