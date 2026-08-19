// distribution-helpers.ts — Pure, side-effect-free helpers + config constants
// for ConfigDistributionSettings. No logger (pure functions). Design §2.2.
//
// Contract:
// - `distribution` column is nullable → readers MUST coalesce to DEFAULT.
// - Client is writer of `is_enabled` ONLY; job handler owns status/media/etc.
// - Render is config-driven via CHANNELS; `video` is the single special-case
//   (1 channel group per videos[] entry).

import type {
  ChannelKey,
  Distribution,
  ExportStatus,
  ExportVariantLeaf,
  VideoDistributionEntry,
  VideoType,
} from '@/types/editor';

// ── Config-driven render descriptors ────────────────────────────────────────

export interface VariantDescriptor {
  leafKey: string; // '1600' | 'epub' | '300dpi' | 'sd' ...
  label: string; // '1600px' | 'epub' | '300 DPI' | '480p (SD)'
}

export interface ChannelDescriptor {
  key: ChannelKey;
  label: string; // non-video; video overrides per type via VIDEO_TYPE_LABELS
  variants: VariantDescriptor[];
}

// Fixed channel/variant order (matches design screenshot).
export const CHANNELS: ChannelDescriptor[] = [
  {
    key: 'player',
    label: 'INGA Player',
    variants: [
      { leafKey: '1600', label: '1600px' },
      { leafKey: '2240', label: '2240px' },
      { leafKey: '2752', label: '2752px' },
    ],
  },
  {
    key: 'digital',
    label: 'Digital Book',
    variants: [
      { leafKey: 'epub', label: 'epub' },
      { leafKey: 'pdf', label: 'pdf' },
    ],
  },
  {
    key: 'printer',
    label: 'Printing Book',
    variants: [
      { leafKey: '600dpi', label: '600 DPI' },
      { leafKey: '300dpi', label: '300 DPI' },
    ],
  },
  // 'video' special-case: render 1 group per videos[] entry, label per type.
  {
    key: 'video',
    label: 'Video',
    variants: [
      { leafKey: 'sd', label: '480p (SD)' },
      { leafKey: 'hd', label: '720p (HD)' },
      { leafKey: 'fhd', label: '1080p (FHD)' },
      { leafKey: 'qhd', label: '1440p (QHD)' },
    ],
  },
];

export const VIDEO_TYPE_LABELS: Record<VideoType, string> = {
  classic: 'Video - Classic',
  dynamic: 'Video - Dynamic',
};

// videos[] always coalesced to exactly these two entries, in this order.
const VIDEO_TYPES: VideoType[] = ['classic', 'dynamic'];

// ── v1 export capability (scope: only Printing Book 300 DPI) ────────────────

export interface ChannelCapability {
  exportableLeafKeys: string[]; // leaves actually export-able in v1
  /** Leaves whose is_enabled checkbox + Export button are LOCKED (no user
   *  trigger). ADR-037: this gates ONLY the toggle/export controls — the status
   *  badge (EXPORTING → UPDATED) still renders for these leaves, so the
   *  auto-chained transcode (08) progress on sd/hd/fhd is visible. */
  disabledLeafKeys: string[];
}

// Single scope-widening point: add a leafKey to exportableLeafKeys (+ wire its
// route) when a new channel ships — render logic stays untouched.
export const V1_EXPORT_CAPABILITY: Record<ChannelKey, ChannelCapability> = {
  // Player export-able (ADR-057, job 18 export_player_media): one job converts
  // every checked quality — the is_enabled checkbox is the quality-selection gate
  // the handler reads at enqueue, so all 3 leaves toggle + export.
  player: { exportableLeafKeys: ['1600', '2240', '2752'], disabledLeafKeys: [] },
  digital: { exportableLeafKeys: [], disabledLeafKeys: [] },
  printer: { exportableLeafKeys: ['300dpi'], disabledLeafKeys: ['600dpi'] },
  // v1: only QHD (1440p) renders via job 07 (render_book_video); SD/HD/FHD are
  // auto-filled by the chained transcode job 08 (ffmpeg downscale from the QHD
  // master, ADR-037). Their checkboxes/Export stay LOCKED (no manual trigger),
  // but their status badge still renders live while 08 runs.
  video: { exportableLeafKeys: ['qhd'], disabledLeafKeys: ['sd', 'hd', 'fhd'] },
};

export interface StatusBadgeTone {
  label: string;
  tone: 'green' | 'amber' | 'blue' | 'red';
}

// pending → null (no badge before first export).
export const STATUS_BADGE: Record<ExportStatus, StatusBadgeTone | null> = {
  updated: { label: 'UPDATED', tone: 'green' },
  outdated: { label: 'OUTDATED', tone: 'amber' },
  exporting: { label: 'EXPORTING', tone: 'blue' },
  failed: { label: 'FAILED', tone: 'red' },
  pending: null,
};

// ── Default builders ─────────────────────────────────────────────────────────

export function makeDefaultLeaf(): ExportVariantLeaf {
  return {
    is_enabled: true,
    status: 'pending',
    media_url: null,
    file_size: null,
    exported_at: null,
    job_id: null,
    last_job_id: null,
  };
}

function makeDefaultVideoEntry(type: VideoType): VideoDistributionEntry {
  return {
    type,
    sd: makeDefaultLeaf(),
    hd: makeDefaultLeaf(),
    fhd: makeDefaultLeaf(),
    qhd: makeDefaultLeaf(),
  };
}

export function buildDefaultDistribution(): Distribution {
  return {
    player: {
      '1600': makeDefaultLeaf(),
      '2240': makeDefaultLeaf(),
      '2752': makeDefaultLeaf(),
    },
    digital: {
      epub: makeDefaultLeaf(),
      pdf: makeDefaultLeaf(),
    },
    printer: {
      '600dpi': makeDefaultLeaf(),
      '300dpi': makeDefaultLeaf(),
    },
    videos: VIDEO_TYPES.map(makeDefaultVideoEntry),
  };
}

// ── Coalesce (null/partial → full shape) ─────────────────────────────────────

/** Fill a single leaf's missing fields from default (reader tolerance). */
function coalesceLeaf(leaf: Partial<ExportVariantLeaf> | null | undefined): ExportVariantLeaf {
  const d = makeDefaultLeaf();
  if (!leaf || typeof leaf !== 'object') return d;
  return {
    is_enabled: typeof leaf.is_enabled === 'boolean' ? leaf.is_enabled : d.is_enabled,
    status: leaf.status ?? d.status,
    media_url: leaf.media_url ?? d.media_url,
    file_size: typeof leaf.file_size === 'number' ? leaf.file_size : d.file_size,
    exported_at: leaf.exported_at ?? d.exported_at,
    job_id: leaf.job_id ?? d.job_id,
    last_job_id: leaf.last_job_id ?? d.last_job_id,
  };
}

function coalesceRecord<K extends string>(
  rec: Partial<Record<K, ExportVariantLeaf>> | null | undefined,
  keys: K[],
): Record<K, ExportVariantLeaf> {
  const out = {} as Record<K, ExportVariantLeaf>;
  for (const k of keys) out[k] = coalesceLeaf(rec?.[k]);
  return out;
}

/** null/partial Distribution → full shape with every leaf present + exactly
 *  2 video entries (classic + dynamic), missing types added as default. */
export function coalesceDistribution(d: Distribution | null | undefined): Distribution {
  if (!d || typeof d !== 'object') return buildDefaultDistribution();

  const byType = new Map<VideoType, VideoDistributionEntry>();
  for (const entry of Array.isArray(d.videos) ? d.videos : []) {
    if (!entry || (entry.type !== 'classic' && entry.type !== 'dynamic')) continue;
    if (byType.has(entry.type)) continue; // first wins; ignore dup
    byType.set(entry.type, {
      type: entry.type,
      sd: coalesceLeaf(entry.sd),
      hd: coalesceLeaf(entry.hd),
      fhd: coalesceLeaf(entry.fhd),
      qhd: coalesceLeaf(entry.qhd),
    });
  }

  return {
    player: coalesceRecord(d.player, ['1600', '2240', '2752']),
    digital: coalesceRecord(d.digital, ['epub', 'pdf']),
    printer: coalesceRecord(d.printer, ['600dpi', '300dpi']),
    videos: VIDEO_TYPES.map((t) => byType.get(t) ?? makeDefaultVideoEntry(t)),
  };
}

// ── Leaf access + immutable patch ────────────────────────────────────────────

/** Bracket-safe leaf read. Returns a default leaf for unknown keys (never
 *  throws) so callers stay defensive against malformed input. Assumes `dist`
 *  is already coalesced. */
export function getLeaf(
  dist: Distribution,
  ch: ChannelKey,
  leafKey: string,
  videoType?: VideoType,
): ExportVariantLeaf {
  if (ch === 'video') {
    const entry = dist.videos.find((v) => v.type === videoType);
    const leaf = entry?.[leafKey as keyof Omit<VideoDistributionEntry, 'type'>];
    return leaf ?? makeDefaultLeaf();
  }
  const rec = dist[ch] as Record<string, ExportVariantLeaf> | undefined;
  return rec?.[leafKey] ?? makeDefaultLeaf();
}

/** Immutable clone of `dist` with one leaf's is_enabled set. Input untouched.
 *  Only mutates is_enabled (client-owned field); never status/media/etc. */
export function patchLeafEnabled(
  dist: Distribution,
  ch: ChannelKey,
  leafKey: string,
  next: boolean,
  videoType?: VideoType,
): Distribution {
  if (ch === 'video') {
    return {
      ...dist,
      videos: dist.videos.map((entry) => {
        if (entry.type !== videoType) return entry;
        // Only the 4 resolution leaves are patchable (never the 'type' discriminator).
        if (leafKey !== 'sd' && leafKey !== 'hd' && leafKey !== 'fhd' && leafKey !== 'qhd') {
          return entry;
        }
        return { ...entry, [leafKey]: { ...entry[leafKey], is_enabled: next } };
      }),
    };
  }
  const rec = dist[ch] as Record<string, ExportVariantLeaf>;
  if (!rec[leafKey]) return dist; // unknown leaf — no-op (defensive)
  return {
    ...dist,
    [ch]: { ...rec, [leafKey]: { ...rec[leafKey], is_enabled: next } },
  };
}

// ── File size formatting ─────────────────────────────────────────────────────

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 8493466 → '8.1 MB'; 0/null → ''. Binary (1024) units, 1 decimal ≥ KB. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${SIZE_UNITS[unit]}`;
}
