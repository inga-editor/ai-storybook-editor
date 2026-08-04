// characters-creative-space.tsx - Root container for characters creative space
// Manages selected character key and active content tab; delegates to sidebar + content area.
//
// Collab (ADR-044 §Revision 2026-07-10 — per-entity HELD session): a USER click on a character in
// the list acquires ONE per-entity lock (step 2 / rtype 3, resource_id = character key). Every entity
// write (name / basic_info / personality / variant add·edit·delete / voice / generate·edit image)
// mutates the snapshot node and is persisted as the WHOLE entity node on release / switch — replacing
// the former per-mutation fire-and-forget saves. Mount does NOT auto-acquire (lock-on-click); the
// first character is shown READ-ONLY until clicked. `useContentSyncSession` reconciles the realtime
// winner's node back into the store.

import { useState, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { CharactersSidebar } from './characters-sidebar';
import { CharactersContentArea, type CharacterContentTab } from './characters-content-area';
import { useCharacterKeys, useSnapshotActions } from '@/stores/snapshot-store/selectors';
import { useSnapshotStore } from '@/stores/snapshot-store';
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

const log = createLogger('Editor', 'CharactersCreativeSpace');

const DEFAULT_CHARACTER_TAB: CharacterContentTab = 'variants';

export function CharactersCreativeSpace() {
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const characterKeys = useCharacterKeys();
  const actions = useSnapshotActions();
  const [userSelectedCharacterKey, setUserSelectedCharacterKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CharacterContentTab>(DEFAULT_CHARACTER_TAB);
  // LOCK-ON-CLICK choke point: the character the user CLICKED to edit → the held lock target. Stays
  // null until a genuine user click (never auto-selected) so the lock never auto-acquires on mount.
  const [lockedKey, setLockedKey] = useState<string | null>(null);

  // Derive DISPLAY character: user choice if valid, else first available (read-only until locked).
  const selectedCharacterKey = useMemo(() => {
    if (userSelectedCharacterKey && characterKeys.includes(userSelectedCharacterKey)) {
      return userSelectedCharacterKey;
    }
    return characterKeys[0] ?? null;
  }, [characterKeys, userSelectedCharacterKey]);

  // ── Per-entity held session ──────────────────────────────────────────────────────────────────
  // Lock target — null until a USER click sets `lockedKey`. Keyed on the STRING key only (React-19).
  const lockTarget = useMemo<LockTarget | null>(
    () => (lockedKey ? { step: 2, resource_type: 3, resource_id: lockedKey, locale: null } : null),
    [lockedKey],
  );

  // Live (non-reactive) read of the locked character node — baseline + dirty-diff source. Reads
  // getState() by the closure `lockedKey` so a switch's release-cleanup still sees the OLD key.
  const getNode = useCallback(
    () => (lockedKey ? useSnapshotStore.getState().characters.find((c) => c.key === lockedKey) ?? null : null),
    [lockedKey],
  );

  // Whole entity node → gateway save payload (backend contract: action_type 3, patch = whole node).
  const buildPayload = useCallback(
    (node: unknown): SavePayload => ({ action_type: 3, patch: node, log: true }),
    [],
  );

  // 409 on acquire → another editor holds this character. Toast + drop the click (idle) so a re-click
  // can retry. `useContentSyncSession` will still reflect their edits.
  const handleLockBlocked = useCallback((holder: string) => {
    log.info('handleLockBlocked', 'character held by another editor', { hasHolder: !!holder });
    toast.info('Another editor is editing this character — your change was not saved.');
    setLockedKey(null);
  }, []);

  // Heartbeat 409 → lock stolen mid-edit. Revert the whole entity node to the pre-edit baseline
  // (drop un-saved local edits), deselect the lock, and toast.
  const handleLockLost = useCallback(
    (baseline: unknown) => {
      log.warn('handleLockLost', 'character lock lost — revert + deselect', { hasBaseline: baseline != null });
      if (lockedKey && baseline != null) {
        actions.revertEntityNode('character', lockedKey, baseline);
      }
      setLockedKey(null);
      toast.warning('You lost the edit lock for this character — your changes were reverted.');
    },
    [lockedKey, actions],
  );

  // ── Undo/redo nexus (ADR-045) — the engine now bridges begin/endSession itself (per-entity
  // WHOLE-node history, sharing the held baseline clone); the space no longer wires it.
  const { status: lockStatus } = useHeldResourceSession({
    target: lockTarget,
    getNode,
    ownedKeys: undefined, // entity = per-entity grain → baseline/dirty/save on the WHOLE node
    buildPayload,
    onBlocked: handleLockBlocked,
    onLost: handleLockLost,
  });

  // Editable only while THIS editor holds the lock for the character on screen (grey-out otherwise).
  const entityEditable = lockStatus === 'held' && lockedKey === selectedCharacterKey && lockedKey !== null;

  // Peer-lock (advisory) for the DISPLAYED character: another editor holds its held lock → veil the
  // content + suppress the acquire-on-click. resource_id '' when nothing is shown (never matches a
  // real key → free). The acquire 409 stays the real authority; this mirrors the realtime registry.
  const displayedLockTarget = useMemo<LockTarget>(
    () => ({ step: 2, resource_type: 3, resource_id: selectedCharacterKey ?? '', locale: null }),
    [selectedCharacterKey],
  );
  const displayedLockedByOther = useIsLockedByOther(displayedLockTarget);
  const displayedHolder = useLockHolderName(displayedLockTarget);

  // Commit-now for the header "Unsaved" button: release the held lock → save + unlock (keep display).
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit held character session (save + unlock)');
    setLockedKey(null);
  }, []);
  useRegisterEditCommit(commitEntity);

  // USER browse (sidebar row click / arrow-nav) → set DISPLAY only; does NOT acquire the lock
  // (browse ≠ lock — mirrors spreads `handleSpreadSelect`, ADR-044 §Revision 2026-07-11). Leaving a
  // HELD entity commits it: null the held target so the hook release-saves the OLD node; the newly
  // shown entity stays READ-ONLY until a genuine interaction. The `prev && prev !== key` guard makes
  // mount/auto-select + re-selecting the same key a no-op (nothing held yet → stays null).
  const handleCharacterSelect = useCallback((key: string) => {
    log.info('handleCharacterSelect', 'user browsed character — display only, no lock', { key });
    setUserSelectedCharacterKey(key);
    setLockedKey((prev) => (prev && prev !== key ? null : prev));
  }, []);

  // USER interact (edit-intent: name edit, sidebar-detail/content-area click, variant edit/upload)
  // → acquire THIS entity's held lock (lock-on-interact). Sets the display key too so a sidebar-detail
  // interaction on a not-yet-displayed row both shows and locks it. Idempotent: re-firing while
  // already holding `key` is a setState no-op (guarded at the call sites to avoid churn).
  const handleCharacterInteract = useCallback((key: string) => {
    log.info('handleCharacterInteract', 'user interacted — acquire held lock', { key });
    setUserSelectedCharacterKey(key);
    setLockedKey(key);
  }, []);

  // Delete of the currently-held character → drop the lock so the held session release-saves the
  // (now removed) node. Only ever called for the held character (delete is gated on entityEditable).
  const handleEntityDeleted = useCallback((key: string) => {
    log.info('handleEntityDeleted', 'held character deleted — release lock', { key });
    setLockedKey((prev) => (prev === key ? null : prev));
    setUserSelectedCharacterKey((prev) => (prev === key ? null : prev));
  }, []);

  const handleTabChange = useCallback((tab: CharacterContentTab) => {
    log.debug('handleTabChange', 'tab changed', { tab });
    setActiveTab(tab);
  }, []);

  log.debug('render', 'CharactersCreativeSpace', {
    characterCount: characterKeys.length,
    lockStatus,
    entityEditable,
  });

  return (
    <div className="flex h-full" role="main" aria-label="Characters creative space">
      <CharactersSidebar
        characterKeys={characterKeys}
        selectedCharacterKey={selectedCharacterKey}
        onCharacterSelect={handleCharacterSelect}
        onCharacterInteract={handleCharacterInteract}
        editable={entityEditable}
        onEntityDeleted={handleEntityDeleted}
      />
      <div
        className="relative flex-1 overflow-hidden"
        // Click anywhere in the content area = intent to edit → acquire the displayed entity's lock
        // (lock-on-interact). Capture-phase so it runs before child handlers (and survives their
        // stopPropagation); guarded so once we already hold this entity it's a setState no-op.
        onPointerDownCapture={() => {
          if (selectedCharacterKey && !displayedLockedByOther && lockedKey !== selectedCharacterKey) {
            handleCharacterInteract(selectedCharacterKey);
          }
        }}
      >
        {/* Edit affordance is global now — the header owns undo/redo + the Unsaved/Saved status
            (ADR-044/045). The canvas/sidebar grey out via editable=false until the lock is held. */}
        {selectedCharacterKey ? (
          <CharactersContentArea
            // key={lockedKey ?? selectedCharacterKey} resets per-entity panel state on switch via
            // remount (NOT setState-in-effect). Falls back to the display key while unlocked.
            key={lockedKey ?? selectedCharacterKey}
            selectedCharacterKey={selectedCharacterKey}
            activeTab={activeTab}
            onTabChange={handleTabChange}
            editable={entityEditable}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">No character selected</p>
          </div>
        )}
        {/* Peer-lock veil: another editor holds the displayed character. `interactive` → the veil
            CAPTURES pointer events (cursor-not-allowed) so nothing beneath (download / zoom preview /
            version-select / edit / upload) can be clicked through while someone else is editing. */}
        {displayedLockedByOther && (
          <LockedByOtherOverlay holderName={displayedHolder} interactive />
        )}
      </div>
    </div>
  );
}
