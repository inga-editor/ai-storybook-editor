// remix-editor-header.tsx — Minimal fixed-height header for the Remix Editor
// sub-app: [◄ Admin App] · 📖 {book title} · 👤 {adminDisplay}.
//
// Deliberately thin vs the main EditorHeader: NO icon-rail, space switcher,
// save-status, undo/redo, or collab UI — the remix surface mutates straight
// through the gateway (no edit-history / save-session). The Admin App control
// opens a NEW tab (the callback wraps `buildAdminAppReturnUrl` + `window.open`
// with noopener) so the editing screen isn't lost.
//
// `adminDisplay` is `admin_name` (or "Admin") — never `admin_ref` / token bits.
import { createLogger } from '@/utils/logger';
import { Button } from '@/components/ui/button';

const log = createLogger('RemixEditor', 'RemixEditorHeader');

interface RemixEditorHeaderProps {
  bookTitle: string;
  adminDisplay: string;
  /** Opens the Admin App return deeplink in a new tab (built at the app root). */
  onOpenAdminApp: () => void;
}

export function RemixEditorHeader({
  bookTitle,
  adminDisplay,
  onOpenAdminApp,
}: RemixEditorHeaderProps) {
  log.debug('render', 'remix editor header', {
    hasTitle: bookTitle.length > 0,
  });

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-950 px-4 text-slate-100">
      {/* Left — back to Admin App (new tab). */}
      <div className="flex min-w-0 flex-1 items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenAdminApp}
          className="gap-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <span aria-hidden="true">◄</span>
          <span>Admin App</span>
        </Button>
      </div>

      {/* Center — book title. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        <span aria-hidden="true">📖</span>
        <span className="truncate text-sm font-medium" title={bookTitle}>
          {bookTitle}
        </span>
      </div>

      {/* Right — signed-in admin display. */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-sm text-slate-300">
        <span aria-hidden="true">👤</span>
        <span className="truncate" title={adminDisplay}>
          {adminDisplay}
        </span>
      </div>
    </header>
  );
}
