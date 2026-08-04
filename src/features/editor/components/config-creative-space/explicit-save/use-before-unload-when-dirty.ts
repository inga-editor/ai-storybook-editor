// use-before-unload-when-dirty.ts — mounts a single `beforeunload` listener for the
// lifetime of the config space. The handler reads the guard's `isDirty()` at RUNTIME
// (from the store's getState()) so we register once and never add/remove based on state
// — a dirty draft triggers the browser's native "leave site?" confirm on reload/close.

import { useEffect } from 'react';
import { useConfigDirtyGuardStore } from '@/stores/config-dirty-guard-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useBeforeUnloadWhenDirty');

export function useBeforeUnloadWhenDirty(): void {
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const isDirty = useConfigDirtyGuardStore.getState().guard?.isDirty() ?? false;
      if (!isDirty) return;
      log.debug('beforeunload', 'dirty draft — prompting native confirm');
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
}
