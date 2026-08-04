import { useEffect } from 'react';
import { useSnapshotActions } from '@/stores/snapshot-store';
import { useSaveSessionStore } from '@/stores/save-session-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useFlushOnHidden');

/**
 * Flush dirty state when the page becomes hidden (tab switch, minimize,
 * mobile background, reload, tab close). `visibilitychange → hidden` is the
 * most reliable "page may disappear" signal — fires earlier than beforeunload
 * and works on mobile Safari (which barely fires beforeunload).
 *
 * TWO fire-and-forget branches, each self-guarded so both are harmless when N/A:
 *   • autoSaveSnapshot() — solo/owner-direct whole-snapshot draft. Self-disables under
 *     collabPersist, so it's the SOLO net.
 *   • save-session flushAllOnHidden() — the COLLAB net: one keepalive `POST /api/resource/save`
 *     per held+dirty per-item session (spec §4.5). Returns immediately when collabPersist is off.
 * Under collabPersist BOTH run: autoSaveSnapshot no-ops, flushAllOnHidden does the work. Best-effort
 * only — an async save can still be cut short on abrupt tab kill; not a hard guarantee.
 *
 * Must be called exactly ONCE per editor session.
 */
export function useFlushOnHidden(): void {
  const { autoSaveSnapshot } = useSnapshotActions();

  useEffect(() => {
    const flush = (reason: string) => {
      if (document.visibilityState !== 'hidden') return;
      log.info('useFlushOnHidden', 'page hidden, flushing', { reason });
      autoSaveSnapshot();
      // Collab per-item net (self-guards on !collabPersist). Read from getState so the single
      // mount-scoped listener always uses the live store, never a render-closure snapshot.
      useSaveSessionStore.getState().flushAllOnHidden();
    };

    const onVisibilityChange = () => flush('visibilitychange');
    // pagehide covers actual teardown (incl. bfcache) as a last-line backstop.
    const onPageHide = () => flush('pagehide');

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [autoSaveSnapshot]);
}
