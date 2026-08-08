// player-loading-state.tsx — Full-screen loading placeholder for the Player shell.
// Shown while booting / waiting for a token / fetching the book. Store-free.
import { createLogger } from '@/utils/logger';

const log = createLogger('Player', 'PlayerLoadingState');

export function PlayerLoadingState() {
  log.debug('render', 'loading state');
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-slate-100"
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-slate-300">Đang tải nội dung…</p>
      </div>
    </div>
  );
}
