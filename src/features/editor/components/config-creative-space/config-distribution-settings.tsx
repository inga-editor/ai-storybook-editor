// config-distribution-settings.tsx — Distribution section root. Multi-source
// (ORIGINAL book + N remixes) export-artifact hub. v1: only Printing Book
// 300 DPI is export-able; all channels toggle is_enabled (persisted).
//
// Status ownership (design §4.6): job handler is single-writer of status/media.
// Client enqueues + toggles is_enabled. UI reflects DB via:
//   - refetch-on-mount (self-heal stuck EXPORTING)
//   - standalone export_pdf watcher (refetch on running/terminal)
//   - post-enqueue refetch (in useDistributionActions)
// No FE polling — backend reaper guards permanent stuck.

import * as React from 'react';
import { toast } from 'sonner';
import { useCurrentBook, useBookActions } from '@/stores/book-store';
import { useRemixes, useRemixActions } from '@/stores/remix-store';
import {
  useDistributionActions,
  type EnqueueExportOutcome,
} from '@/hooks/use-distribution-actions';
import { useExportJobWatcher } from '@/hooks/use-export-job-watcher';
import { getExportPdfDownloadUrl } from '@/apis/jobs-api';
import {
  CHANNELS,
  V1_EXPORT_CAPABILITY,
  VIDEO_TYPE_LABELS,
  coalesceDistribution,
  getLeaf,
  patchLeafEnabled,
} from './distribution-helpers';
import {
  DistributionSourceSection,
  ChannelExportGroup,
} from './config-distribution-settings/index';
import type {
  ChannelKey,
  Distribution,
  ExportVariantLeaf,
  VideoType,
} from '@/types/editor';
import { createLogger } from '@/utils/logger';
import {
  ConfigSectionHeader,
  assertPersisted,
  deepEqual,
  useConfigSectionDraft,
} from './explicit-save';
import { useConfigDirtyGuardActions } from '@/stores/config-dirty-guard-store';

const log = createLogger('Editor', 'ConfigDistributionSettings');

const EXPORT_OPTS = { dpi: 300, color_mode: 'cmyk' } as const;

type SourceKind = 'book' | 'remix';
interface DistSource {
  kind: SourceKind;
  id: string;
  key: string; // 'book' | remix.id — accordion expand key
  label: string;
  dist: Distribution;
}

// ── Draft model: only user-owned `is_enabled` flags. `status`/`media_url` are
//    pipeline-owned → always read straight from the live store, never the draft.
//    Shape: sourceKey → { leafPath → is_enabled }. ────────────────────────────
type LeafFlags = Record<string, boolean>;
type DistributionDraft = Record<string, LeafFlags>;

const VIDEO_LEAF_KEYS = ['sd', 'hd', 'fhd', 'qhd'] as const;

/** Stable path key for one leaf (encodes the video type when present). */
function leafPath(ch: ChannelKey, leafKey: string, videoType?: VideoType): string {
  return videoType ? `${ch}::${leafKey}::${videoType}` : `${ch}::${leafKey}`;
}

/** Extract the is_enabled map for every leaf of a (coalesced) distribution. */
function distEnabledMap(dist: Distribution): LeafFlags {
  const flags: LeafFlags = {};
  (['player', 'digital', 'printer'] as const).forEach((chKey) => {
    const rec = dist[chKey] as Record<string, ExportVariantLeaf>;
    for (const [leafKey, leaf] of Object.entries(rec)) {
      flags[leafPath(chKey, leafKey)] = leaf.is_enabled;
    }
  });
  for (const entry of dist.videos) {
    for (const leafKey of VIDEO_LEAF_KEYS) {
      flags[leafPath('video', leafKey, entry.type)] = entry[leafKey].is_enabled;
    }
  }
  return flags;
}

/** Apply draft flags onto a live (coalesced) distribution, leaving status/media intact. */
function applyFlags(dist: Distribution, flags: LeafFlags): Distribution {
  let next = dist;
  for (const [path, enabled] of Object.entries(flags)) {
    const parts = path.split('::');
    if (parts[0] === 'video') {
      next = patchLeafEnabled(next, 'video', parts[1], enabled, parts[2] as VideoType);
    } else {
      next = patchLeafEnabled(next, parts[0] as ChannelKey, parts[1], enabled);
    }
  }
  return next;
}

interface ChannelView {
  groupKey: string;
  label: string;
  channelKey: ChannelKey;
  videoType?: VideoType;
  variants: Array<{ descriptor: { leafKey: string; label: string }; leaf: ExportVariantLeaf }>;
  canExport: boolean;
  anyExporting: boolean;
}

/** Read one leaf from the live dist but override is_enabled with the draft flag
 *  (status/media_url stay live). */
function leafWithDraft(
  dist: Distribution,
  flags: LeafFlags,
  ch: ChannelKey,
  leafKey: string,
  videoType?: VideoType,
): ExportVariantLeaf {
  const leaf = getLeaf(dist, ch, leafKey, videoType);
  const path = leafPath(ch, leafKey, videoType);
  return path in flags ? { ...leaf, is_enabled: flags[path] } : leaf;
}

/** Build the per-channel view (variants + gating) for one source. `flags` are the
 *  draft is_enabled overrides for this source. */
function buildChannelViews(dist: Distribution, flags: LeafFlags): ChannelView[] {
  const views: ChannelView[] = [];
  for (const ch of CHANNELS) {
    const cap = V1_EXPORT_CAPABILITY[ch.key];
    if (ch.key === 'video') {
      for (const entry of dist.videos) {
        const variants = ch.variants.map((descriptor) => ({
          descriptor,
          leaf: leafWithDraft(dist, flags, 'video', descriptor.leafKey, entry.type),
        }));
        const exportable = variants.filter((v) =>
          cap.exportableLeafKeys.includes(v.descriptor.leafKey),
        );
        const anyChecked = exportable.some((v) => v.leaf.is_enabled);
        const anyExporting = exportable.some((v) => v.leaf.status === 'exporting');
        views.push({
          groupKey: `video-${entry.type}`,
          label: VIDEO_TYPE_LABELS[entry.type],
          channelKey: 'video',
          videoType: entry.type,
          variants,
          canExport: exportable.length > 0 && anyChecked && !anyExporting,
          anyExporting,
        });
      }
      continue;
    }
    const variants = ch.variants.map((descriptor) => ({
      descriptor,
      leaf: leafWithDraft(dist, flags, ch.key, descriptor.leafKey),
    }));
    const exportable = variants.filter((v) =>
      cap.exportableLeafKeys.includes(v.descriptor.leafKey),
    );
    const anyChecked = exportable.some((v) => v.leaf.is_enabled);
    const anyExporting = exportable.some((v) => v.leaf.status === 'exporting');
    views.push({
      groupKey: ch.key,
      label: ch.label,
      channelKey: ch.key,
      variants,
      canExport: exportable.length > 0 && anyChecked && !anyExporting,
      anyExporting,
    });
  }
  return views;
}

export function ConfigDistributionSettings() {
  const book = useCurrentBook();
  const remixes = useRemixes();
  const { updateBook, refetchBookDistribution } = useBookActions();
  const { refetchRemix } = useRemixActions();
  const {
    updateRemixDistribution,
    startBookExportPdf,
    startRemixExportPdf,
    startBookRenderVideo,
    startRemixRenderVideo,
  } = useDistributionActions();

  const [expandedSources, setExpandedSources] = React.useState<Set<string>>(
    () => new Set(['book']),
  );

  // Memoized sources keyed on raw store refs (avoid re-render loop — coalesce
  // produces fresh objects, so never select these inline). Memory: useMemo on
  // stable raw refs, not useShallow on mapped arrays.
  const bookId = book?.id ?? null;
  const sources = React.useMemo<DistSource[]>(() => {
    if (!book) return [];
    const list: DistSource[] = [
      {
        kind: 'book',
        id: book.id,
        key: 'book',
        label: 'ORIGINAL',
        dist: coalesceDistribution(book.distribution),
      },
    ];
    remixes.forEach((r, i) => {
      list.push({
        kind: 'remix',
        id: r.id,
        key: r.id,
        label: r.name?.toUpperCase() || `REMIX ${i + 1}`,
        dist: coalesceDistribution(r.distribution),
      });
    });
    return list;
  }, [book, remixes]);

  const remixIds = React.useMemo(() => remixes.map((r) => r.id), [remixes]);

  // Draft baseline: every source's is_enabled flags. Rebuilt whenever `sources`
  // change (realtime status writes leave is_enabled untouched → stays clean).
  const draftSource = React.useMemo<DistributionDraft>(() => {
    const map: DistributionDraft = {};
    for (const src of sources) map[src.key] = distEnabledMap(src.dist);
    return map;
  }, [sources]);

  const { ensureSaved } = useConfigDirtyGuardActions();

  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<DistributionDraft>({
    sectionKey: 'distribution',
    source: draftSource,
    persistFn: async (d) => {
      // Per source with a diff: rebuild nextDist from the LIVE store dist (so
      // status/media_url stay intact) then apply only this source's draft flags.
      for (const src of sources) {
        const flags = d[src.key];
        if (!flags) continue;
        if (deepEqual(flags, distEnabledMap(src.dist))) continue;
        const nextDist = applyFlags(coalesceDistribution(src.dist), flags);
        log.info('persistFn', 'saving distribution source', { kind: src.kind, id: src.id });
        if (src.kind === 'book') {
          assertPersisted(await updateBook(src.id, { distribution: nextDist }), 'book distribution');
        } else {
          assertPersisted(await updateRemixDistribution(src.id, nextDist), 'remix distribution');
        }
      }
    },
  });

  // Mount the standalone export_pdf watcher (book + current remixes).
  useExportJobWatcher({ bookId, remixIds });

  // Refetch-on-mount self-heal (stuck EXPORTING). Runs once per book id.
  React.useEffect(() => {
    if (!bookId) return;
    log.info('refetchOnMount', 'pull distribution', { bookId, remixCount: remixIds.length });
    void refetchBookDistribution(bookId);
    for (const id of remixIds) void refetchRemix(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  const toggleExpand = React.useCallback((key: string) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleToggleVariant = React.useCallback(
    (src: DistSource, channelKey: ChannelKey, leafKey: string, next: boolean, videoType?: VideoType) => {
      const path = leafPath(channelKey, leafKey, videoType);
      log.debug('handleToggleVariant', 'patch draft', { source: src.key, path, next });
      patchDraft((prev) => ({
        ...prev,
        [src.key]: { ...(prev[src.key] ?? {}), [path]: next },
      }));
    },
    [patchDraft],
  );

  const handleExportChannel = React.useCallback(
    async (
      src: DistSource,
      channelKey: ChannelKey,
      videoType?: VideoType,
    ): Promise<EnqueueExportOutcome> => {
      // Export jobs read config from DB → the latest toggles must be persisted first.
      const saved = await ensureSaved();
      if (!saved) {
        log.warn('handleExportChannel', 'ensureSaved failed — aborting export', { id: src.id });
        toast.error('Save failed — export aborted. Please try again.');
        return { kind: 'skipped', reason: 'unsaved_changes' };
      }
      if (channelKey === 'printer') {
        log.info('handleExportChannel', 'start export-pdf', { kind: src.kind, id: src.id });
        return src.kind === 'book'
          ? await startBookExportPdf(src.id, EXPORT_OPTS)
          : await startRemixExportPdf(src.id, EXPORT_OPTS);
      }
      if (channelKey === 'video' && videoType) {
        log.info('handleExportChannel', 'start render-book-video', {
          kind: src.kind,
          id: src.id,
          edition: videoType,
        });
        const opts = { edition: videoType } as const;
        return src.kind === 'book'
          ? await startBookRenderVideo(src.id, opts)
          : await startRemixRenderVideo(src.id, opts);
      }
      return { kind: 'skipped', reason: 'channel_not_exportable_v1' };
    },
    [ensureSaved, startBookExportPdf, startRemixExportPdf, startBookRenderVideo, startRemixRenderVideo],
  );

  const handleViewVariant = React.useCallback(
    async (src: DistSource, channelKey: ChannelKey, leafKey: string, videoType?: VideoType) => {
      const leaf = getLeaf(src.dist, channelKey, leafKey, videoType);

      // Printer PDFs live under the private `exports/` storage prefix — the
      // stored media_url 403s on direct open. Mint a short-lived signed URL
      // from the job that produced the artifact (leaf.last_job_id).
      if (channelKey === 'printer') {
        if (!leaf.last_job_id) {
          log.warn('handleViewVariant', 'printer leaf has no last_job_id', { leafKey });
          return;
        }
        // Open the tab synchronously (inside the click gesture) so popup
        // blockers don't eat it, then point it at the signed URL. No 'noopener'
        // in the features string — that makes window.open return null (spec),
        // which would orphan the blank tab; sever the reverse link manually.
        const tab = window.open('', '_blank');
        if (tab) tab.opener = null;
        const result = await getExportPdfDownloadUrl(leaf.last_job_id);
        if (!result.success) {
          tab?.close();
          log.error('handleViewVariant', 'sign download url failed', {
            leafKey,
            jobId: leaf.last_job_id,
            httpStatus: result.httpStatus,
            errorCode: result.errorCode,
          });
          toast.error(`Could not open PDF: ${result.error}`);
          return;
        }
        if (tab) tab.location.href = result.data.url;
        else window.open(result.data.url, '_blank', 'noopener,noreferrer');
        return;
      }

      if (!leaf.media_url) {
        log.warn('handleViewVariant', 'no media_url', { channelKey, leafKey });
        return;
      }
      // Scheme allowlist — artifact is a trusted public http(s) URL; reject any
      // javascript:/data: from a tampered row before opening.
      if (!/^https?:\/\//i.test(leaf.media_url)) {
        log.warn('handleViewVariant', 'rejected non-http url', { channelKey, leafKey });
        return;
      }
      window.open(leaf.media_url, '_blank', 'noopener,noreferrer');
    },
    [],
  );

  if (!book) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Distribution Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
      <div className="flex flex-col gap-2 overflow-y-auto p-4">
        {sources.map((src) => {
          const views = buildChannelViews(src.dist, draft[src.key] ?? {});
          return (
            <DistributionSourceSection
              key={src.key}
              label={src.label}
              expanded={expandedSources.has(src.key)}
              onToggle={() => toggleExpand(src.key)}
            >
              {views.map((view) => (
                <ChannelExportGroup
                  key={view.groupKey}
                  label={view.label}
                  channelKey={view.channelKey}
                  videoType={view.videoType}
                  variants={view.variants}
                  canExport={view.canExport}
                  anyExporting={view.anyExporting}
                  onExport={() => handleExportChannel(src, view.channelKey, view.videoType)}
                  onToggleVariant={(leafKey, next) =>
                    handleToggleVariant(src, view.channelKey, leafKey, next, view.videoType)
                  }
                  onViewVariant={(leafKey) => {
                    void handleViewVariant(src, view.channelKey, leafKey, view.videoType);
                  }}
                />
              ))}
            </DistributionSourceSection>
          );
        })}
      </div>
    </div>
  );
}
