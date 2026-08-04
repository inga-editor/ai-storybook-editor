// sketch-spread-canvas.tsx — dedicated single-spread canvas for the sketch-spread creative space.
//
// Renders ONE sketch spread in a fit-to-screen frame (trim-size aspect, no bleed, no staging,
// overflow:hidden). Owns its own selection state (the role the shared SpreadEditorPanel plays
// elsewhere). Reuses leaf items — PageItem (bg + page number, non-selectable), SelectionFrame +
// EditableTextbox + SpreadsTextToolbar (editable) — and a plain-<img> LockedPageImage for the
// per-page backdrops (validation session 1: NOT EditableImage).
//
// Interaction model:
//  - Page images: geometry-LOCKED cover (never drag/resize/crop) but SELECTABLE (validation
//    session 1) — selecting one mounts the floating SketchImageToolbar (Edit + Extract). Edit /
//    Extract are caller-owns-write: their result is appended as a NEW page-image version
//    (addSketchSpreadImageVersion), never spawned as a layer. Selection is mutual-exclusive with
//    the textbox selection (one item at a time). Escape deselects; Delete/Backspace do NOT delete
//    a page image (it is versioned, not deletable). While the spread's generate job runs the image
//    is non-selectable and the toolbar/modal are hidden (guard-at-render race-guard).
//  - Textboxes: select / drag / resize (hard-clamped to [0,100], min 5%) / inline-edit / toolbar /
//    delete. NO rotate, NO add-textbox. Per-language via the current header language.
//  - Keyboard (local, only when a textbox is selected & not editing): Delete/Backspace → delete,
//    Escape → deselect, Arrow → nudge 1% (Shift 10%).

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageItem } from '@/features/editor/components/canvas-spread-view/page-item';
import { SelectionFrame } from '@/features/editor/components/canvas-spread-view/selection-frame';
import { clamp } from '@/features/editor/components/canvas-spread-view/utils/coordinate-utils';
import { applyResizeDelta } from '@/features/editor/components/canvas-spread-view/utils/geometry-utils';
import { EditableTextbox } from '@/features/editor/components/shared-components';
import { SpreadsTextToolbar } from '@/features/editor/components/spreads-creative-space/spreads-text-toolbar';
import {
  useSketchSpreadById,
  useSketchSpreadIds,
  useSketchSpreadGenerating,
  useSnapshotActions,
} from '@/stores/snapshot-store/selectors';
import {
  useTrimSize,
  useSetZoomLevel,
  useLanguageCode,
} from '@/stores/editor-settings-store';
import { CANVAS, LAYER_CONFIG } from '@/constants/spread-constants';
import {
  SKETCH_PAGE_GEOMETRY,
  getSketchSpreadPageImageUrl,
  getSketchTextboxContent,
} from '@/types/sketch';
import type { SketchTextbox, SketchTextboxContent, SketchSpreadImage } from '@/types/sketch';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import {
  makeSketchImageId,
  makeSketchTextboxId,
} from '@/stores/save-session-store/sketch-spread-item-id';
import type { SaveDomain } from '@/stores/save-session-store';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import {
  useResourceLockStore,
  FALLBACK_HOLDER_NAME,
} from '@/stores/resource-lock-store';
import type {
  BaseSpread,
  Geometry,
  PageData,
  ResizeHandle,
  SpreadTextbox,
  TextToolbarContext,
  Typography,
} from '@/types/canvas-types';
import type { SpreadTextboxContent } from '@/types/spread-types';
import { useCurrentBook, useBookActions, useBookStepTypography } from '@/stores/book-store';
import { mapTypographyToTextbox } from '@/constants/book-defaults';
import { DEFAULT_TYPOGRAPHY } from '@/constants/config-constants';
import {
  upsertCropPreset,
  deleteCropPreset,
} from '@/features/editor/components/shared-components/extract-image-modal/crop-preset-utils';
import type { CropPreset } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import { LockedPageImage } from './sketch-spread-canvas-page-image';
import { SketchImageToolbar } from './sketch-image-toolbar';
import { SketchImageToolsModals } from './sketch-image-tools-modals';
import { computeSketchPageNumbers } from './compute-sketch-page-numbers';
import { SketchTextboxLockGate } from './sketch-spread-canvas-textbox-lock-gate';
import { LockedByOtherOverlay } from '../shared-components/sketch-locked-by-other-overlay';

const log = createLogger('Editor', 'SketchSpreadCanvas');

// Nudge steps (locked decision phase-03): 1% normally, 10% with Shift.
// (CANVAS.NUDGE_STEP = 1 is reused; the Shift step is 10 here, not CANVAS.NUDGE_STEP_SHIFT=5.)
const NUDGE_STEP = CANVAS.NUDGE_STEP;
const NUDGE_STEP_SHIFT = 10;
// Min textbox size (%) — matches CANVAS.MIN_ELEMENT_SIZE.
const MIN_TEXTBOX_SIZE = CANVAS.MIN_ELEMENT_SIZE;

/** Hard-clamp a textbox geometry to the visible frame [0,100] with a 5% min size.
 *  The sketch canvas has NO staging (unlike SpreadEditorPanel's soft ±50% bounds). */
function clampTextboxGeometryToFrame(g: Geometry): Geometry {
  const w = clamp(g.w, MIN_TEXTBOX_SIZE, 100);
  const h = clamp(g.h, MIN_TEXTBOX_SIZE, 100);
  const x = clamp(g.x, 0, 100 - w);
  const y = clamp(g.y, 0, 100 - h);
  return { ...g, x, y, w, h };
}

/** Minimal PageData for the non-interactive PageItem (bg + page number only). */
function makePageData(number: number): PageData {
  return { number, type: 'normal_page', layout: null, background: { color: '#ffffff', texture: null } };
}

/** Visual-only vertical spine at 50% (pointer-events:none). */
function SpineDivider() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0"
      style={{
        left: '50%',
        width: 1,
        transform: 'translateX(-0.5px)',
        backgroundColor: 'rgba(0,0,0,0.12)',
        zIndex: 1,
      }}
    />
  );
}

export interface SketchSpreadCanvasProps {
  spreadId: string;
}

export function SketchSpreadCanvas({ spreadId }: SketchSpreadCanvasProps) {
  const spread = useSketchSpreadById(spreadId);
  const trim = useTrimSize();
  const langCode = useLanguageCode();
  const focusGen = useSketchSpreadGenerating(spreadId);
  const spreadIds = useSketchSpreadIds();
  const {
    updateSketchTextbox,
    deleteSketchTextbox,
    addSketchSpreadImageVersion,
    selectSketchSpreadImageVersion,
    setSketchSpreads,
  } = useSnapshotActions();
  const setZoomLevel = useSetZoomLevel();
  const book = useCurrentBook();
  const { updateBook } = useBookActions();
  // Sketch-step book typography — backfills the 8 fields legacy sketch textboxes
  // (stored only { size, color }) omit, at render time (no store mutation).
  const sketchStepTypo = useBookStepTypography('sketch');

  const frameRef = useRef<HTMLDivElement>(null);
  // Latest committed-pending geometry during an active drag/resize — read only in handlers.
  const latestGeoRef = useRef<Geometry | null>(null);

  const [selectedTextboxId, setSelectedTextboxId] = useState<string | null>(null);
  const [editingTextboxId, setEditingTextboxId] = useState<string | null>(null);
  const [activeHandle, setActiveHandle] = useState<ResizeHandle | null>(null);
  // Live drag/resize preview (local) — committed to the store on END (not per-frame).
  const [previewGeometry, setPreviewGeometry] = useState<Geometry | null>(null);
  // Page-image selection (mutual-exclusive with textbox) + which shared modal is open. selImg is
  // live-derived from selectedImageId below, so `activeModal` alone (no imageId) is enough state.
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'edit' | 'extract' | null>(null);

  // Crop presets live on the book (book.crop_presets), CRUD'd via book-store updateBook — mirror
  // raw/object main-views so the sketch Extract crop tab gets FULL preset management.
  const handleUpsertCropPreset = useCallback(
    (preset: CropPreset) => {
      if (!book) return;
      log.debug('handleUpsertCropPreset', 'upsert crop preset', { presetId: preset.id });
      void updateBook(book.id, { crop_presets: upsertCropPreset(book.crop_presets ?? [], preset) });
    },
    [book, updateBook],
  );
  const handleDeleteCropPreset = useCallback(
    (presetId: string) => {
      if (!book) return;
      log.debug('handleDeleteCropPreset', 'delete crop preset', { presetId });
      void updateBook(book.id, { crop_presets: deleteCropPreset(book.crop_presets ?? [], presetId) });
    },
    [book, updateBook],
  );

  // Broadcast zoom=100 on mount so reused EditableTextbox/SelectionFrame read the right scale
  // instead of a stale value left by another creative space (insight #1). This calls the store
  // setter (not local setState) — allowed as a mount effect under React-19 rules.
  useEffect(() => {
    log.info('mount', 'sketch spread canvas mounted', { spreadId });
    setZoomLevel(100);
  }, [setZoomLevel, spreadId]);

  const pageNos = useMemo(
    () => computeSketchPageNumbers(spreadIds, spreadId),
    [spreadIds, spreadId],
  );

  const deselect = useCallback(() => {
    setSelectedTextboxId(null);
    setEditingTextboxId(null);
    setPreviewGeometry(null);
    setActiveHandle(null);
    setSelectedImageId(null);
    // Clear any open modal too — otherwise re-selecting the same image would auto-reopen it.
    setActiveModal(null);
    // Drop any in-flight drag geometry so a stale value can't commit onto the next selection
    // if the SelectionFrame unmounts mid-drag (selection flips before onDragEnd fires).
    latestGeoRef.current = null;
  }, []);

  // Selecting a page image clears any textbox selection (one item at a time), and vice versa.
  const selectImage = useCallback((imageId: string) => {
    log.debug('selectImage', 'select page image', { imageId });
    setSelectedImageId(imageId);
    setSelectedTextboxId(null);
    setEditingTextboxId(null);
    setPreviewGeometry(null);
    setActiveHandle(null);
    // Clear any stale modal intent so mere (re)selection can't auto-open a modal that survived an
    // unmount which bypassed onOpenChange (e.g. a generation-gate flip).
    setActiveModal(null);
    latestGeoRef.current = null;
  }, []);

  const selectTextbox = useCallback((textboxId: string) => {
    setSelectedTextboxId(textboxId);
    setSelectedImageId(null);
    setActiveModal(null);
  }, []);

  const commitGeometry = useCallback(
    (textboxId: string) => {
      const geo = latestGeoRef.current;
      if (geo) {
        log.debug('commitGeometry', 'commit textbox geometry', { textboxId });
        updateSketchTextbox(spreadId, textboxId, langCode, { geometry: geo });
      }
      latestGeoRef.current = null;
      setPreviewGeometry(null);
      // Re-focus the frame so local keyboard (nudge/delete/deselect) stays live after a Moveable
      // drag/resize, which can pull focus out of the textbox subtree.
      frameRef.current?.focus();
    },
    [spreadId, langCode, updateSketchTextbox],
  );

  const handleFramePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Empty-frame click (page items + images are pointer-events:none → event.target === frame).
      if (e.target === e.currentTarget) {
        log.debug('handleFramePointerDown', 'empty frame → deselect');
        deselect();
      }
    },
    [deselect],
  );

  // Local keyboard handler (bubbles from the focused textbox). Only acts when a textbox is
  // selected and NOT in inline-edit. Delete/Backspace → delete, Escape → deselect, Arrow → nudge.
  const handleFrameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Image selection: Escape deselects. NOTE: Delete/Backspace are intentionally NOT bound for
      // a selected page image — the page image is never deleted, only versioned.
      if (selectedImageId) {
        if (e.key === 'Escape') {
          e.preventDefault();
          deselect();
        }
        return;
      }

      if (!selectedTextboxId || editingTextboxId) return;

      // Escape always clears the (possibly stale) selection.
      if (e.key === 'Escape') {
        e.preventDefault();
        deselect();
        return;
      }

      // Resolve the selected textbox's content in the CURRENT language BEFORE any mutation. If it
      // has none (e.g. after a header language switch), the textbox isn't visible/selectable here
      // → ignore Delete/Arrow so we can't mutate an off-screen item (which would drop ALL languages).
      const tb = spread?.textboxes.find((t) => t.id === selectedTextboxId);
      const content = tb ? getSketchTextboxContent(tb, langCode) : undefined;
      if (!content) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        log.info('handleFrameKeyDown', 'delete selected textbox', { textboxId: selectedTextboxId });
        deleteSketchTextbox(spreadId, selectedTextboxId);
        deselect();
        return;
      }

      const step = e.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
      let dx = 0;
      let dy = 0;
      switch (e.key) {
        case 'ArrowLeft': dx = -step; break;
        case 'ArrowRight': dx = step; break;
        case 'ArrowUp': dy = -step; break;
        case 'ArrowDown': dy = step; break;
        default: return;
      }
      e.preventDefault();
      const next = clampTextboxGeometryToFrame({
        ...content.geometry,
        x: content.geometry.x + dx,
        y: content.geometry.y + dy,
      });
      updateSketchTextbox(spreadId, selectedTextboxId, langCode, { geometry: next });
    },
    [selectedImageId, selectedTextboxId, editingTextboxId, spread, langCode, spreadId, deselect, deleteSketchTextbox, updateSketchTextbox],
  );

  // ── Collaborator edit-lock lifecycle ─────────────────────────────────────────
  // The current selection (image XOR textbox) IS the save-session target: selecting acquires,
  // deselecting release-and-saves-if-dirty (design §18). Edits stay LOCAL until release
  // (collabPersist). getNode + buildPayload (audit map / create-fallback for a client-minted page
  // image) now live in the policy registry (save-policies `sketch-image` / `sketch-textbox`); the
  // canvas only threads the COMPOSITE id the policy needs (parent spread, + locale for the textbox).
  const sessionDomain: SaveDomain = selectedImageId ? 'sketch-image' : 'sketch-textbox';
  const sessionId = selectedImageId
    ? makeSketchImageId(spreadId, selectedImageId)
    : selectedTextboxId
      ? makeSketchTextboxId(spreadId, selectedTextboxId, langCode)
      : null; // nothing selected → no session (idle)
  // image = language-agnostic (locale null); textbox = per-language (locale = current langCode). The
  // locale lives in the lock target so switching header language while holding a textbox re-keys.
  const sessionLocale = selectedImageId ? null : langCode;

  // 409 on acquire → another editor holds it. Revert the optimistic selection + toast. `holder` is
  // a user id (MAY be '') — resolve its cached name best-effort, else the generic fallback.
  const onLockBlocked = useCallback(
    (holder: string) => {
      const name = holder
        ? useResourceLockStore.getState().holderNames.get(holder) ?? FALLBACK_HOLDER_NAME
        : FALLBACK_HOLDER_NAME;
      log.info('onLockBlocked', 'acquire blocked — revert selection', { hasHolder: !!holder });
      toast.info(`${name} is editing this — try again shortly`);
      deselect();
    },
    [deselect],
  );

  // Heartbeat 409 → the lock was stolen mid-edit (SRS §10 = REVERT to baseline, unlike a save-lost
  // which keeps local). Write the pre-edit node back, force-deselect, toast.
  const onLockLost = useCallback(
    (baseline: unknown) => {
      log.warn('onLockLost', 'lock lost via heartbeat — revert node + deselect', {
        hasImage: !!selectedImageId,
        hasTextbox: !!selectedTextboxId,
      });
      if (selectedImageId && baseline) {
        // Rebuild spreads with the target image restored to baseline (reuse setSketchSpreads — no
        // dedicated revert action needed). Undoes any prepended Edit/Extract version.
        const spreads = useSnapshotStore.getState().sketch.spreads;
        const next = spreads.map((sp) =>
          sp.id !== spreadId
            ? sp
            : {
                ...sp,
                images: sp.images.map((im) =>
                  im.id === selectedImageId ? (baseline as SketchSpreadImage) : im,
                ),
              },
        );
        setSketchSpreads(next);
      } else if (selectedTextboxId && baseline) {
        // Full-content merge restores every field (text/geometry/typography) to baseline.
        updateSketchTextbox(spreadId, selectedTextboxId, langCode, baseline as SketchTextboxContent);
      }
      deselect();
      toast.warning('You lost the edit lock — your changes were reverted');
    },
    [selectedImageId, selectedTextboxId, spreadId, langCode, setSketchSpreads, updateSketchTextbox, deselect],
  );

  // Single session for the ONE selected resource (image XOR textbox). `sessionLocale` lives in the
  // target, so switching header language while holding a textbox auto re-keys (release old locale
  // dirty-checked → acquire new). getNode/buildPayload are policy-owned (save-policies). The engine
  // captures bookId in its SessionEntry, so the release-save survives an out-of-order space unmount
  // (fixes the two latent canvas bugs: cleanup reading live myLocks, and the missing bookId override).
  const { saveNow } = useSaveSession({
    domain: sessionDomain,
    id: sessionId,
    locale: sessionLocale,
    onBlocked: onLockBlocked,
    onLost: onLockLost,
  });

  // Header "Unsaved" commit (spec §7): the canvas now has an explicit saveNow, so committing SAVES
  // FOR REAL (save-while-held + rebase) and THEN deselects (release the now-clean lock). `saveNow` is
  // read through a ref so the registered callback stays STABLE across selection switches
  // (useRegisterEditCommit requires a stable fn) while always saving the CURRENTLY held item.
  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  });
  const commitCanvas = useCallback(() => {
    log.info('commitCanvas', 'commit held sketch session (save + deselect)');
    void saveNowRef.current().finally(() => deselect());
  }, [deselect]);
  useRegisterEditCommit(commitCanvas);

  if (!spread) {
    log.debug('render', 'no spread — render null', { spreadId });
    return null;
  }

  // Minimal BaseSpread-ish object for the non-interactive PageItem layout-lock check
  // (reads pages/images/textboxes). Empty images/textboxes ⇒ layout never locked (unused anyway
  // since we omit renderPageToolbar → non-selectable).
  const leftPage = makePageData(pageNos.left);
  const rightPage = makePageData(pageNos.right);
  const pageSpread = {
    id: spreadId,
    pages: [leftPage, rightPage],
    images: [],
    textboxes: [],
  } as unknown as BaseSpread;

  const ratio = trim.width / trim.height;

  // Live-derive the selected page image from the store each render (mirror the remix canvas) so an
  // Edit/Extract commit that appends a new version is reflected without re-opening. `showImageUI`
  // is the render-time race-guard: while the spread's generate job runs we keep the selection but
  // hide the toolbar/modal (no set-state-in-effect — React-19 rule).
  const selImg = spread.images.find((im) => im.id === selectedImageId);
  const selUrl = selImg ? getSketchSpreadPageImageUrl(spread, selImg.type) : null;
  const selOrdinal = selImg ? spread.pages.findIndex((p) => p.type === selImg.type) + 1 : 0;
  const showImageUI = Boolean(selImg) && !focusGen.isGenerating;

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      // Deselect on a click in the letterbox gutter AROUND the fitted frame too — not just inside
      // the empty frame. The frame is centered with margins, so gutter clicks land HERE, not on the
      // inner frame's own onPointerDown; without this handler they do nothing and the current
      // selection (hence the edit lock) is never released → the lock stays held and heartbeat renews
      // it indefinitely. The shared handler's `target === currentTarget` guard means clicks on the
      // frame / its children / portaled toolbars are ignored (only a bare gutter click deselects).
      onPointerDown={handleFramePointerDown}
      // isolate: contain the canvas stacking band (divider z:1 … textbox/frame z:700) so it can't
      // out-paint the SpreadsTextToolbar, which portals to document.body with z-auto. Without this,
      // `container-type: size` on a z-auto relative box does NOT confine children in Chrome, and the
      // spine divider / textboxes leak to the root context and paint over the floating toolbar.
      style={{ containerType: 'size', isolation: 'isolate' }}
    >
      <div
        ref={frameRef}
        role="group"
        aria-label={`Sketch spread pages ${pageNos.left}–${pageNos.right}`}
        tabIndex={-1}
        onPointerDown={handleFramePointerDown}
        onKeyDown={handleFrameKeyDown}
        className="relative overflow-hidden bg-white shadow-md outline-none"
        style={{
          aspectRatio: `${trim.width} / ${trim.height}`,
          // Largest ratio-preserving box that fits the container (contain), CSS-only.
          width: `min(100cqw, ${ratio} * 100cqh)`,
          maxWidth: '100%',
          maxHeight: '100%',
        }}
      >
        {/* --- Page layer (always 2, even for a 'full' spread) --- */}
        <PageItem
          page={leftPage}
          pageIndex={0}
          spread={pageSpread}
          spreadId={spreadId}
          position="left"
          isSelected={false}
          onUpdatePage={() => {}}
          availableLayouts={[]}
        />
        <PageItem
          page={rightPage}
          pageIndex={1}
          spread={pageSpread}
          spreadId={spreadId}
          position="right"
          isSelected={false}
          onUpdatePage={() => {}}
          availableLayouts={[]}
        />
        <SpineDivider />

        {/* --- Image layer (per page type; geometry-locked cover, selectable) --- */}
        {spread.pages.map((p, i) => {
          const geometry = SKETCH_PAGE_GEOMETRY[p.type];
          if (!geometry) return null; // guard a corrupt page type (unvalidated in normalizer)
          const url = getSketchSpreadPageImageUrl(spread, p.type);
          const img = spread.images.find((im) => im.type === p.type);
          return (
            <LockedPageImage
              key={`${p.type}-${url ?? 'none'}`}
              geometry={geometry}
              url={url}
              generating={focusGen.isGenerating}
              ordinal={i + 1}
              isSelected={Boolean(img) && img?.id === selectedImageId}
              onSelect={img ? () => selectImage(img.id) : undefined}
              imageId={img?.id}
            />
          );
        })}

        {/* --- Textbox layer (per-language; selectable/editable) --- */}
        {spread.textboxes.map((tb: SketchTextbox, i) => {
          const content = getSketchTextboxContent(tb, langCode);
          if (!content) return null; // no content for the current language → skip

          // Legacy sketch textboxes persisted only { size, color }; backfill the
          // remaining 8 typography fields from book.typography.sketch[lang] at
          // render time (user-set values win; no store mutation).
          const resolvedTypography: Typography = {
            ...mapTypographyToTextbox(sketchStepTypo?.[langCode] ?? DEFAULT_TYPOGRAPHY),
            ...content.typography,
          };

          const isSel = tb.id === selectedTextboxId;
          const isEdit = tb.id === editingTextboxId;
          const displayGeometry = isSel && previewGeometry ? previewGeometry : content.geometry;
          // During a live drag/resize the textbox renders at the preview geometry so it moves with
          // the SelectionFrame; the store write happens once on END (commitGeometry).
          const displayContent: SpreadTextboxContent = {
            ...(content as SpreadTextboxContent),
            typography: resolvedTypography,
            geometry: displayGeometry,
          };

          const startGeometry = content.geometry;

          const toolbarContext: TextToolbarContext<BaseSpread> = {
            item: tb as unknown as SpreadTextbox,
            itemIndex: i,
            spreadId,
            spread: spread as unknown as BaseSpread,
            isSelected: true,
            isSpreadSelected: true,
            selectedGeometry: displayGeometry,
            canvasRef: frameRef,
            onSelect: () => selectTextbox(tb.id),
            onTextChange: (text: string) =>
              updateSketchTextbox(spreadId, tb.id, langCode, { text }),
            // Toolbar geometry edits emit { [langCode]: fullContent }; unwrap → per-language patch.
            onUpdate: (updates: Partial<SpreadTextbox>) => {
              const c = (updates as Record<string, unknown>)[langCode];
              if (c && typeof c === 'object') {
                updateSketchTextbox(spreadId, tb.id, langCode, c as SketchTextboxContent);
              }
            },
            onFormatText: (format: Partial<Typography>) =>
              updateSketchTextbox(spreadId, tb.id, langCode, {
                // Persist the resolved (full 10-field) typography so a format edit
                // also upgrades a legacy { size, color } textbox in one write.
                typography: { ...resolvedTypography, ...format },
              }),
            onDelete: () => {
              log.info('onDelete', 'delete textbox via toolbar', { textboxId: tb.id });
              deleteSketchTextbox(spreadId, tb.id);
              deselect();
            },
            onEditText: () => setEditingTextboxId(tb.id),
            onEditingChange: (editing: boolean) => setEditingTextboxId(editing ? tb.id : null),
            isEditing: isEdit,
          };

          return (
            <SketchTextboxLockGate key={tb.id} textboxId={tb.id} langCode={langCode}>
              {(lockedByOther, holderName) =>
                lockedByOther ? (
                  <>
                    {/* Other-held → static, non-selectable textbox + dim veil (no frame/toolbar). */}
                    <EditableTextbox
                      textboxContent={displayContent}
                      index={i}
                      zIndex={LAYER_CONFIG.TEXT.min + i}
                      isSelected={false}
                      isSelectable={false}
                      isEditable={false}
                      isEditing={false}
                      onSelect={() => {}}
                      onTextChange={() => {}}
                      onEditingChange={() => {}}
                    />
                    <LockedByOtherOverlay
                      holderName={holderName}
                      geometry={content.geometry}
                      zIndex={LAYER_CONFIG.TEXT.max}
                      interactive
                    />
                  </>
                ) : (
                <>
              <EditableTextbox
                textboxContent={displayContent}
                index={i}
                zIndex={LAYER_CONFIG.TEXT.min + i}
                isSelected={isSel}
                isSelectable
                isEditable
                isEditing={isEdit}
                onSelect={() => {
                  log.info('onSelectTextbox', 'textbox selected', { index: i });
                  selectTextbox(tb.id);
                }}
                onTextChange={(text) => updateSketchTextbox(spreadId, tb.id, langCode, { text })}
                onEditingChange={(editing) => setEditingTextboxId(editing ? tb.id : null)}
              />

              {isSel && !isEdit && (
                <>
                  <SelectionFrame
                    geometry={displayGeometry}
                    zIndex={LAYER_CONFIG.TEXT.max}
                    zoomLevel={100}
                    showHandles
                    showRotateHandle={false}
                    canDrag
                    canResize
                    canRotate={false}
                    activeHandle={activeHandle}
                    onDoubleClick={() => setEditingTextboxId(tb.id)}
                    onDragStart={() => {
                      log.debug('onDragStart', 'textbox drag start', { textboxId: tb.id });
                    }}
                    onDrag={(delta) => {
                      const next = clampTextboxGeometryToFrame({
                        ...startGeometry,
                        x: startGeometry.x + delta.x,
                        y: startGeometry.y + delta.y,
                      });
                      latestGeoRef.current = next;
                      setPreviewGeometry(next);
                    }}
                    onDragEnd={() => commitGeometry(tb.id)}
                    onResizeStart={(handle) => setActiveHandle(handle)}
                    onResize={(handle, delta) => {
                      const next = clampTextboxGeometryToFrame(
                        applyResizeDelta(startGeometry, handle, delta.x, delta.y),
                      );
                      latestGeoRef.current = next;
                      setPreviewGeometry(next);
                    }}
                    onResizeEnd={() => {
                      commitGeometry(tb.id);
                      setActiveHandle(null);
                    }}
                  />
                  <SpreadsTextToolbar<BaseSpread> context={toolbarContext} />
                </>
              )}
                </>
                )
              }
            </SketchTextboxLockGate>
          );
        })}

        {/* --- Selected page image: floating Edit/Extract toolbar (portal) --- */}
        {showImageUI && selImg && (
          <SketchImageToolbar
            selectedGeometry={SKETCH_PAGE_GEOMETRY[selImg.type]}
            canvasRef={frameRef}
            onEditImage={() => {
              log.info('onEditImage', 'open sketch edit modal', { pageType: selImg.type });
              setActiveModal('edit');
            }}
            onExtractImage={() => {
              log.info('onExtractImage', 'open sketch extract modal', { pageType: selImg.type });
              setActiveModal('extract');
            }}
          />
        )}
      </div>

      {/* --- Shared image modals (caller-owns-write → result appended as a new page version). --- */}
      {activeModal && selImg && !focusGen.isGenerating && (
        <SketchImageToolsModals
          activeModal={activeModal}
          image={selImg}
          imageUrl={selUrl}
          ordinal={selOrdinal}
          spreadId={spreadId}
          cropPresets={book?.crop_presets ?? undefined}
          onUpsertCropPreset={handleUpsertCropPreset}
          onDeleteCropPreset={handleDeleteCropPreset}
          onPersistVersion={(url, meta) =>
            addSketchSpreadImageVersion(spreadId, selImg.type, url, meta)
          }
          onSelectVersion={(url) => selectSketchSpreadImageVersion(spreadId, selImg.type, url)}
          onClose={() => setActiveModal(null)}
        />
      )}
    </div>
  );
}

export default SketchSpreadCanvas;
