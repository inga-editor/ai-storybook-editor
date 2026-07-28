// use-variant-entity-lock-session.ts — owns EVERYTHING about holding + persisting a sketch entity
// in the Variant creative space. Extracted from the space root (500-LOC rule + one concern per
// module): the root keeps UI state (selection / tabs / zoom / overlays), this hook keeps the collab
// lock lifecycle.
//
// Grain: the WHOLE sketch ENTITY node at step 1 (rtype 3 character / 4 prop) — `useHeldResourceSession`
// with `ownedKeys: undefined`.
//
// LOCK-ON-INTERACT (browse ≠ lock): `activeLockEntity` starts null and is set ONLY by `adopt()` from
// a genuine interaction (edit text / edit crop / edit raw / pick crop / generate) — never by browsing,
// so the lock never auto-acquires on mount.
//
// BATCH-AT-RELEASE (ADR-043 Rev 2026-07-16 — supersedes the old eager-atomic per-gesture model):
// cheap gestures only mutate the store under the hold; the held-session's release-cleanup diffs the
// whole node against the acquire-time baseline and saves it ONCE (switch entity / unmount / the
// header's "Unsaved" button → `commitEntity`). `manageHeaderStatus` is left at its default (true) so
// the hold reads "Unsaved" → release settles "Saving…" → "Saved".
//   ⚡ EXCEPTION — `flushEntityNow` (H2): see its doc. The generate / re-cut chains persist their own
//     AI output inside the job slice and are NOT routed through here.
//
// SOLO (`collabPersist=false`): every path here is a no-op — `useCollabPersistSession` flips
// collabPersist ON for any mounted space with a bookId, so solo only happens with no book loaded
// (nothing to save). The old eager `persistEntity` had an `autoSaveSnapshot()` fallback; it is gone
// on purpose — the global `use-auto-save` (gated on `!collabPersist`) + `use-flush-on-hidden` own
// solo persistence, as they do for the characters/props/stages spaces this mirrors.

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { type LockTarget, type SavePayload } from '@/stores/resource-lock-store';
import {
  resolveSketchVariantLockTarget,
  buildSketchEntityPayload,
  flushSketchEntityUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { useHeldResourceSession } from '@/features/editor/hooks/use-held-resource-session';
import type { BaseKind } from '@/types/sketch';
import { sketchEntitiesOfKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useVariantEntityLockSession');

/** The entity the user is actively editing → the held-lock target (null = browsing only). */
export interface ActiveLockEntity {
  kind: BaseKind;
  entityKey: string;
}

/** True when two entity refs point at the SAME sketch entity (kind + key — key is unique per kind only). */
function sameEntity(a: ActiveLockEntity | null, b: ActiveLockEntity | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.entityKey === b.entityKey;
}

export interface UseVariantEntityLockSessionResult {
  /** Lock-on-interact: adopt this entity (idempotent — re-adopting the held one is a no-op). */
  adopt: (ref: ActiveLockEntity) => void;
  /** Browse: keep the hold only when it is the SAME entity, else drop it → the session release-saves
   *  the OLD node. Mount / re-select is a no-op (nothing held yet). */
  releaseUnlessSame: (ref: ActiveLockEntity) => void;
  /** True when this entity is the one currently adopted. */
  isAdopted: (ref: ActiveLockEntity | null) => boolean;
  /** Persist the FRESH entity node NOW, independent of the held-session baseline. See H2 below. */
  flushEntityNow: (ref: ActiveLockEntity) => void;
}

export function useVariantEntityLockSession(): UseVariantEntityLockSessionResult {
  const [activeLockEntity, setActiveLockEntity] = useState<ActiveLockEntity | null>(null);

  // Lock target — null until a genuine interaction adopts an entity (browse ≠ lock).
  const target = useMemo<LockTarget | null>(
    () =>
      activeLockEntity
        ? resolveSketchVariantLockTarget(activeLockEntity.kind, activeLockEntity.entityKey)
        : null,
    [activeLockEntity],
  );

  // Live (non-reactive) read of the WHOLE locked entity node — baseline + dirty-diff source. Reads
  // getState() through the closure so a switch's release-cleanup still sees the OLD entity (React
  // runs all effect destroys before any creates, and the cbRef that latches these args is written in
  // an earlier-declared effect → the cleanup observes the PREVIOUS render's getNode).
  const getNode = useCallback(
    () =>
      activeLockEntity
        ? sketchEntitiesOfKind(useSnapshotStore.getState().sketch, activeLockEntity.kind).find(
            (e) => e.key === activeLockEntity.entityKey,
          ) ?? null
        : null,
    [activeLockEntity],
  );
  const buildPayload = useCallback((node: unknown): SavePayload => buildSketchEntityPayload(node), []);

  // 409 on acquire → another editor holds this entity. Toast + drop the interaction (idle).
  const handleLockBlocked = useCallback((holder: string) => {
    log.info('handleLockBlocked', 'entity held by another editor', { hasHolder: !!holder });
    toast.info('Another editor is editing this entity — your change was not saved.');
    setActiveLockEntity(null);
  }, []);

  // Heartbeat 409 → lock stolen mid-edit. Deselect + toast; content-sync reconciles the winner's node.
  const handleLockLost = useCallback(() => {
    log.warn('handleLockLost', 'entity lock lost — deselect');
    setActiveLockEntity(null);
    toast.warning('You lost the edit lock for this entity — a later change may not have saved.');
  }, []);

  useHeldResourceSession({
    target,
    getNode,
    ownedKeys: undefined, // entity = per-entity grain → baseline/dirty on the WHOLE node
    buildPayload,
    onBlocked: handleLockBlocked,
    onLost: handleLockLost,
  });

  // Header "Unsaved" button → commit now: null the held target so the session's cleanup release-saves
  // the entity (Saving…→Saved) and unlocks it. The variant stays DISPLAYED (browse ≠ lock); the next
  // genuine interaction re-acquires. Mirrors characters/props/stages `commitEntity`.
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit held entity session (save + unlock)');
    setActiveLockEntity(null);
  }, []);
  useRegisterEditCommit(commitEntity);

  const adopt = useCallback((ref: ActiveLockEntity) => {
    setActiveLockEntity((prev) => (sameEntity(prev, ref) ? prev : { kind: ref.kind, entityKey: ref.entityKey }));
  }, []);

  const releaseUnlessSame = useCallback((ref: ActiveLockEntity) => {
    setActiveLockEntity((prev) => (sameEntity(prev, ref) ? prev : null));
  }, []);

  const isAdopted = useCallback(
    (ref: ActiveLockEntity | null) => sameEntity(activeLockEntity, ref),
    [activeLockEntity],
  );

  /**
   * ⚡ H2 — the ONE gesture that still persists eagerly (`handleSelectCrop`; everything else batches
   * to the release-save). Picking a crop mutates the store SYNCHRONOUSLY in the same event that
   * adopts the entity, while the held-session only captures its baseline inside `acquire()`'s
   * `.then()` — i.e. after a network round-trip. If that round-trip has not settled by the time the
   * pick lands, the baseline is cloned from an ALREADY-PICKED node → the release-time dirty-diff is
   * false → `releaseAndSave` skips the write (`if (dirty && payload)`) and the pick is lost.
   *
   * It is a RACE, not a certainty: reaching a crop card requires clicking the Crop tab first (the
   * pane's `onPointerDownCapture` adopts there), which starts the acquire a full human click earlier
   * — so the baseline is normally pre-pick and the release-save would have caught it anyway. The
   * window only opens when the acquire RTT outlasts that gap. This flush closes it; in the common
   * path it costs one redundant (idempotent) whole-node write.
   *
   * `flushSketchEntityUnderLock` is baseline-independent — it saves exactly the node passed, no diff.
   *
   * ⚠️ Deliberately NOT `releaseIfAcquired:true`. That option means "the held-session never owned
   * this lock, so drop it after saving" — true for the job slice's persist-after (the user may have
   * browsed away mid-AI-call), but FALSE here: `adopt()` runs immediately before this, so the
   * held-session is about to own the lock. In exactly the race above (`myLocks` still empty because
   * the acquire is in flight) this flush would acquire the lock itself and then RELEASE it, while the
   * held-session — whose own acquire resolves moments later — believes it still holds one. Every
   * subsequent release-save would then 409 → `lost` → skipped silently, yet the header still settles
   * to "Saved": whole-session data loss with false-positive UI, strictly worse than the lost pick.
   * Same call shape as flush-BEFORE-generate, which uses the default for the same reason. Orphan risk
   * (H1) is near-nil — a peer-held lock 409s BOTH acquires — and TTL-bounded either way.
   */
  const flushEntityNow = useCallback((ref: ActiveLockEntity) => {
    const node =
      sketchEntitiesOfKind(useSnapshotStore.getState().sketch, ref.kind).find(
        (e) => e.key === ref.entityKey,
      ) ?? null;
    log.debug('flushEntityNow', 'baseline-independent flush', {
      kind: ref.kind,
      entityKey: ref.entityKey,
    });
    void flushSketchEntityUnderLock(ref.kind, ref.entityKey, node);
  }, []);

  // Memoized so the returned handle is referentially stable: consumers put it in useCallback deps,
  // and a fresh object literal each render would churn every handler's identity (and any memo'd
  // child taking them as props). Only `isAdopted` closes over state, so the handle changes exactly
  // when the adopted entity changes — which is when dependents genuinely must recompute.
  return useMemo(
    () => ({ adopt, releaseUnlessSame, isAdopted, flushEntityNow }),
    [adopt, releaseUnlessSame, isAdopted, flushEntityNow],
  );
}
