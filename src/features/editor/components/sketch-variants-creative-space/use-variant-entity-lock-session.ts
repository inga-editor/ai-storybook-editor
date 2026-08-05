// use-variant-entity-lock-session.ts — owns the per-entity SAVE SESSION for the Variant creative
// space. Extracted from the space root (500-LOC rule + one concern per module): the root keeps UI
// state (selection / tabs / zoom / overlays), this hook keeps the save-session lifecycle.
//
// Grain: the WHOLE sketch ENTITY node at step 1 (rtype 3 character / 4 prop) — `useSaveSession`
// with `ownedKeys: undefined`.
//
// LOCKLESS (ADR-044 addendum 2): entity domains no longer acquire a lock. The session binds
// DIRECTLY to the SELECTED entity and the engine begins it synchronously as 'held' — no acquire, no
// peer-lock veil, last-write-wins. The former lock-on-interact model (`adopt`/`releaseUnlessSame`/
// `isAdopted`) is gone: selecting an entity IS the session target; switching entity re-targets the
// session (the old node release-saves on the switch).
//
// BATCH-AT-RELEASE (ADR-043): cheap gestures only mutate the store; the held session diffs the whole
// node against its begin-time baseline and saves it ONCE (switch entity / unmount / the header's
// "Unsaved" button → `commitEntity` → saveNow).
//   ⚡ EXCEPTION — `flushEntityNow`: the crop-pick net, see its doc.
//
// SOLO (no bookId): the global `use-auto-save` + `use-flush-on-hidden` own solo persistence.

import { useCallback, useMemo } from 'react';
import { type LockTarget } from '@/stores/resource-lock-store';
import {
  resolveSketchVariantLockTarget,
  flushSketchEntityUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import type { BaseKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useVariantEntityLockSession');

/** The entity whose session is held — the SELECTED entity (null = nothing selected). */
export interface ActiveLockEntity {
  kind: BaseKind;
  entityKey: string;
}

export interface UseVariantEntityLockSessionResult {
  /** Persist the FRESH entity node NOW, independent of the held-session baseline. See H2 below. */
  flushEntityNow: (ref: ActiveLockEntity) => void;
}

export function useVariantEntityLockSession(
  selected: ActiveLockEntity | null,
): UseVariantEntityLockSessionResult {
  // Session target binds to the SELECTED entity (lockless ⇒ begins 'held' synchronously). Keyed on
  // the STRING key inside useSaveSession, so a variant switch within the SAME entity is a no-op.
  const target = useMemo<LockTarget | null>(
    () => (selected ? resolveSketchVariantLockTarget(selected.kind, selected.entityKey) : null),
    [selected],
  );

  // getNode (WHOLE entity node) + buildPayload live in the `sketch-entity` policy (save-policies).
  // onBlocked/onLost dropped: a lockless session can't be blocked or lost.
  const { saveNow } = useSaveSession(deriveSaveTarget(target));

  // Header "Unsaved" button → commit now: saveNow persists the entity node + rebases the baseline
  // (Saving…→Saved) while staying on the same selection. Mirrors characters/props/stages.
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit entity session (saveNow)');
    void saveNow();
  }, [saveNow]);
  useRegisterEditCommit(commitEntity);

  /**
   * ⚡ H2 — crop-pick net. Picking a crop is a high-value gesture worth persisting eagerly rather
   * than waiting for the release-save. Routes through the engine's `ensureSaved` (via the
   * `flushSketchEntityUnderLock` seam): when the held session is established it is a `saveNow`
   * (dirty-gated) that lands the pick; the idle auto-save (60s) is the net otherwise (spec §4.3).
   * Fire-and-forget; the caller toasts the outcome.
   */
  const flushEntityNow = useCallback((ref: ActiveLockEntity) => {
    log.debug('flushEntityNow', 'engine ensureSaved (crop-pick net)', {
      kind: ref.kind,
      entityKey: ref.entityKey,
    });
    void flushSketchEntityUnderLock(ref.kind, ref.entityKey).then((outcome) =>
      toastSketchSaveOutcome(outcome, resolveSketchVariantLockTarget(ref.kind, ref.entityKey)),
    );
  }, []);

  // Memoized so the returned handle is referentially stable (consumers put it in useCallback deps).
  return useMemo(() => ({ flushEntityNow }), [flushEntityNow]);
}
