// collect-spread-media.ts
// Pure collector that walks a PlayableSpread and returns a flat list of
// MediaItem entries the preload hook will consume. Zero side-effects.
//
// Spec: ai-storybook-design/component/editor-page/shared/playable-spread-view/03-11-spread-media-preload.md §4
// Auto-pic kind classification by URL extension:
//   .webp → image, .webm → video metadata, .lottie/.riv → binary fetch.

import type { PlayableSpread, PlayEdition } from '@/types/playable-types';
import type { SpreadTextboxContent } from '@/types/spread-types';
import { EFFECT_TYPE } from '@/constants/playable-constants';
import { resolveEffectiveStaticUrl } from '@/features/editor/components/playable-spread-view/resolve-auto-pic-display-source';
import { getTextboxContentForLanguage } from '@/features/editor/utils/textbox-helpers';
import { createLogger } from '@/utils/logger';
import type { AudioChannel } from '@/features/editor/components/playable-spread-view/audio/audio-mixer-types';
import {
  getQuizLangContent,
  getQuizItems,
  getQuizItemImage,
  getQuizItemLangContent,
  getQuizDecorImages,
  getQuizBackgroundImage,
} from './quiz-schema-accessors';

const log = createLogger('Editor', 'collectSpreadMedia');

export type MediaKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'auto_pic_img'
  | 'auto_pic_vid'
  | 'auto_pic_bin';

export interface MediaItem {
  url: string;
  kind: MediaKind;
  /** Required when kind === 'audio'; routes element to the right mixer gain. */
  channel?: AudioChannel;
}

function classifyAutoPicExt(mediaUrl: string): MediaKind | undefined {
  const noQuery = mediaUrl.split('?')[0];
  const ext = noQuery.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'webp':
      return 'auto_pic_img';
    case 'webm':
      return 'auto_pic_vid';
    case 'lottie':
    case 'riv':
      return 'auto_pic_bin';
    default:
      return undefined;
  }
}

/**
 * Collect all preload-eligible media URLs in a spread.
 * Caller is responsible for inter-spread dedupe; this returns flat list in
 * traversal order. Empty/null URLs are skipped silently.
 */
export function collectSpreadMedia(
  spread: PlayableSpread | undefined,
  narrationLangCode: string,
  quizLangCode: string,
  playEdition: PlayEdition,
): MediaItem[] {
  if (!spread) return [];
  const items: MediaItem[] = [];
  const pushIfUrl = (
    url: string | null | undefined,
    kind: MediaKind,
    channel?: AudioChannel,
  ): void => {
    if (typeof url === 'string' && url.length > 0) {
      items.push({ url, kind, channel });
    }
  };

  // Static images
  for (const img of spread.images ?? []) {
    pushIfUrl(img.media_url, 'image');
  }

  // Auto-pics: edition-aware.
  //   classic → preload the effective STATIC url only (never the animated
  //             media_url — classic never renders it, saves bandwidth).
  //   dynamic/interactive → classify the animated media_url by extension.
  for (const ap of spread.auto_pics ?? []) {
    if (playEdition === 'classic') {
      const staticUrl = resolveEffectiveStaticUrl(ap.static_image);
      if (staticUrl) pushIfUrl(staticUrl, 'auto_pic_img');
      // classic never preloads the animated file — always continue.
      continue;
    }
    if (!ap.media_url) continue;
    const kind = classifyAutoPicExt(ap.media_url);
    if (kind) {
      pushIfUrl(ap.media_url, kind);
    } else {
      log.debug('collectSpreadMedia', 'auto_pic skipped: unknown ext', {
        spreadId: spread.id,
        url: ap.media_url,
      });
    }
  }

  // Videos (metadata-only preload)
  for (const v of spread.videos ?? []) {
    pushIfUrl(v.media_url, 'video');
  }

  // Channel routing rules (verified against existing components):
  //   spread.audios       → editable-audio.tsx       → 'sfx'
  //   spread.auto_audios  → editable-auto-audio.tsx  → 'sfx'
  //   quiz audio          → use-quiz-audio.ts        → 'narration'
  //   read-along (textbox)→ animation-tween-builders → 'narration'
  for (const a of spread.audios ?? []) {
    pushIfUrl(a.media_url, 'audio', 'sfx');
  }
  for (const aa of spread.auto_audios ?? []) {
    pushIfUrl(aa.media_url, 'audio', 'sfx');
  }

  for (const q of spread.quizzes ?? []) {
    const qLang = getQuizLangContent(q, quizLangCode);
    pushIfUrl(qLang?.audio_url, 'audio', 'narration');

    for (const item of getQuizItems(q)) {
      pushIfUrl(getQuizItemImage(item), 'image');
      pushIfUrl(
        getQuizItemLangContent(item, quizLangCode)?.audio_url,
        'audio',
        'narration',
      );
    }

    for (const decorUrl of getQuizDecorImages(q)) {
      pushIfUrl(decorUrl, 'image');
    }

    pushIfUrl(getQuizBackgroundImage(q), 'image');
  }

  // Read-along narration audio (per animation effect)
  for (const anim of spread.animations ?? []) {
    if (anim.effect.type !== EFFECT_TYPE.READ_ALONG) continue;
    if (anim.target.type !== 'textbox') continue;
    const tb = spread.textboxes?.find((t) => t.id === anim.target.id);
    if (!tb) continue;
    const res = getTextboxContentForLanguage(
      tb as unknown as Record<string, unknown>,
      narrationLangCode,
    );
    const content = res?.content as SpreadTextboxContent | undefined;
    pushIfUrl(content?.audio?.combined_audio_url, 'audio', 'narration');
  }

  return items;
}
