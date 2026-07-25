// sketch-image-modal-adapters.test.ts — unit tests for the pure sketch↔shared-modal adapters.
// These guard the field mapping + the duplicate-version guard that keep Edit/Extract commits from
// appending stray page-image versions.

import { describe, it, expect } from 'vitest';
import {
  toIllustrations,
  classifyEditCommit,
  toSpreadImage,
} from './sketch-image-modal-adapters';
import type { SketchSpreadIllustration, SketchSpreadImage } from '@/types/sketch';
import type { Illustration } from '@/types/prop-types';
// Real modal-side helpers (pure) — the round-trip suite below wires them to the adapters so the
// two directions are asserted against the ACTUAL writer/reader, not a re-implementation.
import {
  prependVersion,
  resolveAiRequestId,
} from '@/features/editor/components/shared-components/edit-image-modal/edit-image-modal-utils';

const illus = (media_url: string, is_selected: boolean): SketchSpreadIllustration => ({
  media_url,
  created_time: '2026-07-04T00:00:00.000Z',
  is_selected,
});

describe('toIllustrations', () => {
  it('maps media_url/created_time/is_selected field-for-field, preserving order', () => {
    const src = [illus('a.png', false), illus('b.png', true)];
    const out = toIllustrations(src);
    expect(out).toEqual([
      { media_url: 'a.png', created_time: '2026-07-04T00:00:00.000Z', is_selected: false },
      { media_url: 'b.png', created_time: '2026-07-04T00:00:00.000Z', is_selected: true },
    ]);
  });

  // ⚡ Provenance copy-through (GAP as-built #18): the sketch entry IS a full Illustration Entry
  // (DB-CHANGELOG 2026-07-23) — dropping these pinned the Inpaint reference picker at 'idle'.
  it('copies provenance through: type / original_url / ai_request_id', () => {
    const out = toIllustrations([
      {
        ...illus('edited.png', true),
        type: 'edited',
        original_url: 'gen.png',
        ai_request_id: 'req-1',
      },
    ]);
    expect(out[0]).toEqual({
      media_url: 'edited.png',
      created_time: '2026-07-04T00:00:00.000Z',
      is_selected: true,
      type: 'edited',
      original_url: 'gen.png',
      ai_request_id: 'req-1',
    });
  });

  // NOTE (by design): this case asserts the CURRENT generate-output shape (no `type`). It must be
  // updated in the same commit as the deferred "generate writes type:'created'" follow-up.
  it('copies ai_request_id alone (raw generate output has no type/original_url)', () => {
    const out = toIllustrations([{ ...illus('gen.png', true), ai_request_id: 'req-2' }]);
    expect(out[0].ai_request_id).toBe('req-2');
    expect('type' in out[0]).toBe(false);
    expect('original_url' in out[0]).toBe(false);
  });

  // omit-if-absent: a missing source field must stay MISSING, not become an `undefined` key —
  // an `undefined` key would land in the snapshot JSONB as an explicit null-ish field.
  it('omits absent provenance keys entirely (no `undefined` values written)', () => {
    const out = toIllustrations([illus('a.png', true)]);
    expect('type' in out[0]).toBe(false);
    expect('original_url' in out[0]).toBe(false);
    expect('ai_request_id' in out[0]).toBe(false);
  });

  it('returns [] for []', () => {
    expect(toIllustrations([])).toEqual([]);
  });
});

describe('classifyEditCommit', () => {
  it('append: the is_selected illustration url is genuinely new', () => {
    const next = [
      { media_url: 'old.png', created_time: 't', is_selected: false },
      { media_url: 'new.png', created_time: 't', is_selected: true },
    ];
    expect(classifyEditCommit(next, ['old.png'])).toEqual({ kind: 'append', url: 'new.png' });
  });

  it('falls back to the first entry when none is selected', () => {
    const next = [
      { media_url: 'first.png', created_time: 't', is_selected: false },
      { media_url: 'second.png', created_time: 't', is_selected: false },
    ];
    expect(classifyEditCommit(next, [])).toEqual({ kind: 'append', url: 'first.png' });
  });

  it('noop on empty list', () => {
    expect(classifyEditCommit([], ['cur.png'])).toEqual({ kind: 'noop' });
  });

  it('select: the selected url equals the current head version (re-selection, not a dup append)', () => {
    const next = [{ media_url: 'same.png', created_time: 't', is_selected: true }];
    expect(classifyEditCommit(next, ['same.png'])).toEqual({ kind: 'select', url: 'same.png' });
  });

  it('select: re-selecting an OLDER existing variant flips selection instead of appending', () => {
    // Modal emits onUpdateIllustrations with v1 re-selected while v3 is the current head.
    const next = [{ media_url: 'v1.png', created_time: 't', is_selected: true }];
    expect(classifyEditCommit(next, ['v3.png', 'v2.png', 'v1.png'])).toEqual({
      kind: 'select',
      url: 'v1.png',
    });
  });

  it('append: the url is new to the version list', () => {
    const next = [{ media_url: 'fresh.png', created_time: 't', is_selected: true }];
    expect(classifyEditCommit(next, ['stale.png', 'older.png'])).toEqual({
      kind: 'append',
      url: 'fresh.png',
    });
  });

  // ⚡ Write direction: the append branch carries the committed entry's provenance so the store
  // write can persist it (aiRequestId + type + originalUrl → Compare toggle + §8.3 chain).
  it('append: carries all 3 provenance fields off the committed entry', () => {
    const next: Illustration[] = [
      {
        media_url: 'new.png',
        created_time: 't',
        is_selected: true,
        type: 'edited',
        original_url: 'gen.png',
        ai_request_id: 'req-9',
      },
      { media_url: 'gen.png', created_time: 't', is_selected: false, ai_request_id: 'req-1' },
    ];
    expect(classifyEditCommit(next, ['gen.png'])).toEqual({
      kind: 'append',
      url: 'new.png',
      aiRequestId: 'req-9',
      type: 'edited',
      originalUrl: 'gen.png',
    });
  });

  it('append: omits provenance keys the entry lacks (erasor commit → type/originalUrl only)', () => {
    const next: Illustration[] = [
      { media_url: 'erased.png', created_time: 't', is_selected: true, type: 'edited', original_url: 'src.png' },
    ];
    const commit = classifyEditCommit(next, ['src.png']);
    expect(commit).toEqual({
      kind: 'append',
      url: 'erased.png',
      type: 'edited',
      originalUrl: 'src.png',
    });
    expect('aiRequestId' in commit).toBe(false);
  });

  it('select: carries NO provenance (re-selection must not rewrite an existing version)', () => {
    const next: Illustration[] = [
      {
        media_url: 'v1.png',
        created_time: 't',
        is_selected: true,
        type: 'edited',
        original_url: 'v0.png',
        ai_request_id: 'req-1',
      },
    ];
    // Exact-equality: any extra provenance key here would be a regression.
    expect(classifyEditCommit(next, ['v1.png'])).toEqual({ kind: 'select', url: 'v1.png' });
  });

  it('noop: carries NO provenance', () => {
    expect(classifyEditCommit([], [])).toEqual({ kind: 'noop' });
  });
});

describe('toSpreadImage', () => {
  const sketchImg: SketchSpreadImage = {
    id: 'img-1',
    type: 'right',
    illustrations: [illus('v1.png', true)],
  };
  const geom = { x: 50, y: 0, w: 50, h: 100 };

  it('synthesizes id/geometry/media_url/illustrations for the crop tab', () => {
    const out = toSpreadImage(sketchImg, geom, 'v1.png');
    expect(out.id).toBe('img-1');
    expect(out.geometry).toEqual(geom);
    expect(out.media_url).toBe('v1.png');
    expect(out.illustrations).toEqual([
      { media_url: 'v1.png', created_time: '2026-07-04T00:00:00.000Z', is_selected: true },
    ]);
  });

  it('leaves media_url undefined when url is null', () => {
    const out = toSpreadImage(sketchImg, geom, null);
    expect(out.media_url).toBeUndefined();
  });
});

// ⚡ Round-trip across the REAL modal writer (prependVersion, the single writer of illustrations[])
// and the sketch adapters — the seam GAP as-built #18 broke. Guards both directions at once:
// read (sketch entry → modal sees ai_request_id) and write (modal commit → meta reaches the store).
describe('sketch ↔ Edit-modal provenance round-trip', () => {
  const stored: SketchSpreadIllustration[] = [
    { ...illus('gen.png', true), ai_request_id: 'req-gen' },
  ];

  it('read: the modal sees the generate entry\'s ai_request_id (picker leaves "idle")', () => {
    const seeded = toIllustrations(stored);
    expect(resolveAiRequestId(seeded[0], seeded)).toEqual({ id: 'req-gen', fromAncestor: false });
  });

  it('write: an inpaint commit round-trips type/original_url/ai_request_id back out', () => {
    const seeded = toIllustrations(stored);
    // Inpaint commit → modal prepends the edited entry (AI call → its own ai_request_id).
    const next = prependVersion(seeded, 'edited.png', 'gen.png', 'req-edit');
    const commit = classifyEditCommit(next, stored.map((i) => i.media_url));
    expect(commit).toEqual({
      kind: 'append',
      url: 'edited.png',
      aiRequestId: 'req-edit',
      type: 'edited',
      originalUrl: 'gen.png',
    });
  });

  it('write: an Erasor commit (no AI id) still carries type+originalUrl → §8.3 chain survives', () => {
    const seeded = toIllustrations(stored);
    const next = prependVersion(seeded, 'erased.png', 'gen.png'); // no aiRequestId
    const commit = classifyEditCommit(next, stored.map((i) => i.media_url));
    expect(commit).toEqual({
      kind: 'append',
      url: 'erased.png',
      type: 'edited',
      originalUrl: 'gen.png',
    });
    // Re-opening Edit on that persisted version: the chain walks back to the generate entry's id.
    const reopened = toIllustrations([
      { ...illus('erased.png', true), type: 'edited', original_url: 'gen.png' },
      { ...illus('gen.png', false), ai_request_id: 'req-gen' },
    ]);
    expect(resolveAiRequestId(reopened[0], reopened)).toEqual({
      id: 'req-gen',
      fromAncestor: true, // picker captions "(từ bản gốc)"
    });
  });
});
