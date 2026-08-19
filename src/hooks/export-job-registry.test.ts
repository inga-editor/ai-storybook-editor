// export-job-registry.test.ts — resolveSource routing + registry build/rebuild/
// clear, including the auto-chain 08 multi-leaf case (one job_id → sd+hd+fhd).

import { describe, it, expect } from 'vitest';
import {
  buildLeafRefsFromDistribution,
  rebuildRegistryForSource,
  resolveSource,
  type LeafRef,
} from './export-job-registry';
import type { BackgroundJob } from '@/stores/background-jobs-store';
import { coalesceDistribution } from '@/features/editor/components/config-creative-space/distribution-helpers';
import type { Distribution } from '@/types/editor';

function job(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'j1',
    type: 'render_book_video',
    bookId: 'book-1',
    userId: 'u1',
    status: 'running',
    currentStep: 1,
    totalSteps: 5,
    stepDetails: null,
    params: {},
    result: null,
    cancelRequested: false,
    createdAt: '2026-06-07T00:00:00Z',
    updatedAt: '2026-06-07T00:00:00Z',
    ...over,
  };
}

/** Build a coalesced distribution then stamp specific leaves as exporting+job. */
function distWith(
  patch: (d: Distribution) => void,
): Distribution {
  const d = coalesceDistribution(null);
  patch(d);
  return d;
}

describe('resolveSource', () => {
  it('routes to book when no remix_id and bookId matches', () => {
    expect(resolveSource(job({ bookId: 'book-1', params: {} }), 'book-1', [])).toEqual({
      kind: 'book',
      id: 'book-1',
    });
  });

  it('routes to remix when params.remix_id is a loaded remix', () => {
    expect(
      resolveSource(job({ params: { remix_id: 'rem-9' } }), 'book-1', ['rem-9']),
    ).toEqual({ kind: 'remix', id: 'rem-9' });
  });

  it('returns null for remix not in UI', () => {
    expect(resolveSource(job({ params: { remix_id: 'rem-X' } }), 'book-1', ['rem-9'])).toBeNull();
  });

  it('returns null for a different book', () => {
    expect(resolveSource(job({ bookId: 'book-2', params: {} }), 'book-1', [])).toBeNull();
  });

  it('returns null when no book context', () => {
    expect(resolveSource(job({ params: {} }), null, [])).toBeNull();
  });
});

describe('buildLeafRefsFromDistribution', () => {
  it('maps exporting printer + video leaves grouped by job_id (08 → sd+hd+fhd)', () => {
    const dist = distWith((d) => {
      d.printer['300dpi'] = { ...d.printer['300dpi'], status: 'exporting', job_id: 'job-pdf' };
      const classic = d.videos.find((v) => v.type === 'classic')!;
      classic.sd = { ...classic.sd, status: 'exporting', job_id: 'job-08' };
      classic.hd = { ...classic.hd, status: 'exporting', job_id: 'job-08' };
      classic.fhd = { ...classic.fhd, status: 'exporting', job_id: 'job-08' };
      classic.qhd = { ...classic.qhd, status: 'exporting', job_id: 'job-07' };
    });

    const map = buildLeafRefsFromDistribution('book', 'book-1', dist);
    expect(map.get('job-pdf')).toEqual([
      { sourceKind: 'book', sourceId: 'book-1', channelKey: 'printer', leafKey: '300dpi' },
    ]);
    expect(map.get('job-08')?.map((r) => r.leafKey).sort()).toEqual(['fhd', 'hd', 'sd']);
    expect(map.get('job-08')?.every((r) => r.videoType === 'classic')).toBe(true);
    expect(map.get('job-07')?.[0].leafKey).toBe('qhd');
  });

  it('ignores non-exporting or job_id-less leaves', () => {
    const dist = distWith((d) => {
      d.printer['300dpi'] = { ...d.printer['300dpi'], status: 'updated', job_id: 'done' };
      const classic = d.videos.find((v) => v.type === 'classic')!;
      classic.qhd = { ...classic.qhd, status: 'exporting', job_id: null };
    });
    expect(buildLeafRefsFromDistribution('book', 'book-1', dist).size).toBe(0);
  });

  it('maps exporting player tier leaves — one job 18 → up to 3 refs (ADR-057)', () => {
    const dist = distWith((d) => {
      d.player.web = { ...d.player.web, status: 'exporting', job_id: 'job-18' };
      d.player.mobile = { ...d.player.mobile, status: 'exporting', job_id: 'job-18' };
      // ipad unchecked → handler never claimed it; stays pending, no job_id.
    });

    const map = buildLeafRefsFromDistribution('remix', 'remix-1', dist);
    expect(map.get('job-18')?.map((r) => r.leafKey).sort()).toEqual(['mobile', 'web']);
    expect(
      map.get('job-18')?.every(
        (r) => r.channelKey === 'player' && r.sourceKind === 'remix' && r.sourceId === 'remix-1',
      ),
    ).toBe(true);
  });
});

describe('rebuildRegistryForSource', () => {
  it('replaces a source entries; clears when leaf leaves exporting', () => {
    const registry = new Map<string, LeafRef[]>();
    const exporting = distWith((d) => {
      const classic = d.videos.find((v) => v.type === 'classic')!;
      classic.qhd = { ...classic.qhd, status: 'exporting', job_id: 'job-07' };
    });
    rebuildRegistryForSource(registry, 'book', 'book-1', exporting);
    expect(registry.get('job-07')).toHaveLength(1);

    // qhd now updated → registry entry for that source clears.
    const done = coalesceDistribution(null);
    rebuildRegistryForSource(registry, 'book', 'book-1', done);
    expect(registry.has('job-07')).toBe(false);
  });

  it('keeps other-source refs when rebuilding one source', () => {
    const registry = new Map<string, LeafRef[]>();
    registry.set('shared', [
      { sourceKind: 'remix', sourceId: 'rem-1', channelKey: 'video', leafKey: 'qhd', videoType: 'classic' },
    ]);
    const bookDist = distWith((d) => {
      d.printer['300dpi'] = { ...d.printer['300dpi'], status: 'exporting', job_id: 'shared' };
    });
    rebuildRegistryForSource(registry, 'book', 'book-1', bookDist);
    // 'shared' now has both the remix ref (kept) and the new book ref.
    expect(registry.get('shared')).toHaveLength(2);
  });
});
