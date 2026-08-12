// remix-editor-status.ts — Shared status/route/error types for the Remix Editor sub-app
// (Vite entry #3). No React, no I/O here — pure type + status-derivation vocabulary so
// both the app shell and its unit tests import from one source of truth.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/README.md §2, §4.2.

/** The shell's render status (7 states per design §2). */
export type RemixEditorAppStatus =
  | 'booting'
  | 'exchanging'
  | 'needs_admin_app'
  | 'loading'
  | 'config_missing'
  | 'ready'
  | 'error';

/**
 * Editor-session lifecycle status owned by the auth module. The non-authed values map 1:1
 * onto RemixEditorAppStatus; `authed` hands control to the bundle/data layer. ADR-053: no
 * `resuming` state — resume from sessionStorage is a synchronous local `exp` check (0 network)
 * that lands straight on `authed`.
 */
export type EditorSessionStatus = 'booting' | 'exchanging' | 'needs_admin_app' | 'authed';

/**
 * Book-bundle load status owned by the (Phase 06) data layer. Phase 03 stubs this at
 * `idle`.
 */
export type BundleStatus = 'idle' | 'loading' | 'config_missing' | 'error' | 'ready';

/** Parsed route params from `/book/:bookId?remix=:id`. */
export interface RemixEditorRouteParams {
  bookId: string;
  preselectRemixId?: string;
}

/**
 * Server/protocol error codes (design §4.2). NEVER surfaced verbatim — mapped to
 * hard-coded copy via error-message-table.ts (anti-injection).
 */
export type RemixEditorErrorCode =
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'HANDOFF_INVALID'
  | 'SESSION_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NETWORK'
  | 'SERVER';

/**
 * Error codes the error STATE can display. Superset of the protocol codes with
 * route-level `BOOK_ID_MISSING` (URL had no valid `/book/:bookId`).
 */
export type RemixEditorErrorDisplayCode = RemixEditorErrorCode | 'BOOK_ID_MISSING';

/** Result of the pure status-derivation function. */
export interface RemixEditorDerivedState {
  status: RemixEditorAppStatus;
  /** Present only when `status === 'error'`. */
  errorCode?: RemixEditorErrorDisplayCode;
}
