// player-message-state.tsx — Shared minimal message screen for the Player shell.
// Used for both `token_missing` and `error` statuses. Intentionally has NO
// "back to home" link (the sub-app is embedded — there is no home). An optional
// `onRetry` renders a [Thử lại] button (error state → calls `reload()`).
import { createLogger } from '@/utils/logger';

const log = createLogger('Player', 'PlayerMessageState');

export interface PlayerMessageStateProps {
  /** Headline text — a hardcoded, code-derived string (never the raw server message). */
  title: string;
  /** Optional secondary line. */
  description?: string;
  /** When provided, renders a [Thử lại] button invoking this handler. */
  onRetry?: () => void;
}

export function PlayerMessageState({ title, description, onRetry }: PlayerMessageStateProps) {
  log.debug('render', 'message state', { hasRetry: onRetry !== undefined });
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-center text-slate-100">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span className="text-4xl" aria-hidden="true">
          📕
        </span>
        <p className="text-base font-medium">{title}</p>
        {description && <p className="text-sm text-slate-400">{description}</p>}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded-md bg-slate-100 px-4 py-1.5 text-sm font-medium text-slate-900 transition-colors hover:bg-white"
          >
            Thử lại
          </button>
        )}
      </div>
    </div>
  );
}
