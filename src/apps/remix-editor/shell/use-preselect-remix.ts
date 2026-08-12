// use-preselect-remix.ts — Applies the `?remix=<id>` deeplink selection EXACTLY
// ONCE, after the remix store's first successful server sync.
//
// Why gated on `hasSyncedOnce` (not `remixes.length`): an empty list before the
// first sync is indistinguishable from a genuinely-empty book — preselecting
// "not found" too early would fire a spurious toast. `hasSyncedOnce` flips in the
// SAME commit that populates `remixes`, so when it is true the list is authoritative.
//
// Apply-once is guarded by a ref (survives the re-render the `setActiveRemixId`
// commit triggers). We NEVER sync the selection back to the URL — the sidebar owns
// selection afterward, and mirroring it would churn history (YAGNI).
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/05-remix-editor-shell.md.
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import { useHasSyncedOnce, useRemixes, useRemixStore } from '@/stores/remix-store';

const log = createLogger('RemixEditor', 'UsePreselectRemix');

/**
 * One-shot preselect of a deeplinked remix id. No-op when `preselectRemixId` is
 * undefined. After the first successful sync: selects the remix if present, else
 * toasts and keeps the sidebar default. Idempotent across re-renders (ref guard).
 */
export function usePreselectRemix(preselectRemixId: string | undefined): void {
  const hasSyncedOnce = useHasSyncedOnce();
  const remixes = useRemixes();
  const appliedRef = useRef(false);

  useEffect(() => {
    if (!preselectRemixId || appliedRef.current || !hasSyncedOnce) {
      return;
    }
    // Claim the one-shot slot BEFORE mutating so the selection-triggered re-render
    // cannot re-enter this branch (apply-once, even as `remixes` ref changes).
    appliedRef.current = true;

    const exists = remixes.some((r) => r.id === preselectRemixId);
    if (exists) {
      log.info('apply', 'preselect remix', { preselectRemixId });
      useRemixStore.getState().setActiveRemixId(preselectRemixId);
    } else {
      log.warn('apply', 'preselect remix not found — keep default', {
        preselectRemixId,
      });
      toast.error('Remix không tồn tại');
    }
  }, [preselectRemixId, hasSyncedOnce, remixes]);
}
