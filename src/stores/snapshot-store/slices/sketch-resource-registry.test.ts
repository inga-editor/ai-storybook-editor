// sketch-resource-registry.test.ts — predicate mapping: every SketchResourceKey must block
// exactly the LockTargets that write into its subtree (ADR-047 phase-01 acceptance).

import { describe, it, expect } from 'vitest';
import {
  resourceKeyToLockPredicate,
  describeResource,
  describeResetImpact,
  type SketchResourceKey,
} from './sketch-resource-registry';
import type { LockTarget, ResourceType, Step } from '@/stores/resource-lock-store/types';

const t = (step: Step, rtype: ResourceType, rid: string, locale: string | null = null): LockTarget => ({
  step,
  resource_type: rtype,
  resource_id: rid,
  locale,
});

describe('resourceKeyToLockPredicate', () => {
  it("'sketch' (root coarse) blocks EVERY step-1 write, none at other steps", () => {
    const p = resourceKeyToLockPredicate('sketch');
    for (const rtype of [1, 2, 3, 4, 5, 6, 11] as const) {
      expect(p(t(1, rtype, 'anything'))).toBe(true);
    }
    expect(p(t(2, 6, 'sp-1'))).toBe(false); // illustration scene
    expect(p(t(3, 10, 'sp-1'))).toBe(false); // retouch
  });

  it('sheet keys match rtype 11 with the exact sheet resource_id only', () => {
    const p = resourceKeyToLockPredicate('base.character_sheet');
    expect(p(t(1, 11, 'character_sheet'))).toBe(true);
    expect(p(t(1, 11, 'prop_sheet'))).toBe(false);
    expect(p(t(1, 3, 'character_sheet'))).toBe(false); // same id, wrong rtype
    expect(p(t(2, 11, 'character_sheet'))).toBe(false); // wrong step

    const pp = resourceKeyToLockPredicate('base.prop_sheet');
    expect(pp(t(1, 11, 'prop_sheet'))).toBe(true);
    expect(pp(t(1, 11, 'character_sheet'))).toBe(false);
  });

  it.each([
    ['characters', 3],
    ['props', 4],
    ['stages', 5],
  ] as const)("node-grain '%s/hero' matches only that entity", (kind, rtype) => {
    const p = resourceKeyToLockPredicate(`${kind}/hero` as SketchResourceKey);
    expect(p(t(1, rtype as ResourceType, 'hero'))).toBe(true);
    expect(p(t(1, rtype as ResourceType, 'villain'))).toBe(false); // sibling isolated
    expect(p(t(1, 6, 'hero'))).toBe(false); // wrong rtype
  });

  it.each([
    ['characters', 3],
    ['props', 4],
    ['stages', 5],
  ] as const)("collection-grain '%s' (coarse) blocks EVERY entity of that rtype", (kind, rtype) => {
    const p = resourceKeyToLockPredicate(kind as SketchResourceKey);
    expect(p(t(1, rtype as ResourceType, 'hero'))).toBe(true);
    expect(p(t(1, rtype as ResourceType, 'villain'))).toBe(true);
    // ...but NOT the other kinds (isolation between collections).
    const otherRtype = rtype === 3 ? 4 : 3;
    expect(p(t(1, otherRtype as ResourceType, 'hero'))).toBe(false);
  });

  it("'spreads/{id}' matches that spread (rtype 6) AND coarsely every rtype 1/2 child write", () => {
    const p = resourceKeyToLockPredicate('spreads/sp-1');
    expect(p(t(1, 6, 'sp-1'))).toBe(true);
    expect(p(t(1, 6, 'sp-2'))).toBe(false); // sibling spread isolated at rtype 6
    // rtype 1/2 carry CHILD ids — unattributable → blocked coarsely (fail-safe).
    expect(p(t(1, 1, 'image-uuid'))).toBe(true);
    expect(p(t(1, 2, 'textbox-uuid', 'en'))).toBe(true);
    expect(p(t(1, 3, 'hero'))).toBe(false); // entities untouched
    expect(p(t(1, 11, 'character_sheet'))).toBe(false);
  });

  it("'spreads/{id}' ALSO blocks the whole-collection 'spreads' sentinel (Excel import replace-all)", () => {
    const p = resourceKeyToLockPredicate('spreads/sp-1');
    // The replace-all import writes rtype 6 with resource_id 'spreads' — it would overwrite the
    // quarantined spread without consent, so a node-grain degraded spread must block it.
    expect(p(t(1, 6, 'spreads'))).toBe(true);
  });

  it("'spreads' (coarse) blocks rtype 6 + 1 + 2, any id", () => {
    const p = resourceKeyToLockPredicate('spreads');
    expect(p(t(1, 6, 'anything'))).toBe(true);
    expect(p(t(1, 1, 'img'))).toBe(true);
    expect(p(t(1, 2, 'tb', 'vi'))).toBe(true);
    expect(p(t(1, 5, 'forest'))).toBe(false);
  });

  it('full rtype coverage: every step-1 rtype (1,2,3,4,5,6,11) is blockable by SOME key', () => {
    const keys: SketchResourceKey[] = [
      'base.character_sheet',
      'characters',
      'props',
      'stages',
      'spreads',
    ];
    // Realistic resource_id per rtype (11 is only ever a sheet id).
    const RID: Record<number, string> = { 1: 'img', 2: 'tb', 3: 'e', 4: 'e', 5: 'e', 6: 'sp', 11: 'character_sheet' };
    for (const rtype of [1, 2, 3, 4, 5, 6, 11] as const) {
      const covered = keys.some((k) => resourceKeyToLockPredicate(k)(t(1, rtype, RID[rtype])));
      expect(covered, `rtype ${rtype} must be blockable`).toBe(true);
    }
  });
});

describe('describeResource / describeResetImpact (modal copy)', () => {
  it('labels every key shape in Vietnamese', () => {
    expect(describeResource('base.character_sheet')).toContain('character_sheet');
    expect(describeResource('characters/hero')).toContain('"hero"');
    expect(describeResource('spreads/sp-1')).toContain('"sp-1"');
    expect(describeResource('props')).toContain('Danh sách');
  });

  it('impact copy states exactly WHAT a reset destroys', () => {
    expect(describeResetImpact('base.character_sheet')).toContain('xoá toàn bộ style');
    expect(describeResetImpact('characters/hero')).toContain('"hero"');
    expect(describeResetImpact('sketch')).toContain('TOÀN BỘ');
  });
});
