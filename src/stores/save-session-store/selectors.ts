// selectors.ts — PRIMITIVE-ONLY selectors for the save-session engine. Each returns a string or
// boolean so Object.is equality holds even though `sessions` is replaced (new Map) on every
// mutation — NEVER return the entry object or a freshly-built array/object (the useShallow /
// nested-fresh-array footgun that loops re-renders).

import { useSaveSessionStore } from './index';
import type { SessionStatus } from '@/stores/resource-lock-store';

/** Live status for a session key. `null` key ⇒ 'idle'; no entry yet ⇒ 'acquiring' (mid-begin). */
export function useSessionStatus(key: string | null): SessionStatus {
  return useSaveSessionStore((s) => {
    if (!key) return 'idle';
    return s.sessions.get(key)?.status ?? 'acquiring';
  });
}

/** True while ANY held session is dirty. Re-renders on save-session changes only (not snapshot
 *  edits) — sufficient for the header's coarse "unsaved" hint; the precise label stays
 *  session-driven. Returns a boolean ⇒ stable. */
export function useIsAnySessionDirty(): boolean {
  return useSaveSessionStore((s) => {
    for (const [key, entry] of s.sessions) {
      if (entry.status === 'held' && s.isDirty(key)) return true;
    }
    return false;
  });
}
