// use-player-spread-preload.ts
// Sliding window N+1/N+2 media preload for the active player canvas.
// Tier 1 fires after 1000ms (N+1), Tier 2 after 2500ms (N+2). Window is
// recomputed on activeSpreadId / lang / enabled change. Browser HTTP cache is
// the source of truth — this hook only warms it.
//
// Spec: ai-storybook-design/component/editor-page/shared/playable-spread-view/03-11-spread-media-preload.md
'use client';

import { useEffect } from 'react';
import type { PlayableSpread, PlayEdition } from '@/types/playable-types';
import { createLogger } from '@/utils/logger';
import { usePlayerAudioStore } from '@/stores/player-audio-store';
import { collectSpreadMedia, type MediaItem, type MediaKind } from './collect-spread-media';

const log = createLogger('Editor', 'usePlayerSpreadPreload');

const TIER_1_DELAY_MS = 1000;
const TIER_2_DELAY_MS = 2500;
const VIDEO_POLICY = 'metadata' as const;
const URL_LOG_MAX = 80;

interface PreloaderHandle {
  abort: () => void;
}

interface UsePlayerSpreadPreloadParams {
  spreads: PlayableSpread[];
  activeSpreadId: string;
  narrationLangCode: string;
  quizLangCode: string;
  /** Active edition — drives auto_pic preload (classic → static url only). */
  playEdition: PlayEdition;
  /**
   * Stable identifier for the spread source (e.g. `original:<bookId>` or
   * `remix:<remixId>`). Changing this key re-fires the preload window so a
   * source switch (Original ↔ Remix) repopulates the audio pool with the new
   * URL set even when `activeSpreadId` is unchanged.
   */
  sourceKey?: string;
  enabled?: boolean;
}

function truncateUrl(url: string): string {
  if (url.length <= URL_LOG_MAX) return url;
  return `${url.slice(0, 32)}…${url.slice(-32)}`;
}

function countByKind(map: Map<string, MediaItem>): Record<string, number> {
  const counts: Record<string, number> = {};
  map.forEach((item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  });
  return counts;
}

function preload(item: MediaItem): PreloaderHandle {
  switch (item.kind) {
    case 'image':
    case 'auto_pic_img': {
      const img = new Image();
      // fetchPriority is widely supported on Chrome/Edge/Safari 17+; older
      // browsers ignore the unknown property gracefully.
      (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
      img.src = item.url;
      return {
        abort: () => {
          img.src = '';
        },
      };
    }
    case 'audio': {
      // Audio routed through the player-audio-store pool: element is created,
      // mixer-attached, and warmed once; survives across spread advances. The
      // preload tier abort is a no-op because eviction is owned by the store
      // (lang change → releaseAllAudio; player unmount → teardown).
      if (item.channel) {
        usePlayerAudioStore.getState().preloadAudio(item.url, item.channel);
      } else {
        log.warn('preload', 'audio_item_missing_channel', { url: truncateUrl(item.url) });
      }
      return { abort: () => {} };
    }
    case 'video':
    case 'auto_pic_vid': {
      const v = document.createElement('video');
      v.preload = VIDEO_POLICY;
      v.src = item.url;
      return {
        abort: () => {
          v.src = '';
          v.load();
        },
      };
    }
    case 'auto_pic_bin': {
      const ctrl = new AbortController();
      // RequestInit.priority is a non-standard hint — cast to bypass the lib
      // dom typing gap. Browsers without support ignore unknown options.
      const init: RequestInit & { priority?: 'low' | 'high' | 'auto' } = {
        signal: ctrl.signal,
        priority: 'low',
      };
      fetch(item.url, init)
        .then((r) => r.blob())
        .then(() => {
          /* discard — purpose is to warm HTTP cache only */
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          log.warn('preloadFail', 'spread_preload_item_failed', {
            kind: item.kind,
            url: truncateUrl(item.url),
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return {
        abort: () => ctrl.abort(),
      };
    }
    default: {
      // Exhaustiveness check — TS will flag if MediaKind grows.
      const _exhaustive: never = item.kind;
      void _exhaustive;
      return { abort: () => {} };
    }
  }
}

/**
 * Mount inside player canvas subtree; effect re-runs on activeSpreadId or
 * language change. Reads `spreads` at trigger time (intentionally NOT in deps)
 * — book replacement implies spread id change anyway.
 */
export function usePlayerSpreadPreload(params: UsePlayerSpreadPreloadParams): void {
  const {
    spreads,
    activeSpreadId,
    narrationLangCode,
    quizLangCode,
    playEdition,
    sourceKey,
    enabled = true,
  } = params;

  useEffect(() => {
    if (!enabled) return;

    const activeIdx = spreads.findIndex((s) => s.id === activeSpreadId);
    if (activeIdx === -1) {
      log.warn('runEffect', 'spread_preload_active_not_found', { activeSpreadId });
      return;
    }

    const active = spreads[activeIdx];
    const n1 = spreads[activeIdx + 1];
    const n2 = spreads[activeIdx + 2];

    const activeUrls = new Set(
      collectSpreadMedia(active, narrationLangCode, quizLangCode, playEdition).map((i) => i.url),
    );

    const n1Items = collectSpreadMedia(n1, narrationLangCode, quizLangCode, playEdition).filter(
      (i) => !activeUrls.has(i.url),
    );
    const n1Map = new Map<string, MediaItem>(n1Items.map((i) => [i.url, i]));

    const n2Items = collectSpreadMedia(n2, narrationLangCode, quizLangCode, playEdition).filter(
      (i) => !activeUrls.has(i.url) && !n1Map.has(i.url),
    );
    const n2Map = new Map<string, MediaItem>(n2Items.map((i) => [i.url, i]));

    log.info('runEffect', 'spread_preload_window_computed', {
      activeIdx,
      activeSpreadId,
      n1Count: n1Map.size,
      n2Count: n2Map.size,
    });

    const handles: PreloaderHandle[] = [];

    const timer1 = setTimeout(() => {
      n1Map.forEach((item) => handles.push(preload(item)));
      log.info('tier1Fire', 'spread_preload_tier1_started', {
        spreadId: n1?.id,
        count: n1Map.size,
        kinds: countByKind(n1Map),
      });
    }, TIER_1_DELAY_MS);

    const timer2 = setTimeout(() => {
      n2Map.forEach((item) => handles.push(preload(item)));
      log.info('tier2Fire', 'spread_preload_tier2_started', {
        spreadId: n2?.id,
        count: n2Map.size,
        kinds: countByKind(n2Map),
      });
    }, TIER_2_DELAY_MS);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      handles.forEach((h) => h.abort());
      log.debug('cleanup', 'spread_preload_cleanup', {
        activeSpreadId,
        aborted: handles.length,
      });
    };
    // `spreads` is intentionally not a dep: we read it at trigger time. Adding
    // it would re-fire on every parent re-render that produces a new array
    // identity even when content is unchanged. Source switches are signaled by
    // `sourceKey` instead (Original ↔ Remix toggles the spread set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpreadId, narrationLangCode, quizLangCode, playEdition, sourceKey, enabled]);
}

export type { MediaKind };
