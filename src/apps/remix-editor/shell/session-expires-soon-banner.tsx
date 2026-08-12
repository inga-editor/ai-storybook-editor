// session-expires-soon-banner.tsx — Informational, dismissible in-session banner shown when
// the editor session is within 15 min of expiry (`expiresSoon`).
//
// ADR-053: expiry is one-way (no refresh) — the only defence against lost work is warning the
// admin early to SAVE. Per project convention it does NOT hide/disable any UI: it purely warns
// "Phiên hết hạn lúc {HH:mm} — hãy save công việc". `[Đóng]` hides it locally for the rest of
// the session (the caller still owns the `expiresSoon` flag).
//
// Rendered by the shell only when `expiresSoon && !sessionExpired` (once truly expired the
// SessionExpiredModal takes over).
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/01-editor-auth-module.md §2.3.
import { useState } from 'react';
import { createLogger } from '@/utils/logger';
import { getExpiresAtMs } from '../auth/editor-session-keeper';

const log = createLogger('RemixEditor', 'SessionExpiresSoonBanner');

/** Format an epoch-ms as a local `HH:mm` clock label. */
function formatClock(epochMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(epochMs));
  } catch {
    return '--:--';
  }
}

export function SessionExpiresSoonBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const expiresAtLabel = formatClock(getExpiresAtMs());
  log.debug('render', 'expires-soon banner', { expiresAtLabel });

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-3 bg-amber-500/95 px-4 py-2 text-sm font-medium text-slate-950"
    >
      <span>Phiên hết hạn lúc {expiresAtLabel} — hãy save công việc.</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded bg-slate-950/10 px-2 py-0.5 text-xs font-semibold hover:bg-slate-950/20"
      >
        Đóng
      </button>
    </div>
  );
}
