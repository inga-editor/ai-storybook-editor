// config-missing-state.tsx — Shown when the session is authed and the book bundle loaded,
// but the book has no remix configuration to edit yet (bundleStatus === 'config_missing').
// A dead-end informational screen (remix config is provisioned by the Admin App).
// Store-free, no I/O.
import { createLogger } from '@/utils/logger';

const log = createLogger('RemixEditor', 'ConfigMissingState');

export function ConfigMissingState() {
  log.debug('render', 'config missing state');
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-center text-slate-100">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span className="text-4xl" aria-hidden="true">
          🗂️
        </span>
        <p className="text-base font-medium">Chưa có cấu hình remix</p>
        <p className="text-sm text-slate-400">
          Sách này chưa được thiết lập cấu hình remix. Vui lòng thiết lập trong Admin App trước khi
          chỉnh sửa.
        </p>
      </div>
    </div>
  );
}
