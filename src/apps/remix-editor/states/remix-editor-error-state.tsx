// remix-editor-error-state.tsx — Terminal error screen for the Remix Editor shell. Copy is
// resolved from the hard-coded error-message-table by CODE only — the raw server `message`
// is NEVER rendered (design §4.2 anti-injection). An optional [Thử lại] retries.
import { createLogger } from '@/utils/logger';
import { errorMessageFor } from './error-message-table';
import type { RemixEditorErrorDisplayCode } from '../types/remix-editor-status';

const log = createLogger('RemixEditor', 'ErrorState');

export interface RemixEditorErrorStateProps {
  /** Error code driving the displayed copy. */
  code?: RemixEditorErrorDisplayCode;
  /** When provided, renders a [Thử lại] button invoking this handler. */
  onRetry?: () => void;
}

export function RemixEditorErrorState({ code, onRetry }: RemixEditorErrorStateProps) {
  const copy = errorMessageFor(code);
  log.debug('render', 'error state', { code, hasRetry: onRetry !== undefined });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-center text-slate-100">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span className="text-4xl" aria-hidden="true">
          ⚠️
        </span>
        <p className="text-base font-medium">{copy.title}</p>
        <p className="text-sm text-slate-400">{copy.description}</p>
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
