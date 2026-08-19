// export-job-registry.ts — Client-side map of background-job id → distribution
// leaves it drives (ADR-037 §4.9). A single job can feed N leaves — the
// auto-chained `transcode_video` (08) writes sd+hd+fhd of one video edition, so
// one job_id → 3 LeafRefs. Built by scanning a source's distribution for leaves
// currently `exporting` with a job_id. Pure helpers; the watcher owns the live
// Map instance.

import type { Distribution } from '@/types/editor';
import type { BackgroundJob } from '@/stores/background-jobs-store';

export interface ResolvedSource {
  kind: 'book' | 'remix';
  id: string;
}

/** Resolve which UI source (current book / a loaded remix) a job belongs to, or
 *  null if it's outside this editor (other book, remix swap, another user's
 *  job). Pure read of the job's raw params + the watcher's current target ids. */
export function resolveSource(
  job: BackgroundJob,
  bookId: string | null,
  remixIds: string[],
): ResolvedSource | null {
  const remixId = typeof job.params?.remix_id === 'string' ? job.params.remix_id : null;
  if (remixId) {
    return remixIds.includes(remixId) ? { kind: 'remix', id: remixId } : null;
  }
  if (!bookId) return null;
  if (job.bookId && job.bookId !== bookId) return null;
  return { kind: 'book', id: bookId };
}

export interface LeafRef {
  sourceKind: 'book' | 'remix';
  sourceId: string;
  channelKey: 'printer' | 'video' | 'player';
  leafKey: string; // '300dpi' | '600dpi' | 'sd' | 'hd' | 'fhd' | 'qhd' | '1600' | '2240' | '2752'
  videoType?: 'classic' | 'dynamic';
}

const PRINTER_LEAF_KEYS = ['600dpi', '300dpi'] as const;
const VIDEO_LEAF_KEYS = ['sd', 'hd', 'fhd', 'qhd'] as const;
const PLAYER_LEAF_KEYS = ['1600', '2240', '2752'] as const;

/** Scan one source's (coalesced) distribution → LeafRefs grouped by job_id, for
 *  every printer/video/player leaf that is `exporting` and carries a job_id.
 *  One export_player_media job claims every enabled tier leaf (ADR-057), so one
 *  job_id → up to 3 player LeafRefs (same shape as the transcode 08 fan-out).
 *  The digital channel doesn't run background-job exports in v1 → skipped. */
export function buildLeafRefsFromDistribution(
  sourceKind: 'book' | 'remix',
  sourceId: string,
  dist: Distribution,
): Map<string, LeafRef[]> {
  const map = new Map<string, LeafRef[]>();
  const add = (jobId: string, ref: LeafRef) => {
    const arr = map.get(jobId);
    if (arr) arr.push(ref);
    else map.set(jobId, [ref]);
  };

  for (const leafKey of PRINTER_LEAF_KEYS) {
    const leaf = dist.printer[leafKey];
    if (leaf?.status === 'exporting' && leaf.job_id) {
      add(leaf.job_id, { sourceKind, sourceId, channelKey: 'printer', leafKey });
    }
  }

  for (const leafKey of PLAYER_LEAF_KEYS) {
    const leaf = dist.player[leafKey];
    if (leaf?.status === 'exporting' && leaf.job_id) {
      add(leaf.job_id, { sourceKind, sourceId, channelKey: 'player', leafKey });
    }
  }

  for (const entry of dist.videos) {
    for (const leafKey of VIDEO_LEAF_KEYS) {
      const leaf = entry[leafKey];
      if (leaf?.status === 'exporting' && leaf.job_id) {
        add(leaf.job_id, {
          sourceKind,
          sourceId,
          channelKey: 'video',
          leafKey,
          videoType: entry.type,
        });
      }
    }
  }

  return map;
}

/** Merge a freshly-scanned per-source map into the live registry: first drop
 *  every existing entry owned by that source (so a leaf that left `exporting`
 *  clears), then add the fresh refs. Mutates `registry` in place. */
export function rebuildRegistryForSource(
  registry: Map<string, LeafRef[]>,
  sourceKind: 'book' | 'remix',
  sourceId: string,
  dist: Distribution,
): void {
  for (const [jobId, refs] of [...registry]) {
    const kept = refs.filter(
      (r) => !(r.sourceKind === sourceKind && r.sourceId === sourceId),
    );
    if (kept.length > 0) registry.set(jobId, kept);
    else registry.delete(jobId);
  }
  const fresh = buildLeafRefsFromDistribution(sourceKind, sourceId, dist);
  for (const [jobId, refs] of fresh) {
    const existing = registry.get(jobId);
    if (existing) existing.push(...refs);
    else registry.set(jobId, refs);
  }
}
