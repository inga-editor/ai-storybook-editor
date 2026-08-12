// derive-remix-editor-status.ts — Pure status-derivation for the Remix Editor shell.
// Kept in its own module (not the component file) so React Fast Refresh stays happy and so
// the derivation table is unit-testable in isolation. NO React, no I/O.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/README.md §4.2.
import type {
  BundleStatus,
  EditorSessionStatus,
  RemixEditorErrorCode,
  RemixEditorDerivedState,
  RemixEditorRouteParams,
} from './types/remix-editor-status';

/**
 * Derive the shell's render status from (route, sessionStatus, bundleStatus). Order
 * matters: a missing/invalid route short-circuits to a route-level error before session/
 * bundle are consulted. Non-authed session statuses map 1:1 onto app statuses; once
 * authed, the bundle status drives the UI.
 *
 * `bundleErrorCode` (Phase 06) surfaces the concrete bundle failure code when
 * `bundleStatus === 'error'`; it defaults to 'SERVER' when omitted (back-compat).
 */
export function deriveRemixEditorStatus(
  route: RemixEditorRouteParams | null,
  sessionStatus: EditorSessionStatus,
  bundleStatus: BundleStatus,
  bundleErrorCode?: RemixEditorErrorCode,
): RemixEditorDerivedState {
  if (route === null) {
    return { status: 'error', errorCode: 'BOOK_ID_MISSING' };
  }
  if (sessionStatus !== 'authed') {
    // 'booting' | 'exchanging' | 'needs_admin_app' — all valid app statuses.
    return { status: sessionStatus };
  }
  switch (bundleStatus) {
    case 'idle':
    case 'loading':
      return { status: 'loading' };
    case 'config_missing':
      return { status: 'config_missing' };
    case 'error':
      return { status: 'error', errorCode: bundleErrorCode ?? 'SERVER' };
    case 'ready':
      return { status: 'ready' };
  }
}
