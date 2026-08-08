// use-sound-media-url.ts — Thin wrapper around shared `useAudioMediaUrl`.
// Resolves a `book.sound.*_id` (UUID) → media_url via `useSoundsStore`.

import { useAudioMediaUrl } from '@/features/audio-library/hooks/use-audio-media-url';
import { useSoundsStore } from '@/stores/sounds-store';

export function useSoundMediaUrl(soundId: string | null): string | null {
  return useAudioMediaUrl(useSoundsStore, soundId, 'sound');
}
