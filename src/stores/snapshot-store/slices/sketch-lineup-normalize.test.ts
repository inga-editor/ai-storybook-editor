// Lineup tabs read boundary (2026-07-25): coerceLineupTabs (fail-open coercer) + the
// normalizeSketch/coerceSketchNode branches. Pure — no jsdom/store needed.
import { describe, it, expect } from 'vitest';

import { coerceLineupTabs } from './sketch-coerce-helpers';
import { normalizeSketch, coerceSketchNode } from './sketch-normalize';
import type { SketchAnomaly } from './sketch-resource-registry';
import type { SketchLineupTab } from '@/types/sketch';

const tab = (id: string, over: Partial<SketchLineupTab> = {}): SketchLineupTab => ({
  id,
  name: `Tab ${id}`,
  entries: [],
  ...over,
});

const entry = (kind: 'characters' | 'props', entity_key: string, variant_key = 'base') => ({
  kind,
  entity_key,
  variant_key,
});

describe('coerceLineupTabs', () => {
  it('ABSENT (null/undefined) → [] with NO anomaly', () => {
    const anomalies: SketchAnomaly[] = [];
    expect(coerceLineupTabs(null, (a) => anomalies.push(a))).toEqual([]);
    expect(coerceLineupTabs(undefined, (a) => anomalies.push(a))).toEqual([]);
    expect(anomalies).toEqual([]);
  });

  it("non-array container → [] + ONE cls:'report' anomaly under the coarse 'sketch' key", () => {
    const anomalies: SketchAnomaly[] = [];
    expect(coerceLineupTabs({ nope: true }, (a) => anomalies.push(a))).toEqual([]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].cls).toBe('report'); // NEVER 'reset' — 'sketch' reset blocks every step-1 write
    expect(anomalies[0].resource).toBe('sketch');
  });

  it('drops garbage elements without any anomaly (fail-open)', () => {
    const anomalies: SketchAnomaly[] = [];
    const out = coerceLineupTabs(
      [tab('t1'), 42, null, { name: 'no id' }, { id: '', name: 'empty id' }, { id: 't2' }],
      (a) => anomalies.push(a),
    );
    // {id:'t2'} has no string name → dropped too.
    expect(out.map((t) => t.id)).toEqual(['t1']);
    expect(anomalies).toEqual([]);
  });

  it('whitelists entry fields, keeps append order, and dedupes by (kind, entity_key, variant_key)', () => {
    const rawEntries: unknown[] = [
      entry('characters', 'elara'),
      entry('props', 'wand'),
      entry('characters', 'elara'), // exact dup → dropped (keep FIRST)
      { kind: 'stages', entity_key: 'x', variant_key: 'base' }, // bad kind → dropped
      { kind: 'props', entity_key: 7, variant_key: 'base' }, // bad entity_key type → dropped
      { ...entry('characters', 'elara', 'winter'), extra_field: 'stripped' },
    ];
    const out = coerceLineupTabs([{ ...tab('t1'), entries: rawEntries }]);
    expect(out[0].entries).toEqual([
      entry('characters', 'elara'),
      entry('props', 'wand'),
      entry('characters', 'elara', 'winter'),
    ]);
  });

  it('SAME entity/variant key across kinds are DISTINCT entries (kind in the dedupe key)', () => {
    const out = coerceLineupTabs([
      tab('t1', { entries: [entry('characters', 'armor'), entry('props', 'armor')] }),
    ]);
    expect(out[0].entries).toHaveLength(2);
  });

  it('keeps DANGLING entries (schema-valid — render-time skip is the contract)', () => {
    const out = coerceLineupTabs([
      tab('t1', { entries: [entry('characters', 'deleted_entity', 'gone_variant')] }),
    ]);
    expect(out[0].entries).toHaveLength(1);
  });

  it('dedupes duplicate tab ids (keep first) and trims + clamps name to 60 chars', () => {
    const out = coerceLineupTabs([
      tab('t1', { name: '  padded  ' }),
      tab('t1', { name: 'dup — dropped' }),
      tab('t2', { name: 'x'.repeat(80) }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(out[0].name).toBe('padded');
    expect(out[1].name).toHaveLength(60);
  });
});

describe('normalizeSketch — lineups branch', () => {
  it('round-trip: a snapshot WITH lineups loads them intact (whitelist survival)', () => {
    const anomalies: SketchAnomaly[] = [];
    const s = normalizeSketch(
      { lineups: [tab('t1', { entries: [entry('characters', 'elara')] }), tab('t2')] },
      (a) => anomalies.push(a),
    );
    expect(s.lineups.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(s.lineups[0].entries).toEqual([entry('characters', 'elara')]);
    expect(anomalies).toEqual([]);
  });

  it('a snapshot WITHOUT lineups → [] and NO anomaly (old books load clean)', () => {
    const anomalies: SketchAnomaly[] = [];
    const s = normalizeSketch({ characters: [], spreads: [] }, (a) => anomalies.push(a));
    expect(s.lineups).toEqual([]);
    expect(anomalies).toEqual([]);
  });

  it("malformed lineups → [] + cls:'report' ONLY — no 'reset' anomaly is ever emitted", () => {
    const anomalies: SketchAnomaly[] = [];
    const s = normalizeSketch({ lineups: 'garbage' }, (a) => anomalies.push(a));
    expect(s.lineups).toEqual([]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].cls).toBe('report');
    // No reset ⇒ loadSketch never marks sketchDegraded ⇒ step-1 writes stay unblocked.
    expect(anomalies.some((a) => a.cls === 'reset')).toBe(false);
  });
});

describe('coerceSketchNode — [lineups] branch', () => {
  it("path ['lineups'] coerces the whole array (peer merge validated)", () => {
    const out = coerceSketchNode(['lineups'], [tab('t1'), 'garbage']) as SketchLineupTab[];
    expect(out.map((t) => t.id)).toEqual(['t1']);
  });

  it('null passes through (remove semantics — caller skips structural deletes)', () => {
    expect(coerceSketchNode(['lineups'], null)).toBeNull();
  });

  it('deeper paths pass through untouched (only the array grain is addressable)', () => {
    const v = { anything: true };
    expect(coerceSketchNode(['lineups', '0'], v)).toBe(v);
  });
});
