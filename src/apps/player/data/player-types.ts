// player-types.ts — Player data-layer contract. The rest of the sub-app knows only
// `PlayableBookPayload` + `PlayerDataSource`; all token/HTTP details stay in player-api.ts.
//
// Contract = share/01 shape with `shareConfig` → `viewConfig` + a `contractVersion` field,
// so we REUSE `BookPreviewData` / `SnapshotPreviewData` (do not redefine them).
// SSOT: ai-storybook-python-api/src/routers/player/get_book_preview.py (code wins over spec).

import type { BookPreviewData, SnapshotPreviewData } from '@/types/share-preview-types';
import type { PlayerErrorCode } from '../embed/player-messages';

/** Which editions + languages the consumer enabled for this book (book-level projection). */
export interface PlayerViewConfig {
  editions: { classic: boolean; dynamic: boolean; interactive: boolean };
  /** `name` is `""` in book mode → UI must fall back to `code` (`name || code`). */
  languages: { name: string; code: string }[];
}

export interface PlayableBookPayload {
  /** Observability only — logged, NEVER used to gate parsing (parse stays lenient). */
  contractVersion: number;
  viewConfig: PlayerViewConfig;
  book: BookPreviewData;
  /** Defensive nullable (design 02) — backend never returns null on 200; no-snapshot ⇒ 404. */
  snapshot: SnapshotPreviewData | null;
}

/** The single I/O seam for the sub-app. Phase 07 depends only on this interface. */
export interface PlayerDataSource {
  /** @param signal optional AbortSignal so the caller can cancel an in-flight request. */
  loadPlayableBook(signal?: AbortSignal): Promise<PlayableBookPayload>;
}

/**
 * Typed error thrown by the data source. `code` is the mapped `PlayerErrorCode`;
 * `retryAfterSeconds` is populated from the `Retry-After` header on 429 (UI hint).
 */
export class PlayerApiError extends Error {
  readonly code: PlayerErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: PlayerErrorCode, retryAfterSeconds?: number) {
    super(`Player API error: ${code}`);
    this.name = 'PlayerApiError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
