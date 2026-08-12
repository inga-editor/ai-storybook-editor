// remix-editor-shell.tsx — Thin ready-state frame around `RemixCreativeSpace`.
//
// EXACTLY 2 providers, no more/less (parity with editor-page.tsx:371-372):
//   TooltipProvider(delay 300) → InteractionLayerProvider → RemixCreativeSpace.
// Dropping InteractionLayerProvider BREAKS the canvas toolbar + selection (not a
// cosmetic bug). We deliberately do NOT mount EditHistoryBridge, icon-rail, space
// switcher, save-status, or collab UI — the remix surface writes straight through
// the gateway (no edit-history / save-session plane).
//
// `RemixCreativeSpace` takes NO props (it reads the stores directly). The space
// lives in a `flex-1 min-h-0 overflow-hidden` cell — omitting `min-h-0` lets the
// canvas overflow the viewport (classic flexbox trap).
//
// `sessionExpired` raises an overlay that sits ABOVE the surface's own modals and
// does NOT unmount the space (dirty state preserved). `[Đóng]` hides the modal
// locally; the expired flag itself stays owned by the caller.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/05-remix-editor-shell.md.
import { useState } from 'react';
import { Toaster } from 'sonner';
import { createLogger } from '@/utils/logger';
import { TooltipProvider } from '@/components/ui/tooltip';
import { InteractionLayerProvider } from '@/features/editor/contexts';
import { RemixCreativeSpace } from '@/features/editor/components/remix-creative-space';
import { RemixEditorHeader } from './remix-editor-header';
import { SessionExpiredModal } from './session-expired-modal';
import { SessionExpiresSoonBanner } from './session-expires-soon-banner';
import { usePreselectRemix } from './use-preselect-remix';

const log = createLogger('RemixEditor', 'RemixEditorShell');

export interface RemixEditorShellProps {
  bookTitle: string;
  adminDisplay: string;
  /** `?remix=<id>` deeplink — applied once after the first store sync. */
  preselectRemixId?: string;
  sessionExpired: boolean;
  /** Within 15 min of expiry — shows the "save your work" banner (ADR-053). */
  expiresSoon: boolean;
  /** Re-authorize via the Admin App in a new tab (header + expired modal). */
  onOpenAdminApp: () => void;
}

export function RemixEditorShell({
  bookTitle,
  adminDisplay,
  preselectRemixId,
  sessionExpired,
  expiresSoon,
  onOpenAdminApp,
}: RemixEditorShellProps) {
  // Local dismissal of the expired overlay — hides the modal without unmounting
  // the space; the `sessionExpired` flag stays owned by the caller.
  const [expiredModalDismissed, setExpiredModalDismissed] = useState(false);

  usePreselectRemix(preselectRemixId);

  log.info('render', 'remix editor shell', {
    hasPreselect: preselectRemixId != null,
    sessionExpired,
    expiresSoon,
    expiredModalDismissed,
  });

  return (
    <div className="flex h-screen w-screen max-w-full flex-col overflow-hidden bg-slate-950">
      <RemixEditorHeader
        bookTitle={bookTitle}
        adminDisplay={adminDisplay}
        onOpenAdminApp={onOpenAdminApp}
      />

      {/* Informational expiry warning — never gates any UI (ADR-053). Suppressed once the
          session is fully expired (the modal below takes over). */}
      {expiresSoon && !sessionExpired && <SessionExpiresSoonBanner />}

      {/* Space cell — `min-h-0` keeps the canvas from overflowing the column. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <TooltipProvider delayDuration={300}>
          <InteractionLayerProvider>
            <RemixCreativeSpace />
          </InteractionLayerProvider>
        </TooltipProvider>
      </div>

      {sessionExpired && !expiredModalDismissed && (
        <SessionExpiredModal
          onReauthorize={onOpenAdminApp}
          onDismiss={() => setExpiredModalDismissed(true)}
        />
      )}

      {/* Toast host for the sub-app (preselect-not-found + surface toasts). */}
      <Toaster position="top-center" richColors />
    </div>
  );
}
