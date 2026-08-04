// distribution-helpers.test.ts — Unit tests for pure distribution helpers:
// coalesce (null/partial), formatFileSize, getLeaf, patchLeafEnabled, and the
// v1 export-capability gating contract.

import { describe, it, expect } from 'vitest';
import {
  V1_EXPORT_CAPABILITY,
  buildDefaultDistribution,
  coalesceDistribution,
  formatFileSize,
  getLeaf,
  makeDefaultLeaf,
  patchLeafEnabled,
} from './distribution-helpers';
import type { Distribution, ExportVariantLeaf } from '@/types/editor';

describe('coalesceDistribution', () => {
  it('null → full DEFAULT shape with all leaves + 2 video entries', () => {
    const d = coalesceDistribution(null);
    expect(Object.keys(d.player)).toEqual(['web', 'mobile', 'ipad']);
    expect(Object.keys(d.digital)).toEqual(['epub', 'pdf']);
    expect(Object.keys(d.printer)).toEqual(['600dpi', '300dpi']);
    expect(d.videos.map((v) => v.type)).toEqual(['classic', 'dynamic']);
    // every leaf defaulted
    expect(d.player.web).toEqual(makeDefaultLeaf());
    expect(d.printer['300dpi'].status).toBe('pending');
    expect(d.printer['300dpi'].is_enabled).toBe(true);
    expect(d.printer['300dpi'].media_url).toBeNull();
  });

  it('undefined → DEFAULT (same as null)', () => {
    expect(coalesceDistribution(undefined)).toEqual(buildDefaultDistribution());
  });

  it('partial missing dynamic video → adds default dynamic entry, keeps classic', () => {
    const partial = {
      videos: [{ type: 'classic', sd: makeDefaultLeaf(), hd: makeDefaultLeaf(), fhd: makeDefaultLeaf(), qhd: makeDefaultLeaf() }],
    } as unknown as Distribution;
    const d = coalesceDistribution(partial);
    expect(d.videos.map((v) => v.type)).toEqual(['classic', 'dynamic']);
  });

  it('leaf missing fields → filled from default; preserves provided values', () => {
    const partial = {
      printer: {
        '300dpi': { is_enabled: false, status: 'updated', media_url: 'https://x/y.pdf' },
      },
    } as unknown as Distribution;
    const d = coalesceDistribution(partial);
    const leaf = d.printer['300dpi'];
    expect(leaf.is_enabled).toBe(false); // preserved
    expect(leaf.status).toBe('updated'); // preserved
    expect(leaf.media_url).toBe('https://x/y.pdf'); // preserved
    expect(leaf.file_size).toBeNull(); // defaulted
    expect(leaf.exported_at).toBeNull(); // defaulted
    expect(leaf.job_id).toBeNull(); // defaulted
    // sibling leaf fully defaulted
    expect(d.printer['600dpi']).toEqual(makeDefaultLeaf());
  });

  it('ignores duplicate video types (first wins)', () => {
    const partial = {
      videos: [
        { type: 'classic', sd: { ...makeDefaultLeaf(), status: 'updated' }, hd: makeDefaultLeaf(), fhd: makeDefaultLeaf(), qhd: makeDefaultLeaf() },
        { type: 'classic', sd: { ...makeDefaultLeaf(), status: 'failed' }, hd: makeDefaultLeaf(), fhd: makeDefaultLeaf(), qhd: makeDefaultLeaf() },
      ],
    } as unknown as Distribution;
    const d = coalesceDistribution(partial);
    expect(d.videos.filter((v) => v.type === 'classic')).toHaveLength(1);
    expect(d.videos.find((v) => v.type === 'classic')!.sd.status).toBe('updated');
  });
});

describe('formatFileSize', () => {
  it('8493466 → "8.1 MB"', () => {
    expect(formatFileSize(8493466)).toBe('8.1 MB');
  });
  it('null / 0 / negative / NaN → ""', () => {
    expect(formatFileSize(null)).toBe('');
    expect(formatFileSize(0)).toBe('');
    expect(formatFileSize(-5)).toBe('');
    expect(formatFileSize(Number.NaN)).toBe('');
  });
  it('bytes < 1KB → integer B', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });
  it('KB / GB boundaries', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
  });
});

describe('getLeaf', () => {
  const dist = coalesceDistribution(null);
  it('printer["300dpi"] bracket access', () => {
    expect(getLeaf(dist, 'printer', '300dpi')).toEqual(makeDefaultLeaf());
  });
  it('video by type', () => {
    const d = patchLeafEnabled(dist, 'video', 'hd', false, 'dynamic');
    expect(getLeaf(d, 'video', 'hd', 'dynamic').is_enabled).toBe(false);
  });
  it('unknown leaf key → default-safe (no throw)', () => {
    expect(getLeaf(dist, 'printer', 'nope')).toEqual(makeDefaultLeaf());
    expect(getLeaf(dist, 'video', 'hd', 'missing-type' as never)).toEqual(makeDefaultLeaf());
  });
});

describe('patchLeafEnabled', () => {
  it('is immutable — input untouched, only is_enabled changes', () => {
    const dist = coalesceDistribution(null);
    const before = JSON.parse(JSON.stringify(dist)) as Distribution;
    const next = patchLeafEnabled(dist, 'printer', '300dpi', false);
    expect(dist).toEqual(before); // input unchanged
    expect(next.printer['300dpi'].is_enabled).toBe(false);
    // only that field changed
    const onlyEnabledDiff: ExportVariantLeaf = {
      ...next.printer['300dpi'],
      is_enabled: true,
    };
    expect(onlyEnabledDiff).toEqual(dist.printer['300dpi']);
  });

  it('video patch targets the correct type entry', () => {
    const dist = coalesceDistribution(null);
    const next = patchLeafEnabled(dist, 'video', 'qhd', false, 'classic');
    expect(getLeaf(next, 'video', 'qhd', 'classic').is_enabled).toBe(false);
    expect(getLeaf(next, 'video', 'qhd', 'dynamic').is_enabled).toBe(true); // untouched
  });

  it('unknown leaf key → no-op (returns dist unchanged)', () => {
    const dist = coalesceDistribution(null);
    expect(patchLeafEnabled(dist, 'printer', 'nope', false)).toBe(dist);
  });
});

describe('V1_EXPORT_CAPABILITY gating', () => {
  it('only printer/300dpi is export-able; 600dpi disabled', () => {
    expect(V1_EXPORT_CAPABILITY.printer.exportableLeafKeys).toEqual(['300dpi']);
    expect(V1_EXPORT_CAPABILITY.printer.disabledLeafKeys).toEqual(['600dpi']);
  });
  it('player/digital have no export-able leaves in v1', () => {
    expect(V1_EXPORT_CAPABILITY.player.exportableLeafKeys).toEqual([]);
    expect(V1_EXPORT_CAPABILITY.digital.exportableLeafKeys).toEqual([]);
  });
  it('video: only qhd export-able (job 07); sd/hd/fhd locked (auto-chain 08 badge only)', () => {
    expect(V1_EXPORT_CAPABILITY.video.exportableLeafKeys).toEqual(['qhd']);
    expect(V1_EXPORT_CAPABILITY.video.disabledLeafKeys).toEqual(['sd', 'hd', 'fhd']);
  });
});

describe('rebuild from live (distribution-draft rebuild contract)', () => {
  it('applying flag draft onto live dist preserves status + media_url', () => {
    // Live distribution from DB (already has status/media_url from job execution)
    const live = coalesceDistribution({
      printer: {
        '300dpi': {
          is_enabled: true,
          status: 'updated',
          media_url: 'https://cdn.example.com/export-300.pdf',
          file_size: 12345,
          exported_at: '2026-08-04T10:00:00Z',
          job_id: 'job-123',
        },
        '600dpi': makeDefaultLeaf(),
      },
    } as unknown as Distribution);

    // Draft from UI: user toggled 300dpi OFF
    const draftFlagChange = patchLeafEnabled(live, 'printer', '300dpi', false);

    // After rebuild from live with draft flags applied:
    const rebuilt = draftFlagChange;
    const leaf = getLeaf(rebuilt, 'printer', '300dpi');

    // Status and media_url preserved
    expect(leaf.status).toBe('updated');
    expect(leaf.media_url).toBe('https://cdn.example.com/export-300.pdf');
    expect(leaf.file_size).toBe(12345);
    expect(leaf.exported_at).toBe('2026-08-04T10:00:00Z');
    expect(leaf.job_id).toBe('job-123');

    // Only is_enabled changed
    expect(leaf.is_enabled).toBe(false);
  });

  it('sibling leaves keep their status unaffected', () => {
    const live = coalesceDistribution({
      printer: {
        '300dpi': {
          is_enabled: true,
          status: 'updated',
          media_url: 'https://cdn.example.com/300.pdf',
          file_size: 1000,
          exported_at: '2026-08-04T10:00:00Z',
          job_id: 'job-1',
        },
        '600dpi': {
          is_enabled: false,
          status: 'pending',
          media_url: null,
          file_size: null,
          exported_at: null,
          job_id: null,
        },
      },
    } as unknown as Distribution);

    // Toggle 300dpi off
    const draft = patchLeafEnabled(live, 'printer', '300dpi', false);

    // 600dpi unchanged
    const leaf600 = getLeaf(draft, 'printer', '600dpi');
    expect(leaf600.status).toBe('pending');
    expect(leaf600.media_url).toBeNull();
    expect(leaf600.is_enabled).toBe(false);
  });
});
