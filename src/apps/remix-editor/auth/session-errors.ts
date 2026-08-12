// session-errors.ts — Typed errors for the Remix Editor auth module.
//
// `SessionExpiredError` is thrown when a silent refresh fails. It propagates up to the
// caller (a pending mutation) so dirty in-store state is KEPT (auth spec §3.4) — the shell
// shows a "re-open from Admin App" modal instead of destroying work. `AdminAuthError`
// carries a `RemixEditorErrorCode` so the boot flow can branch (HANDOFF_INVALID vs
// SESSION_EXPIRED vs NETWORK) without string-matching messages.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/01-editor-auth-module.md §2.4.
import type { RemixEditorErrorCode } from '../types/remix-editor-status';

/** Thrown when the editor session cannot be refreshed (silent-refresh failure). */
export class SessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED' as const;
  constructor(message = 'Editor session expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** Thrown by the Admin-App auth client; `code` maps upstream failures to a display code. */
export class AdminAuthError extends Error {
  readonly code: RemixEditorErrorCode;
  readonly httpStatus?: number;
  constructor(code: RemixEditorErrorCode, message?: string, httpStatus?: number) {
    super(message ?? code);
    this.name = 'AdminAuthError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
