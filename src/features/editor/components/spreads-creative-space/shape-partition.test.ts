// shape-partition.test.ts — pins the UI-layer partition predicate (ADR-044 addendum 2026-08-05):
// `shape` is the only SCENE-space item routed through the RETOUCH (rtype 10) gate today; every
// other item type must stay on the SCENE (rtype 6) gate. A wrong `true` here over-locks the
// spread's objects grain; a wrong `false` re-opens the silent shape data-loss defect.

import { describe, it, expect } from 'vitest';
import { isRetouchOwnedItem } from './shape-partition';

describe('isRetouchOwnedItem', () => {
  it('shape → RETOUCH partition', () => {
    expect(isRetouchOwnedItem('shape')).toBe(true);
  });

  it.each(['raw_image', 'raw_textbox', 'page'] as const)('%s → SCENE partition', (kind) => {
    expect(isRetouchOwnedItem(kind)).toBe(false);
  });

  it('canvas dispatch aliases of scene layers stay SCENE (image/textbox wide-union strings)', () => {
    expect(isRetouchOwnedItem('image')).toBe(false);
    expect(isRetouchOwnedItem('textbox')).toBe(false);
  });
});
