// use-base-sheet-generate-notifications.ts — watches the base-sheet generate ops MAP (⚡REV
// 2026-08-21: keyed by GROUP KEY, groups run in parallel) and fires ONE error toast per group when
// that op settles with an error, then dismisses it. SUCCESS is intentionally silent (per-style
// inline status is enough — one style generated per run); partial-crop warnings are toasted by the
// slice itself. Mount once at editor-page level so the toast fires regardless of which creative
// space is active. Also feeds the cross-space guard indirectly via useIsAnySketchGenerating.

import { useEffect, useRef } from 'react';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'BaseSheetGenerateNotifications');

/**
 * Side-effect-only hook. React 19: prevRef is read/written ONLY inside the effect body (never in the
 * render body). It holds the last seen error PER GROUP, so two groups failing produce two toasts and
 * neither suppresses the other. Rebuilt from the current map each run → dismissed keys drop out.
 */
export function useBaseSheetGenerateNotifications(): void {
  const prevErrorsRef = useRef<Record<string, string>>({});
  const ops = useSnapshotStore((s) => s.baseSheetGenerateOps);
  const base = useSnapshotStore((s) => s.sketch.base);

  useEffect(() => {
    const prev = prevErrorsRef.current;
    const next: Record<string, string> = {};

    for (const [group, op] of Object.entries(ops)) {
      if (!op?.error) continue;
      next[group] = op.error;
      if (prev[group] === op.error) continue; // already toasted this exact failure
      const label = base[group]?.name ?? group;
      log.warn('toast', 'base sheet op error', { group, styleIndex: op.styleIndex });
      toast.error(`${label}: ${op.error}`);
      useSnapshotStore.getState().dismissBaseSheetGenerateError(group);
    }

    prevErrorsRef.current = next;
  }, [ops, base]);
}
