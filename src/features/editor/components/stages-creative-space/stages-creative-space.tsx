// stages-creative-space.tsx - Root container for stages creative space
// Manages selected stage key and active content tab; delegates to sidebar + content area.
//
// Collab (ADR-044 addendum 2 — LOCKLESS entity save): entity domains no longer acquire a per-entity
// lock. The per-item save session binds DIRECTLY to the SELECTED stage (step 2 / rtype 5); the engine
// begins it synchronously as 'held' (no acquire, no peer-lock veil, last-write-wins). Every entity
// write (name / location / variant add·edit·delete / attribute sections / sound add·edit·delete /
// generate·edit image) mutates the snapshot node and is persisted as the WHOLE entity node on switch /
// leave / saveNow. `useContentSyncSession` reconciles the realtime winner's node.

import { useState, useMemo, useCallback, useEffect } from 'react';
import { StagesSidebar } from './stages-sidebar';
import { StagesContentArea } from './stages-content-area';
import { useStageKeys } from '@/stores/snapshot-store/selectors';
import { useLocationActions } from '@/stores/location-store';
import { createLogger } from '@/utils/logger';
import { useCurrentBookId } from '@/stores/book-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { type LockTarget } from '@/stores/resource-lock-store';
import type { StageContentTab } from './stages-content-area';

const log = createLogger('Editor', 'StagesCreativeSpace');

export function StagesCreativeSpace() {
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const stageKeys = useStageKeys();
  const { fetchLocations } = useLocationActions();
  const [userSelectedStageKey, setUserSelectedStageKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StageContentTab>('variants');

  // Fetch locations on mount
  useEffect(() => {
    log.info('StagesCreativeSpace', 'mount — fetching locations');
    fetchLocations();
  }, [fetchLocations]);

  // Derive DISPLAY stage: user choice if valid, else first available.
  const selectedStageKey = useMemo(() => {
    if (userSelectedStageKey && stageKeys.includes(userSelectedStageKey)) {
      return userSelectedStageKey;
    }
    return stageKeys[0] ?? null;
  }, [stageKeys, userSelectedStageKey]);

  // ── Per-entity save session (lockless) — binds to the SELECTED stage; begins 'held' synchronously.
  const lockTarget = useMemo<LockTarget | null>(
    () =>
      selectedStageKey
        ? { step: 2, resource_type: 5, resource_id: selectedStageKey, locale: null }
        : null,
    [selectedStageKey],
  );

  // Undo/redo nexus (ADR-045) — the engine bridges begin/endSession itself. onBlocked/onLost dropped:
  // a lockless session can't be blocked or lost.
  const { status: sessionStatus, saveNow } = useSaveSession(deriveSaveTarget(lockTarget));

  const entityEditable = sessionStatus === 'held' && selectedStageKey !== null;

  // Commit-now for the header "Unsaved" button: saveNow persists the entity node + rebases in place.
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit entity session (saveNow)');
    void saveNow();
  }, [saveNow]);
  useRegisterEditCommit(commitEntity);

  // USER select (sidebar row click / arrow-nav / detail interaction) → set DISPLAY = session target.
  const handleStageSelect = useCallback((key: string) => {
    log.info('handleStageSelect', 'user selected stage', { key });
    setUserSelectedStageKey(key);
  }, []);

  const handleEntityDeleted = useCallback((key: string) => {
    log.info('handleEntityDeleted', 'stage deleted — clear selection', { key });
    setUserSelectedStageKey((prev) => (prev === key ? null : prev));
  }, []);

  const handleTabChange = useCallback((tab: StageContentTab) => {
    log.debug('handleTabChange', 'tab changed', { tab });
    setActiveTab(tab);
  }, []);

  log.debug('render', 'StagesCreativeSpace', { stageCount: stageKeys.length, sessionStatus, entityEditable });

  return (
    <div className="flex h-full" role="main" aria-label="Stages creative space">
      <StagesSidebar
        stageKeys={stageKeys}
        selectedStageKey={selectedStageKey}
        onStageSelect={handleStageSelect}
        editable={entityEditable}
        onEntityDeleted={handleEntityDeleted}
      />
      <div className="relative flex-1 overflow-hidden">
        {/* Header owns undo/redo + Unsaved/Saved status. No peer-lock veil — entity domains are
            lockless (owner-only, last-write-wins). */}
        {selectedStageKey ? (
          <StagesContentArea
            key={selectedStageKey}
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
      </div>
    </div>
  );
}

export default StagesCreativeSpace;
