// spreads-creative-space.tsx - Root container for illustration spreads creative space
"use client";

import { useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { SpreadsMainView } from "./spreads-main-view";
import { SpreadsSidebar } from "./spreads-sidebar";
import { useSnapshotStore } from "@/stores/snapshot-store";
import { useSnapshotActions } from "@/stores/snapshot-store/selectors";
import { createLogger } from "@/utils/logger";
import { useCurrentBookId } from "@/stores/book-store";
import { useCollabPersistSession } from "@/features/editor/hooks/use-collab-persist-session";
import { useContentSyncSession } from "@/features/editor/hooks/use-content-sync-session";
import { useSaveSession } from "@/features/editor/hooks/use-save-session";
import { deriveSaveTarget } from "@/stores/save-session-store";
import { useRegisterEditCommit } from "@/stores/edit-session-status-store";
import type { LockTarget } from "@/stores/resource-lock-store";
import { useSpaceViewState, useEffectiveSpreadId } from "@/features/editor/hooks/use-space-view-state";
import { ZOOM, COLUMNS } from "@/constants/spread-constants";
import type { ViewMode } from "@/types/canvas-types";
import type { SelectedItem } from "./utils";

const log = createLogger("Editor", "SpreadsCreativeSpace");

export function SpreadsCreativeSpace() {
  const bookId = useCurrentBookId();
  // Collab: SCENE space is collab-LIVE. ADR-044 §Revision 2026-07-10 (per-spread held session): a
  // click on a spread acquires ONE per-spread SCENE lock (step 2 / rtype 6); every IN-SPREAD scene
  // write (raw_images / raw_textboxes / manuscript / pages / branch_setting / tiny_sketch_media_url)
  // mutates the snapshot node and is persisted as ONE owned-key sub-tree on release / saveNow —
  // replacing the former per-node fire-and-forget saves. SPREAD-level collection ops (create / delete
  // / reorder a whole spread) keep their explicit saves. `useContentSyncSession` reconciles the
  // realtime winner's version back into the store.
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  const actions = useSnapshotActions();

  // useShallow: .map() returns new array ref each call — must shallow-compare
  const illustrationSpreadIds = useSnapshotStore(
    useShallow((s) => s.illustration?.spreads?.map((sp) => sp.id) ?? [])
  );

  const [selectedItemId, setSelectedItemId] = useState<SelectedItem | null>(
    null
  );
  // LOCK-ON-CLICK choke point (ADR-044): the spread the user CLICKED to edit → the SCENE held-lock
  // target. Stays null until a genuine user click (never auto-selected) so the lock never
  // auto-acquires on the auto-select / view-restore path.
  const [lockedSpreadId, setLockedSpreadId] = useState<string | null>(null);
  // DUAL-SESSION (ADR-044 addendum 2026-08-05): `shapes` is a RETOUCH-owned key (rtype 10) but is
  // still mutable from this SCENE space. A scene rtype-6 session excludes `shapes` from its
  // baseline/diff/patch, so shape edits routed through it are silently dropped. Shape interactions
  // therefore acquire a SECOND per-spread held session (step 3 / rtype 10) — lazily, on the first
  // shape interaction only (browse + scene-key edits must never take the retouch lock).
  const [lockedRetouchSpreadId, setLockedRetouchSpreadId] = useState<string | null>(null);

  const { activeSpreadId, zoomLevel, viewMode, columnsPerRow, patch } = useSpaceViewState('spread');
  const effectiveSpreadId = useEffectiveSpreadId(activeSpreadId, illustrationSpreadIds);

  // ── SCENE per-spread held session (ADR-044 §Revision 2026-07-10) ─────────────────────────────

  // Lock target — null until a USER click sets `lockedSpreadId`. Keyed on the STRING id only
  // (React-19: no object dep churn).
  const sceneLockTarget = useMemo<LockTarget | null>(
    () =>
      lockedSpreadId
        ? { step: 2, resource_type: 6, resource_id: lockedSpreadId, locale: null }
        : null,
    [lockedSpreadId],
  );

  // Retouch lock target — the SAME spread grain the Objects space locks (step 3 / rtype 10), so a
  // scene editor touching shapes and an Objects editor contend on one lock (admission grain =
  // persist grain). Keyed on the STRING id only (React-19: no object dep churn).
  const retouchLockTarget = useMemo<LockTarget | null>(
    () =>
      lockedRetouchSpreadId
        ? { step: 3, resource_type: 10, resource_id: lockedRetouchSpreadId, locale: null }
        : null,
    [lockedRetouchSpreadId],
  );

  // Live (non-reactive) read of the locked spread node — baseline + dirty-diff source. Reads
  // getState() by the closure `lockedSpreadId` so a switch's release-cleanup still sees the OLD id.
  // getNode + owned-subtree projection + buildPayload now live in the `scene-spread` policy
  // (save-policies, SCENE_OWNED_KEYS) — the engine reads the live spread node and builds the payload.

  // Owned sub-tree → gateway save payload (backend contract: action_type 3 edit, patch = SCENE
  // owned-key sub-object, log:true). step/rtype/id/locale come from the LockTarget.
  // 409 on acquire → another editor holds this spread's scene sub-tree. Toast + drop the click
  // (target → null → idle) so a re-click can retry.
  const handleSceneLockBlocked = useCallback(
    (holder: string) => {
      log.info("handleSceneLockBlocked", "spread scene held by another editor", { hasHolder: !!holder });
      toast.info("Another editor is editing this spread — your change was not saved.");
      setLockedSpreadId(null);
      setSelectedItemId(null);
    },
    [],
  );

  // Heartbeat 409 → lock stolen mid-edit. Revert the SCENE owned sub-tree to the pre-edit baseline
  // (drop un-saved local edits), deselect, and drop the lock.
  const handleSceneLockLost = useCallback(
    (baseline: unknown) => {
      log.warn("handleSceneLockLost", "scene lock lost — revert + deselect", {
        hasBaseline: baseline != null,
      });
      if (lockedSpreadId && baseline != null) {
        actions.revertSceneOwnedSubtree(lockedSpreadId, baseline);
      }
      setLockedSpreadId(null);
      setSelectedItemId(null);
      toast.warning("You lost the edit lock for this spread — your changes were reverted.");
    },
    [lockedSpreadId, actions],
  );

  // First-click lock gate: acquire the SCENE lock without an item selection (sidebar add-element,
  // header modal buttons). The queued action runs once the session is HELD.
  const handleRequestLock = useCallback(() => {
    if (!effectiveSpreadId) return;
    log.info("handleRequestLock", "acquire scene lock (first-click gate)", { effectiveSpreadId });
    setLockedSpreadId(effectiveSpreadId);
  }, [effectiveSpreadId]);

  // 409 on retouch acquire → an Objects-space editor holds this spread's objects/shapes. Block ONLY
  // shape work: drop the retouch target + deselect a selected shape, but leave the scene session and
  // any non-shape selection untouched (scene editing must stay usable).
  const handleRetouchLockBlocked = useCallback((holder: string) => {
    log.info("handleRetouchLockBlocked", "spread objects held by another editor — shapes blocked", {
      hasHolder: !!holder,
    });
    toast.info("Another editor is editing this spread's objects — your shape change was not saved.");
    setLockedRetouchSpreadId(null);
    setSelectedItemId((prev) => (prev?.type === "shape" ? null : prev));
  }, []);

  // Retouch heartbeat 409 → shape lock stolen mid-edit. Revert ONLY the RETOUCH owned sub-tree
  // (partition-isolated: scene keys — and the scene session — stay untouched).
  const handleRetouchLockLost = useCallback(
    (baseline: unknown) => {
      log.warn("handleRetouchLockLost", "retouch lock lost — revert shapes + drop lock", {
        hasBaseline: baseline != null,
      });
      if (lockedRetouchSpreadId && baseline != null) {
        actions.revertRetouchOwnedSubtree(lockedRetouchSpreadId, baseline);
      }
      setLockedRetouchSpreadId(null);
      setSelectedItemId((prev) => (prev?.type === "shape" ? null : prev));
      toast.warning("You lost the shape edit lock — shape changes were reverted.");
    },
    [lockedRetouchSpreadId, actions],
  );

  // First-interaction gate for shapes: acquire the retouch lock when a queued shape action needs it.
  const handleRequestRetouchLock = useCallback(() => {
    if (!effectiveSpreadId) return;
    log.info("handleRequestRetouchLock", "acquire retouch lock (first-shape-interaction gate)", {
      effectiveSpreadId,
    });
    setLockedRetouchSpreadId(effectiveSpreadId);
  }, [effectiveSpreadId]);

  // ── Undo/redo nexus (ADR-045) — the engine now bridges begin/endSession itself (illustration-scene
  // grain, sharing the held baseline clone) on acquire/release/switch/unmount/LOST; no space wiring.
  const {
    status: sceneLockStatus,
    commitOnModalClose: sceneCommitOnModalClose,
    runWithLock,
  } = useSaveSession({
    ...deriveSaveTarget(sceneLockTarget),
    onBlocked: handleSceneLockBlocked,
    onLost: handleSceneLockLost,
    requestLock: handleRequestLock,
    gateResetKey: effectiveSpreadId ?? null,
  });

  // Session #2 — retouch grain (rtype 10) for shapes edited from this space. Independent session-map
  // entry + undo grain ('retouch'); the engine release-saves it separately from the scene session.
  // (No commitOnModalClose taken — this space has no shape-level modal.)
  const {
    status: retouchLockStatus,
    runWithLock: runWithRetouchLock,
  } = useSaveSession({
    ...deriveSaveTarget(retouchLockTarget),
    onBlocked: handleRetouchLockBlocked,
    onLost: handleRetouchLockLost,
    requestLock: handleRequestRetouchLock,
    gateResetKey: effectiveSpreadId ?? null,
  });

  // The active spread is editable only while THIS editor holds its SCENE lock (grey-out otherwise).
  const spreadEditable = sceneLockStatus === "held" && lockedSpreadId === effectiveSpreadId;
  // Shapes are editable only under the RETOUCH lock — a separate affordance from `spreadEditable`.
  const shapeEditable =
    retouchLockStatus === "held" && lockedRetouchSpreadId === effectiveSpreadId;

  // LOCK-ON-ITEM-SELECT (ADR-044 §Revision 2026-07-10b): selecting a spread NO LONGER locks it —
  // browsing a spread must never lock (and this sidesteps the first-entry "click spread to unlock
  // items" gate that made auto-selected spread 1 feel frozen). Leaving the currently-edited spread
  // commits it: null the held target → the hook release-saves the OLD spread; the new spread stays
  // read-only until the user selects an item on it. (setLockedSpreadId(prev) is called from BOTH
  // user clicks and the programmatic auto-select — the `prev && prev !== spreadId` guard makes the
  // mount/auto-select path a no-op since nothing is held yet.)
  const handleSpreadSelect = useCallback((spreadId: string) => {
    log.info("handleSpreadSelect", "spread selected", { spreadId });
    patch({ activeSpreadId: spreadId });
    setSelectedItemId(null);
    setLockedSpreadId((prev) => (prev && prev !== spreadId ? null : prev));
    // Leaving the spread commits the retouch (shape) session too — same guard shape.
    setLockedRetouchSpreadId((prev) => (prev && prev !== spreadId ? null : prev));
  }, [patch]);

  // Commit-now for the header "Unsaved" button. `useRegisterEditCommit` is SINGLE-SLOT (last
  // registrant wins), so this one callback must release BOTH held sessions (scene + retouch) —
  // two independent release-saves. Stable (setters only) so the registration effect runs once.
  const commitScene = useCallback(() => {
    log.info("commitScene", "commit held scene + retouch sessions (save + unlock)");
    setLockedSpreadId(null);
    setLockedRetouchSpreadId(null);
    setSelectedItemId(null);
  }, []);
  useRegisterEditCommit(commitScene);

  const handleViewModeChange = useCallback((mode: ViewMode) => { patch({ viewMode: mode }); }, [patch]);
  const handleZoomChange = useCallback((level: number) => { patch({ zoomLevel: level }); }, [patch]);
  const handleColumnsChange = useCallback((columns: number) => { patch({ columnsPerRow: columns }); }, [patch]);

  const handleItemSelect = useCallback(
    (item: SelectedItem | null) => {
      log.debug("handleItemSelect", "item selection changed", { item });
      setSelectedItemId(item);
      // Selecting an item = intent to edit → acquire this spread's SCENE lock (lock-on-item-select).
      // Deselect (null) KEEPS the lock (still on this spread); commit happens on spread/space/step
      // leave or the header commit button.
      if (item && effectiveSpreadId) {
        setLockedSpreadId(effectiveSpreadId);
        // Selecting a SHAPE additionally acquires the retouch lock (its mutators persist through
        // the rtype-10 session). Scene lock is still taken above — selection semantics unchanged.
        if (item.type === "shape") {
          setLockedRetouchSpreadId(effectiveSpreadId);
        }
      }
    },
    [effectiveSpreadId]
  );

  return (
    <div
      className="flex h-full"
      role="main"
      aria-label="Spreads creative space"
    >
      <SpreadsSidebar
        selectedSpreadId={effectiveSpreadId ?? ""}
        selectedItemId={selectedItemId}
        onItemSelect={handleItemSelect}
        isEditable={spreadEditable}
        isShapeEditable={shapeEditable}
        runWithLock={runWithLock}
        runWithRetouchLock={runWithRetouchLock}
      />
      <div className="relative flex-1 min-w-0 overflow-hidden">
        {/* Edit affordance is global now — the header owns undo/redo + the Unsaved/Saved status
            (ADR-044/045). The canvas + sidebar grey out via isEditable=false until the scene lock
            is held (lock-on-click). */}
        <SpreadsMainView
          selectedSpreadId={effectiveSpreadId ?? ""}
          selectedItemId={selectedItemId}
          onSpreadSelect={handleSpreadSelect}
          onItemSelect={handleItemSelect}
          spreadEditable={spreadEditable}
          shapeEditable={shapeEditable}
          runWithRetouchLock={runWithRetouchLock}
          onCommitSave={sceneCommitOnModalClose}
          viewMode={viewMode ?? 'edit'}
          zoomLevel={zoomLevel ?? ZOOM.DEFAULT}
          columnsPerRow={columnsPerRow ?? COLUMNS.DEFAULT}
          onViewModeChange={handleViewModeChange}
          onZoomChange={handleZoomChange}
          onColumnsChange={handleColumnsChange}
        />
      </div>
    </div>
  );
}

export default SpreadsCreativeSpace;
