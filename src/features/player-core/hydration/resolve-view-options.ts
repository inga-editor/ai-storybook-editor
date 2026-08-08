// resolve-view-options.ts — Pure resolution of edition/language view constraints.
//
// editions: an all-false/absent config means "no constraint" → all-true.
// languages: an empty list means "no constraint" → undefined (show all).
import type { AvailableEditions } from '@/stores/animation-playback-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('PlayerCore', 'resolveViewOptions');

/** Language entry shared by share config and player init options. */
export interface LanguageOption {
  name: string;
  code: string;
}

/**
 * Resolve available editions: an empty/all-false object → all three enabled;
 * otherwise return the config as-is.
 */
export function resolveAvailableEditions(editions: AvailableEditions): AvailableEditions {
  if (!editions.classic && !editions.dynamic && !editions.interactive) {
    log.debug('resolveAvailableEditions', 'all-false → all-true fallback');
    return { classic: true, dynamic: true, interactive: true };
  }
  return editions;
}

/**
 * Resolve available languages: empty list → undefined (no constraint, show all).
 */
export function resolveAvailableLanguages(
  languages: LanguageOption[],
): LanguageOption[] | undefined {
  return languages.length > 0 ? languages : undefined;
}
