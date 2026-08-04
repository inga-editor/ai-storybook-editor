// props-creative-space.tsx - Root container for props creative space
// Manages selected prop key and active content tab; delegates to sidebar + content area.
//
// Collab (ADR-044 §Revision 2026-07-10 — per-entity HELD session): a USER click on a prop acquires
// ONE per-entity lock (step 2 / rtype 4, resource_id = prop key). Every entity write (name / category
// / type / variant add·edit·delete / sound add·edit·delete / generate·edit image) mutates the snapshot
// node and is persisted as the WHOLE entity node on release / switch — replacing the former
// per-mutation fire-and-forget saves. Mount does NOT auto-acquire (lock-on-click); the first prop is
// shown READ-ONLY until clicked. `useContentSyncSession` reconciles the realtime winner's node.

import { useState, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { PropsSidebar } from './props-sidebar';
import { PropsContentArea } from './props-content-area';
import { usePropKeys, useSnapshotActions } from '@/stores/snapshot-store/selectors';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { DEFAULT_CONTENT_TAB } from '@/constants/prop-constants';
import type { ContentTab } from '@/types/prop-types';
import { createLogger } from '@/utils/logger';
import { useCurrentBookId } from '@/stores/book-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useHeldResourceSession } from '@/features/editor/hooks/use-held-resource-session';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import {
  useIsLockedByOther,
  useLockHolderName,
  type LockTarget,
  type SavePayload,
} from '@/stores/resource-lock-store';
import { LockedByOtherOverlay } from '@/features/editor/components/shared-components/sketch-locked-by-other-overlay';

const log = createLogger('Editor', 'PropsCreativeSpace');

export function PropsCreativeSpace() {
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const propKeys = usePropKeys();
  const actions = useSnapshotActions();
  const [userSelectedPropKey, setUserSelectedPropKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ContentTab>(DEFAULT_CONTENT_TAB);
  // LOCK-ON-CLICK choke point: the prop the user CLICKED to edit → held lock target. null until click.
  const [lockedKey, setLockedKey] = useState<string | null>(null);

  // Derive DISPLAY prop: user choice if valid, else first available (read-only until locked).
  const selectedPropKey = useMemo(() => {
    if (userSelectedPropKey && propKeys.includes(userSelectedPropKey)) {
      return userSelectedPropKey;
    }
    return propKeys[0] ?? null;
  }, [propKeys, userSelectedPropKey]);

  // ── Per-entity held session ──────────────────────────────────────────────────────────────────
  const lockTarget = useMemo<LockTarget | null>(
    () => (lockedKey ? { step: 2, resource_type: 4, resource_id: lockedKey, locale: null } : null),
    [lockedKey],
  );

  // Live read of the locked prop node — reads getState() by the closure `lockedKey` so a switch's
  // release-cleanup still sees the OLD key.
  const getNode = useCallback(
    () => (lockedKey ? useSnapshotStore.getState().props.find((p) => p.key === lockedKey) ?? null : null),
    [lockedKey],
  );

  const buildPayload = useCallback(
    (node: unknown): SavePayload => ({ action_type: 3, patch: node, log: true }),
    [],
  );

  const handleLockBlocked = useCallback((holder: string) => {
    log.info('handleLockBlocked', 'prop held by another editor', { hasHolder: !!holder });
    toast.info('Another editor is editing this prop — your change was not saved.');
    setLockedKey(null);
  }, []);

  const handleLockLost = useCallback(
    (baseline: unknown) => {
      log.warn('handleLockLost', 'prop lock lost — revert + deselect', { hasBaseline: baseline != null });
      if (lockedKey && baseline != null) {
        actions.revertEntityNode('prop', lockedKey, baseline);
      }
      setLockedKey(null);
      toast.warning('You lost the edit lock for this prop — your changes were reverted.');
    },
    [lockedKey, actions],
  );

  // ── Undo/redo nexus (ADR-045) — the engine now bridges begin/endSession itself; no space wiring.
  const { status: lockStatus } = useHeldResourceSession({
    target: lockTarget,
    getNode,
    ownedKeys: undefined, // entity = per-entity grain → baseline/dirty/save on the WHOLE node
    buildPayload,
    onBlocked: handleLockBlocked,
    onLost: handleLockLost,
  });

  const entityEditable = lockStatus === 'held' && lockedKey === selectedPropKey && lockedKey !== null;

  // Peer-lock (advisory) for the DISPLAYED prop: another editor holds its held lock → veil the content
  // + suppress the acquire-on-click. resource_id '' when nothing is shown (never matches → free).
  const displayedLockTarget = useMemo<LockTarget>(
    () => ({ step: 2, resource_type: 4, resource_id: selectedPropKey ?? '', locale: null }),
    [selectedPropKey],
  );
  const displayedLockedByOther = useIsLockedByOther(displayedLockTarget);
  const displayedHolder = useLockHolderName(displayedLockTarget);

  // Commit-now for the header "Unsaved" button: release the held lock → save + unlock (keep display).
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit held prop session (save + unlock)');
    setLockedKey(null);
  }, []);
  useRegisterEditCommit(commitEntity);

  // USER browse (sidebar row click / arrow-nav) → DISPLAY only, no lock (browse ≠ lock — mirrors
  // spreads `handleSpreadSelect`, ADR-044 §Revision 2026-07-11). Leaving a HELD prop commits it via
  // the `prev && prev !== key` guard; the newly shown prop stays READ-ONLY until a real interaction.
  const handlePropSelect = useCallback((key: string) => {
    log.info('handlePropSelect', 'user browsed prop — display only, no lock', { key });
    setUserSelectedPropKey(key);
    setLockedKey((prev) => (prev && prev !== key ? null : prev));
  }, []);

  // USER interact (name edit / sidebar-detail / content-area click) → acquire this prop's held lock.
  const handlePropInteract = useCallback((key: string) => {
    log.info('handlePropInteract', 'user interacted — acquire held lock', { key });
    setUserSelectedPropKey(key);
    setLockedKey(key);
  }, []);

  const handleEntityDeleted = useCallback((key: string) => {
    log.info('handleEntityDeleted', 'held prop deleted — release lock', { key });
    setLockedKey((prev) => (prev === key ? null : prev));
    setUserSelectedPropKey((prev) => (prev === key ? null : prev));
  }, []);

  const handleTabChange = useCallback((tab: ContentTab) => {
    log.debug('handleTabChange', 'tab changed', { tab });
    setActiveTab(tab);
  }, []);

  log.debug('render', 'PropsCreativeSpace', { propCount: propKeys.length, lockStatus, entityEditable });

  return (
    <div className="flex h-full" role="main" aria-label="Props creative space">
      <PropsSidebar
        propKeys={propKeys}
        selectedPropKey={selectedPropKey}
        onPropSelect={handlePropSelect}
        onPropInteract={handlePropInteract}
        editable={entityEditable}
        onEntityDeleted={handleEntityDeleted}
      />
      <div
        className="relative flex-1 overflow-hidden"
        // Click anywhere in the content area = intent to edit → acquire the displayed prop's lock
        // (lock-on-interact). Capture-phase, guarded so holding this prop makes it a no-op.
        onPointerDownCapture={() => {
          if (selectedPropKey && !displayedLockedByOther && lockedKey !== selectedPropKey) {
            handlePropInteract(selectedPropKey);
          }
        }}
      >
        {/* Edit affordance is global now — the header owns undo/redo + the Unsaved/Saved status
            (ADR-044/045). The canvas/sidebar grey out via editable=false until the lock is held. */}
        {selectedPropKey ? (
          <PropsContentArea
            key={lockedKey ?? selectedPropKey}
            selectedPropKey={selectedPropKey}
            activeTab={activeTab}
            onTabChange={handleTabChange}
            editable={entityEditable}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">No prop selected</p>
          </div>
        )}
        {/* Peer-lock veil: another editor holds the displayed prop. `interactive` → the veil captures
            pointer events so nothing beneath (download / zoom / version-select / edit / upload) can be
            clicked through while someone else is editing. */}
        {displayedLockedByOther && (
          <LockedByOtherOverlay holderName={displayedHolder} interactive />
        )}
      </div>
    </div>
  );
}

export default PropsCreativeSpace;
