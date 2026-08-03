import { describe, it, expect } from 'vitest';
import {
  SCENE_OWNED_KEYS,
  RETOUCH_OWNED_KEYS,
  extractOwnedSubtree,
} from './collab-owned-subtree';

// The full top-level key set of an illustration.spreads[] node
// (ai-storybook-design/snapshot/illustration-structure.md §spreads[]).
const ALL_SPREAD_KEYS = [
  'id', 'manuscript', 'tiny_sketch_media_url', 'pages', 'raw_images',
  'raw_textboxes', 'images', 'textboxes', 'shapes', 'videos', 'auto_pics',
  'audios', 'auto_audios', 'composites', 'quizzes', 'animations',
  'branch_setting',
  // Spread Pool metadata (2026-08-03) — scene owned keys.
  'pool', 'thumbnail_url', 'title',
];

describe('collab-owned-subtree partition', () => {
  it('SCENE and RETOUCH owned-key sets are disjoint', () => {
    const scene = new Set<string>(SCENE_OWNED_KEYS);
    const retouch = new Set<string>(RETOUCH_OWNED_KEYS);
    expect([...scene].some((k) => retouch.has(k))).toBe(false);
  });

  it('SCENE ∪ RETOUCH ∪ {id} is EXHAUSTIVE over the spread node (no key un-owned)', () => {
    // A missing key = an edit to it is neither dirty-diffed nor saved on release
    // (silent data loss). Must stay in lockstep with the backend partition +
    // structure spec — pinned identically in the image-api addressing test.
    const covered = new Set<string>([...SCENE_OWNED_KEYS, ...RETOUCH_OWNED_KEYS, 'id']);
    expect(covered).toEqual(new Set(ALL_SPREAD_KEYS));
  });

  it('mirrors the backend key sets exactly (SSOT alignment)', () => {
    expect([...SCENE_OWNED_KEYS]).toEqual([
      'raw_images', 'raw_textboxes', 'manuscript',
      'tiny_sketch_media_url', 'pages', 'branch_setting',
      'pool', 'thumbnail_url', 'title',
    ]);
    expect([...RETOUCH_OWNED_KEYS]).toEqual([
      'images', 'textboxes', 'shapes', 'videos', 'auto_pics', 'audios',
      'auto_audios', 'composites', 'quizzes', 'animations',
    ]);
  });
});

describe('extractOwnedSubtree', () => {
  const node = {
    id: 'sp-1',
    manuscript: 'story',
    raw_images: [{ id: 'ri-1' }],
    images: [{ id: 'im-1' }],
    animations: [{ type: 1 }],
  };

  it('picks ONLY the scene owned keys present (drops retouch + id)', () => {
    expect(extractOwnedSubtree(node, SCENE_OWNED_KEYS)).toEqual({
      manuscript: 'story',
      raw_images: [{ id: 'ri-1' }],
    });
  });

  it('picks ONLY the retouch owned keys present (drops scene + id)', () => {
    expect(extractOwnedSubtree(node, RETOUCH_OWNED_KEYS)).toEqual({
      images: [{ id: 'im-1' }],
      animations: [{ type: 1 }],
    });
  });

  it('is undefined/null-safe (non-object → {})', () => {
    expect(extractOwnedSubtree(null, SCENE_OWNED_KEYS)).toEqual({});
    expect(extractOwnedSubtree(undefined, RETOUCH_OWNED_KEYS)).toEqual({});
    expect(extractOwnedSubtree('nope', SCENE_OWNED_KEYS)).toEqual({});
  });

  it('omits absent owned keys (never emits undefined values)', () => {
    const sub = extractOwnedSubtree({ manuscript: 'x' }, SCENE_OWNED_KEYS);
    expect('pages' in sub).toBe(false);
    expect(sub).toEqual({ manuscript: 'x' });
  });
});
