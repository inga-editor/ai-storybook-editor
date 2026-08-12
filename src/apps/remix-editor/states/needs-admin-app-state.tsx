// needs-admin-app-state.tsx — Shown when there is no editor session and one cannot be
// established here (the Remix Editor is entered ONLY via a handoff from the Admin App).
// Offers a deeplink back to the Admin App.
//
// Phase 04: the deeplink now carries return context via `buildAdminAppReturnUrl()`
// (bookId / remixId folded in) instead of the raw env URL. When no Admin App URL is
// configured the button renders GREYED + disabled (repo UI convention — never hidden).
// Store-free, no I/O.
import { createLogger } from '@/utils/logger';
import { buildAdminAppReturnUrl } from '../auth/use-editor-session';

const log = createLogger('RemixEditor', 'NeedsAdminAppState');

export function NeedsAdminAppState() {
  // Pure read of window.location + env — safe in render.
  const returnUrl = buildAdminAppReturnUrl();
  const hasAdminAppUrl = returnUrl.length > 0;
  log.debug('render', 'needs admin app', { hasAdminAppUrl });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-center text-slate-100">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span className="text-4xl" aria-hidden="true">
          🔐
        </span>
        <p className="text-base font-medium">Cần mở từ Admin App</p>
        <p className="text-sm text-slate-400">
          Trình chỉnh sửa Remix chỉ mở được thông qua Admin App. Vui lòng quay lại và mở từ đó.
        </p>
        {hasAdminAppUrl ? (
          <a
            href={returnUrl}
            className="mt-2 rounded-md bg-slate-100 px-4 py-1.5 text-sm font-medium text-slate-900 transition-colors hover:bg-white"
          >
            Mở Admin App
          </a>
        ) : (
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="mt-2 cursor-not-allowed rounded-md bg-slate-700 px-4 py-1.5 text-sm font-medium text-slate-400 opacity-60"
          >
            Mở Admin App
          </button>
        )}
      </div>
    </div>
  );
}
