// use-config-section-draft.ts — owns the local DRAFT + isDirty + save/discard for one
// config section, and registers a guard into ConfigDirtyGuardStore for its mount lifetime.
//
// React 19 rules honored:
//   • `source` resync uses the SET-STATE-IN-RENDER pattern (React's sanctioned way to
//     adjust state when props change) — NOT useEffect + setState (lint error).
//   • A `latestRef` is written by an effect that ONLY writes the ref (no setState) and is
//     read ONLY from imperative callbacks (save/discard/guard) — never during render.
//   • The guard object is stable (save/discard have []-deps), so register/unregister
//     does not loop.
//
// IMPORTANT for callers: pass a `source` that is REFERENTIALLY STABLE while unchanged —
// project it with `useMemo` over the raw store ref. A fresh object every render reads as
// "source changed" and would resync every frame.

import * as React from 'react';
import { toast } from 'sonner';
import type { ConfigSection } from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';
import { deepEqual } from './draft-utils';
import {
  useConfigDirtyGuardActions,
  type ConfigDirtyGuard,
} from '@/stores/config-dirty-guard-store';

const log = createLogger('Editor', 'useConfigSectionDraft');

/** Patch recipe: shallow-merge a partial, or a functional producer (keyed-map drafts). */
export type DraftRecipe<T> = Partial<T> | ((prev: T) => T);

export interface ConfigSectionDraftOptions<T> {
  sectionKey: ConfigSection;
  /** Projection from the source store (the subtree this section owns). Must be a stable ref. */
  source: T;
  /** Persist the draft to the source store/DB. MUST throw on failure. */
  persistFn: (draft: T) => Promise<void>;
}

export interface ConfigSectionDraft<T> {
  draft: T;
  isDirty: boolean;
  isSaving: boolean;
  patchDraft: (recipe: DraftRecipe<T>) => void;
  save: () => Promise<void>;
  discard: () => void;
}

/** baseline (source) + working copy (draft), swapped atomically so isDirty stays consistent. */
interface DraftSnap<T> {
  source: T;
  draft: T;
}

export function useConfigSectionDraft<T>({
  sectionKey,
  source,
  persistFn,
}: ConfigSectionDraftOptions<T>): ConfigSectionDraft<T> {
  const [snap, setSnap] = React.useState<DraftSnap<T>>(() => ({ source, draft: source }));
  const [isSaving, setIsSaving] = React.useState(false);

  // Resync when the source REF changes (realtime / cascade / refetch). Set-state-in-render:
  // compare by reference first (cheap, avoids loops), deepEqual only decides keep-vs-drop draft.
  if (snap.source !== source) {
    const wasClean = deepEqual(snap.draft, snap.source);
    // clean → passthrough new source; dirty → keep draft, advance baseline (isDirty recomputes).
    setSnap(wasClean ? { source, draft: source } : { source, draft: snap.draft });
  }

  const isDirty = React.useMemo(() => !deepEqual(snap.draft, snap.source), [snap]);

  // Mirror the current values into a ref for imperative callbacks (no setState here → lint-safe).
  const latestRef = React.useRef({ snap, isSaving, persistFn, sectionKey });
  React.useEffect(() => {
    latestRef.current = { snap, isSaving, persistFn, sectionKey };
  });

  const patchDraft = React.useCallback((recipe: DraftRecipe<T>) => {
    setSnap((prev) => {
      const nextDraft =
        typeof recipe === 'function'
          ? (recipe as (p: T) => T)(prev.draft)
          : ({ ...(prev.draft as object), ...(recipe as object) } as T);
      return { source: prev.source, draft: nextDraft };
    });
    log.debug('patchDraft', 'draft mutated', { sectionKey });
  }, [sectionKey]);

  // Stable across renders — reads everything from latestRef so it never goes stale.
  const save = React.useCallback(async () => {
    const cur = latestRef.current;
    const dirty = !deepEqual(cur.snap.draft, cur.snap.source);
    if (!dirty || cur.isSaving) {
      log.debug('save', 'skip — clean or already saving', { sectionKey: cur.sectionKey, dirty });
      return;
    }
    const persisted = cur.snap.draft;
    setIsSaving(true);
    try {
      await cur.persistFn(persisted);
      log.info('save', 'persisted draft', { sectionKey: cur.sectionKey });
      // Clean immediately — do not wait for a store echo (source ref may not change).
      setSnap({ source: persisted, draft: persisted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('save', 'persist failed', { sectionKey: cur.sectionKey, msg });
      toast.error('Save failed. Your changes are kept — please try again.');
      throw err; // let resolveSave / ensureSaved know it failed
    } finally {
      setIsSaving(false);
    }
  }, []);

  const discard = React.useCallback(() => {
    const cur = latestRef.current;
    log.info('discard', 'reverting draft to source', { sectionKey: cur.sectionKey });
    setSnap({ source: cur.snap.source, draft: cur.snap.source });
  }, []);

  // Stable guard object — save/discard are []-stable, sectionKey is fixed per section.
  const guard = React.useMemo<ConfigDirtyGuard>(
    () => ({
      sectionKey,
      isDirty: () => !deepEqual(latestRef.current.snap.draft, latestRef.current.snap.source),
      save,
      discard,
    }),
    [sectionKey, save, discard]
  );

  const { register, unregister } = useConfigDirtyGuardActions();
  React.useEffect(() => {
    register(guard);
    return () => unregister(sectionKey);
  }, [sectionKey, guard, register, unregister]);

  return { draft: snap.draft, isDirty, isSaving, patchDraft, save, discard };
}
