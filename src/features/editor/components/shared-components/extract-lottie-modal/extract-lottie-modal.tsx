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
import { Star } from 'lucide-react';
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
} from './extract-lottie-modal-constants';
import {
  detectAlphaBBox,
  cropImageByBBox,
  selectedVersionOf,
  buildLottieFile,
  slugify,
  downloadBlob,
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

  // ── Parts tab: create (segment / null) ──────────────────────────────────────────
  const handleCreate = useCallback(async () => {
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

    const prompt = partsPrompt.trim();
    if (!prompt || !sourceUrl) return;
    setIsProcessing(true);
    log.info('handleCreate', 'segment start', { promptLen: prompt.length });
    try {
      const res = await callSegmentLayer({
        imageUrl: sourceUrl,
        prompt,
        ...(attribution?.snapshotId ? { snapshotId: attribution.snapshotId } : {}),
      });
      if (!res.success || !res.data) {
        toast.error(mapExtractError(res as ImageApiFailure));
        return;
      }
      const segmentUrl = res.data.imageUrl;
      const bbox = await detectAlphaBBox(segmentUrl);
      const part: LottiePart = {
        id: crypto.randomUUID(),
        name: prompt,
        kind: 'normal',
        parentId: null,
        bbox,
        aspect: 'Free',
        segmentUrl,
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
  }, [createKind, parts, partsPrompt, sourceUrl, attribution]);

  // ── Parts tab: crop the active part to its bbox ──────────────────────────────────
  const handleCrop = useCallback(async () => {
    if (!activePart || activePart.kind !== 'normal' || !activePart.segmentUrl || !activePart.bbox) return;
    const partId = activePart.id;
    const segmentUrl = activePart.segmentUrl;
    const bbox = activePart.bbox;
    setIsProcessing(true);
    try {
      const dataUrl = await cropImageByBBox(segmentUrl, bbox);
      const url = await uploadCroppedToStorage(dataUrl, LOTTIE_PARTS_FOLDER);
      const version: LottiePartVersion = {
        id: crypto.randomUUID(),
        media_url: url,
        type: 'crop',
        bboxAtCrop: { ...bbox },
        created_time: new Date().toISOString(),
      };
      updatePart(partId, (p) => ({
        ...p,
        versions: [...p.versions, version],
        selectedVersionId: version.id,
      }));
    } catch (err) {
      log.error('handleCrop', 'crop/upload failed', { error: String(err) });
      toast.error('Không lưu được ảnh part — thử lại.');
    } finally {
      setIsProcessing(false);
    }
  }, [activePart, updatePart]);

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

  // ── Extract (View tab) ───────────────────────────────────────────────────────────
  const normalParts = parts.filter((p) => p.kind === 'normal');
  const uncroppedNormal = normalParts.filter((p) => p.versions.length === 0);
  const extractGate = parts.length > 0 && normalParts.length > 0 && uncroppedNormal.length === 0;
  const extractTooltip = !extractGate
    ? normalParts.length === 0
      ? 'Cần ít nhất 1 part normal đã crop'
      : `Chưa crop: ${uncroppedNormal.map((p) => p.name).join(', ')}`
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
      if (imageId) clearDraftFn();
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
    imageId,
    clearDraftFn,
    resetInMemory,
    onCreateAutoPic,
    onClose,
  ]);

  // ── Mask undo/redo hotkeys (Edit tab only) ───────────────────────────────────────
  useGlobalHotkey(
    (e) =>
      open &&
      activeTab === 'edit' &&
      !isProcessing &&
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === 'z',
    (e) => {
      if (e.shiftKey) maskRedo();
      else maskUndo();
    },
    [open, activeTab, isProcessing, maskUndo, maskRedo],
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

  const cropHint =
    activeTab === 'parts' &&
    activePart?.kind === 'normal' &&
    activePart.bbox &&
    selectedVersionOf(activePart) &&
    JSON.stringify(activePart.bbox) !== JSON.stringify(selectedVersionOf(activePart)?.bboxAtCrop)
      ? 'Box đã thay đổi — bấm Crop để cắt lại'
      : null;

  const cropDisabled =
    isProcessing || !activePart || activePart.kind !== 'normal' || !activePart.segmentUrl || !activePart.bbox;

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
    ) : null;

  const editHasAsset = activePart?.kind === 'normal' && !!selectedVersionOf(activePart);
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
                {cropHint && (
                  <span className="text-[11px] text-amber-400">{cropHint}</span>
                )}
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
                  bbox={editVersion.bboxAtCrop}
                  brushSize={editTab.brushSize}
                  strokes={activePart.maskStrokes}
                  onStrokeCommit={handleStrokeCommit}
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
