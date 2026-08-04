// stages-creative-space.tsx - Root container for stages creative space
// Manages selected stage key and active content tab; delegates to sidebar + content area.
//
// Collab (ADR-044 §Revision 2026-07-10 — per-entity HELD session): a USER click on a stage acquires
// ONE per-entity lock (step 2 / rtype 5, resource_id = stage key). Every entity write (name / location
// / variant add·edit·delete / attribute sections / sound add·edit·delete / generate·edit image)
// mutates the snapshot node and is persisted as the WHOLE entity node on release / switch. Mount does
// NOT auto-acquire (lock-on-click); the first stage is shown READ-ONLY until clicked.

import { useState, useMemo, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { StagesSidebar } from './stages-sidebar';
import { StagesContentArea } from './stages-content-area';
import { useStageKeys, useSnapshotActions } from '@/stores/snapshot-store/selectors';
import { useLocationActions } from '@/stores/location-store';
import { createLogger } from '@/utils/logger';
import { useCurrentBookId } from '@/stores/book-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import {
  useIsLockedByOther,
  useLockHolderName,
  type LockTarget,
} from '@/stores/resource-lock-store';
import { LockedByOtherOverlay } from '@/features/editor/components/shared-components/sketch-locked-by-other-overlay';
import type { StageContentTab } from './stages-content-area';

const log = createLogger('Editor', 'StagesCreativeSpace');

export function StagesCreativeSpace() {
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const stageKeys = useStageKeys();
  const actions = useSnapshotActions();
  const { fetchLocations } = useLocationActions();
  const [userSelectedStageKey, setUserSelectedStageKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StageContentTab>('variants');
  // LOCK-ON-CLICK choke point: the stage the user CLICKED to edit → held lock target. null until click.
  const [lockedKey, setLockedKey] = useState<string | null>(null);

  // Fetch locations on mount
  useEffect(() => {
    log.info('StagesCreativeSpace', 'mount — fetching locations');
    fetchLocations();
  }, [fetchLocations]);

  // Derive DISPLAY stage: user choice if valid, else first available (read-only until locked).
  const selectedStageKey = useMemo(() => {
    if (userSelectedStageKey && stageKeys.includes(userSelectedStageKey)) {
      return userSelectedStageKey;
    }
    return stageKeys[0] ?? null;
  }, [stageKeys, userSelectedStageKey]);

  // ── Per-entity held session ──────────────────────────────────────────────────────────────────
  const lockTarget = useMemo<LockTarget | null>(
    () => (lockedKey ? { step: 2, resource_type: 5, resource_id: lockedKey, locale: null } : null),
    [lockedKey],
  );

  // getNode + buildPayload now live in the `illustration-entity` policy (save-policies) — the engine
  // reads the live node + builds the whole-node edit payload from the derived id.

  const handleLockBlocked = useCallback((holder: string) => {
    log.info('handleLockBlocked', 'stage held by another editor', { hasHolder: !!holder });
    toast.info('Another editor is editing this stage — your change was not saved.');
    setLockedKey(null);
  }, []);

  const handleLockLost = useCallback(
    (baseline: unknown) => {
      log.warn('handleLockLost', 'stage lock lost — revert + deselect', { hasBaseline: baseline != null });
      if (lockedKey && baseline != null) {
        actions.revertEntityNode('stage', lockedKey, baseline);
      }
      setLockedKey(null);
      toast.warning('You lost the edit lock for this stage — your changes were reverted.');
    },
    [lockedKey, actions],
  );

  // ── Undo/redo nexus (ADR-045) — per-entity WHOLE-node history; shares the held baseline clone.
  // ── Undo/redo nexus (ADR-045) — the engine now bridges begin/endSession itself; no space wiring.
  const { status: lockStatus } = useSaveSession({
    ...deriveSaveTarget(lockTarget),
    onBlocked: handleLockBlocked,
    onLost: handleLockLost,
  });

  const entityEditable = lockStatus === 'held' && lockedKey === selectedStageKey && lockedKey !== null;

  // Peer-lock (advisory) for the DISPLAYED stage: another editor holds its held lock → veil the content
  // + suppress the acquire-on-click. resource_id '' when nothing is shown (never matches → free).
  const displayedLockTarget = useMemo<LockTarget>(
    () => ({ step: 2, resource_type: 5, resource_id: selectedStageKey ?? '', locale: null }),
    [selectedStageKey],
  );
  const displayedLockedByOther = useIsLockedByOther(displayedLockTarget);
  const displayedHolder = useLockHolderName(displayedLockTarget);

  // Commit-now for the header "Unsaved" button: release the held lock → save + unlock (keep display).
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit held stage session (save + unlock)');
    setLockedKey(null);
  }, []);
  useRegisterEditCommit(commitEntity);

  // USER browse (sidebar row click / arrow-nav) → DISPLAY only, no lock (browse ≠ lock — mirrors
  // spreads `handleSpreadSelect`, ADR-044 §Revision 2026-07-11). Leaving a HELD stage commits it via
  // the `prev && prev !== key` guard; the newly shown stage stays READ-ONLY until a real interaction.
  const handleStageSelect = useCallback((key: string) => {
    log.info('handleStageSelect', 'user browsed stage — display only, no lock', { key });
    setUserSelectedStageKey(key);
    setLockedKey((prev) => (prev && prev !== key ? null : prev));
  }, []);

  // USER interact (name edit / sidebar-detail / content-area click) → acquire this stage's held lock.
  const handleStageInteract = useCallback((key: string) => {
    log.info('handleStageInteract', 'user interacted — acquire held lock', { key });
    setUserSelectedStageKey(key);
    setLockedKey(key);
  }, []);

  const handleEntityDeleted = useCallback((key: string) => {
    log.info('handleEntityDeleted', 'held stage deleted — release lock', { key });
    setLockedKey((prev) => (prev === key ? null : prev));
    setUserSelectedStageKey((prev) => (prev === key ? null : prev));
  }, []);

  const handleTabChange = useCallback((tab: StageContentTab) => {
    log.debug('handleTabChange', 'tab changed', { tab });
    setActiveTab(tab);
  }, []);

  log.debug('render', 'StagesCreativeSpace', { stageCount: stageKeys.length, lockStatus, entityEditable });

  return (
    <div className="flex h-full" role="main" aria-label="Stages creative space">
      <StagesSidebar
        stageKeys={stageKeys}
        selectedStageKey={selectedStageKey}
        onStageSelect={handleStageSelect}
        onStageInteract={handleStageInteract}
        editable={entityEditable}
        onEntityDeleted={handleEntityDeleted}
      />
      <div
        className="relative flex-1 overflow-hidden"
        // Click anywhere in the content area = intent to edit → acquire the displayed stage's lock
        // (lock-on-interact). Capture-phase, guarded so holding this stage makes it a no-op.
        onPointerDownCapture={() => {
          if (selectedStageKey && !displayedLockedByOther && lockedKey !== selectedStageKey) {
            handleStageInteract(selectedStageKey);
          }
        }}
      >
        {/* Edit affordance is global now — the header owns undo/redo + the Unsaved/Saved status
            (ADR-044/045). The canvas/sidebar grey out via editable=false until the lock is held. */}
        {selectedStageKey ? (
          <StagesContentArea
            key={lockedKey ?? selectedStageKey}
            selectedStageKey={selectedStageKey}
            activeTab={activeTab}
            onTabChange={handleTabChange}
            editable={entityEditable}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">Select a stage</p>
          </div>
        )}
        {/* Peer-lock veil: another editor holds the displayed stage. `interactive` → the veil captures
            pointer events so nothing beneath (download / zoom / version-select / edit / upload) can be
            clicked through while someone else is editing. */}
        {displayedLockedByOther && (
          <LockedByOtherOverlay holderName={displayedHolder} interactive />
        )}
      </div>
    </div>
  );
}

export default StagesCreativeSpace;
