// Pure multi-tab helpers (2026-07-25): ref minting, payload builders (the exact entries[] each
// write hands the store), and the deterministic default tab name. No React/jsdom needed.
//
// ⚡REV 2026-08-21 — DYNAMIC GROUPS: the sidebar is N groups (useSketchBaseGroups), not a fixed
// 3-kind list. The old `KIND_GROUPS`/`LINEUP_WIRED_KINDS`/`ALL_KINDS` seams and the
// alter→characters narrowing are gone. A group's `kind` (`characters` | `props`) IS the persist
// vocabulary, so these tests pin that the grant key is the kind itself AND that the rtype-12 wire
// vocabulary is STILL the two real collections (never widened).
import { describe, it, expect } from 'vitest';
import type { LineupEntry, SheetKind, SketchLineupEntry, SketchLineupTab } from '@/types/sketch';
import { lineupEntryRef } from '@/types/sketch';
import {
  buildCleanupEntries,
  buildToggleAllEntries,
  buildToggleEntries,
  grantKeyOf,
  nextTabName,
  refOf,
  toTabEntry,
} from './lineup-constants';
import { LINEUP_ENTRY_KINDS } from '@/stores/snapshot-store/slices/sketch-coerce-helpers';
import { STEP_RESOURCES } from '../collaborators-creative-space/collaboration-space-types';

const LINEUP_KINDS: SheetKind[] = ['characters', 'props'];

describe('lineup grant keys + wire vocabulary (dynamic groups)', () => {
  it('grantKeyOf is the kind itself — a REAL collaborator grant key (STEP_RESOURCES.sketch)', () => {
    // The grant key is a key of `access_rights.steps.sketch.resources`. An unknown key silently
    // reads `undefined` → the group greys out for every collaborator.
    for (const kind of LINEUP_KINDS) {
      expect(grantKeyOf(kind)).toBe(kind);
      expect(STEP_RESOURCES.sketch).toContain(grantKeyOf(kind));
    }
  });

  it('the rtype-12 wire vocabulary is the two real collections — NOT widened', () => {
    // Every group PERSISTS its kind verbatim; that kind must be one the entry coercer keeps on
    // reload, or checked rows would vanish on the next snapshot load.
    for (const kind of LINEUP_KINDS) expect(LINEUP_ENTRY_KINDS).toContain(kind);
    expect(LINEUP_ENTRY_KINDS).toEqual(['characters', 'props']); // NOT widened
    expect(LINEUP_ENTRY_KINDS).not.toContain('alter_characters');
  });
});

const view = (kind: SheetKind, entityKey: string, variantKey = 'base', over: Partial<LineupEntry> = {}): LineupEntry => ({
  kind,
  entityKey,
  variantKey,
  ref: lineupEntryRef(kind, entityKey, variantKey),
  imageUrl: 'crop.png',
  heightCm: 100,
  ...over,
});

const persisted = (kind: SheetKind, entity_key: string, variant_key = 'base'): SketchLineupEntry => ({
  kind,
  entity_key,
  variant_key,
});

const tab = (id: string, name: string): SketchLineupTab => ({ id, name, entries: [] });

describe('refOf / toTabEntry', () => {
  it('refOf mints the EXACT selector ref format (round-trip through toTabEntry)', () => {
    const v = view('props', 'wand', 'lit');
    expect(refOf(toTabEntry(v))).toBe(v.ref);
  });

  it('toTabEntry carries the group kind straight through (no narrowing)', () => {
    expect(toTabEntry(view('props', 'wand', 'lit'))).toEqual({
      kind: 'props',
      entity_key: 'wand',
      variant_key: 'lit',
    });
    expect(toTabEntry(view('characters', 'elara'))).toEqual({
      kind: 'characters',
      entity_key: 'elara',
      variant_key: 'base',
    });
  });

  it('kind qualifies the ref — same entity/variant key across kinds never collides', () => {
    expect(refOf(persisted('characters', 'armor'))).not.toBe(refOf(persisted('props', 'armor')));
    expect(view('characters', 'armor').ref).not.toBe(view('props', 'armor').ref);
  });

  it('a checked row and its persisted entry resolve to the SAME ref (survives a reload)', () => {
    const row = view('characters', 'elara', 'fairy');
    expect(row.ref).toBe('characters:@elara/fairy');
    expect(refOf(toTabEntry(row))).toBe(row.ref);
  });
});

describe('buildToggleEntries', () => {
  const base = [persisted('characters', 'elara'), persisted('props', 'wand')];

  it('check appends at the END (membership is append-order)', () => {
    const next = buildToggleEntries(base, view('characters', 'kip'), true);
    expect(next.map(refOf)).toEqual([
      'characters:@elara/base',
      'props:@wand/base',
      'characters:@kip/base',
    ]);
  });

  it('uncheck removes by kind-qualified ref — the other kind\'s twin survives', () => {
    const twins = [persisted('characters', 'armor'), persisted('props', 'armor')];
    const next = buildToggleEntries(twins, view('characters', 'armor'), false);
    expect(next).toEqual([persisted('props', 'armor')]);
  });
});

describe('buildToggleAllEntries', () => {
  const dangling = persisted('characters', 'deleted_entity');

  it('check adds every missing selectable (sidebar order) after the existing members', () => {
    const base = [dangling, persisted('characters', 'elara')];
    const sidebar = [view('characters', 'elara'), view('characters', 'kip'), view('props', 'wand')];
    const next = buildToggleAllEntries(base, sidebar, true);
    expect(next.map(refOf)).toEqual([
      'characters:@deleted_entity/base', // kept — dangling is never auto-pruned
      'characters:@elara/base', // already a member — not duplicated
      'characters:@kip/base',
      'props:@wand/base',
    ]);
  });

  it('uncheck drops ONLY selectable members — dangling KEPT (spec: no auto-prune)', () => {
    const base = [dangling, persisted('characters', 'elara'), persisted('props', 'wand')];
    const sidebar = [view('characters', 'elara'), view('props', 'wand')];
    const next = buildToggleAllEntries(base, sidebar, false);
    expect(next).toEqual([dangling]);
  });
});

describe('buildCleanupEntries', () => {
  it('keeps ONLY members that resolve to a selectable row (everything the chip counts is dropped)', () => {
    const base = [
      persisted('characters', 'deleted_entity'), // unresolvable → dropped
      persisted('characters', 'elara'), // selectable → kept
      persisted('props', 'no_crop'), // resolvable but NOT selectable → dropped (cannot render)
    ];
    const selectableRows = [view('characters', 'elara')];
    expect(buildCleanupEntries(base, selectableRows)).toEqual([persisted('characters', 'elara')]);
  });
});

describe('nextTabName', () => {
  it('seeds at count+1 ("Lineup 2" after the first tab)', () => {
    expect(nextTabName([tab('t1', 'Lineup')])).toBe('Lineup 2');
  });

  it('bumps past collisions deterministically (Cancel + reopen gives the same suggestion)', () => {
    const tabs = [tab('t1', 'Lineup'), tab('t2', 'Lineup 3')];
    expect(nextTabName(tabs)).toBe('Lineup 4'); // 3 taken → 4
    expect(nextTabName(tabs)).toBe('Lineup 4'); // deterministic on the same input
  });

  it('custom names never collide → plain count+1', () => {
    expect(nextTabName([tab('t1', 'Winter cast'), tab('t2', 'Summer')])).toBe('Lineup 3');
  });
});
