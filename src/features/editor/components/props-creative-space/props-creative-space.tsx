// props-creative-space.tsx - Root container for props creative space
// Manages selected prop key and active content tab; delegates to sidebar + content area.
//
// Collab (ADR-044 addendum 2 — LOCKLESS entity save): entity domains no longer acquire a per-entity
// lock. The per-item save session binds DIRECTLY to the SELECTED prop (step 2 / rtype 4); the engine
// begins it synchronously as 'held' (no acquire, no peer-lock veil, last-write-wins). Every entity
// write (name / category / type / variant add·edit·delete / sound add·edit·delete / generate·edit
// image) mutates the snapshot node and is persisted as the WHOLE entity node on switch / leave /
// saveNow. `useContentSyncSession` reconciles the realtime winner's node.

import { useState, useMemo, useCallback } from 'react';
import { PropsSidebar } from './props-sidebar';
import { PropsContentArea } from './props-content-area';
import { usePropKeys } from '@/stores/snapshot-store/selectors';
import { DEFAULT_CONTENT_TAB } from '@/constants/prop-constants';
import type { ContentTab } from '@/types/prop-types';
import { createLogger } from '@/utils/logger';
import { useCurrentBookId } from '@/stores/book-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { type LockTarget } from '@/stores/resource-lock-store';

const log = createLogger('Editor', 'PropsCreativeSpace');

export function PropsCreativeSpace() {
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const propKeys = usePropKeys();
  const [userSelectedPropKey, setUserSelectedPropKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ContentTab>(DEFAULT_CONTENT_TAB);

  // Derive DISPLAY prop: user choice if valid, else first available.
  const selectedPropKey = useMemo(() => {
    if (userSelectedPropKey && propKeys.includes(userSelectedPropKey)) {
      return userSelectedPropKey;
    }
    return propKeys[0] ?? null;
  }, [propKeys, userSelectedPropKey]);

  // ── Per-entity save session (lockless) — binds to the SELECTED prop; begins 'held' synchronously.
  const lockTarget = useMemo<LockTarget | null>(
    () =>
      selectedPropKey
        ? { step: 2, resource_type: 4, resource_id: selectedPropKey, locale: null }
        : null,
    [selectedPropKey],
  );

  // Undo/redo nexus (ADR-045) — the engine bridges begin/endSession itself. onBlocked/onLost dropped:
  // a lockless session can't be blocked or lost.
  const { status: sessionStatus, saveNow } = useSaveSession(deriveSaveTarget(lockTarget));

  const entityEditable = sessionStatus === 'held' && selectedPropKey !== null;

  // Commit-now for the header "Unsaved" button: saveNow persists the entity node + rebases in place.
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit entity session (saveNow)');
    void saveNow();
  }, [saveNow]);
  useRegisterEditCommit(commitEntity);

  // USER select (sidebar row click / arrow-nav / detail interaction) → set DISPLAY = session target.
  const handlePropSelect = useCallback((key: string) => {
    log.info('handlePropSelect', 'user selected prop', { key });
    setUserSelectedPropKey(key);
  }, []);

  const handleEntityDeleted = useCallback((key: string) => {
    log.info('handleEntityDeleted', 'prop deleted — clear selection', { key });
    setUserSelectedPropKey((prev) => (prev === key ? null : prev));
  }, []);

  const handleTabChange = useCallback((tab: ContentTab) => {
    log.debug('handleTabChange', 'tab changed', { tab });
    setActiveTab(tab);
  }, []);

  log.debug('render', 'PropsCreativeSpace', { propCount: propKeys.length, sessionStatus, entityEditable });

  return (
    <div className="flex h-full" role="main" aria-label="Props creative space">
      <PropsSidebar
        propKeys={propKeys}
        selectedPropKey={selectedPropKey}
        onPropSelect={handlePropSelect}
        editable={entityEditable}
        onEntityDeleted={handleEntityDeleted}
      />
      <div className="relative flex-1 overflow-hidden">
        {/* Header owns undo/redo + Unsaved/Saved status. No peer-lock veil — entity domains are
            lockless (owner-only, last-write-wins). */}
        {selectedPropKey ? (
          <PropsContentArea
            key={selectedPropKey}
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
      </div>
    </div>
  );
}

export default PropsCreativeSpace;
