// use-music-media-url.ts — Thin wrapper around shared `useAudioMediaUrl`.
// Resolves `book.music.background_id` (UUID) → media_url via `useMusicsStore`.

import { useAudioMediaUrl } from '@/features/audio-library/hooks/use-audio-media-url';
import { useMusicsStore } from '@/stores/musics-store';

export function useMusicMediaUrl(backgroundId: string | null): string | null {
  return useAudioMediaUrl(useMusicsStore, backgroundId, 'music');
}
