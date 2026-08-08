// empty-snapshot-state.tsx — Rendered when a loaded book has a null snapshot.
//
// NOTE: unreachable with the real backend — a book without a snapshot returns 404
// `NOT_FOUND` (→ error state), never a 200 with `snapshot: null` (phase-07 §Insight 6).
// Kept as a cheap, design-faithful branch guarding a hypothetical future backend.
import { createLogger } from '@/utils/logger';

const log = createLogger('Player', 'EmptySnapshotState');

export interface EmptySnapshotStateProps {
  title: string;
}

export function EmptySnapshotState({ title }: EmptySnapshotStateProps) {
  log.debug('render', 'empty snapshot state');
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 bg-slate-950 px-6 text-center text-slate-300">
      <span className="text-4xl" aria-hidden="true">
        📭
      </span>
      <p className="text-base font-medium text-slate-100">{title}</p>
      <p className="text-sm">Sách chưa có nội dung</p>
    </div>
  );
}
