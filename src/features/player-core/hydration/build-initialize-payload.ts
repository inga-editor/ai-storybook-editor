// build-initialize-payload.ts — Pure builder for the playback `InitializePayload`.
//
// Computes the default edition (highest available) + resolved language, then
// applies optional player overrides. The `sessionId` is supplied BY THE CALLER
// (`share:<id>` vs `player:<id>`) — the helper never guesses the prefix.
import type {
  AvailableEditions,
  InitializePayload,
} from '@/stores/animation-playback-store';
import type { PlayableSpread, PlayEdition } from '@/types/playable-types';
import type { LanguageOption } from './resolve-view-options';
import { createLogger } from '@/utils/logger';

const log = createLogger('PlayerCore', 'buildInitializePayload');

export interface BuildInitializePayloadInput {
  /** Caller-supplied session id, e.g. `share:<id>` or `player:<id>`. */
  sessionId: string;
  /** Converted spreads (empty → no payload). */
  spreads: PlayableSpread[];
  /** Resolved edition availability (all-true fallback already applied). */
  availableEditions: AvailableEditions;
  /** Raw language list (empty → falls back to originalLanguage). */
  languages: LanguageOption[];
  /** Book original language, used as the language fallback. */
  originalLanguage: string;
  /** Player init: explicit language override (share passes undefined). */
  languageOverride?: string;
  /** Player init: explicit edition override — applied ONLY if ∈ enabled editions. */
  editionOverride?: PlayEdition;
  /** Player init: explicit start spread (share passes undefined → first spread). */
  startSpreadId?: string;
}

// Highest-available edition: interactive > dynamic > classic.
function defaultEdition(editions: AvailableEditions): PlayEdition {
  return editions.interactive ? 'interactive' : editions.dynamic ? 'dynamic' : 'classic';
}

/**
 * Build the atomic `InitializePayload`. Returns null when there are no spreads.
 */
export function buildInitializePayload(
  input: BuildInitializePayloadInput,
): InitializePayload | null {
  const {
    sessionId,
    spreads,
    availableEditions,
    languages,
    originalLanguage,
    languageOverride,
    editionOverride,
    startSpreadId,
  } = input;

  if (spreads.length === 0) {
    log.debug('buildInitializePayload', 'skip: no spreads');
    return null;
  }

  // Edition: override wins ONLY if it is an enabled edition; else highest-available default.
  const fallbackEdition = defaultEdition(availableEditions);
  const overrideEnabled =
    editionOverride !== undefined && availableEditions[editionOverride] === true;
  const edition: PlayEdition = overrideEnabled
    ? (editionOverride as PlayEdition)
    : fallbackEdition;
  if (editionOverride !== undefined && !overrideEnabled) {
    log.warn('buildInitializePayload', 'edition override outside enabled — ignored', {
      editionOverride,
    });
  }

  // Language: explicit override → first configured language → book original → en_US.
  const language = languageOverride ?? languages[0]?.code ?? originalLanguage ?? 'en_US';

  const resolvedStart = startSpreadId ?? spreads[0].id;

  log.info('buildInitializePayload', 'payload built', {
    sessionId,
    edition,
    language,
    spreadCount: spreads.length,
  });

  return {
    sessionId,
    language,
    edition,
    availableEditions,
    startSpreadId: resolvedStart,
  };
}
