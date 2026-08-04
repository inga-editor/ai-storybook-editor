// sketch-spread-canvas-policy.test.ts — parity proof for the sketch-spread CANVAS migration off
// `use-resource-lock-session` (phase 4). Asserts the `sketch-image` / `sketch-textbox` policies
// resolve the SAME lock target (byte-identical `keyOf`) the OLD canvas built inline, and that
// getNode / buildPayload reproduce the OLD per-page-image / per-locale-content builders. The
// resource-lock / snapshot stores are mocked (same seam as ensure-saved.test.ts).

import { describe, it, expect, vi } from 'vitest';

const snapshot = {
  sketch: {
    characters: [],
    props: [],
    stages: [],
    base: {},
    lineups: [],
    spreads: [
      {
        id: 'spread-A',
        images: [
          { id: 'img-L', type: 'left', illustrations: [{ media_url: 'l.png' }] },
          { id: 'img-R', type: 'right', illustrations: [] },
        ],
        textboxes: [
          {
            id: 'tb-1',
            en: { text: 'Hello', geometry: { x: 1, y: 2, w: 3, h: 4 }, typography: { size: 12 } },
            vi: { text: 'Xin chào', geometry: { x: 5, y: 6, w: 7, h: 8 }, typography: { size: 14 } },
          },
        ],
      },
      { id: 'spread-B', images: [], textboxes: [] },
    ],
  },
};

vi.mock('@/stores/snapshot-store', () => ({ useSnapshotStore: { getState: () => snapshot } }));
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => ({}) },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  isSketchWriteBlocked: () => false,
  FALLBACK_HOLDER_NAME: 'another editor',
  ACTION_TYPE_CREATE: 2,
}));

import { SAVE_POLICIES } from './save-policies';
import { makeSketchImageId, makeSketchTextboxId } from './sketch-spread-item-id';
import { keyOf, type LockTarget } from '@/stores/resource-lock-store';

const BOOK = 'book-1';

/** The OLD `use-resource-lock-session` canvas lockTarget (sketch-spread-canvas.tsx, pre-phase-4). */
function oldImageTarget(imageId: string): LockTarget {
  return { step: 1, resource_type: 1, resource_id: imageId, locale: null };
}
function oldTextboxTarget(textboxId: string, langCode: string): LockTarget {
  return { step: 1, resource_type: 2, resource_id: textboxId, locale: langCode };
}

describe('sketch-image policy', () => {
  const p = SAVE_POLICIES['sketch-image'];

  it('resolveTarget keyOf === OLD canvas image target (locale-agnostic)', () => {
    const id = makeSketchImageId('spread-A', 'img-L');
    expect(keyOf(BOOK, p.resolveTarget(id, null))).toBe(keyOf(BOOK, oldImageTarget('img-L')));
  });

  it('getNode returns the per-page image node addressed by the composite id', () => {
    const node = p.getNode(makeSketchImageId('spread-A', 'img-R')) as { id: string; type: string } | null;
    expect(node).toMatchObject({ id: 'img-R', type: 'right' });
  });

  it('buildPayload = { action_type:3, patch, target_ref{spread_number,page}, create_fallback }', () => {
    const id = makeSketchImageId('spread-A', 'img-L');
    const node = p.getNode(id);
    const payload = p.buildPayload(node, id);
    expect(payload.action_type).toBe(3);
    expect(payload.patch).toBe(node);
    expect(payload.target_ref).toEqual({ spread_number: 1, page: 'left' }); // spread-A is doc-order #1
    expect(payload.create_fallback).toEqual({ parent_id: 'spread-A', collection: 'images' });
  });

  it('spread_number tracks doc-order (spread-B is #2)', () => {
    // spread-B has no images; supply a synthetic node to exercise the payload builder's numbering.
    const payload = p.buildPayload({ id: 'x', type: 'full' }, makeSketchImageId('spread-B', 'x'));
    expect(payload.target_ref).toMatchObject({ spread_number: 2, page: 'full' });
  });
});

describe('sketch-textbox policy — multi-locale keyOf parity', () => {
  const p = SAVE_POLICIES['sketch-textbox'];

  // The single most important parity guarantee: for EVERY locale the OLD canvas used the langCode as
  // the lock target's `locale`; the new composite-id path must reproduce it byte-for-byte.
  it.each(['en', 'vi', 'zh-CN'])('keyOf matches OLD canvas target for locale "%s"', (lang) => {
    const id = makeSketchTextboxId('spread-A', 'tb-1', lang);
    expect(keyOf(BOOK, p.resolveTarget(id, lang))).toBe(keyOf(BOOK, oldTextboxTarget('tb-1', lang)));
  });

  it('empty-string locale keyOf === null-locale keyOf (DB NULLS NOT DISTINCT ≡ "")', () => {
    // Guards the "locale null vs ''" edge the task calls out: keyOf folds both to trailing '', so the
    // new path must never diverge from the OLD one regardless of which the caller threads.
    const idEmpty = makeSketchTextboxId('spread-A', 'tb-1', '');
    expect(keyOf(BOOK, p.resolveTarget(idEmpty, ''))).toBe(keyOf(BOOK, oldTextboxTarget('tb-1', '')));
    expect(keyOf(BOOK, oldTextboxTarget('tb-1', ''))).toBe(keyOf(BOOK, { step: 1, resource_type: 2, resource_id: 'tb-1', locale: null }));
  });

  it('getNode returns the PER-LOCALE content (not the whole textbox)', () => {
    const en = p.getNode(makeSketchTextboxId('spread-A', 'tb-1', 'en')) as { text: string } | null;
    const vi_ = p.getNode(makeSketchTextboxId('spread-A', 'tb-1', 'vi')) as { text: string } | null;
    expect(en).toMatchObject({ text: 'Hello' });
    expect(vi_).toMatchObject({ text: 'Xin chào' });
  });

  it('buildPayload target_ref carries { spread_number, textbox_id, locale }', () => {
    const id = makeSketchTextboxId('spread-A', 'tb-1', 'vi');
    const node = p.getNode(id);
    const payload = p.buildPayload(node, id);
    expect(payload.action_type).toBe(3);
    expect(payload.patch).toBe(node);
    expect(payload.target_ref).toEqual({ spread_number: 1, textbox_id: 'tb-1', locale: 'vi' });
  });
});
