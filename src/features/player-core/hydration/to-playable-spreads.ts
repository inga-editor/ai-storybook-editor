// to-playable-spreads.ts — Pure snapshot → playback-domain conversions.
//
// Converts the raw snapshot illustration into the shapes PlayableSpreadView
// consumes: PlayableSpread[] (cast + default animations) and Section[].
import type { PlayableSpread } from '@/types/playable-types';
import type { Section } from '@/types/illustration-types';
import type { SnapshotPreviewData } from '@/types/share-preview-types';
import { createLogger } from '@/utils/logger';

const log = createLogger('PlayerCore', 'toPlayableSpreads');

/**
 * Convert snapshot spreads → PlayableSpread[] (direct cast + `animations ?? []`).
 * Returns [] when snapshot is null.
 */
export function toPlayableSpreads(snapshot: SnapshotPreviewData | null): PlayableSpread[] {
  if (!snapshot) return [];
  log.debug('toPlayableSpreads', 'converting spreads', {
    count: snapshot.illustration.spreads.length,
  });
  return snapshot.illustration.spreads.map((raw) => ({
    ...(raw as Omit<PlayableSpread, 'animations'>),
    animations: (raw.animations as PlayableSpread['animations']) ?? [],
  }));
}

/**
 * Extract Section[] from the snapshot illustration (authoritative playback source).
 * Returns [] when snapshot is null.
 */
export function toSections(snapshot: SnapshotPreviewData | null): Section[] {
  if (!snapshot) return [];
  return (snapshot.illustration.sections ?? []) as Section[];
}
