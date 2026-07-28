// Pure multi-tab helpers (2026-07-25): ref minting, payload builders (the exact entries[] each
// write hands the store), and the deterministic default tab name. No React/jsdom needed.
import { describe, it, expect } from 'vitest';
import type { BaseKind, LineupEntry, SketchLineupEntry, SketchLineupTab } from '@/types/sketch';
import { lineupEntryRef, lineupPersistKind } from '@/types/sketch';
import {
  ALL_KINDS,
  DEFAULT_EXPANDED_GROUPS,
  KIND_GROUPS,
  LINEUP_WIRED_KINDS,
  buildCleanupEntries,
  buildToggleAllEntries,
  buildToggleEntries,
  grantKeyOf,
  nextTabName,
  refOf,
  toTabEntry,
} from './lineup-constants';
import { KIND_GROUPS as BASE_KIND_GROUPS } from '../sketch-base-creative-space/sketch-base-constants';
import { LINEUP_ENTRY_KINDS } from '@/stores/snapshot-store/slices/sketch-coerce-helpers';
import { STEP_RESOURCES } from '../collaborators-creative-space/collaboration-space-types';

// The lineup sidebar used to re-export the BASE space's KIND_GROUPS verbatim, so adding the third
// base group (Alter Character, 2026-07-28) silently rendered an alter group HERE too — ungranted
// even for the book owner, and excluded from `allEntries`, i.e. a group that shows a false "no edit
// rights" message and silently drops whatever is checked in it. Phase 07 wired the kind for real:
// these tests now pin that EVERY seam moved together, and that the wire vocabulary did NOT.
describe('lineup KIND_GROUPS — only kinds this space has fully wired', () => {
  it('renders exactly the wired kinds, alter INCLUDED and LAST (base-space order)', () => {
    expect(LINEUP_WIRED_KINDS).toContain('alter_characters');
    expect(KIND_GROUPS.map((g) => g.kind)).toEqual(['characters', 'props', 'alter_characters']);
    // Derived from the base groups (not a second hand-written list) → order can never drift.
    expect(KIND_GROUPS.map((g) => g.kind)).toEqual(
      BASE_KIND_GROUPS.filter((g) => LINEUP_WIRED_KINDS.includes(g.kind)).map((g) => g.kind),
    );
  });

  it('ALL_KINDS (what the OWNER may edit) covers every rendered group', () => {
    // A group missing here renders "You do not have edit rights" TO THE BOOK OWNER.
    for (const g of KIND_GROUPS) expect(ALL_KINDS.has(g.kind)).toBe(true);
    expect(ALL_KINDS.size).toBe(KIND_GROUPS.length);
  });

  it('every rendered group PERSISTS as a kind the entry coercer keeps on reload', () => {
    // A group whose PERSIST kind is missing from LINEUP_ENTRY_KINDS would let the user check rows
    // that vanish on the next snapshot load. Note the asymmetry: the UI knows 3 kinds, the wire
    // vocabulary stays 2 — so this is asserted through `lineupPersistKind`, not on `g.kind`.
    for (const g of KIND_GROUPS) expect(LINEUP_ENTRY_KINDS).toContain(lineupPersistKind(g.kind));
    expect(LINEUP_ENTRY_KINDS).toEqual(['characters', 'props']); // NOT widened
    expect(LINEUP_ENTRY_KINDS).not.toContain('alter_characters');
  });

  it('every rendered group has an expand-state key and a REAL collaborator grant key', () => {
    // The grant key is a key of `access_rights.steps.sketch.resources` — a DIFFERENT vocabulary
    // from LINEUP_ENTRY_KINDS (they only happen to overlap). An unknown key silently reads
    // `undefined` → the group greys out for every collaborator.
    for (const g of KIND_GROUPS) {
      expect(DEFAULT_EXPANDED_GROUPS[g.kind]).toBe(true);
      expect(STEP_RESOURCES.sketch).toContain(grantKeyOf(g.kind));
    }
    expect(grantKeyOf('alter_characters')).toBe('characters'); // alter rides the characters grant
  });

  it('reuses the base labels (no drift between the two sidebars)', () => {
    for (const g of KIND_GROUPS) {
      expect(g).toEqual(BASE_KIND_GROUPS.find((b) => b.kind === g.kind));
    }
  });
});

const view = (kind: BaseKind, entityKey: string, variantKey = 'base', over: Partial<LineupEntry> = {}): LineupEntry => ({
  kind,
  entityKey,
  variantKey,
  ref: lineupEntryRef(kind, entityKey, variantKey),
  imageUrl: 'crop.png',
  heightCm: 100,
  ...over,
});

const persisted = (kind: 'characters' | 'props', entity_key: string, variant_key = 'base'): SketchLineupEntry => ({
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

  it('kind qualifies the ref — same entity/variant key across kinds never collides', () => {
    expect(refOf(persisted('characters', 'armor'))).not.toBe(refOf(persisted('props', 'armor')));
  });
});

// ── UI knows 3 kinds · the snapshot stores 2 ────────────────────────────────────────────────────
// The rtype-12 vocabulary is `LINEUP_ENTRY_KINDS` = ['characters','props']. Writing the UI kind
// would make the coercer DROP the entry on the next load (silent data loss); minting the ref from
// the UI kind would make a checked alter row stop matching its own persisted entry after reload.
describe('alter characters — persist as `characters`, still group as alter', () => {
  it('toTabEntry narrows alter_characters → characters (wire vocabulary)', () => {
    expect(toTabEntry(view('alter_characters', 'elara_alt', 'fairy'))).toEqual({
      kind: 'characters',
      entity_key: 'elara_alt',
      variant_key: 'fairy',
    });
  });

  it('every kind the UI can render persists to a value the coercer keeps', () => {
    for (const kind of LINEUP_WIRED_KINDS) {
      expect(LINEUP_ENTRY_KINDS).toContain(toTabEntry(view(kind, 'e')).kind);
    }
  });

  it('an alter ROW and its PERSISTED entry resolve to the SAME ref (survives a reload)', () => {
    const row = view('alter_characters', 'elara_alt', 'fairy');
    expect(row.ref).toBe('characters:@elara_alt/fairy'); // minted in the PERSIST vocabulary
    expect(refOf(toTabEntry(row))).toBe(row.ref);
  });

  it('unchecking an alter row removes it (ref match), instead of appending a duplicate', () => {
    const row = view('alter_characters', 'elara_alt');
    const base = buildToggleEntries([], row, true);
    expect(base).toEqual([{ kind: 'characters', entity_key: 'elara_alt', variant_key: 'base' }]);
    expect(buildToggleEntries(base, row, false)).toEqual([]);
  });

  it('select-all does not re-add an already-checked alter row (no duplicate member)', () => {
    const alter = view('alter_characters', 'elara_alt');
    const prop = view('props', 'wand');
    const base = [toTabEntry(alter)];
    expect(buildToggleAllEntries(base, [alter, prop], true)).toEqual([
      toTabEntry(alter),
      toTabEntry(prop),
    ]);
  });

  it('cleanup keeps an alter member that still resolves to a selectable row', () => {
    const alter = view('alter_characters', 'elara_alt');
    expect(buildCleanupEntries([toTabEntry(alter)], [alter])).toEqual([toTabEntry(alter)]);
  });

  it('a story character and an alter never share a ref (entity keys are unique in the array)', () => {
    expect(view('characters', 'elara').ref).not.toBe(view('alter_characters', 'elara_alt').ref);
    // …but the two kinds DO share the prefix — that is the point: the wire cannot tell them apart,
    // the entity key can, and the alter/story split is re-derived from `actor_role` on read.
    expect(view('alter_characters', 'x').ref.startsWith('characters:')).toBe(true);
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
