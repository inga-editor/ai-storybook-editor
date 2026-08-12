// remix-editor-loading-state.tsx — Full-screen loading placeholder for the Remix Editor
// shell. Shown while booting / exchanging a session, or while the book bundle is loading.
// Store-free, no I/O.
import { createLogger } from '@/utils/logger';

const log = createLogger('RemixEditor', 'LoadingState');

export interface RemixEditorLoadingStateProps {
  /** Optional caption (defaults to a generic loading line). */
  caption?: string;
}

export function RemixEditorLoadingState({ caption }: RemixEditorLoadingStateProps) {
  log.debug('render', 'loading state', { hasCaption: caption !== undefined });
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-slate-100"
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-slate-300">{caption ?? 'Đang chuẩn bị trình chỉnh sửa…'}</p>
      </div>
    </div>
  );
}
