"use client";

// extract-image-modal.tsx — Root orchestrator for the full-screen "Extracting Image"
// workspace (design extract-image-modal/README.md). Owns ALL state + handlers + ILS
// registration; the regions (header / results-sidebar / canvas) + the per-tab ParamsPanel
// are presentational. Consolidates SegmentLayerModal + SplitImageModal:
//   • [+] (left sidebar)   → run the active tab's AI extract (segment append / layers replace).
//   • ⭐ Extract (canvas)  → upload every remaining result → onCreateImages(N) → close.
// Results are session-local (ephemeral API URLs); upload happens only on commit.

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useInteractionLayer } from "@/features/editor/contexts";
import { createLogger } from "@/utils/logger";
import type { SpreadImage } from "@/types/spread-types";
import type { SaveResourceDirective } from "@/types/save-resource";
import { SWAP_MODAL_TOKENS, Z_INDEX, HEADER_HEIGHT_PX, RIGHT_SIDEBAR_WIDTH_PX } from "./extract-image-modal-constants";
import {
  EXTRACT_TABS,
  DEFAULT_EXTRACT_TAB,
  type ExtractResult,
  type ExtractTabKey,
  type BackgroundRemoveCandidate,
  type CropPreset,
  type ExtractedTextbox,
} from "./extract-image-modal-constants";
import {
  resolveSourceImageUrl,
  uploadEphemeralToStorage,
} from "./extract-image-modal-utils";
import { resolveInitialKey } from "../image-tools-space-matrix";
import { useSegmentTabState, type SegmentTabHandle } from "./segment-tab";
import { useLayersTabState, type LayersTabHandle } from "./layers-tab";
import { useObjectsTabState } from "./objects-tab";
import { useCropsTabState } from "./crops-tab";
import { useTextsTabState } from "./texts-tab";
import { useBackgroundTabState, type BackgroundTabHandle } from "./background-tab";
import { ExtractImageModalHeader } from "./extract-image-modal-header";
import { ExtractResultsSidebar } from "./extract-results-sidebar";
import { ExtractObjectsSidebar } from "./extract-objects-sidebar";
import { ExtractTextsSidebar } from "./extract-texts-sidebar";
import { ExtractCropsSidebar } from "./extract-crops-sidebar";
import { CropPresetConfirmDialog } from "./crop-preset-confirm-dialog";
import { ExtractCanvas } from "./extract-canvas";

const log = createLogger("Editor", "ExtractImageModal");

/** Stable empty array so the per-tab fallback keeps a constant identity (no re-render churn). */
const EMPTY_RESULTS: ExtractResult[] = [];
/** Stable empty presets fallback (Crops tab) — same constant-identity rationale. */
const EMPTY_CROP_PRESETS: CropPreset[] = [];

/** Shared subset of the Objects + Crops + Texts box-overlay handles the root drives (canvas
 *  overlay, selection, Delete hotkey). All three satisfy it structurally. NOTE: `commitExtract`
 *  is intentionally NOT shared — Objects/Crops return `Promise<ExtractResult[]>` (async crop +
 *  upload) while Texts returns `ExtractedTextbox[]` (sync spawn). The root routes commit by
 *  `commitMode`, picking the concrete handle per branch (see handleCommitExtract). */
type BoxOverlayHandle = {
  selectedBoxId: string | null;
  canRun: boolean;
  CanvasOverlay: React.ReactNode;
  onImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  deleteBox: (id: string) => void;
};

export interface ExtractImageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  image: SpreadImage;
  onCreateImages: (results: ExtractResult[]) => void;
  /** Texts tab ⭐ Extract — parent spawns raw_textboxes[] from the detected specs (client-side,
   *  no upload). Absent → Extract disabled on the Texts tab (tooltip "Text extract not available
   *  here") so the button is never a silent no-op. */
  onCreateTexts?: (textboxes: ExtractedTextbox[]) => void;
  initialTab?: ExtractTabKey;
  /** Per-space tab availability (matrix gate #1). `undefined` → all EXTRACT_TABS (legacy).
   *  Tabs absent from the list are hidden; present-but-unbuilt tabs render as "Coming soon". */
  enabledTabs?: ExtractTabKey[];
  yieldedFrom?: { parentId: string; onParentForcePop: () => void };
  /** Objects tab Detect context (visualDescription + snapshotId). Absent → Detect disabled. */
  detectContext?: { visualDescription: string; snapshotId: string };
  /** Attribution-only snapshot version id (book cost) forwarded into the AI extract tabs
   *  (segment / layering / background / get_text). Book-context only — never remix. */
  snapshotId?: string;
  /** Opt-in double-write directive (parent/opener resolves the path). v1 threads to the Background
   *  tab only (RESERVED create-node — see background-tab); other extract tabs are not wired.
   *  Undefined → payload omits the field. */
  saveResource?: SaveResourceDirective;
  /** Background tab — other spread images (effective URLs, source excluded) offered as
   *  remove targets. Absent/[] → Background grid empty → run disabled. */
  backgroundRemoveCandidates?: BackgroundRemoveCandidate[];
  /** Crops tab — book.crop_presets[] (dropdown source + Save target). undefined → [] (Custom only). */
  cropPresets?: CropPreset[];
  /** Crops tab — Save/Edit-on-saved → parent persists books.crop_presets[] (append/replace by id). */
  onUpsertCropPreset?: (preset: CropPreset) => void;
  /** Crops tab — sidebar 🗑 → parent removes the entry from books.crop_presets[] (filter by id). */
  onDeleteCropPreset?: (presetId: string) => void;
}

export function ExtractImageModal({
  open,
  onOpenChange,
  image,
  onCreateImages,
  onCreateTexts,
  initialTab,
  enabledTabs,
  yieldedFrom,
  detectContext,
  snapshotId,
  saveResource,
  backgroundRemoveCandidates = [],
  cropPresets,
  onUpsertCropPreset,
  onDeleteCropPreset,
}: ExtractImageModalProps) {
  // Landing tab ∈ (available-in-space ∩ built); falls back to leftmost available (coming-soon)
  // when a space has no built tab (e.g. raw Extract). Plain const → seeds useState + feeds
  // resetState. The header renders the FULL EXTRACT_TABS registry — tabs gated off by
  // `enabledTabs` show disabled, never hidden.
  const resolvedInitialTab = resolveInitialKey(EXTRACT_TABS, enabledTabs, initialTab, DEFAULT_EXTRACT_TAB);

  // ── State ──────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ExtractTabKey>(resolvedInitialTab);
  const [resultsByTab, setResultsByTab] = useState<
    Partial<Record<ExtractTabKey, ExtractResult[]>>
  >({});
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  // Crops-tab canvas zoom (CSS width scale). Gated to activeTab==='crop' so Objects keeps
  // its current header (validation S1). Reset on tab change / close.
  const [zoom, setZoom] = useState(100);

  const dialogContentRef = useRef<HTMLDivElement>(null);
  // API clients don't take an AbortSignal — the controller is a "should I still apply
  // setState?" flag (checked after await), so a forcePop/close mid-run can't write stale state.
  const abortRef = useRef<AbortController | null>(null);
  // Stable indirection so a tab's Ctrl/Cmd+Enter reaches the latest handleRunExtract without
  // a render-body ref write (React 19 lint). Synced in an effect below.
  const runExtractRef = useRef<() => void>(() => {});

  const isBusy = isProcessing || isCommitting;
  const onRequestRun = useCallback(() => runExtractRef.current(), []);

  // ── Per-tab sub-state (all hooks run unconditionally; root renders the active one) ──
  const segmentHandle = useSegmentTabState(image, { isBusy, onRequestRun, snapshotId });
  const layersHandle = useLayersTabState(image, { isBusy, snapshotId });
  const objectsHandle = useObjectsTabState(image, { isBusy, detectContext });
  const textsState = useTextsTabState(image, { isBusy, snapshotId });
  const cropsState = useCropsTabState(image, {
    isBusy,
    cropPresets: cropPresets ?? EMPTY_CROP_PRESETS,
    onUpsertCropPreset,
    onDeleteCropPreset,
  });
  const backgroundHandle = useBackgroundTabState(image, {
    isBusy,
    onRequestRun,
    removeCandidates: backgroundRemoveCandidates,
    snapshotId,
    saveResource,
  });

  // ── Derived (computed in render — no set-state-in-effect, React 19 lint) ─────────
  const activeContract = useMemo(
    () => EXTRACT_TABS.find((t) => t.key === activeTab) ?? null,
    [activeTab],
  );
  const activeHandle: SegmentTabHandle | LayersTabHandle | BackgroundTabHandle | null =
    activeTab === "segment"
      ? segmentHandle
      : activeTab === "layering"
        ? layersHandle
        : activeTab === "background"
          ? backgroundHandle
          : null;
  // Objects overrides the shared shell: source + box overlay canvas, box-list sidebar,
  // [+] = instant add (no API), ⭐ Extract = crop-on-extract (README §2.3 gating branch).
  const isBoxOverlay = activeContract?.interactionMode === "box-overlay";
  const isCropTab = activeTab === "crop";
  const isTextsTab = activeTab === "get_text";
  // Box-overlay tabs (Objects + Crops + Texts) share the canvas overlay / selection / Delete-hotkey
  // path; pick the active handle via the shared structural contract. Commit + Detect route
  // separately (per-tab handle) because their signatures diverge (see handleCommitExtract).
  const boxTab: BoxOverlayHandle = isTextsTab ? textsState : isCropTab ? cropsState : objectsHandle;
  // Title of the box pending crop-preset delete (drives the confirm dialog copy).
  const confirmPresetTitle =
    cropsState.boxes.find((b) => b.id === cropsState.confirmDeleteBoxId)?.title ?? "";

  const results = resultsByTab[activeTab] ?? EMPTY_RESULTS;
  const selectedResult = useMemo(
    () => results.find((r) => r.id === selectedResultId) ?? results[0] ?? null,
    [results, selectedResultId],
  );

  const sourceUrl = resolveSourceImageUrl(image);
  // [+] gate — box-overlay: addBox (busy / no source only, NOT canRun — else first box is stuck);
  // result-grid: run extract (also needs the tab's canRun). isBusy gates during commit too.
  const runDisabled = isBoxOverlay
    ? isBusy || !sourceUrl
    : isBusy || !sourceUrl || !(activeHandle?.canRun ?? false);
  // ⭐ Extract gate — box-overlay: boxes > 0 (active handle); result-grid: has results.
  // Texts additionally needs a consumer (onCreateTexts) or the client-side spawn is a no-op.
  const commitDisabled = isBoxOverlay
    ? isBusy ||
      !sourceUrl ||
      !boxTab.canRun ||
      (activeContract?.commitMode === "spawn-textbox" && !onCreateTexts)
    : results.length === 0 || isBusy;
  const processingLabel = isBoxOverlay
    ? "Detecting…"
    : activeTab === "layering"
      ? "Splitting…"
      : activeTab === "background"
        ? "Generating background…"
        : "Segmenting…";
  const committingLabel =
    isBoxOverlay || activeTab === "background" ? "Extracting…" : "Saving…";

  const paramsPanel =
    activeTab === "segment"
      ? segmentHandle.ParamsPanel
      : activeTab === "layering"
        ? layersHandle.ParamsPanel
        : activeTab === "get_object"
          ? objectsHandle.ParamsPanel
          : activeTab === "get_text"
            ? textsState.ParamsPanel
            : activeTab === "background"
              ? backgroundHandle.ParamsPanel
              : (
                <div className="px-4 py-6 text-center text-sm text-[var(--swap-modal-text-muted)]">
                  Coming soon
                </div>
              );

  // ── State reset / close ──────────────────────────────────────────────────────
  const resetState = useCallback(() => {
    abortRef.current?.abort();
    setActiveTab(resolvedInitialTab);
    setResultsByTab({});
    setSelectedResultId(null);
    setIsProcessing(false);
    setIsCommitting(false);
    setZoom(100);
    segmentHandle.reset();
    layersHandle.reset();
    objectsHandle.reset();
    textsState.reset();
    cropsState.reset();
    backgroundHandle.reset();
  }, [resolvedInitialTab, segmentHandle, layersHandle, objectsHandle, textsState, cropsState, backgroundHandle]);

  const handleClose = useCallback(() => {
    if (isBusy) {
      log.debug("handleClose", "blocked — busy", { isProcessing, isCommitting });
      return;
    }
    resetState();
    onOpenChange(false);
  }, [isBusy, isProcessing, isCommitting, resetState, onOpenChange]);

  const handleDialogOpenChange = useCallback(
    (next: boolean) => {
      if (!next) handleClose();
    },
    [handleClose],
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleTabChange = useCallback(
    (tab: ExtractTabKey) => {
      if (isBusy) return;
      const contract = EXTRACT_TABS.find((t) => t.key === tab);
      const availableInSpace = !enabledTabs || enabledTabs.includes(tab);
      if (!availableInSpace || !contract?.enabled) {
        log.debug("handleTabChange", "ignored — coming-soon tab", { tab });
        return;
      }
      log.debug("handleTabChange", "switch tab", { from: activeTab, to: tab });
      setActiveTab(tab);
      setSelectedResultId(null);
      setZoom(100);
    },
    [isBusy, enabledTabs, activeTab],
  );

  const handleRunExtract = useCallback(async () => {
    if (runDisabled || !activeContract || !activeHandle || !sourceUrl) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsProcessing(true);
    log.info("handleRunExtract", "start", { activeTab, runMode: activeContract.runMode });

    try {
      const newResults = await activeHandle.runExtract(sourceUrl);
      if (controller.signal.aborted) return;
      if (newResults.length === 0) {
        log.debug("handleRunExtract", "no results", { activeTab });
        return;
      }
      setResultsByTab((prev) => {
        const existing = prev[activeTab] ?? [];
        const merged =
          activeContract.runMode === "append" ? [...newResults, ...existing] : newResults;
        return { ...prev, [activeTab]: merged };
      });
      setSelectedResultId(newResults[0]?.id ?? null);
      log.info("handleRunExtract", "done", { activeTab, added: newResults.length });
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : "Extraction failed. Please try again.";
      log.error("handleRunExtract", "failed", { activeTab, error: msg });
      toast.error(msg);
    } finally {
      if (!controller.signal.aborted) setIsProcessing(false);
    }
  }, [runDisabled, activeContract, activeHandle, sourceUrl, activeTab]);

  // Sync the Ctrl/Cmd+Enter indirection (effect, not render-body — React 19 lint).
  useEffect(() => {
    runExtractRef.current = handleRunExtract;
  }, [handleRunExtract]);

  const handleSelectResult = useCallback((id: string) => {
    setSelectedResultId(id);
  }, []);

  const handleDeleteResult = useCallback(
    (id: string) => {
      setResultsByTab((prev) => {
        const filtered = (prev[activeTab] ?? []).filter((r) => r.id !== id);
        return { ...prev, [activeTab]: filtered };
      });
      setSelectedResultId((prev) => {
        if (prev !== id) return prev;
        const remaining = (resultsByTab[activeTab] ?? []).filter((r) => r.id !== id);
        return remaining[0]?.id ?? null;
      });
      log.debug("handleDeleteResult", "deleted", { activeTab, resultId: id });
    },
    [activeTab, resultsByTab],
  );

  // 🔍 Detect (box-overlay) — root owns isProcessing; the tab handles its own toasts. Objects and
  // Texts both expose { canDetect, detect(sourceUrl) }; route by tab (Crops has no Detect).
  const handleDetect = useCallback(async () => {
    const detectHandle = isTextsTab ? textsState : objectsHandle;
    if (!isBoxOverlay || !sourceUrl || isBusy || !detectHandle.canDetect) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsProcessing(true);
    log.info("handleDetect", "start", { imageId: image.id, activeTab });
    try {
      await detectHandle.detect(sourceUrl);
    } finally {
      if (!controller.signal.aborted) setIsProcessing(false);
    }
  }, [isBoxOverlay, isTextsTab, sourceUrl, isBusy, textsState, objectsHandle, image.id, activeTab]);

  const handleCommitExtract = useCallback(async () => {
    if (commitDisabled) return;

    // Texts: spawn-textbox — client-side only. Map boxes → specs and hand them to the parent
    // (which spawns raw_textboxes[]); no crop/upload/API. Sync → close immediately.
    if (activeContract?.commitMode === "spawn-textbox") {
      if (!onCreateTexts) return; // commitDisabled already blocks, but guard the silent no-op.
      const specs = textsState.commitExtract();
      if (specs.length === 0) return;
      log.info("handleCommitExtract", "spawn-textbox", { count: specs.length });
      onCreateTexts(specs);
      onOpenChange(false);
      return;
    }

    // Objects + Crops: crop-on-extract — crop every box → upload → geometry-positioned spawn.
    if (activeContract?.commitMode === "crop-on-extract") {
      if (!sourceUrl) return;
      // boxTab drops commitExtract (signature diverges for Texts) → pick the concrete crop handle.
      const cropHandle = isCropTab ? cropsState : objectsHandle;
      setIsCommitting(true);
      log.info("handleCommitExtract", "crop-on-extract start", { activeTab });
      try {
        const uploaded = await cropHandle.commitExtract(sourceUrl);
        log.info("handleCommitExtract", "crop-on-extract done", { count: uploaded.length });
        onCreateImages(uploaded);
        onOpenChange(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Extract failed. Please try again.";
        log.error("handleCommitExtract", "crop-on-extract failed", { error: msg });
        toast.error(msg);
      } finally {
        setIsCommitting(false);
      }
      return;
    }

    // Background: passthrough — API already returned permanent Storage URLs, so spawn the
    // results directly (no ephemeral re-upload → no duplicate Storage objects).
    if (activeContract?.commitMode === "passthrough") {
      setIsCommitting(true);
      log.info("handleCommitExtract", "passthrough", { activeTab, count: results.length });
      try {
        onCreateImages(results);
        onOpenChange(false);
      } finally {
        setIsCommitting(false);
      }
      return;
    }

    // Default: upload-ephemeral (Segment/Layers).
    setIsCommitting(true);
    log.info("handleCommitExtract", "start", { activeTab, count: results.length });
    try {
      const uploaded = await Promise.all(results.map(uploadEphemeralToStorage));
      log.info("handleCommitExtract", "uploaded", { count: uploaded.length });
      onCreateImages(uploaded);
      onOpenChange(false);
    } catch (err) {
      log.error("handleCommitExtract", "failed", { error: String(err) });
      toast.error("Save failed. Please try again.");
    } finally {
      setIsCommitting(false);
    }
  }, [
    commitDisabled,
    activeContract,
    sourceUrl,
    isCropTab,
    cropsState,
    objectsHandle,
    textsState,
    onCreateTexts,
    results,
    activeTab,
    onCreateImages,
    onOpenChange,
  ]);

  // ── Interaction Layer Stack (top modal slot) ────────────────────────────────────
  useInteractionLayer(
    "modal",
    open
      ? {
          id: "extract-image-modal",
          ref: dialogContentRef,
          // Delete/Backspace handled HERE (top modal slot) so they don't fall through to the
          // item/spread slot below (memory: sidebars don't own destructive hotkeys). The
          // provider already ignores them while an input/textarea is focused.
          hotkeys: ["Escape", "Delete", "Backspace"],
          captureClickOutside: true,
          portalSelectors: [
            "[data-radix-popper-content-wrapper]",
            "[data-radix-select-content]",
            '[role="listbox"]',
          ],
          // Picking a Model Select option unmounts the popper synchronously; dropdownSelectors
          // let the Provider keep the modal open instead of mis-closing it (see memory).
          dropdownSelectors: [
            "[data-radix-select-content]",
            "[data-radix-popper-content-wrapper]",
          ],
          onHotkey: (key) => {
            if (key === "Escape") {
              // Defensive: if the crop confirm dialog is open, cancel it instead of closing
              // the modal. Radix usually consumes Esc + stops propagation before this runs,
              // so this guards against any AlertDialog↔Dialog propagation difference.
              if (isCropTab && cropsState.confirmDeleteBoxId !== null) {
                cropsState.cancelDeletePreset();
                return;
              }
              handleClose();
              return;
            }
            if (key === "Delete" || key === "Backspace") {
              // Ignore the destructive hotkey while the crop confirm dialog is open (the box
              // is already pending confirm; Radix AlertDialog doesn't capture Delete).
              if (isCropTab && cropsState.confirmDeleteBoxId !== null) return;
              if (isBoxOverlay && boxTab.selectedBoxId) {
                log.debug("onHotkey", "delete box", { boxId: boxTab.selectedBoxId });
                boxTab.deleteBox(boxTab.selectedBoxId);
              }
            }
          },
          onClickOutside: () => handleClose(),
          // Spread switch / target-image delete → force close + reset (bypasses busy guard).
          onForcePop: () => {
            log.debug("onForcePop", "force close + reset", { imageId: image.id });
            resetState();
            onOpenChange(false);
          },
          yieldedFrom,
        }
      : null,
  );

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        ref={dialogContentRef}
        aria-labelledby="extract-image-modal-title"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        style={{ ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.swapModal } as React.CSSProperties}
        className="inset-0 left-0 top-0 flex h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[var(--swap-modal-bg)] p-0 text-[var(--swap-modal-text-primary)] [&>button]:hidden"
      >
        <DialogTitle className="sr-only">Extracting Image</DialogTitle>
        <DialogDescription className="sr-only">
          Trích xuất object/layer hoặc tái tạo nền từ ảnh nguồn (Objects / Segments / Layers / Background).
        </DialogDescription>

        <ExtractImageModalHeader
          activeTab={activeTab}
          tabs={EXTRACT_TABS}
          enabledKeys={enabledTabs}
          onTabChange={handleTabChange}
          onClose={handleClose}
          disabled={isBusy}
        />

        <div className="flex min-h-0 flex-1">
          {isCropTab ? (
            <ExtractCropsSidebar
              title={activeContract?.label ?? ""}
              boxes={cropsState.boxes}
              selectedBoxId={cropsState.selectedBoxId}
              editingBoxId={cropsState.editingBoxId}
              displayLabel={cropsState.displayLabel}
              canSave={cropsState.canSave}
              onAddBox={cropsState.addBox}
              onSelectBox={cropsState.selectBox}
              onStartEdit={cropsState.setEditingBox}
              onRename={cropsState.renameBox}
              onCancelEdit={() => cropsState.setEditingBox(null)}
              onSaveBox={cropsState.saveBox}
              onDeleteCropPreset={cropsState.deleteCropPreset}
              addDisabled={runDisabled}
            />
          ) : isTextsTab ? (
            <ExtractTextsSidebar
              title={activeContract?.label ?? ""}
              texts={textsState.texts}
              selectedTextId={textsState.selectedBoxId}
              onSelect={textsState.selectBox}
              onDelete={textsState.deleteBox}
            />
          ) : isBoxOverlay ? (
            <ExtractObjectsSidebar
              title={activeContract?.label ?? ""}
              boxes={objectsHandle.boxes}
              selectedBoxId={objectsHandle.selectedBoxId}
              onSelectBox={objectsHandle.selectBox}
              onDeleteBox={objectsHandle.deleteBox}
              onAddBox={objectsHandle.addBox}
              addDisabled={runDisabled}
            />
          ) : (
            <ExtractResultsSidebar
              title={activeContract?.label ?? ""}
              results={results}
              selectedResultId={selectedResultId}
              onSelectResult={handleSelectResult}
              onDeleteResult={handleDeleteResult}
              onRunExtract={handleRunExtract}
              runDisabled={runDisabled}
              isProcessing={isProcessing}
            />
          )}

          <ExtractCanvas
            sourceUrl={sourceUrl}
            selectedResult={selectedResult}
            isProcessing={isProcessing}
            isCommitting={isCommitting}
            processingLabel={processingLabel}
            committingLabel={committingLabel}
            onCommitExtract={handleCommitExtract}
            commitDisabled={commitDisabled}
            interactionMode={activeContract?.interactionMode}
            resultPreview={activeContract?.resultPreview}
            overlay={isBoxOverlay ? boxTab.CanvasOverlay : undefined}
            onImageLoad={isBoxOverlay ? boxTab.onImageLoad : undefined}
            onDetect={handleDetect}
            canDetect={isTextsTab ? textsState.canDetect : objectsHandle.canDetect}
            detectVisible={isBoxOverlay && !isCropTab}
            zoom={zoom}
            onZoomChange={setZoom}
            showZoom={isCropTab}
          />

          {activeContract?.hasParams !== false && (
          <aside
            className="flex h-full shrink-0 flex-col overflow-hidden border-l border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)]"
            style={{ width: RIGHT_SIDEBAR_WIDTH_PX }}
            aria-label="Extract parameters"
          >
            <div
              className="flex shrink-0 items-center border-b border-[var(--swap-modal-border)] px-4"
              style={{ height: HEADER_HEIGHT_PX }}
            >
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]">
                Parameters
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{paramsPanel}</div>
          </aside>
          )}
        </div>

        {/* Destructive confirm — delete a crop preset book-wide (portaled INTO this modal). */}
        <CropPresetConfirmDialog
          open={cropsState.confirmDeleteBoxId !== null}
          presetTitle={confirmPresetTitle}
          onConfirm={cropsState.confirmDeletePreset}
          onCancel={cropsState.cancelDeletePreset}
        />
      </DialogContent>
    </Dialog>
  );
}
