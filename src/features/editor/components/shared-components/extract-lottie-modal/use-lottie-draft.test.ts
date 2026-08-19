// use-lottie-draft.test.ts — Unit tests for the localStorage draft helpers (README §6).
// jsdom provides localStorage; hook behavior (debounced autosave) is covered by the live smoke.

import { describe, it, expect, beforeEach } from 'vitest';
import { draftKey, saveDraft, loadDraft, clearDraft } from './use-lottie-draft';
import type { LottieDraft } from './extract-lottie-modal-types';

const IMG = 'img-123';

const draft: LottieDraft = {
  version: 1,
  sourceUrl: 'https://example/original.png',
  parts: [
    {
      id: 'a',
      name: 'head',
      kind: 'normal',
      parentId: null,
      bbox: { x: 10, y: 20, w: 30, h: 40 },
      aspect: 'Free',
      segmentUrl: 'https://example/seg.png',
      versions: [],
      selectedVersionId: null,
      pivot: { x: 25, y: 40 },
      maskStrokes: [],
    },
  ],
  activeTab: 'parts',
  activePartId: 'a',
  savedAt: '2026-08-19T00:00:00.000Z',
};

describe('lottie draft helpers', () => {
  beforeEach(() => localStorage.clear());

  it('save → load round-trips the full draft', () => {
    expect(saveDraft(IMG, draft)).toBe(true);
    expect(loadDraft(IMG)).toEqual(draft);
  });

  it('keys by image id', () => {
    saveDraft(IMG, draft);
    expect(localStorage.getItem(draftKey(IMG))).not.toBeNull();
    expect(loadDraft('other')).toBeNull();
  });

  it('clear removes the draft', () => {
    saveDraft(IMG, draft);
    clearDraft(IMG);
    expect(loadDraft(IMG)).toBeNull();
  });

  it('corrupt JSON → null (no throw)', () => {
    localStorage.setItem(draftKey(IMG), '{not json');
    expect(loadDraft(IMG)).toBeNull();
  });

  it('wrong-version / malformed payload → null', () => {
    localStorage.setItem(draftKey(IMG), JSON.stringify({ version: 2, parts: [] }));
    expect(loadDraft(IMG)).toBeNull();
    localStorage.setItem(draftKey(IMG), JSON.stringify({ version: 1, parts: 'nope' }));
    expect(loadDraft(IMG)).toBeNull();
  });
});
