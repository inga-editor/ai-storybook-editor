'use client';

// extract-lottie-modal.tsx — Root of the standalone Extract-Lottie workspace (design
// component/editor-page/shared/extract-lottie-modal/README.md). Full-screen dark portal that owns
// ALL session state (ExtractLottieModalState + parts) + handlers + ILS + localStorage draft. Four
// mode tabs operate on ONE part set: Parts (segment → bbox → crop) / Pivot / Edit (inpaint +
// auto-remove-bg) / View (composite → build .lottie v2 + spawn auto_pic). Child regions are
// presentational; this file is the single writer of `parts`. Store-agnostic — the parent supplies
// the image + the onCreateAutoPic commit sink (frozen ExtractLottieModalProps).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eraser, Star } from 'lucide-react';
import { toast } from 'sonner';
import { useInteractionLayer, useGlobalHotkey } from '@/features/editor/contexts';
import { createLogger } from '@/utils/logger';
import { CANVAS_CONFIRM_DIALOG_Z } from '@/constants/spread-constants';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { callSegmentLayer } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import {
  resolveSourceImageUrl,
  uploadCroppedToStorage,
  mapExtractError,
} from '../extract-image-modal/extract-image-modal-utils';
import type { Stroke } from '../edit-image-modal/erase-stroke-engine';
import { ZoomControl } from '../zoom-control';
import type {
  BBoxPct,
  ExtractLottieModalProps,
  ExtractLottieModalState,
  LottieDraft,
  LottieModeTab,
  LottiePart,
  LottiePartKind,
  LottiePartVersion,
} from './extract-lottie-modal-types';
import {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  LOTTIE_MODAL_LAYOUT,
  SEGMENT_MODEL_OPTIONS,
  LOTTIE_PARTS_FOLDER,
  MANUAL_DEFAULT_BBOX,
} from './extract-lottie-modal-constants';
import {
  detectAlphaBBox,
  cropImageByBBox,
  selectedVersionOf,
  buildLottieFile,
  slugify,
  downloadBlob,
  localToOriginal,
  originalToLocal,
  intersectBBox,
  erasableChildrenOf,
  erasePartsFromAsset,
} from './extract-lottie-modal-utils';
import { useLottieDraft } from './use-lottie-draft';
import { ExtractLottieModalHeader } from './extract-lottie-modal-header';
import { PartsSidebar } from './parts-sidebar';
import { LottieStageCanvas } from './lottie-stage-canvas';
import { PartBoxOverlay } from './part-box-overlay';
import { PivotOverlay } from './pivot-overlay';
import { PartsTab } from './parts-tab';
import { PivotTab } from './pivot-tab';
import { LottieMaskCanvas } from './lottie-mask-canvas';
import { ViewTab } from './view-tab';
import { useLottieEditTab } from './edit-tab';
import { useLottieEraserTab } from './lottie-eraser-tab';

const log = createLogger('Editor', 'ExtractLottieModal');

const PORTAL_SELECTORS = [
  '[data-radix-popper-content-wrapper]',
  '[data-radix-select-content]',
  '[role="listbox"]',
  '[role="alertdialog"]',
];

const RIGHT_PANEL_TITLE: Record<LottieModeTab, string> = {
  parts: 'Tạo Part',
  pivot: 'Parameters',
  edit: 'Parameters',
  eraser: 'Parameters',
  view: '',
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

export function ExtractLottieModal({
  open,
  image,
  attribution,
  onClose,
  onCreateAutoPic,
}: ExtractLottieModalProps) {
  // ── Session state ────────────────────────────────────────────────────────────
  const [parts, setParts] = useState<LottiePart[]>([]);
  const [activePartId, setActivePartId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<LottieModeTab>('parts');
  const [zoom, setZoom] = useState<number>(LOTTIE_MODAL_LAYOUT.zoomDefault);
  const [isProcessing, setIsProcessing] = useState(false);
  const [imageNatural, setImageNatural] = useState<{ w: number; h: number } | null>(null);

  // Parts-tab create controls (small — kept here so the tab stays dumb).
  const [createKind, setCreateKind] = useState<LottiePartKind>('normal');
  const [partsPrompt, setPartsPrompt] = useState('');

  // Dialogs
  const [resetOpen, setResetOpen] = useState(false);
  const [staleDraft, setStaleDraft] = useState<LottieDraft | null>(null);

  const modalRootRef = useRef<HTMLDivElement>(null);
  const redoRef = useRef<{ partId: string; strokes: Stroke[] }>({ partId: '', strokes: [] });
  const restoredKeyRef = useRef<string | null>(null);

  const imageId = image?.id ?? null;
  const sourceUrl = image ? resolveSourceImageUrl(image) ?? '' : '';
  const activePart = parts.find((p) => p.id === activePartId) ?? null;
  const hasParts = parts.length > 0;

  const state = useMemo<ExtractLottieModalState>(
    () => ({ activeTab, parts, activePartId, zoom, isProcessing }),
    [activeTab, parts, activePartId, zoom, isProcessing],
  );
  const draft = useLottieDraft({ imageId, state, sourceUrl, enabled: open });
  const { restore: restoreDraft, clear: clearDraftFn } = draft;

  // ── Part mutation helpers ──────────────────────────────────────────────────────
  const updatePart = useCallback((id: string, updater: (p: LottiePart) => LottiePart) => {
    setParts((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const resetInMemory = useCallback(() => {
    setParts([]);
    setActivePartId(null);
    setActiveTab('parts');
    setZoom(LOTTIE_MODAL_LAYOUT.zoomDefault);
    setIsProcessing(false);
    setCreateKind('normal');
    setPartsPrompt('');
    redoRef.current = { partId: '', strokes: [] };
  }, []);

  const applyDraft = useCallback(
    (d: LottieDraft) => {
      setParts(d.parts);
      setActiveTab(d.activeTab);
      setActivePartId(d.activePartId);
    },
    [],
  );

  // ── Draft restore on open (one-time per open session) ───────────────────────────
  useEffect(() => {
    if (!open || !imageId) {
      if (!open) restoredKeyRef.current = null;
      return;
    }
    if (restoredKeyRef.current === imageId) return;
    restoredKeyRef.current = imageId;
    const d = restoreDraft();
    if (!d || d.parts.length === 0) return;
    if (d.sourceUrl !== sourceUrl) {
      setStaleDraft(d);
    } else {
      applyDraft(d);
      toast('Đã khôi phục bản nháp');
    }
  }, [open, imageId, sourceUrl, restoreDraft, applyDraft]);

  // ── Close / reset ────────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (isProcessing) {
      log.debug('handleClose', 'blocked — processing');
      return;
    }
    resetInMemory();
    restoredKeyRef.current = null;
    onClose();
  }, [isProcessing, resetInMemory, onClose]);

  const confirmReset = useCallback(() => {
    if (imageId) clearDraftFn();
    resetInMemory();
    setResetOpen(false);
  }, [imageId, clearDraftFn, resetInMemory]);

  // ── Tab / selection ────────────────────────────────────────────────────────────
  const handleTabChange = useCallback(
    (tab: LottieModeTab) => {
      if (tab !== 'parts' && parts.length === 0) return; // gate
      setActiveTab(tab);
    },
    [parts.length],
  );

  const handleSelectPart = useCallback((id: string) => setActivePartId(id), []);
  // Deselect → back to the original image (no active part). Used by outside-clicks on the stage
  // and the sidebar empty area.
  const handleDeselectPart = useCallback(() => setActivePartId(null), []);

  const handleDeletePart = useCallback(
    (id: string) => {
      setParts((prev) => {
        const next = prev
          .filter((p) => p.id !== id)
          .map((p) => (p.parentId === id ? { ...p, parentId: null } : p));
        // If the gated tab lost its last part, drop back to Parts.
        if (next.length === 0) setActiveTab('parts');
        return next;
      });
      setActivePartId((cur) => (cur === id ? null : cur));
    },
    [],
  );

  const handleConfigSave = useCallback(
    (id: string, patch: { name: string; parentId: string | null }) => {
      updatePart(id, (p) => ({ ...p, name: patch.name, parentId: patch.parentId }));
    },
    [updatePart],
  );

  const handleSelectVersion = useCallback(
    (partId: string, versionId: string) => {
      updatePart(partId, (p) => ({ ...p, selectedVersionId: versionId }));
    },
    [updatePart],
  );

  // ── Parts tab: create (segment / manual / null) ─────────────────────────────────
  // Crop/segment SOURCE: the selected image part's chosen version (sub-part extraction — e.g. cắt
  // cánh tay từ part tay), else the ORIGINAL image. No selection / null part / part chưa crop →
  // original. New sub-parts auto-parent to the source part (rig follows the extraction tree).
  const createSourcePart =
    activePart && activePart.kind !== 'null' && selectedVersionOf(activePart) ? activePart : null;

  const handleCreate = useCallback(async () => {
    const sourceVersion = createSourcePart ? selectedVersionOf(createSourcePart)! : null;
    const source = sourceVersion
      ? { url: sourceVersion.media_url, rect: sourceVersion.bboxAtCrop }
      : null;

    if (createKind === 'null') {
      const n = parts.filter((p) => p.kind === 'null').length + 1;
      const part: LottiePart = {
        id: crypto.randomUUID(),
        name: `Null ${n}`,
        kind: 'null',
        parentId: null,
        bbox: null,
        aspect: 'Free',
        segmentUrl: null,
        versions: [],
        selectedVersionId: null,
        pivot: null,
        maskStrokes: [],
      };
      setParts((prev) => [...prev, part]);
      setActivePartId(part.id);
      return;
    }

    // Manual crop: drop a movable/resizable rectangle onto the canvas immediately (no AI). The
    // user positions it, then the top-bar Crop button cuts the SOURCE image by this box.
    if (createKind === 'manual') {
      const n = parts.filter((p) => p.kind === 'manual').length + 1;
      const part: LottiePart = {
        id: crypto.randomUUID(),
        name: `Crop ${n}`,
        kind: 'manual',
        parentId: source ? createSourcePart!.id : null,
        // Default box centered within the source rect (original % either way).
        bbox: source ? localToOriginal(MANUAL_DEFAULT_BBOX, source.rect) : { ...MANUAL_DEFAULT_BBOX },
        aspect: 'Free',
        segmentUrl: null,
        source,
        versions: [],
        selectedVersionId: null,
        pivot: null,
        maskStrokes: [],
      };
      setParts((prev) => [...prev, part]);
      setActivePartId(part.id);
      return;
    }

    const prompt = partsPrompt.trim();
    if (!prompt || !sourceUrl) return;
    setIsProcessing(true);
    log.info('handleCreate', 'segment start', {
      promptLen: prompt.length,
      sourcePart: createSourcePart?.id ?? null,
    });
    try {
      const res = await callSegmentLayer({
        imageUrl: source?.url ?? sourceUrl,
        prompt,
        ...(attribution?.snapshotId ? { snapshotId: attribution.snapshotId } : {}),
      });
      if (!res.success || !res.data) {
        toast.error(mapExtractError(res as ImageApiFailure));
        return;
      }
      // Cutout (and its alpha bbox) live in SOURCE-image space → map bbox to original %.
      const segmentUrl = res.data.imageUrl;
      const localBBox = await detectAlphaBBox(segmentUrl);
      const bbox = source ? localToOriginal(localBBox, source.rect) : localBBox;
      const part: LottiePart = {
        id: crypto.randomUUID(),
        name: prompt,
        kind: 'normal',
        parentId: source ? createSourcePart!.id : null,
        bbox,
        aspect: 'Free',
        segmentUrl,
        source,
        versions: [],
        selectedVersionId: null,
        pivot: null,
        maskStrokes: [],
      };
      setParts((prev) => [...prev, part]);
      setActivePartId(part.id);
      setPartsPrompt('');
    } catch (err) {
      log.error('handleCreate', 'segment failed', { error: String(err) });
      toast.error('Không tạo được part — thử lại.');
    } finally {
      setIsProcessing(false);
    }
  }, [createKind, parts, partsPrompt, sourceUrl, attribution, createSourcePart]);

  // ── Parts tab: crop the active part to its bbox ──────────────────────────────────
  const handleCrop = useCallback(async () => {
    if (!activePart || activePart.kind === 'null' || !activePart.bbox) return;
    // Normal crops its AI segment cutout (transparent bg); manual crops its source image (parent
    // asset for a sub-part, else the original).
    const src = activePart.source ?? null;
    const cropSource = activePart.kind === 'manual' ? src?.url ?? sourceUrl : activePart.segmentUrl;
    if (!cropSource) return;
    const partId = activePart.id;
    // Clip to the source rect (a sub-part box can't crop pixels outside the parent asset), then map
    // into the crop-source image's local % (cutout + parent asset share source-local space).
    const eff = src ? intersectBBox(activePart.bbox, src.rect) : activePart.bbox;
    if (!eff) {
      toast.error('Khung nằm ngoài vùng ảnh nguồn của part.');
      return;
    }
    const localBBox = src ? originalToLocal(eff, src.rect) : eff;
    setIsProcessing(true);
    try {
      const dataUrl = await cropImageByBBox(cropSource, localBBox);
      const url = await uploadCroppedToStorage(dataUrl, LOTTIE_PARTS_FOLDER);
      const version: LottiePartVersion = {
        id: crypto.randomUUID(),
        media_url: url,
        type: 'crop',
        bboxAtCrop: { ...eff },
        created_time: new Date().toISOString(),
      };
      updatePart(partId, (p) => ({
        ...p,
        bbox: { ...eff }, // sync the visible box to the clipped crop rect
        versions: [...p.versions, version],
        selectedVersionId: version.id,
      }));
    } catch (err) {
      log.error('handleCrop', 'crop/upload failed', { error: String(err) });
      toast.error('Không lưu được ảnh part — thử lại.');
    } finally {
      setIsProcessing(false);
    }
  }, [activePart, sourceUrl, updatePart]);

  // ── Box / pivot updates ──────────────────────────────────────────────────────────
  const handleUpdateBBox = useCallback(
    (id: string, bbox: BBoxPct) => updatePart(id, (p) => ({ ...p, bbox })),
    [updatePart],
  );
  const handleAspectChange = useCallback(
    (id: string, aspect: string) => updatePart(id, (p) => ({ ...p, aspect })),
    [updatePart],
  );
  const handleSetPivot = useCallback(
    (pivot: { x: number; y: number }) => {
      if (!activePartId) return;
      updatePart(activePartId, (p) => ({ ...p, pivot }));
    },
    [activePartId, updatePart],
  );

  // ── Edit tab: mask stroke commit + undo/redo (shell owns part.maskStrokes) ────────
  const handleStrokeCommit = useCallback(
    (stroke: Stroke) => {
      if (!activePartId) return;
      redoRef.current = { partId: activePartId, strokes: [] };
      updatePart(activePartId, (p) => ({ ...p, maskStrokes: [...p.maskStrokes, stroke] }));
    },
    [activePartId, updatePart],
  );

  const handleAddVersion = useCallback(
    (partId: string, version: LottiePartVersion) => {
      updatePart(partId, (p) => ({
        ...p,
        versions: [...p.versions, version],
        selectedVersionId: version.id,
      }));
    },
    [updatePart],
  );

  // ── Parts tab: erase extracted sub-parts from the active part (client-only) ──────
  // Every sub-part cropped FROM the active part gets its pixels erased from the part's asset
  // (canvas destination-out — no AI call); the result lands as a NEW `edited` version on the
  // SAME part (auto-selected). The rig tree + old version stay intact — switching back in the
  // version selector undoes the erase, and the .lottie build stops double-painting sub-parts.
  const activeSelectedVersion = useMemo(
    () => (activePart && activePart.kind !== 'null' ? selectedVersionOf(activePart) : null),
    [activePart],
  );
  const eraseChildren = useMemo(
    () => (activePart && activeSelectedVersion ? erasableChildrenOf(parts, activePart) : []),
    [activePart, activeSelectedVersion, parts],
  );

  const handleEraseExtracted = useCallback(async () => {
    if (!activePart || !activeSelectedVersion || eraseChildren.length === 0) return;
    const partId = activePart.id;
    setIsProcessing(true);
    log.info('handleEraseExtracted', 'start', { partId, childCount: eraseChildren.length });
    try {
      const dataUrl = await erasePartsFromAsset(
        activeSelectedVersion.media_url,
        activeSelectedVersion.bboxAtCrop,
        eraseChildren.map(({ version }) => ({ url: version.media_url, rect: version.bboxAtCrop })),
      );
      if (!dataUrl) {
        toast.error('Các phần đã tách phủ kín part — không còn pixel nào để giữ lại.');
        return;
      }
      const url = await uploadCroppedToStorage(dataUrl, LOTTIE_PARTS_FOLDER);
      const version: LottiePartVersion = {
        id: crypto.randomUUID(),
        media_url: url,
        type: 'edited',
        original_url: activeSelectedVersion.media_url,
        bboxAtCrop: { ...activeSelectedVersion.bboxAtCrop },
        created_time: new Date().toISOString(),
      };
      handleAddVersion(partId, version);
      toast.success(`Đã xoá ${eraseChildren.length} phần đã tách khỏi part — version mới được chọn.`);
    } catch (err) {
      log.error('handleEraseExtracted', 'erase/upload failed', { error: String(err) });
      toast.error('Không xoá được các phần đã tách — thử lại.');
    } finally {
      setIsProcessing(false);
    }
  }, [activePart, activeSelectedVersion, eraseChildren, handleAddVersion]);

  const handleClearMask = useCallback(
    (partId: string) => {
      redoRef.current = { partId: '', strokes: [] };
      updatePart(partId, (p) => ({ ...p, maskStrokes: [] }));
    },
    [updatePart],
  );

  const maskUndo = useCallback(() => {
    const p = activePart;
    if (!p || p.maskStrokes.length === 0) return;
    const last = p.maskStrokes[p.maskStrokes.length - 1];
    if (redoRef.current.partId !== p.id) redoRef.current = { partId: p.id, strokes: [] };
    redoRef.current.strokes.push(last);
    updatePart(p.id, (x) => ({ ...x, maskStrokes: x.maskStrokes.slice(0, -1) }));
  }, [activePart, updatePart]);

  const maskRedo = useCallback(() => {
    const p = activePart;
    if (!p || redoRef.current.partId !== p.id || redoRef.current.strokes.length === 0) return;
    const s = redoRef.current.strokes.pop()!;
    updatePart(p.id, (x) => ({ ...x, maskStrokes: [...x.maskStrokes, s] }));
  }, [activePart, updatePart]);

  const editTab = useLottieEditTab({
    activePart,
    sourceUrl,
    parts,
    attribution,
    isProcessing,
    setProcessing: setIsProcessing,
    onAddVersion: handleAddVersion,
    onClearMask: handleClearMask,
  });

  const eraserTab = useLottieEraserTab({
    activePart,
    isProcessing,
    setProcessing: setIsProcessing,
    onAddVersion: handleAddVersion,
  });

  // ── Extract (View tab) ───────────────────────────────────────────────────────────
  // Image parts (normal + manual) carry an asset; null parts are rig-only. The extract gate needs
  // at least one image part, all of them cropped.
  const imageParts = parts.filter((p) => p.kind !== 'null');
  const uncroppedImage = imageParts.filter((p) => p.versions.length === 0);
  const extractGate = parts.length > 0 && imageParts.length > 0 && uncroppedImage.length === 0;
  const extractTooltip = !extractGate
    ? imageParts.length === 0
      ? 'Cần ít nhất 1 part ảnh đã crop'
      : `Chưa crop: ${uncroppedImage.map((p) => p.name).join(', ')}`
    : undefined;

  const handleExtract = useCallback(async () => {
    if (!image || !extractGate) return;
    setIsProcessing(true);
    log.info('handleExtract', 'build start', { partCount: parts.length });
    try {
      let dims = imageNatural;
      if (!dims) {
        const img = await loadImage(sourceUrl);
        dims = { w: img.naturalWidth, h: img.naturalHeight };
      }
      const title = image.title ?? 'Image';
      const blob = await buildLottieFile(parts, dims.w, dims.h, title);
      downloadBlob(blob, `${slugify(image.title)}.lottie`);
      // Atomic order: build + download OK → then spawn the auto_pic.
      const spawned = onCreateAutoPic({
        sourceImageId: image.id,
        staticImageUrl: sourceUrl,
        suggestedTitle: `${title} (Lottie)`,
      });
      if (!spawned) {
        // Spawn lock-rejected (spread not held) — the .lottie already downloaded, but keep the
        // draft + modal open so the part session survives (parent already toasted the reason).
        setIsProcessing(false);
        return;
      }
      // Draft is deliberately KEPT after a successful extract — reopening the modal restores the
      // part session so the rig can be tweaked and re-extracted; only explicit Reset clears it.
      resetInMemory();
      restoredKeyRef.current = null;
      onClose();
    } catch (err) {
      log.error('handleExtract', 'build/download failed', { error: String(err) });
      toast.error('Không tạo được file .lottie — thử lại.');
      setIsProcessing(false);
    }
  }, [
    image,
    extractGate,
    parts,
    imageNatural,
    sourceUrl,
    resetInMemory,
    onCreateAutoPic,
    onClose,
  ]);

  // ── Stroke undo/redo hotkeys (Edit tab = inpaint mask, Eraser tab = erase strokes) ──
  useGlobalHotkey(
    (e) =>
      open &&
      (activeTab === 'edit' || activeTab === 'eraser') &&
      !isProcessing &&
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === 'z',
    (e) => {
      const undoFn = activeTab === 'eraser' ? eraserTab.undo : maskUndo;
      const redoFn = activeTab === 'eraser' ? eraserTab.redo : maskRedo;
      if (e.shiftKey) redoFn();
      else undoFn();
    },
    [open, activeTab, isProcessing, maskUndo, maskRedo, eraserTab.undo, eraserTab.redo],
  );

  // ── Interaction Layer Stack ───────────────────────────────────────────────────────
  useInteractionLayer(
    'modal',
    open
      ? {
          id: 'extract-lottie-modal',
          ref: modalRootRef,
          captureClickOutside: true,
          hotkeys: ['Escape'],
          portalSelectors: PORTAL_SELECTORS,
          dropdownSelectors: PORTAL_SELECTORS,
          onHotkey: (key) => {
            if (key === 'Escape') handleClose();
          },
          onClickOutside: () => handleClose(),
          onForcePop: () => {
            resetInMemory();
            restoredKeyRef.current = null;
            onClose();
          },
        }
      : null,
  );

  if (!open || !image) return null;

  // Crop needs a box + a source (normal from its segment cutout, manual from the original image) and
  // an un-cropped part — once cropped the box locks, so re-cropping is done via a fresh part.
  const cropDisabled =
    isProcessing ||
    !activePart ||
    activePart.kind === 'null' ||
    !activePart.bbox ||
    !!selectedVersionOf(activePart) ||
    (activePart.kind === 'normal' && !activePart.segmentUrl);

  const rightPanel =
    activeTab === 'parts' ? (
      <PartsTab
        createKind={createKind}
        onCreateKindChange={setCreateKind}
        segmentModel={SEGMENT_MODEL_OPTIONS[0]}
        prompt={partsPrompt}
        onPromptChange={setPartsPrompt}
        onCreate={handleCreate}
        isProcessing={isProcessing}
        sourceName={createSourcePart?.name ?? null}
      />
    ) : activeTab === 'pivot' ? (
      <PivotTab
        key={activePartId ?? 'none'}
        pivot={activePart?.pivot ?? null}
        hasActivePart={!!activePart}
        onPivotChange={handleSetPivot}
      />
    ) : activeTab === 'edit' ? (
      editTab.ParamsPanel
    ) : activeTab === 'eraser' ? (
      eraserTab.ParamsPanel
    ) : null;

  const editHasAsset = activePart?.kind !== 'null' && !!activePart && !!selectedVersionOf(activePart);
  const editVersion = editHasAsset ? selectedVersionOf(activePart!) : null;

  return createPortal(
    <div
      ref={modalRootRef}
      data-modal="extract-lottie"
      className="fixed inset-0 isolate flex flex-col text-[var(--swap-modal-text-primary)]"
      style={
        {
          ...SWAP_MODAL_TOKENS,
          zIndex: Z_INDEX.swapModal,
          backgroundColor: 'var(--swap-modal-backdrop)',
        } as React.CSSProperties
      }
    >
      <ExtractLottieModalHeader
        activeTab={activeTab}
        hasParts={hasParts}
        disabled={isProcessing}
        onTabChange={handleTabChange}
        onReset={() => setResetOpen(true)}
        onClose={handleClose}
      />

      <div className="flex min-h-0 flex-1">
        {activeTab !== 'view' && (
          <PartsSidebar
            parts={parts}
            activePartId={activePartId}
            disabled={isProcessing}
            onSelectPart={handleSelectPart}
            onDeletePart={handleDeletePart}
            onConfigSave={handleConfigSave}
            onSelectVersion={handleSelectVersion}
            onDeselect={handleDeselectPart}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col bg-[var(--swap-modal-canvas-bg)]">
          {/* Stage header: Crop (Parts) / Extract (View) + zoom */}
          <div
            className="flex shrink-0 items-center gap-3 border-b border-[var(--swap-modal-border)] px-4"
            style={{ height: LOTTIE_MODAL_LAYOUT.stageHeaderH }}
          >
            {activeTab === 'parts' && (
              <>
                <button
                  type="button"
                  disabled={cropDisabled}
                  onClick={handleCrop}
                  className="rounded-md bg-[var(--swap-modal-accent)] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--swap-modal-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Crop
                </button>
                <button
                  type="button"
                  disabled={isProcessing || eraseChildren.length === 0}
                  onClick={handleEraseExtracted}
                  title={
                    eraseChildren.length === 0
                      ? 'Chọn part gốc đã crop và đã tách ít nhất 1 part con từ nó'
                      : `Tạo version mới của part này với ${eraseChildren.length} phần đã tách bị xoá (${eraseChildren.map(({ part }) => part.name).join(', ')})`
                  }
                  className="flex items-center gap-1.5 rounded-md border border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] px-3 py-1.5 text-sm font-semibold text-[var(--swap-modal-text-primary)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Eraser className="h-4 w-4" aria-hidden="true" />
                  Xoá phần đã tách
                  {eraseChildren.length > 0 && (
                    <span className="tabular-nums">({eraseChildren.length})</span>
                  )}
                </button>
              </>
            )}
            {activeTab === 'view' && (
              <button
                type="button"
                disabled={isProcessing || !extractGate}
                title={extractTooltip}
                onClick={handleExtract}
                className="flex items-center gap-1.5 rounded-md bg-[var(--swap-modal-accent)] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--swap-modal-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Star className="h-4 w-4" aria-hidden="true" />
                Extract
              </button>
            )}
            <div className="flex-1" />
            <ZoomControl
              value={zoom}
              onChange={setZoom}
              min={LOTTIE_MODAL_LAYOUT.zoomMin}
              max={LOTTIE_MODAL_LAYOUT.zoomMax}
              step={LOTTIE_MODAL_LAYOUT.zoomStep}
            />
          </div>

          {sourceUrl && (
            <LottieStageCanvas
              sourceUrl={sourceUrl}
              zoom={zoom}
              hideSource={activeTab === 'view'}
              dimSource={!!activePart && activePart.kind !== 'null'}
              onBackgroundClick={activeTab === 'parts' ? handleDeselectPart : undefined}
              cursor={activeTab === 'pivot' ? 'crosshair' : undefined}
              isProcessing={isProcessing}
              onNaturalSize={setImageNatural}
            >
              {activeTab === 'parts' && (
                <PartBoxOverlay
                  parts={parts}
                  activePartId={activePartId}
                  imageNatural={imageNatural}
                  interactive
                  onSelectPart={handleSelectPart}
                  onUpdateBBox={handleUpdateBBox}
                  onAspectChange={handleAspectChange}
                  onDeselect={handleDeselectPart}
                />
              )}

              {activeTab === 'pivot' && (
                <>
                  <PartBoxOverlay
                    parts={parts}
                    activePartId={activePartId}
                    imageNatural={imageNatural}
                    interactive={false}
                    onSelectPart={handleSelectPart}
                    onUpdateBBox={handleUpdateBBox}
                    onAspectChange={handleAspectChange}
                  />
                  <PivotOverlay
                    pivot={activePart?.pivot ?? null}
                    onSetPivot={activePart ? handleSetPivot : null}
                  />
                </>
              )}

              {activeTab === 'edit' && editHasAsset && editVersion && activePart && (
                <LottieMaskCanvas
                  assetUrl={editVersion.media_url}
                  name={activePart.name}
                  bbox={editVersion.bboxAtCrop}
                  brushSize={editTab.brushSize}
                  strokes={activePart.maskStrokes}
                  onStrokeCommit={handleStrokeCommit}
                />
              )}

              {activeTab === 'eraser' && editHasAsset && editVersion && activePart && (
                <LottieMaskCanvas
                  variant="erase"
                  assetUrl={editVersion.media_url}
                  name={activePart.name}
                  bbox={editVersion.bboxAtCrop}
                  brushSize={eraserTab.brushSize}
                  strokes={eraserTab.strokes}
                  onStrokeCommit={eraserTab.onStrokeCommit}
                />
              )}

              {activeTab === 'view' && <ViewTab parts={parts} />}
            </LottieStageCanvas>
          )}
        </div>

        {activeTab !== 'view' && (
          <aside
            className="flex h-full shrink-0 flex-col overflow-hidden border-l border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)]"
            style={{ width: LOTTIE_MODAL_LAYOUT.rightSidebar }}
            aria-label="Parameters"
          >
            <div
              className="flex shrink-0 items-center border-b border-[var(--swap-modal-border)] px-4"
              style={{ height: LOTTIE_MODAL_LAYOUT.stageHeaderH }}
            >
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
                {RIGHT_PANEL_TITLE[activeTab]}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{rightPanel}</div>
          </aside>
        )}
      </div>

      {/* Reset confirm */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent zIndex={CANVAS_CONFIRM_DIALOG_Z}>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset</AlertDialogTitle>
            <AlertDialogDescription>
              Xoá toàn bộ {parts.length} part đã tạo?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReset}>Xoá</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Stale-source draft confirm */}
      <AlertDialog open={!!staleDraft} onOpenChange={(o) => !o && setStaleDraft(null)}>
        <AlertDialogContent zIndex={CANVAS_CONFIRM_DIALOG_Z}>
          <AlertDialogHeader>
            <AlertDialogTitle>Ảnh gốc đã thay đổi</AlertDialogTitle>
            <AlertDialogDescription>
              Ảnh gốc đã thay đổi so với bản nháp — khôi phục bản nháp cũ hay bắt đầu lại?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (imageId) clearDraftFn();
                setStaleDraft(null);
              }}
            >
              Bắt đầu lại
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (staleDraft) applyDraft(staleDraft);
                setStaleDraft(null);
              }}
            >
              Khôi phục
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>,
    document.body,
  );
}
