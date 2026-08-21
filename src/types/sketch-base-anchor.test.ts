// sketch-base-anchor.test.ts — `firstConfirmedBaseAnchor`: the pure resolver that surfaces the
// first earlier-confirmed base group's locked raw sheet as a MANDATORY style anchor (injected into
// the base + stage generate modals so a later group / a stage can't drift off the established look).
import { describe, it, expect } from 'vitest';
import { firstConfirmedBaseAnchor } from './sketch';
import type { BaseGroup, SketchBase, SketchBaseStyle } from './sketch';

const group = (group_key: string, kind: BaseGroup['kind'], order?: number): BaseGroup => ({
  group_key,
  kind,
  name: group_key,
  order,
});

const style = (is_selected: boolean, url: string | null): SketchBaseStyle => ({
  style_prompt: '',
  is_selected,
  image_references: [],
  illustrations: url ? [{ media_url: url, is_selected: true } as never] : [],
  crops: [],
});

const sheet = (styles: SketchBaseStyle[]) => ({ styles });

describe('firstConfirmedBaseAnchor', () => {
  it('returns null when no group has a locked style', () => {
    const groups = [group('character_1', 'characters', 0)];
    const base: SketchBase = { character_1: sheet([style(false, 'x.png')]) };
    expect(firstConfirmedBaseAnchor(groups, base)).toBeNull();
  });

  it('returns the confirmed group locked sheet url', () => {
    const groups = [group('character_1', 'characters', 0)];
    const base: SketchBase = { character_1: sheet([style(true, 'sheet.png')]) };
    expect(firstConfirmedBaseAnchor(groups, base)).toEqual({
      groupKey: 'character_1',
      name: 'character_1',
      mediaUrl: 'sheet.png',
    });
  });

  it('picks the FIRST group in list order (chars before props), skipping unconfirmed', () => {
    // buildBaseGroups already sorts chars→props then by order; the resolver honours that order.
    const groups = [
      group('character_1', 'characters', 0), // not confirmed → skipped
      group('character_2', 'characters', 1), // first confirmed → wins
      group('prop_1', 'props', 0),
    ];
    const base: SketchBase = {
      character_1: sheet([style(false, 'c1.png')]),
      character_2: sheet([style(true, 'c2.png')]),
      prop_1: sheet([style(true, 'p1.png')]),
    };
    expect(firstConfirmedBaseAnchor(groups, base)?.mediaUrl).toBe('c2.png');
  });

  it('excludes the current group so a regenerate never anchors to itself', () => {
    const groups = [
      group('character_1', 'characters', 0),
      group('character_2', 'characters', 1),
    ];
    const base: SketchBase = {
      character_1: sheet([style(true, 'c1.png')]),
      character_2: sheet([style(true, 'c2.png')]),
    };
    // Regenerating character_1 → its own confirmed sheet is skipped, falls through to character_2.
    expect(firstConfirmedBaseAnchor(groups, base, 'character_1')?.mediaUrl).toBe('c2.png');
  });

  it('skips a confirmed style with no usable illustration', () => {
    const groups = [
      group('character_1', 'characters', 0),
      group('character_2', 'characters', 1),
    ];
    const base: SketchBase = {
      character_1: sheet([style(true, null)]), // confirmed but empty illustrations → not usable
      character_2: sheet([style(true, 'c2.png')]),
    };
    expect(firstConfirmedBaseAnchor(groups, base)?.mediaUrl).toBe('c2.png');
  });
});
