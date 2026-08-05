// characters-creative-space.tsx - Root container for characters creative space
// Manages selected character key and active content tab; delegates to sidebar + content area.
//
// Collab (ADR-044 addendum 2 — LOCKLESS entity save): entity domains no longer acquire a per-entity
// lock. The per-item save session binds DIRECTLY to the SELECTED character; the engine begins it
// synchronously as 'held' (no acquire, no peer-lock veil, last-write-wins). Every entity write
// (name / basic_info / personality / variant add·edit·delete / voice / generate·edit image) mutates
// the snapshot node and is persisted as the WHOLE entity node on switch / leave / saveNow.
// `useContentSyncSession` reconciles the realtime winner's node back into the store.

import { useState, useMemo, useCallback } from 'react';
import { CharactersSidebar } from './characters-sidebar';
import { CharactersContentArea, type CharacterContentTab } from './characters-content-area';
import { useCharacterKeys } from '@/stores/snapshot-store/selectors';
import { createLogger } from '@/utils/logger';
import { useCurrentBookId } from '@/stores/book-store';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { type LockTarget } from '@/stores/resource-lock-store';

const log = createLogger('Editor', 'CharactersCreativeSpace');

const DEFAULT_CHARACTER_TAB: CharacterContentTab = 'variants';

export function CharactersCreativeSpace() {
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const characterKeys = useCharacterKeys();
  const [userSelectedCharacterKey, setUserSelectedCharacterKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CharacterContentTab>(DEFAULT_CHARACTER_TAB);

  // Derive DISPLAY character: user choice if valid, else first available.
  const selectedCharacterKey = useMemo(() => {
    if (userSelectedCharacterKey && characterKeys.includes(userSelectedCharacterKey)) {
      return userSelectedCharacterKey;
    }
    return characterKeys[0] ?? null;
  }, [characterKeys, userSelectedCharacterKey]);

  // ── Per-entity save session (lockless) ─────────────────────────────────────────────────────────
  // Session target binds to the SELECTED character (step 2 / rtype 3). No acquire; the engine begins
  // 'held' synchronously so the first edit lands inside the session (no silent loss). Keyed on the
  // STRING key only (React-19). getNode + buildPayload live in the `illustration-entity` policy.
  const lockTarget = useMemo<LockTarget | null>(
    () =>
      selectedCharacterKey
        ? { step: 2, resource_type: 3, resource_id: selectedCharacterKey, locale: null }
        : null,
    [selectedCharacterKey],
  );

  // Undo/redo nexus (ADR-045) — the engine bridges begin/endSession itself (per-entity WHOLE-node
  // history). onBlocked/onLost dropped: a lockless session can't be blocked or lost.
  const { status: sessionStatus, saveNow } = useSaveSession(deriveSaveTarget(lockTarget));

  // Editable whenever a character is selected + its session is held (lockless ⇒ held immediately).
  const entityEditable = sessionStatus === 'held' && selectedCharacterKey !== null;

  // Commit-now for the header "Unsaved" button: save the current entity node while staying (lockless
  // ⇒ no release/unlock; saveNow persists + rebases the baseline in place).
  const commitEntity = useCallback(() => {
    log.info('commitEntity', 'commit entity session (saveNow)');
    void saveNow();
  }, [saveNow]);
  useRegisterEditCommit(commitEntity);

  // USER select (sidebar row click / arrow-nav / detail interaction) → set DISPLAY = session target.
  // Leaving the previous entity commits it (session re-targets → old node release-saves on switch).
  const handleCharacterSelect = useCallback((key: string) => {
    log.info('handleCharacterSelect', 'user selected character', { key });
    setUserSelectedCharacterKey(key);
  }, []);

  // Delete of the selected character → clear selection so the session re-targets the next available.
  const handleEntityDeleted = useCallback((key: string) => {
    log.info('handleEntityDeleted', 'character deleted — clear selection', { key });
    setUserSelectedCharacterKey((prev) => (prev === key ? null : prev));
  }, []);

  const handleTabChange = useCallback((tab: CharacterContentTab) => {
    log.debug('handleTabChange', 'tab changed', { tab });
    setActiveTab(tab);
  }, []);

  log.debug('render', 'CharactersCreativeSpace', {
    characterCount: characterKeys.length,
    sessionStatus,
    entityEditable,
  });

  return (
    <div className="flex h-full" role="main" aria-label="Characters creative space">
      <CharactersSidebar
        characterKeys={characterKeys}
        selectedCharacterKey={selectedCharacterKey}
        onCharacterSelect={handleCharacterSelect}
        editable={entityEditable}
        onEntityDeleted={handleEntityDeleted}
      />
      <div className="relative flex-1 overflow-hidden">
        {/* Edit affordance is global (header owns undo/redo + Unsaved/Saved). No peer-lock veil —
            entity domains are lockless (owner-only, last-write-wins). */}
        {selectedCharacterKey ? (
          <CharactersContentArea
            // key resets per-entity panel state on switch via remount (NOT setState-in-effect).
            key={selectedCharacterKey}
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
      </div>
    </div>
  );
}
