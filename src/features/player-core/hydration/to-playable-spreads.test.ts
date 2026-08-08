// to-playable-spreads.test.ts — snapshot → playback shapes.
import { describe, it, expect } from 'vitest';
import type { SnapshotPreviewData } from '@/types/share-preview-types';
import { toPlayableSpreads, toSections } from './to-playable-spreads';

function makeSnapshot(over: Partial<SnapshotPreviewData['illustration']> = {}): SnapshotPreviewData {
  return {
    id: 'snap-1',
    version: 'v1',
    illustration: {
      spreads: [{ id: 'sp-1' }, { id: 'sp-2', animations: [{ foo: 1 }] }],
      sections: [
        { id: 'sec-1', title: 'S1', start_spread_id: 'sp-1', end_spread_id: 'sp-2' },
      ],
      ...over,
    },
  };
}

describe('toPlayableSpreads', () => {
  it('returns [] for null snapshot', () => {
    expect(toPlayableSpreads(null)).toEqual([]);
  });

  it('casts spreads and defaults missing animations to []', () => {
    const out = toPlayableSpreads(makeSnapshot());
    expect(out).toHaveLength(2);
    expect(out[0].animations).toEqual([]);
    expect(out[1].animations).toEqual([{ foo: 1 }]);
  });
});

describe('toSections', () => {
  it('returns [] for null snapshot', () => {
    expect(toSections(null)).toEqual([]);
  });

  it('extracts sections from snapshot', () => {
    expect(toSections(makeSnapshot())).toHaveLength(1);
  });
});
