// sketch-lineup-creative-space.tsx — root of the Lineup creative space (design README §2). ONE
// space for BOTH kinds (character + prop), covering EVERY variant incl. 'base'. Sidebar picks
// variants; the content area lays their locked crops side-by-side on one shared ruler.
//
// ⚡ 2026-07-25 MULTI-TAB + PERSIST (ADR-043 §Mở rộng): selection is no longer local — each tab is
// a PERSISTED named selection in `sketch.lineups[]` (rtype 12 collab node). The space follows the
// standard collab checklist (memory *new-pipeline-space-collab-flow*): persist + content-sync
// sessions mounted FIRST (teardown order), then the lineup lock session; EVERY write goes through
// `withLock` (acquire BEFORE mutate, 409 = mutation dropped); solo persists via the setters'
// sync.isDirty + whole-doc autosave (never autoSaveSnapshot here).
//
// VIRTUAL TAB: a book with no `lineups` yet shows one FE-only tab (id minted ONCE per mount);
// NOTHING is written by browsing — the first write MATERIALIZES it (spec §2.3). Payload shapes
// per gesture live in lineup-constants (buildToggle*/buildCleanup — unit-tested).
//
// ORDER (Validation S1 — diverges from design 0635ee5): the canvas renders checked entries in
// SIDEBAR order; the persisted entries[] is append-order MEMBERSHIP only.
//
// React 19: `activeTab` reconciles IN RENDER (`find ?? first`) — no useEffect+setState prune; a
// peer-deleted active tab falls back to tab 1 and fires one muted toast (effect w/o setState).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useSketchLineupEntries, useSketchLineups } from '@/stores/snapshot-store/selectors';
import { useCurrentBook, useCurrentBookId } from '@/stores/book-store';
import { useAuthStore } from '@/stores/auth-store';
import { useIsLockedByOther, useLockHolderName } from '@/stores/resource-lock-store';
import { LINEUP_LOCK_TARGET } from '@/stores/snapshot-store/slices/collab-sketch-lineups-save-helper';
import { useCollabPersistSession } from '@/features/editor/hooks/use-collab-persist-session';
import { useContentSyncSession } from '@/features/editor/hooks/use-content-sync-session';
import { useMyCollaboration } from '@/features/editor/components/collaborators-creative-space/hooks/use-my-collaboration';
import type { BaseKind, LineupEntry, SketchLineupTab } from '@/types/sketch';
import { LineupSidebar } from './lineup-sidebar';
import { LineupContentArea } from './lineup-content-area';
import { NewLineupTabModal } from './new-lineup-tab-modal';
import { DeleteLineupTabAlertDialog } from './delete-lineup-tab-alert-dialog';
import { useLineupLockSession } from './use-lineup-lock-session';
import {
  DEFAULT_EXPANDED_GROUPS,
  KIND_GROUPS,
  LINEUP_TAB_LIMIT,
  ZOOM,
  buildCleanupEntries,
  buildToggleAllEntries,
  buildToggleEntries,
  mintVirtualTab,
  nextTabName,
  refOf,
  selectable,
} from './lineup-constants';

const log = createLogger('Editor', 'SketchLineupSpace');

const ALL_KINDS: ReadonlySet<BaseKind> = new Set(['characters', 'props']);

type TabDialogState = { mode: 'create' } | { mode: 'rename'; tabId: string };

export function SketchLineupSpace() {
  // ── Collab session mount — DECLARED FIRST (teardown order: persist-session must outlive the
  // held session's release-save cleanup), then the lock session. ──────────────────────────────
  const bookId = useCurrentBookId();
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);
  const { withLock } = useLineupLockSession();

  const charEntries = useSketchLineupEntries('characters');
  const propEntries = useSketchLineupEntries('props');
  const tabs = useSketchLineups();

  // Peer lock on the ONE rtype-12 grain → every write affordance greys (browse stays live).
  const lockedByOther = useIsLockedByOther(LINEUP_LOCK_TARGET);
  const holderName = useLockHolderName(LINEUP_LOCK_TARGET);

  // Granted kinds — the FE mitigation of the gateway's characters∨props OR-gate over-permit
  // (signed-off Validation S1): an ungranted kind renders greyed, the gateway stays the authority.
  const book = useCurrentBook();
  const currentUserId = useAuthStore((s) => s.user?.id) ?? null;
  const isOwner = book ? book.owner_id === currentUserId : true;
  const { access_rights } = useMyCollaboration(bookId ?? null, currentUserId, isOwner);
  const grantedKinds = useMemo<ReadonlySet<BaseKind>>(() => {
    if (isOwner) return ALL_KINDS;
    const sketchStep = access_rights?.steps?.sketch;
    if (!sketchStep?.enabled) return new Set<BaseKind>(); // null rights → disable all defensively
    const granted = new Set<BaseKind>();
    if (sketchStep.resources.characters) granted.add('characters');
    if (sketchStep.resources.props) granted.add('props');
    return granted;
  }, [isOwner, access_rights]);

  // ── Local UI state (never persisted) ────────────────────────────────────────────────────────
  // Virtual tab: minted ONCE per mount (useState initializer — never in the render body).
  const [virtualTab] = useState<SketchLineupTab>(mintVirtualTab);
  const [activeTabId, setActiveTabId] = useState<string>(virtualTab.id);
  const [zoom, setZoom] = useState<number>(ZOOM.default);
  const [expandedGroups, setExpandedGroups] =
    useState<Record<BaseKind, boolean>>(DEFAULT_EXPANDED_GROUPS);
  const [tabDialog, setTabDialog] = useState<TabDialogState | null>(null);
  const [deletingTabId, setDeletingTabId] = useState<string | null>(null);

  // Effective tabs: persisted, or the single virtual tab pre-materialization (spec §2.3).
  // useMemo (not a bare conditional) so hooks depending on it keep a stable ref per input.
  const effectiveTabs = useMemo(
    () => (tabs.length > 0 ? tabs : [virtualTab]),
    [tabs, virtualTab],
  );
  // Reconcile IN RENDER: unknown/stale id (peer delete, first load of a book with tabs) → tab 1.
  const activeTab = effectiveTabs.find((t) => t.id === activeTabId) ?? effectiveTabs[0];

  // Muted heads-up when the tab the user is LOOKING AT vanishes under them (peer delete). Ref
  // guard so the initial "virtual id not in persisted tabs" reconcile never cries wolf. No
  // setState here — the render-time fallback above already moved the view.
  const lastSeenActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const present = effectiveTabs.some((t) => t.id === activeTabId);
    if (!present && lastSeenActiveRef.current === activeTabId) {
      log.info('activeTabWatch', 'active tab removed by a peer — fell back to tab 1', {});
      toast.info('The tab you were viewing was deleted — switched to the first tab.');
    }
    lastSeenActiveRef.current = present ? activeTabId : null;
  }, [effectiveTabs, activeTabId]);

  const entriesByKind = useMemo<Record<BaseKind, LineupEntry[]>>(
    () => ({ characters: charEntries, props: propEntries }),
    [charEntries, propEntries],
  );
  // Sidebar order (char → prop, snapshot order) IS the canvas order (Validation S1).
  const allEntries = useMemo(() => [...charEntries, ...propEntries], [charEntries, propEntries]);

  // Checked = DERIVED from the active tab's persisted membership (peer edits move checkboxes).
  const checkedRefs = useMemo<ReadonlySet<string>>(
    () => new Set(activeTab.entries.map(refOf)),
    [activeTab.entries],
  );

  // Canvas: checked ∩ selectable, in SIDEBAR order (never the entries[] append order).
  const canvasEntries = useMemo(
    () => allEntries.filter((e) => checkedRefs.has(e.ref) && selectable(e)),
    [allEntries, checkedRefs],
  );
  // Members that cannot render (deleted entity/variant OR lost image/height) — the "Dọn" chip.
  const danglingCount = activeTab.entries.length - canvasEntries.length;

  const writeDisabled = lockedByOther;
  const canCreateTab = effectiveTabs.length < LINEUP_TAB_LIMIT;

  // ── Write handlers — ALL go through withLock (acquire → mutate → flush) ─────────────────────
  // Store reads inside `mutate` are FRESH (getState at commit time): a peer change landing
  // between the gesture and the acquire round-trip is never overwritten from a stale closure.

  /** Fresh entries of the active tab; null ⇒ tab vanished mid-gesture (peer delete) → drop. */
  const resolveLiveTab = useCallback(
    (tabId: string): SketchLineupTab | null => {
      const lineups = useSnapshotStore.getState().sketch.lineups ?? [];
      if (lineups.length === 0) return null; // pre-materialization — virtual tab is the target
      return lineups.find((t) => t.id === tabId) ?? null;
    },
    [],
  );

  /** Write the active tab's entries[] — materializes the virtual tab on the FIRST write. */
  const writeActiveTabEntries = useCallback(
    (build: (base: SketchLineupTab['entries']) => SketchLineupTab['entries']) => {
      const targetId = activeTab.id;
      const targetName = activeTab.name;
      const targetEntries = activeTab.entries;
      void withLock(() => {
        const s = useSnapshotStore.getState();
        const lineups = s.sketch.lineups ?? [];
        if (lineups.length === 0) {
          // First materialization — the on-screen (virtual) tab becomes tab 1 WITH the change.
          log.debug('writeActiveTabEntries', 'materializing virtual tab', { tabId: targetId });
          s.addSketchLineupTab({ id: targetId, name: targetName, entries: build(targetEntries) });
          return;
        }
        const live = lineups.find((t) => t.id === targetId);
        if (!live) {
          log.warn('writeActiveTabEntries', 'active tab vanished mid-gesture — dropped', { tabId: targetId });
          toast.info('The tab you were editing was deleted — change not applied.');
          return;
        }
        s.setSketchLineupTabEntries(live.id, build(live.entries));
      });
    },
    [activeTab.id, activeTab.name, activeTab.entries, withLock],
  );

  const handleToggleEntry = useCallback(
    (entry: LineupEntry, checked: boolean) => {
      log.info('handleToggleEntry', 'entry toggled', { ref: entry.ref, checked });
      writeActiveTabEntries((base) => buildToggleEntries(base, entry, checked));
    },
    [writeActiveTabEntries],
  );

  const handleToggleAll = useCallback(
    (checked: boolean) => {
      // Only GRANTED selectable entries join/leave — ungranted kinds are inert (UX gate).
      const grantedSelectable = allEntries.filter((e) => grantedKinds.has(e.kind) && selectable(e));
      log.info('handleToggleAll', 'select-all toggled', { checked, count: grantedSelectable.length });
      writeActiveTabEntries((base) => buildToggleAllEntries(base, grantedSelectable, checked));
    },
    [allEntries, grantedKinds, writeActiveTabEntries],
  );

  const handleCleanupDangling = useCallback(() => {
    const selectableEntries = allEntries.filter(selectable);
    log.info('handleCleanupDangling', 'cleanup requested', { danglingCount });
    writeActiveTabEntries((base) => buildCleanupEntries(base, selectableEntries));
  }, [allEntries, danglingCount, writeActiveTabEntries]);

  const handleCreateTab = useCallback(
    (name: string) => {
      const newTab: SketchLineupTab = { id: crypto.randomUUID(), name, entries: [] };
      log.info('handleCreateTab', 'creating tab', { tabId: newTab.id, total: effectiveTabs.length + 1 });
      let created = false;
      void withLock(() => {
        // Re-check the cap on the FRESH store (a peer may have filled it while the modal was
        // open / during the acquire round-trip) — the ＋ disable is render-time only.
        const s = useSnapshotStore.getState();
        const lineups = s.sketch.lineups ?? [];
        const effectiveCount = lineups.length === 0 ? 1 : lineups.length; // virtual counts as 1
        if (effectiveCount >= LINEUP_TAB_LIMIT) {
          log.info('handleCreateTab', 'cap reached at commit time — dropped', { tabId: newTab.id });
          toast.info(`Tab limit reached (${LINEUP_TAB_LIMIT}).`);
          return;
        }
        // Materializing create keeps the on-screen virtual tab as tab 1 (payload [virtual, new]).
        s.addSketchLineupTab(newTab, virtualTab);
        created = true;
      }).then((ok) => {
        if (ok && created) setActiveTabId(newTab.id);
      });
    },
    [withLock, virtualTab, effectiveTabs.length],
  );

  const handleRenameTab = useCallback(
    (tabId: string, name: string) => {
      log.info('handleRenameTab', 'renaming tab', { tabId });
      void withLock(() => {
        const s = useSnapshotStore.getState();
        if ((s.sketch.lineups ?? []).length === 0) {
          // Renaming the VIRTUAL tab materializes it (spec §2.3 — rename is a real write).
          s.addSketchLineupTab({ id: virtualTab.id, name, entries: activeTab.entries });
          return;
        }
        s.renameSketchLineupTab(tabId, name);
      });
    },
    [withLock, virtualTab.id, activeTab.entries],
  );

  const handleDeleteTab = useCallback(
    (tabId: string) => {
      const live = resolveLiveTab(tabId);
      if (!live) {
        log.debug('handleDeleteTab', 'nothing to delete (virtual/vanished)', { tabId });
        return;
      }
      // Move the view FIRST (same event) so the render-time fallback never flashes a stale id
      // and the peer-delete toast guard cannot misfire on our own delete.
      if (tabId === activeTabId) {
        const idx = effectiveTabs.findIndex((t) => t.id === tabId);
        const neighbor = effectiveTabs[idx - 1] ?? effectiveTabs[idx + 1];
        if (neighbor) setActiveTabId(neighbor.id);
      }
      log.info('handleDeleteTab', 'deleting tab', { tabId });
      void withLock(() => {
        useSnapshotStore.getState().removeSketchLineupTab(tabId);
      });
    },
    [withLock, resolveLiveTab, activeTabId, effectiveTabs],
  );

  // ── Browse handlers — NO lock (browse ≠ lock) ───────────────────────────────────────────────
  const handleToggleGroup = useCallback((kind: BaseKind) => {
    setExpandedGroups((prev) => {
      const next = { ...prev, [kind]: !prev[kind] };
      log.debug('handleToggleGroup', 'group toggled', { kind, expanded: next[kind] });
      return next;
    });
  }, []);

  const handleChangeZoom = useCallback((next: number) => {
    const clamped = Math.min(ZOOM.max, Math.max(ZOOM.min, next));
    log.debug('handleChangeZoom', 'zoom changed', { zoom: clamped });
    setZoom(clamped);
  }, []);

  // Modal seeds — computed HERE (the modal only receives strings; design 03 §contract).
  const renameTarget =
    tabDialog?.mode === 'rename' ? effectiveTabs.find((t) => t.id === tabDialog.tabId) : undefined;
  const dialogInitialName =
    tabDialog?.mode === 'create' ? nextTabName(effectiveTabs) : renameTarget?.name ?? '';

  return (
    <main className="flex h-full" role="main" aria-label="Sketch lineup creative space">
      <LineupSidebar
        groups={KIND_GROUPS}
        entriesByKind={entriesByKind}
        checkedRefs={checkedRefs}
        expandedGroups={expandedGroups}
        disabled={writeDisabled}
        lockHolderName={holderName}
        canCreateTab={canCreateTab}
        grantedKinds={grantedKinds}
        onToggleEntry={handleToggleEntry}
        onToggleAll={handleToggleAll}
        onToggleGroup={handleToggleGroup}
        onCreateTab={() => setTabDialog({ mode: 'create' })}
      />
      <LineupContentArea
        entries={canvasEntries}
        zoom={zoom}
        onChangeZoom={handleChangeZoom}
        tabs={effectiveTabs}
        activeTabId={activeTab.id}
        writeDisabled={writeDisabled}
        danglingCount={danglingCount}
        onSelectTab={setActiveTabId}
        onRequestRenameTab={(tabId) => setTabDialog({ mode: 'rename', tabId })}
        onRequestDeleteTab={setDeletingTabId}
        onCleanupDangling={handleCleanupDangling}
      />

      {tabDialog && (
        <NewLineupTabModal
          key={tabDialog.mode + (tabDialog.mode === 'rename' ? tabDialog.tabId : '')}
          mode={tabDialog.mode}
          initialName={dialogInitialName}
          onSubmit={(name) => {
            if (tabDialog.mode === 'create') handleCreateTab(name);
            else handleRenameTab(tabDialog.tabId, name);
            setTabDialog(null);
          }}
          onClose={() => setTabDialog(null)}
        />
      )}

      <DeleteLineupTabAlertDialog
        tabName={effectiveTabs.find((t) => t.id === deletingTabId)?.name ?? null}
        onConfirm={() => {
          if (deletingTabId) handleDeleteTab(deletingTabId);
          setDeletingTabId(null);
        }}
        onClose={() => setDeletingTabId(null)}
      />
    </main>
  );
}
