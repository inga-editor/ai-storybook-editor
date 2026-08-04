// objects-creative-space.tsx - Root container for objects creative space
// Extended (phase-04): merges AnimationsCreativeSpace state + handlers + 3-way selection sync.
"use client";

import { useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Zap } from "lucide-react";
import { ObjectsMainView } from "./objects-main-view";
import { ObjectsSidebar } from "./objects-sidebar";
import { AnimationEditorSidebar } from "./animation-editor-sidebar";
import {
  useRetouchSpreadIds,
  useRetouchSpreadById,
  useRetouchAnimations,
  useSnapshotActions,
} from "@/stores/snapshot-store/selectors";
import { useSnapshotStore } from "@/stores/snapshot-store";
import { createLogger } from "@/utils/logger";
import { useCurrentBookId } from "@/stores/book-store";
import { useCollabPersistSession } from "@/features/editor/hooks/use-collab-persist-session";
import { useContentSyncSession } from "@/features/editor/hooks/use-content-sync-session";
import { useHeldResourceSession } from "@/features/editor/hooks/use-held-resource-session";
import { useRegisterEditCommit } from "@/stores/edit-session-status-store";
import { RETOUCH_OWNED_KEYS } from "@/stores/snapshot-store/slices/collab-owned-subtree";
import type { LockTarget, SavePayload } from "@/stores/resource-lock-store";
import { toastLockRequired } from "@/utils/collab-save-toasts";
import {
  useSpaceViewState,
  useEffectiveSpreadId,
} from "@/features/editor/hooks/use-space-view-state";
import { useCurrentLanguage, useCanvasWidth, useCanvasHeight } from "@/stores/editor-settings-store";
import { ZOOM } from "@/constants/spread-constants";
import { EFFECT_TYPE } from "@/constants/animation-constants";
import { EFFECT_TYPE_NAMES } from "@/constants/playable-constants";
import type { SpreadAnimation } from "@/types/spread-types";
import type {
  AnimationFilterState,
  ItemType,
} from "@/types/animation-types";
import {
  resolveAnimations,
  filterAnimations,
  buildObjectFilterOptions,
  getAvailableEffects,
  buildDefaultEffect,
  createDefaultFilterState,
  buildItemsMap,
  inferEffectTypeForComposite,
} from "./animation-utils";
import {
  adaptToAnimationSelectedItem,
  adaptFromAnimationItem,
} from "./objects-creative-space-adapters";
// Preserve consumer compat: types remain importable from this module.
export type { ObjectElementType, SelectedItem } from "./objects-creative-space-adapters";
import type { SelectedItem } from "./objects-creative-space-adapters";
import { fetchMediaDurationMs, findMediaUrlFromSpread } from "@/utils/media-duration-utils";
import { getTextboxContentForLanguage } from "@/features/editor/utils/textbox-helpers";
import { computePlayEffectDuration } from "@/features/editor/utils/compute-play-effect-duration";
import { resolveTargetItemGeometry } from "@/features/editor/utils/composite-resolve-helpers";
import type { ZoomAreaGeometry } from "@/features/editor/components/canvas-spread-view/overlays/zoom-area-overlay-utils";
import type { MotionLineGeometry } from "@/features/editor/components/canvas-spread-view/overlays/motion-line-overlay-utils";

const log = createLogger("Editor", "ObjectsCreativeSpace");

export function ObjectsCreativeSpace() {
  const bookId = useCurrentBookId();
  // Collab: objects/retouch space is collab-LIVE. ADR-044 §Revision 2026-07-10 (per-spread held
  // session): a click on a spread acquires ONE per-spread retouch lock (step 3 / rtype 10); every
  // retouch write (video/audio/auto_pic/auto_audio/composite/quiz/animation + edited image versions)
  // mutates the snapshot node and is persisted as ONE owned-key sub-tree on release / saveNow —
  // replacing the former per-node fire-and-forget saves. `useContentSyncSession` reconciles the
  // realtime winner's version back into the store.
  useCollabPersistSession(bookId);
  useContentSyncSession(bookId);

  // --- Store selectors ---
  const retouchSpreadIds = useRetouchSpreadIds();
  const currentLanguage = useCurrentLanguage();
  const actions = useSnapshotActions();

  // --- Space view state (persisted — phase-05 added animationSidebarCollapsed) ---
  const { activeSpreadId, zoomLevel, animationSidebarCollapsed, patch } =
    useSpaceViewState("object");

  // --- Local state ---
  const [selectedItemId, setSelectedItemId] = useState<SelectedItem | null>(null);
  const [expandedAnimIndex, setExpandedAnimIndex] = useState<number | null>(null);
  const [filterState, setFilterState] = useState<AnimationFilterState>(createDefaultFilterState);
  const [drawZoomAreaMode, setDrawZoomAreaMode] = useState(false);
  // LOCK-ON-CLICK choke point (ADR-044): the spread the user CLICKED to edit → the retouch held
  // lock target. Stays null until a genuine user click (never auto-selected) so the lock never
  // auto-acquires on the auto-select / view-restore path.
  const [lockedSpreadId, setLockedSpreadId] = useState<string | null>(null);

  // Spread ratio for Camera Zoom default geometry / overlay aspect lock
  const canvasWidth = useCanvasWidth();
  const canvasHeight = useCanvasHeight();
  const spreadRatio = useMemo(
    () => (canvasHeight > 0 ? canvasWidth / canvasHeight : 1),
    [canvasWidth, canvasHeight],
  );

  // Derived: effective spread ID (persisted choice if valid, else first)
  const selectedSpreadId = useEffectiveSpreadId(activeSpreadId, retouchSpreadIds);

  const currentSpread = useRetouchSpreadById(selectedSpreadId ?? "");
  const animations = useRetouchAnimations(selectedSpreadId ?? "");

  // ── Retouch per-spread held session (ADR-044 §Revision 2026-07-10) ──────────────────────────
  // Reset the per-item / animation selection (shared by spread-switch + lock-blocked/lost).
  const resetSelection = useCallback(() => {
    setSelectedItemId(null);
    setExpandedAnimIndex(null);
    setDrawZoomAreaMode(false);
  }, []);

  // Lock target — null until a USER click sets `lockedSpreadId` (lock-on-click). Keyed on the STRING
  // id only (React-19: no object dep churn).
  const retouchLockTarget = useMemo<LockTarget | null>(
    () =>
      lockedSpreadId
        ? { step: 3, resource_type: 10, resource_id: lockedSpreadId, locale: null }
        : null,
    [lockedSpreadId],
  );

  // Live (non-reactive) read of the locked spread node — baseline + dirty-diff source. Reads
  // getState() by the closure `lockedSpreadId` so a switch's release-cleanup still sees the OLD id.
  const getRetouchNode = useCallback(
    () =>
      lockedSpreadId
        ? useSnapshotStore.getState().illustration.spreads.find((s) => s.id === lockedSpreadId) ?? null
        : null,
    [lockedSpreadId],
  );

  // Owned sub-tree → gateway save payload (backend contract: action_type 3 edit, patch = retouch
  // owned-key sub-object, log:true). step/rtype/id/locale come from the LockTarget.
  const buildRetouchPayload = useCallback(
    (subtree: unknown): SavePayload => ({ action_type: 3, patch: subtree, log: true }),
    [],
  );

  // 409 on acquire → another editor holds this spread's objects. Toast + drop the click (target →
  // null → idle) so a re-click can retry.
  const handleRetouchLockBlocked = useCallback(
    (holder: string) => {
      log.info("handleRetouchLockBlocked", "spread objects held by another editor", {
        hasHolder: !!holder,
      });
      toast.info("Another editor is editing this spread's objects — your change was not saved.");
      setLockedSpreadId(null);
      resetSelection();
    },
    [resetSelection],
  );

  // Heartbeat 409 → lock stolen mid-edit. Revert the retouch owned sub-tree to the pre-edit baseline
  // (drop un-saved local edits), deselect, and drop the lock.
  const handleRetouchLockLost = useCallback(
    (baseline: unknown) => {
      log.warn("handleRetouchLockLost", "retouch lock lost — revert + deselect", {
        hasBaseline: baseline != null,
      });
      if (lockedSpreadId && baseline != null) {
        actions.revertRetouchOwnedSubtree(lockedSpreadId, baseline);
      }
      setLockedSpreadId(null);
      resetSelection();
      toast.warning("You lost the edit lock for this spread — your changes were reverted.");
    },
    [lockedSpreadId, actions, resetSelection],
  );

  // ── Undo/redo nexus (ADR-045) — the engine now bridges begin/endSession itself (retouch grain,
  // sharing the held baseline clone) on acquire/release/switch/LOST; no space wiring.
  const { status: retouchLockStatus, saveNow: retouchSaveNow } = useHeldResourceSession({
    target: retouchLockTarget,
    getNode: getRetouchNode,
    ownedKeys: RETOUCH_OWNED_KEYS,
    buildPayload: buildRetouchPayload,
    onBlocked: handleRetouchLockBlocked,
    onLost: handleRetouchLockLost,
  });

  // The active spread is editable only while THIS editor holds its retouch lock (grey-out otherwise).
  const spreadEditable = retouchLockStatus === "held" && lockedSpreadId === selectedSpreadId;

  // Commit-now for the header "Unsaved" button: release the held retouch lock → save + unlock.
  const commitRetouch = useCallback(() => {
    log.info("commitRetouch", "commit held retouch session (save + unlock)");
    setLockedSpreadId(null);
    resetSelection();
  }, [resetSelection]);
  useRegisterEditCommit(commitRetouch);

  // --- Derived data (useMemo) ---
  const languageCode = currentLanguage.code;

  const itemsMap = useMemo(
    () => buildItemsMap(currentSpread, languageCode),
    [currentSpread, languageCode],
  );

  const resolvedAnimations = useMemo(
    () => resolveAnimations(animations, itemsMap, currentSpread),
    [animations, itemsMap, currentSpread],
  );

  const filteredAnimations = useMemo(
    () => filterAnimations(resolvedAnimations, filterState),
    [resolvedAnimations, filterState],
  );

  const objectFilterOptions = useMemo(
    () => buildObjectFilterOptions(resolvedAnimations, itemsMap),
    [resolvedAnimations, itemsMap],
  );

  // Check if the selected item (for "+" add dropdown) is a textbox with audio
  const selectedItemHasAudio = useMemo(() => {
    if (!selectedItemId || selectedItemId.type !== "textbox") return false;
    const textbox = currentSpread?.textboxes?.find((t) => t.id === selectedItemId.id);
    if (!textbox) {
      log.debug("selectedItemHasAudio", "textbox not found", {
        id: selectedItemId.id,
        textboxCount: currentSpread?.textboxes?.length,
      });
      return false;
    }
    const result = getTextboxContentForLanguage(
      textbox as Record<string, unknown>,
      languageCode,
    );
    const hasCombined = result?.content?.audio?.combined_audio_url != null;
    log.debug("selectedItemHasAudio", "check", {
      id: selectedItemId.id,
      hasAudio: !!result?.content?.audio,
      hasCombined,
    });
    return hasCombined;
  }, [selectedItemId, currentSpread, languageCode]);

  // Check if the expanded animation's target textbox has audio (for effect-type grid)
  const targetHasAudio = useMemo(() => {
    if (expandedAnimIndex === null) return selectedItemHasAudio;
    const expandedAnimation = filteredAnimations[expandedAnimIndex];
    if (!expandedAnimation) return false;
    const target = expandedAnimation.animation.target;
    if (target.type !== "textbox") return false;
    const textbox = currentSpread?.textboxes?.find((t) => t.id === target.id);
    if (!textbox) return false;
    const result = getTextboxContentForLanguage(
      textbox as Record<string, unknown>,
      languageCode,
    );
    return result?.content?.audio?.combined_audio_url != null;
  }, [expandedAnimIndex, filteredAnimations, currentSpread, languageCode, selectedItemHasAudio]);

  // Resolve effect-grid matrix type considering composite re-target rule:
  // - If selectedItem is a variant of a composite → use restrictive composite matrix.
  // - If selectedItem.type === 'composite' → infer matrix.
  // - Else → variant type as-is.
  const animationSelectedItem = useMemo(
    () => adaptToAnimationSelectedItem(selectedItemId),
    [selectedItemId],
  );

  const effectMatrixType = useMemo<ItemType | null>(() => {
    if (!animationSelectedItem) return null;
    const parent = currentSpread?.composites?.find((c) =>
      c.variants.some((v) => v.id === animationSelectedItem.id),
    );
    if (parent) return inferEffectTypeForComposite(parent);
    if (animationSelectedItem.type === "composite") {
      const composite = currentSpread?.composites?.find(
        (c) => c.id === animationSelectedItem.id,
      );
      if (composite) return inferEffectTypeForComposite(composite);
      return "image";
    }
    return animationSelectedItem.type;
  }, [animationSelectedItem, currentSpread]);

  const availableEffects = useMemo(() => {
    const base = effectMatrixType
      ? getAvailableEffects(effectMatrixType, selectedItemHasAudio)
      : [];
    // Camera Zoom (19) is spread-level — always offer regardless of selectedItem.
    const hasZoom = base.some((e) => e.id === 19);
    if (!hasZoom) {
      base.push({
        id: 19,
        name: EFFECT_TYPE_NAMES[19] ?? "Zoom In",
        category: "camera",
      });
    }
    return base;
  }, [effectMatrixType, selectedItemHasAudio]);

  // Currently expanded animation (raw, for canvas overlay)
  const expandedAnimationRaw = useMemo<SpreadAnimation | null>(() => {
    if (expandedAnimIndex === null) return null;
    const resolved = filteredAnimations[expandedAnimIndex];
    return resolved?.animation ?? null;
  }, [expandedAnimIndex, filteredAnimations]);

  const expandedAnimationOriginalIndex = useMemo<number | null>(() => {
    if (expandedAnimIndex === null) return null;
    const resolved = filteredAnimations[expandedAnimIndex];
    return resolved?.originalIndex ?? null;
  }, [expandedAnimIndex, filteredAnimations]);

  // --- Handlers ---

  const handleZoomChange = useCallback(
    (level: number) => {
      patch({ zoomLevel: level });
    },
    [patch],
  );

  // LOCK-ON-ITEM-SELECT (ADR-044 §Revision 2026-07-10b — matches the scene space): selecting a
  // spread no longer locks it. Leaving the currently-edited spread commits it (null the held target
  // → the hook release-saves the OLD spread). The `prev && prev !== spreadId` guard keeps the mount
  // / auto-select path a no-op (nothing held yet).
  const handleSpreadSelect = useCallback(
    (spreadId: string) => {
      log.info("handleSpreadSelect", "spread selected", { spreadId });
      patch({ activeSpreadId: spreadId });
      resetSelection();
      setLockedSpreadId((prev) => (prev && prev !== spreadId ? null : prev));
    },
    [patch, resetSelection],
  );

  const handleItemSelect = useCallback((item: SelectedItem | null) => {
    log.debug("handleItemSelect", "item selection changed", { item });
    setExpandedAnimIndex(null);
    setSelectedItemId(item);
    // Selecting an item = intent to edit → acquire this spread's retouch lock. Deselect keeps it.
    if (item && selectedSpreadId) {
      setLockedSpreadId(selectedSpreadId);
    }
  }, [selectedSpreadId]);

  // Callback from AnimationEditorSidebar — item type/id in animation space; adapt back to SelectedItem
  const handleAnimationSidebarItemSelect = useCallback(
    (itemType: ItemType | null, itemId: string | null) => {
      log.debug("handleAnimationSidebarItemSelect", "from animation sidebar", {
        itemType,
        itemId,
      });
      const adapted = adaptFromAnimationItem(itemType, itemId);
      setSelectedItemId(adapted);
      // Editing an animation target is an in-spread (RETOUCH_OWNED_KEYS) op → acquire the lock.
      if (adapted && selectedSpreadId) {
        setLockedSpreadId(selectedSpreadId);
      }
    },
    [selectedSpreadId],
  );

  const handleAnimationSidebarToggle = useCallback(() => {
    log.info("handleAnimationSidebarToggle", "toggle", {
      newState: !animationSidebarCollapsed,
    });
    patch({ animationSidebarCollapsed: !animationSidebarCollapsed });
  }, [animationSidebarCollapsed, patch]);

  const handleAddAnimation = useCallback(
    async (effectType: number) => {
      if (!selectedSpreadId) return;
      // Lock-on-click gate (ADR-044): animations ∈ RETOUCH_OWNED_KEYS — block when the spread's
      // objects lock is not held, else the mutation dirties the node but the held session never
      // saves it (silent non-persistence).
      if (!spreadEditable) {
        log.debug("handleAddAnimation", "blocked — spread not held", { selectedSpreadId, effectType });
        toastLockRequired();
        return;
      }

      // Camera Zoom (19) — spread-level: enter draw mode, animation created on draw complete.
      if (effectType === 19) {
        log.info("handleAddAnimation", "enable draw zoom area mode", {});
        setDrawZoomAreaMode(true);
        return;
      }

      // Camera Focus (18) — per-item; falls through to existing flow that requires selectedItem.
      if (!animationSelectedItem) {
        log.debug("handleAddAnimation", "skip — no selected item for per-item effect", {
          effectType,
        });
        return;
      }

      // Composite re-target rule: if selectedItem is a variant of a composite,
      // route the animation target to the composite instead of the variant.
      const parentComposite = currentSpread?.composites?.find((c) =>
        c.variants.some((v) => v.id === animationSelectedItem.id),
      );
      const resolvedTarget: SpreadAnimation["target"] = parentComposite
        ? { id: parentComposite.id, type: "composite" }
        : {
            id: animationSelectedItem.id,
            type: animationSelectedItem.type as SpreadAnimation["target"]["type"],
          };

      const effectItemType: ItemType = parentComposite
        ? inferEffectTypeForComposite(parentComposite)
        : animationSelectedItem.type;

      log.info("handleAddAnimation", "adding animation", {
        effectType,
        targetId: resolvedTarget.id,
        targetType: resolvedTarget.type,
        rerouted: !!parentComposite,
      });
      if (parentComposite) {
        log.debug("handleAddAnimation", "re-target to composite", {
          variantId: animationSelectedItem.id,
          compositeId: parentComposite.id,
          effectItemType,
        });
      }

      const maxOrder = animations.reduce((max, a) => Math.max(max, a.order), -1);
      const itemGeometryForEffect = resolveTargetItemGeometry(resolvedTarget, currentSpread);
      const effect = buildDefaultEffect(
        effectType,
        spreadRatio,
        itemGeometryForEffect ?? undefined,
      );

      // Skip auto-fetch media duration for composite: composite has no direct media_url.
      if (resolvedTarget.type !== "composite") {
        // Auto-set duration for Play effect on video/audio targets
        if (
          effectType === EFFECT_TYPE.PLAY &&
          (animationSelectedItem.type === "video" || animationSelectedItem.type === "audio")
        ) {
          const mediaUrl = findMediaUrlFromSpread(
            currentSpread,
            animationSelectedItem.id,
            animationSelectedItem.type,
          );
          if (mediaUrl) {
            const durationMs = await fetchMediaDurationMs(mediaUrl);
            if (durationMs) {
              effect.duration = durationMs;
              log.debug("handleAddAnimation", "auto-set play duration from media", {
                durationMs,
              });
            }
          }
        }

        // Auto-set duration for Read-Along effect on textbox targets
        if (
          effectType === EFFECT_TYPE.READ_ALONG &&
          animationSelectedItem.type === "textbox"
        ) {
          const textbox = currentSpread?.textboxes?.find(
            (tb) => tb.id === animationSelectedItem.id,
          );
          if (textbox) {
            const result = getTextboxContentForLanguage(
              textbox as Record<string, unknown>,
              languageCode,
            );
            const url = result?.content?.audio?.combined_audio_url;
            if (url) {
              const durationMs = await fetchMediaDurationMs(url);
              if (durationMs) {
                effect.duration = durationMs;
                log.debug(
                  "handleAddAnimation",
                  "auto-set read-along duration from narration audio",
                  { durationMs },
                );
              }
            }
          }
        }
      } else {
        log.debug(
          "handleAddAnimation",
          "skip media duration auto-fetch for composite target",
          { compositeId: resolvedTarget.id },
        );
      }

      const newAnimation: SpreadAnimation = {
        order: maxOrder + 1,
        type: 0,
        target: resolvedTarget,
        trigger_type: "on_next",
        effect,
      };

      actions.addRetouchAnimation(selectedSpreadId, newAnimation);
      setExpandedAnimIndex(animations.length);
    },
    [
      animationSelectedItem,
      selectedSpreadId,
      spreadEditable,
      animations,
      actions,
      currentSpread,
      languageCode,
      spreadRatio,
    ],
  );

  const handleDrawZoomAreaComplete = useCallback(
    (geometry: ZoomAreaGeometry) => {
      if (!selectedSpreadId || !spreadEditable) return;
      log.info("handleDrawZoomAreaComplete", "create camera zoom animation", {
        w: geometry.w,
        h: geometry.h,
      });
      const maxOrder = animations.reduce((max, a) => Math.max(max, a.order), -1);
      const newAnimation: SpreadAnimation = {
        order: maxOrder + 1,
        type: 0,
        target: { id: "spread", type: "spread" },
        trigger_type: "on_next",
        effect: {
          type: 19,
          delay: 0,
          duration: 3000,
          geometry,
          payload: { ease_time: 500 },
        },
      };
      actions.addRetouchAnimation(selectedSpreadId, newAnimation);
      setExpandedAnimIndex(animations.length);
      setDrawZoomAreaMode(false);
    },
    [selectedSpreadId, spreadEditable, animations, actions],
  );

  const handleDrawZoomAreaCancel = useCallback(() => {
    log.debug("handleDrawZoomAreaCancel", "cancel draw mode", {});
    setDrawZoomAreaMode(false);
  }, []);

  const handleCameraZoomGeometryChange = useCallback(
    (animationIndex: number, geometry: ZoomAreaGeometry) => {
      if (!selectedSpreadId || !spreadEditable) return;
      const current = animations[animationIndex];
      if (!current) {
        log.warn("handleCameraZoomGeometryChange", "animation not found", { animationIndex });
        return;
      }
      log.debug("handleCameraZoomGeometryChange", "update geometry", { animationIndex });
      actions.updateRetouchAnimation(selectedSpreadId, animationIndex, {
        effect: { ...current.effect, geometry },
      });
    },
    [selectedSpreadId, spreadEditable, animations, actions],
  );

  const handleMotionLineGeometryChange = useCallback(
    (animationIndex: number, geometry: MotionLineGeometry) => {
      if (!selectedSpreadId || !spreadEditable) return;
      const current = animations[animationIndex];
      if (!current) {
        log.warn("handleMotionLineGeometryChange", "animation not found", { animationIndex });
        return;
      }
      if (current.effect.type !== 16) {
        log.warn("handleMotionLineGeometryChange", "animation type mismatch", {
          animationIndex,
          type: current.effect.type,
        });
        return;
      }
      log.info("handleMotionLineGeometryChange", "update geometry", {
        animationIndex,
        x: geometry.x,
        y: geometry.y,
      });
      actions.updateRetouchAnimation(selectedSpreadId, animationIndex, {
        effect: { ...current.effect, geometry },
      });
    },
    [selectedSpreadId, spreadEditable, animations, actions],
  );

  const handleUpdateAnimation = useCallback(
    (index: number, updates: Partial<SpreadAnimation>) => {
      if (!selectedSpreadId || !spreadEditable) return;
      log.debug("handleUpdateAnimation", "updating", {
        index,
        keys: Object.keys(updates),
      });

      // Component must merge effect fields before calling store (shallow replace)
      if (updates.effect && animations[index]) {
        const current = animations[index];
        const mergedEffect = { ...current.effect, ...updates.effect };

        // Auto-sync effect.duration for PLAY + audio target on loop/type change.
        const isPlayAudio =
          mergedEffect.type === EFFECT_TYPE.PLAY && current.target.type === "audio";
        const loopChanged = updates.effect.loop !== undefined;
        const typeChangedToPlay =
          updates.effect.type === EFFECT_TYPE.PLAY &&
          current.effect.type !== EFFECT_TYPE.PLAY;

        if (isPlayAudio && (loopChanged || typeChangedToPlay)) {
          const audio = currentSpread?.audios?.find((a) => a.id === current.target.id);
          if (audio?.media_length && audio.media_length > 0) {
            const newDuration = computePlayEffectDuration({
              loop: mergedEffect.loop,
              media_length: audio.media_length,
            });
            if (newDuration !== undefined) {
              log.info("handleUpdateAnimation", "auto-sync effect.duration", {
                animationId: current.target.id,
                loop: mergedEffect.loop,
                media_length: audio.media_length,
                newDuration,
              });
              mergedEffect.duration = newDuration;
            }
          } else {
            log.warn("handleUpdateAnimation", "media_length missing — keeping user-set duration", {
              audioId: current.target.id,
            });
          }
        }

        const merged: Partial<SpreadAnimation> = {
          ...updates,
          effect: mergedEffect,
        };
        actions.updateRetouchAnimation(selectedSpreadId, index, merged);
      } else {
        actions.updateRetouchAnimation(selectedSpreadId, index, updates);
      }
    },
    [selectedSpreadId, spreadEditable, animations, actions, currentSpread],
  );

  const handleDeleteAnimation = useCallback(
    (index: number) => {
      if (!selectedSpreadId || !spreadEditable) return;
      log.info("handleDeleteAnimation", "deleting", { index });
      actions.deleteRetouchAnimation(selectedSpreadId, index);
      if (expandedAnimIndex === index) {
        setExpandedAnimIndex(null);
      } else if (expandedAnimIndex !== null && expandedAnimIndex > index) {
        setExpandedAnimIndex(expandedAnimIndex - 1);
      }
    },
    [selectedSpreadId, spreadEditable, actions, expandedAnimIndex],
  );

  const handleReorderAnimation = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!selectedSpreadId || !spreadEditable) return;
      log.debug("handleReorderAnimation", "reordering", {
        fromIndex,
        toIndex,
        expandedAnimIndex,
      });
      actions.reorderRetouchAnimations(selectedSpreadId, fromIndex, toIndex);

      // Keep expanded index tracking the same item after reorder
      setExpandedAnimIndex((prev) => {
        if (prev === null) return null;
        if (prev === fromIndex) return toIndex;
        if (fromIndex < toIndex && prev > fromIndex && prev <= toIndex) return prev - 1;
        if (fromIndex > toIndex && prev >= toIndex && prev < fromIndex) return prev + 1;
        return prev;
      });
    },
    [selectedSpreadId, spreadEditable, actions, expandedAnimIndex],
  );

  const handleFilterChange = useCallback(
    (updates: Partial<AnimationFilterState>) => {
      setFilterState((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  // --- Render ---
  log.debug("render", "ObjectsCreativeSpace", {
    spreadCount: retouchSpreadIds.length,
    animationSidebarCollapsed,
  });

  if (retouchSpreadIds.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">No spreads available</p>
      </div>
    );
  }

  // animationSidebarCollapsed === undefined → default OPEN per Validation S1
  const isSidebarOpen = animationSidebarCollapsed !== true;

  return (
    <div className="relative flex h-full">
      <ObjectsSidebar
        selectedSpreadId={selectedSpreadId ?? ""}
        selectedItemId={selectedItemId}
        onItemSelect={handleItemSelect}
        isEditable={spreadEditable}
      />

      <div className="relative flex-1 min-w-0 overflow-hidden">
        {/* Edit affordance is global now — the header owns undo/redo + the Unsaved/Saved status
            (ADR-044/045). The canvas greys out via isEditable=false (see spreadEditable) until the
            retouch lock is held (lock-on-click). */}
        <ObjectsMainView
          selectedSpreadId={selectedSpreadId ?? ""}
          selectedItemId={selectedItemId}
          onSpreadSelect={handleSpreadSelect}
          onItemSelect={handleItemSelect}
          spreadEditable={spreadEditable}
          onCommitSave={retouchSaveNow}
          zoomLevel={zoomLevel ?? ZOOM.DEFAULT}
          onZoomChange={handleZoomChange}
          expandedAnimation={expandedAnimationRaw}
          expandedAnimationIndex={expandedAnimationOriginalIndex}
          allAnimations={animations}
          onCameraZoomGeometryChange={handleCameraZoomGeometryChange}
          onMotionLineGeometryChange={handleMotionLineGeometryChange}
          drawZoomAreaMode={drawZoomAreaMode}
          onDrawZoomAreaComplete={handleDrawZoomAreaComplete}
          onDrawZoomAreaCancel={handleDrawZoomAreaCancel}
        />

        {/* Floating toggle button — bottom-right of canvas, offset left of AI Assistant FAB */}
        <button
          aria-label={
            isSidebarOpen
              ? "Close animations sidebar"
              : "Open animations sidebar"
          }
          onClick={handleAnimationSidebarToggle}
          className="absolute top-16 right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md hover:bg-primary/90"
          title={isSidebarOpen ? "Hide animations" : "Show animations"}
        >
          <Zap className="h-5 w-5" />
        </button>
      </div>

      {/* Right sidebar — conditional. Default OPEN: animationSidebarCollapsed !== true */}
      {isSidebarOpen && (
        <AnimationEditorSidebar
          animations={filteredAnimations}
          allAnimations={resolvedAnimations}
          selectedItem={animationSelectedItem}
          expandedAnimationIndex={expandedAnimIndex}
          availableEffects={availableEffects}
          filterState={filterState}
          objectFilterOptions={objectFilterOptions}
          onFilterChange={handleFilterChange}
          onExpandChange={setExpandedAnimIndex}
          onAddAnimation={handleAddAnimation}
          onUpdateAnimation={handleUpdateAnimation}
          onDeleteAnimation={handleDeleteAnimation}
          onReorderAnimation={handleReorderAnimation}
          onItemSelect={handleAnimationSidebarItemSelect}
          targetHasAudio={targetHasAudio}
          editable={spreadEditable}
        />
      )}
    </div>
  );
}

export default ObjectsCreativeSpace;
