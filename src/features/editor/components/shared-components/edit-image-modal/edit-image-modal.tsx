"use client";

// edit-image-modal.tsx — Root orchestrator for the full-screen "Editing Image" workspace
// (design edit-image-modal/README.md). Store-agnostic / controlled: the parent owns the
// store binding and passes `illustrations` + `onUpdateIllustrations`. Consolidates the old
// EditImageModal (prompt+removeBg) + EraseImageModal (paint) into ONE tabbed shell (clone of
// ExtractImageModal). Each tab = an edit tool; `[+]` runs/commits the active tool → prepends
// a new `type='edited'` version. Compare is always-available (before=original_url,
// after=media_url). Owns ALL shell state + handlers + ILS; the regions + per-tab panels are
// presentational. Single writer of illustrations[] = `prependVersion` here.

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ImageZoomDialog } from "@/components/ui/image-zoom-preview";
import { toast } from "sonner";
import { useInteractionLayer, useGlobalHotkey } from "@/features/editor/contexts";
import type { YieldedFromLinkage } from "@/features/editor/contexts/interaction-layer-provider";
import { createLogger } from "@/utils/logger";
import type { Illustration } from "@/types/prop-types";
import type { SaveResourceDirective } from "@/types/save-resource";
import {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  HEADER_HEIGHT_PX,
  RIGHT_SIDEBAR_WIDTH_PX,
  EDIT_TOOLS,
  DEFAULT_EDIT_TOOL,
  COMMIT_HINTS,
  ZOOM,
  type EditToolKey,
  type EditCanvasMode,
  type EditImageAttribution,
} from "./edit-image-modal-constants";
import {
  prependVersion,
  versionFromMediaUrl,
  mapEditError,
  type ReferenceImageCandidate,
} from "./edit-image-modal-utils";
import { resolveInitialKey } from "../image-tools-space-matrix";
import { useRemoveBgTabState } from "./remove-bg-tab";
import { useRemoveTextTabState } from "./remove-text-tab";
import { useUpscaleTabState } from "./upscale-tab";
import { useOutpaintTabState } from "./outpaint-tab";
import { useEraserTabState } from "./eraser-tab";
import { useInpaintTabState } from "./inpaint-tab";
import { EditImageModalHeader } from "./edit-image-modal-header";
import { EditImageModalVersionsSidebar } from "./edit-image-modal-versions-sidebar";
import { EditImageModalCanvas } from "./edit-image-modal-canvas";

const log = createLogger("Editor", "EditImageModal");

const PROCESSING_LABELS: Partial<Record<EditToolKey, string>> = {
  inpaint: "Inpainting…",
  outpaint: "Outpainting…",
  remove_background: "Removing background…",
  remove_text: "Removing text…",
  upscale: "Upscaling…",
  erasor: "Saving erased version…",
};

// Per-tool label threaded into mapEditError (Validation S1) so generic REPLICATE_ERROR/TIMEOUT
// wording names the active tool ("Upscale thất bại…" vs "Remove background thất bại…").
const ERROR_ACTION_LABELS: Partial<Record<EditToolKey, string>> = {
  inpaint: "Inpaint",
  outpaint: "Outpaint",
  remove_background: "Remove background",
  remove_text: "Remove text",
  upscale: "Upscale",
  erasor: "Lưu",
};

export interface EditImageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // ── Controlled data (store-agnostic — parent owns binding) ──
  imageTitle: string;
  illustrations: Illustration[];
  /** Seed fallback shown (display-only, NOT persisted) when illustrations is empty. */
  mediaUrl: string;
  onUpdateIllustrations: (next: Illustration[]) => void;
  /** Storage path prefix for eraser upload (e.g. `retouch/${imageId}/erased`). */
  pathPrefix: string;
  // ── UI ──
  initialTool?: EditToolKey;
  /** Per-space tool availability (matrix gate #1). `undefined` → all EDIT_TOOLS (legacy).
   *  3-state header (never hidden): tools absent from the list render disabled + "Not available
   *  in this space"; present-but-unbuilt tools render disabled + "Coming soon". */
  enabledTools?: EditToolKey[];
  /** Inpaint reference-image candidates (prop-variants) resolved by the parent per space (design
   *  §8.4). Threaded to the Inpaint tab's picker grid; undefined → picker offers Upload only. */
  referenceImageCandidates?: ReferenceImageCandidate[];
  /** AI-usage attribution threaded into every EDIT commit (book snapshotId / remix remixId).
   *  Dual-context: book mounts pass `{ snapshotId }`, the remix mount passes `{ remixId }`. */
  attribution?: EditImageAttribution;
  /** Opt-in double-write directive (parent/opener resolves the path — modal stays path-agnostic).
   *  Threaded into every AI-tab commit payload (inpaint/outpaint/upscale/remove-text/remove-bg).
   *  Erasor is upload-only (no endpoint) → never receives it. Undefined → payload omits the field. */
  saveResource?: SaveResourceDirective;
  yieldedFrom?: YieldedFromLinkage;
}

export function EditImageModal({
  open,
  onOpenChange,
  imageTitle,
  illustrations,
  mediaUrl,
  onUpdateIllustrations,
  pathPrefix,
  initialTool,
  enabledTools,
  referenceImageCandidates,
  attribution,
  saveResource,
  yieldedFrom,
}: EditImageModalProps) {
  // Landing tool ∈ (available-in-space ∩ built); never lands on a coming-soon slot. Plain const
  // (cheap) so it seeds useState + feeds resetState consistently. The header renders the FULL
  // EDIT_TOOLS registry — tools gated off by `enabledTools` show disabled, never hidden.
  const resolvedInitialTool = resolveInitialKey(EDIT_TOOLS, enabledTools, initialTool, DEFAULT_EDIT_TOOL);

  // ── State ──────────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState<EditToolKey>(resolvedInitialTool);
  const [compareMode, setCompareMode] = useState(false);
  const [zoom, setZoom] = useState<number>(ZOOM.default);
  const [isProcessing, setIsProcessing] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomSrc, setZoomSrc] = useState("");

  const modalContentRef = useRef<HTMLDivElement>(null);
  // Stale-guard token (⚡D): bumped per commit AND on close/forcePop/reset → a late-resolving
  // commit can't prependVersion onto an image that's been switched/deleted. NOT an AbortSignal.
  const commitRunIdRef = useRef(0);

  // ── Derived (render-time — no set-state-in-effect, React 19) ─────────────────
  // "version" is a UI label over the canonical Illustration entry (no new type). Empty
  // illustrations → a display-only fallback from mediaUrl (NOT written to the store on open;
  // the first commit persists a real version — Validation S1, override spec §2.4).
  const versions = useMemo<Illustration[]>(
    () => (illustrations.length > 0 ? illustrations : mediaUrl ? [versionFromMediaUrl(mediaUrl)] : []),
    [illustrations, mediaUrl],
  );
  const selectedVersion = useMemo(
    () => versions.find((v) => v.is_selected) ?? versions[0] ?? null,
    [versions],
  );
  const canCompare = selectedVersion?.type === "edited" && !!selectedVersion.original_url;

  // ── Per-tab sub-state (all hooks run unconditionally; shell renders the active one) ──
  const removeBgState = useRemoveBgTabState({ selectedVersion, attribution, saveResource });
  const removeTextState = useRemoveTextTabState({ selectedVersion, attribution, saveResource });
  const upscaleState = useUpscaleTabState({ selectedVersion, attribution, saveResource });
  const outpaintState = useOutpaintTabState({ selectedVersion, attribution, saveResource });
  // Erasor = plain upload (no AI endpoint) → intentionally NOT threaded saveResource.
  const erasorState = useEraserTabState({ selectedVersion, pathPrefix, zoom });
  const inpaintState = useInpaintTabState({ selectedVersion, zoom, referenceImageCandidates, attribution, saveResource });

  // Active "paint" tab — inpaint + erasor share the canvas/commit/undo-redo/confirm path
  // (both expose the same paint surface; resetAll is inpaint-only and used in resetState).
  const isErasor = activeTool === "erasor";
  const isInpaint = activeTool === "inpaint";
  const isPaint = isErasor || isInpaint;
  const activePaint = isErasor ? erasorState : isInpaint ? inpaintState : null;
  const activeContract = EDIT_TOOLS.find((t) => t.key === activeTool) ?? null;
  const canvasMode: EditCanvasMode | "compare" = compareMode
    ? "compare"
    : activeContract?.canvasMode ?? "preview";

  // Dispatch the shared `{ canCommit, commit, ParamsPanel, CanvasLayer, hasUncommitted, ... }`
  // contract: paint tabs (inpaint/erasor) go through `activePaint`; preview tabs by activeTool.
  const activeCanCommit = activePaint
    ? activePaint.canCommit
    : activeTool === "upscale"
      ? upscaleState.canCommit
      : activeTool === "outpaint"
        ? outpaintState.canCommit
        : activeTool === "remove_text"
          ? removeTextState.canCommit
          : removeBgState.canCommit;
  const commitDisabled = isProcessing || !selectedVersion || !activeCanCommit;
  const commitHint = COMMIT_HINTS[activeTool] ?? "Commit";
  const processingLabel = PROCESSING_LABELS[activeTool] ?? "Processing…";

  const paramsPanel = activePaint
    ? activePaint.ParamsPanel
    : activeTool === "remove_background"
      ? removeBgState.ParamsPanel
      : activeTool === "upscale"
        ? upscaleState.ParamsPanel
        : activeTool === "outpaint"
          ? outpaintState.ParamsPanel
          : activeTool === "remove_text"
            ? removeTextState.ParamsPanel
            : (
                <div className="px-4 py-6 text-center text-sm text-[var(--swap-modal-text-muted)]">
                  Coming soon
                </div>
              );

  // ── Reset / close ────────────────────────────────────────────────────────────
  const resetState = useCallback(() => {
    commitRunIdRef.current += 1; // invalidate any in-flight commit
    setActiveTool(resolvedInitialTool);
    setCompareMode(false);
    setZoom(ZOOM.default);
    setIsProcessing(false);
    setZoomOpen(false);
    erasorState.resetStrokes();
    inpaintState.resetAll(); // inpaint also resets prompt + model on close (not just strokes)
  }, [resolvedInitialTool, erasorState, inpaintState]);

  const handleClose = useCallback(() => {
    if (isProcessing) {
      log.debug("handleClose", "blocked — processing");
      return;
    }
    resetState();
    onOpenChange(false);
  }, [isProcessing, resetState, onOpenChange]);

  const handleDialogOpenChange = useCallback(
    (next: boolean) => {
      if (!next) handleClose();
    },
    [handleClose],
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleToolChange = useCallback(
    (tool: EditToolKey) => {
      if (isProcessing) return;
      const contract = EDIT_TOOLS.find((t) => t.key === tool);
      const availableInSpace = !enabledTools || enabledTools.includes(tool);
      if (!availableInSpace || !contract?.enabled) {
        log.debug("handleToolChange", "ignored — coming-soon tool", { tool });
        return;
      }
      // Leaving a paint tab (inpaint/erasor) with uncommitted strokes → blocking confirm (⚡E).
      if (isPaint && tool !== activeTool && activePaint?.hasUncommitted) {
        if (!window.confirm("Huỷ các nét chưa lưu?")) return;
        activePaint.resetStrokes();
      }
      log.debug("handleToolChange", "switch", { from: activeTool, to: tool });
      setActiveTool(tool);
      setCompareMode(false);
    },
    [isProcessing, enabledTools, isPaint, activePaint, activeTool],
  );

  const handleSelectVersion = useCallback(
    (index: number) => {
      if (isProcessing) return; // ⚡F: no version switch mid run/commit
      const target = versions[index];
      if (!target || target.is_selected) return; // no-op (covers display-only fallback)
      // Changing source while a paint tab has uncommitted strokes → blocking confirm (⚡E).
      if (isPaint && activePaint?.hasUncommitted) {
        if (!window.confirm("Huỷ các nét chưa lưu?")) return;
      }
      const next = versions.map((v, i) => ({ ...v, is_selected: i === index }));
      onUpdateIllustrations(next);
      // ⚡C: switching to a non-edited version while comparing → drop compare (no original_url).
      if (!(target.type === "edited" && target.original_url)) setCompareMode(false);
      if (isPaint) activePaint?.resetStrokes(); // new source image → discard strokes
      log.debug("handleSelectVersion", "selected", { index });
    },
    [isProcessing, versions, isPaint, activePaint, onUpdateIllustrations],
  );

  const handleCommit = useCallback(async () => {
    if (commitDisabled || !selectedVersion) return;
    const runId = (commitRunIdRef.current += 1);
    const committed = selectedVersion; // capture — selection may change while resolving
    setIsProcessing(true);
    log.info("handleCommit", "start", { activeTool, runId });
    try {
      const commitFn = activePaint
        ? activePaint.commit
        : activeTool === "upscale"
          ? upscaleState.commit
          : activeTool === "outpaint"
            ? outpaintState.commit
            : activeTool === "remove_text"
              ? removeTextState.commit
              : removeBgState.commit;
      const { imageUrl: newUrl, aiRequestId } = await commitFn(committed);
      if (runId !== commitRunIdRef.current) {
        log.debug("handleCommit", "stale — dropped", { runId });
        return;
      }
      // prepend onto the REAL illustrations (not the display fallback); the fallback's url is
      // preserved as original_url so Compare works after the very first commit. `aiRequestId`
      // (present only for AI tabs) is persisted onto the new edited entry for cost provenance.
      const next = prependVersion(illustrations, newUrl, committed.media_url, aiRequestId);
      onUpdateIllustrations(next);
      if (isPaint) activePaint?.afterCommit(); // clear strokes (inpaint keeps prompt + model)
      log.info("handleCommit", "done", { activeTool });
    } catch (err) {
      if (runId !== commitRunIdRef.current) return;
      log.error("handleCommit", "failed", { activeTool, error: String(err) });
      toast.error(mapEditError(err, { actionLabel: ERROR_ACTION_LABELS[activeTool] }));
    } finally {
      if (runId === commitRunIdRef.current) setIsProcessing(false);
    }
  }, [commitDisabled, selectedVersion, activeTool, isPaint, activePaint, removeBgState, removeTextState, upscaleState, outpaintState, illustrations, onUpdateIllustrations]);

  const handleToggleCompare = useCallback(() => {
    if (!canCompare) return;
    setCompareMode((m) => !m);
  }, [canCompare]);

  const handleZoomVersion = useCallback((src: string) => {
    setZoomSrc(src);
    setZoomOpen(true);
  }, []);

  // ── Paint undo/redo — global hotkey (Ctrl/Cmd+Z, +Shift = redo) only while a paint tab active ──
  useGlobalHotkey(
    (e) => open && isPaint && !isProcessing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z",
    (e) => {
      if (e.shiftKey) activePaint?.redo();
      else activePaint?.undo();
    },
    [open, isPaint, isProcessing, activePaint],
  );

  // ── Interaction Layer Stack (top modal slot) — gated off while zoom child owns the slot ──
  useInteractionLayer(
    "modal",
    open && !zoomOpen
      ? {
          id: "edit-image-modal",
          ref: modalContentRef,
          captureClickOutside: true,
          hotkeys: ["Escape", "c", "C"],
          portalSelectors: [
            "[data-radix-popper-content-wrapper]",
            "[data-radix-select-content]",
            '[role="listbox"]',
            '[role="alertdialog"]',
          ],
          dropdownSelectors: [
            "[data-radix-select-content]",
            "[data-radix-popper-content-wrapper]",
            '[role="alertdialog"]',
          ],
          onHotkey: (key) => {
            if (key === "Escape") {
              handleClose();
              return;
            }
            // Provider already suppresses hotkeys while an input is focused.
            if ((key === "c" || key === "C") && canCompare) handleToggleCompare();
          },
          onClickOutside: () => handleClose(),
          onForcePop: () => {
            log.debug("onForcePop", "force close + reset");
            resetState();
            onOpenChange(false);
          },
          yieldedFrom,
        }
      : null,
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          ref={modalContentRef}
          aria-labelledby="edit-image-modal-title"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          style={{ ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.swapModal } as React.CSSProperties}
          className="inset-0 left-0 top-0 flex h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[var(--swap-modal-bg)] p-0 text-[var(--swap-modal-text-primary)] [&>button]:hidden"
        >
          <DialogTitle className="sr-only">Editing Image</DialogTitle>
          <DialogDescription className="sr-only">
            Chỉnh sửa ảnh (Inpaint / Upscale / Remove BG / Erasor) trong workspace toàn màn hình.
          </DialogDescription>

          <EditImageModalHeader
            title="Editing Image"
            activeTool={activeTool}
            tools={EDIT_TOOLS}
            enabledKeys={enabledTools}
            onToolChange={handleToolChange}
            onClose={handleClose}
            disabled={isProcessing}
          />

          <div className="flex min-h-0 flex-1">
            <EditImageModalVersionsSidebar
              versions={versions}
              onSelectVersion={handleSelectVersion}
              onCommit={handleCommit}
              commitDisabled={commitDisabled}
              isProcessing={isProcessing}
              commitHint={commitHint}
              onZoom={handleZoomVersion}
            />

            <EditImageModalCanvas
              canvasMode={canvasMode}
              selectedVersion={selectedVersion}
              canvasLayer={activePaint?.CanvasLayer}
              compareMode={compareMode}
              canCompare={canCompare}
              onToggleCompare={handleToggleCompare}
              zoom={zoom}
              onZoomChange={setZoom}
              isProcessing={isProcessing}
              processingLabel={processingLabel}
              previewOverlay={activeTool === "outpaint" ? outpaintState.previewOverlay : undefined}
            />

            <aside
              className="flex h-full shrink-0 flex-col overflow-hidden border-l border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)]"
              style={{ width: RIGHT_SIDEBAR_WIDTH_PX }}
              aria-label="Edit parameters"
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
          </div>
        </DialogContent>
      </Dialog>

      {/* Full-image zoom — yields the modal slot (provider handles parent restore on close). */}
      <ImageZoomDialog
        open={zoomOpen}
        onOpenChange={setZoomOpen}
        src={zoomSrc}
        alt={imageTitle}
        yieldedFrom={{
          parentId: "edit-image-modal",
          onParentForcePop: () => {
            resetState();
            onOpenChange(false);
          },
        }}
      />
    </>
  );
}
