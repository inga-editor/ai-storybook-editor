// inpaint-tab.tsx — Inpaint tab (design 04-inpaint-tab.md): AI Gemini edit via set-of-mark.
// The user brushes a translucent "region" hint onto the workspace canvas + writes a prompt;
// `[+]` composites source + mark at natural resolution → `regionAnnotation` (base64) →
// callEditObjectImage (Gemini) → a permanent Storage URL the shell prepends as a new
// `type='edited'` version. canvasMode='paint' (shell renders CanvasLayer in the center stage).
//
// ~85% clone of eraser-tab. Differences: mark is rendered TRANSLUCENT (set-of-mark, not erase)
// via a 2-pass offscreen→globalAlpha draw; params are Model + Brush + Prompt (no Color Mode, no
// History UI — mask is edited via Ctrl/Cmd+Z hotkeys wired in the shell); commit is an AI call
// instead of an upload; the region is OPTIONAL (no strokes → prompt-only full-image edit).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createLogger } from '@/utils/logger';
import { callEditObjectImage, type EditObjectImageParams } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { type Stroke, norm, paintStrokesOnCtx } from './erase-stroke-engine';
import {
  INPAINT_BRUSH_DEFAULT,
  INPAINT_DEFAULT_MODEL,
  INPAINT_MARK_COLOR,
  INPAINT_MARK_ALPHA,
  INPAINT_IMAGE_SIZE,
  INPAINT_REF_MAX,
  type InpaintModel,
  type EditImageAttribution,
  type EditCommitResult,
} from './edit-image-modal-constants';
import { computeFrameSize, fitNaturalToFrame } from './edit-image-modal-fit';
import {
  EditApiError,
  compositeMark,
  nearestAspectRatio,
  exceedsRegionSizeCap,
  type ReferenceImageCandidate,
} from './edit-image-modal-utils';
import { InpaintParamsPanel } from './inpaint-params-panel';
import { useInpaintReferences } from './use-inpaint-references';
import { useInpaintProvenance } from './use-inpaint-provenance';

const log = createLogger('Editor', 'InpaintTab');

// Translucent mark color for the brush-preview ring (mark is a soft hint, not a hard mask).
const BRUSH_RING_FILL = `${INPAINT_MARK_COLOR}80`;

export interface InpaintTabApi {
  ParamsPanel: ReactNode;
  CanvasLayer: ReactNode;
  /** prompt.trim().length > 0 — the [+] commit gate (region is OPTIONAL). */
  canCommit: boolean;
  /** strokes.length > 0 — shell blocking-confirm gate on version/tool change (mirror Erasor). */
  hasUncommitted: boolean;
  /** Composite mark → callEditObjectImage (Gemini) → new Storage URL + aiRequestId. Throws
   *  EditApiError on API failure or the pre-flight REGION_TOO_LARGE guard; plain Error on CORS taint. */
  commit: (version: Illustration) => Promise<EditCommitResult>;
  /** Clear strokes + redo after a successful commit — KEEPS prompt + model (continue editing). */
  afterCommit: () => void;
  /** Discard strokes when the source image changes (version/tool switch, post-confirm). */
  resetStrokes: () => void;
  /** Full reset on modal close: strokes + redo + prompt + model back to defaults. */
  resetAll: () => void;
  undo: () => void;
  redo: () => void;
}

interface UseInpaintTabOptions {
  selectedVersion: Illustration | null;
  /** FULL version list — walked backwards via `original_url` to find the nearest ancestor carrying an
   *  `ai_request_id` (design §8.3), so a derivative still borrows its AI-gen source's refs. */
  versions: Illustration[];
  /** Shell zoom (50–400) — drives canvas display CSS size + brush-ring cursor scale (⚡H). */
  zoom: number;
  /** `activeTool === 'inpaint'` — LAZY gate for the provenance lookup: a space that never opens the
   *  inpaint tab costs 0 provenance requests (design §8.3). */
  isActive: boolean;
  /** AI-usage attribution (book snapshotId / remix remixId) forwarded into the edit call. */
  attribution?: EditImageAttribution;
  /** Opt-in double-write directive (parent-resolved path). Undefined → payload omits it. */
  saveResource?: SaveResourceDirective;
}

export function useInpaintTabState({
  selectedVersion,
  versions,
  zoom,
  isActive,
  attribution,
  saveResource,
}: UseInpaintTabOptions): InpaintTabApi {
  const [model, setModel] = useState<InpaintModel>(INPAINT_DEFAULT_MODEL);
  // Reference-image picker + onPick (upload + picked provenance refs GỘP, cap = INPAINT_REF_MAX). Lives
  // in a hook so refs persist across version/tab switches; cleared only on modal close (resetAll).
  const refs = useInpaintReferences();
  // Refs of the AI call that PRODUCED the selected version (resolve → lazy fetch → cache → race).
  const prov = useInpaintProvenance({ selectedVersion, versions, isActive });
  const [brushSize, setBrushSize] = useState<number>(INPAINT_BRUSH_DEFAULT);
  const [prompt, setPrompt] = useState('');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  // Redo stack is read only via the functional updater (no History UI buttons — hotkey-only).
  const [, setRedoStack] = useState<Stroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<Stroke | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  // Canvas intrinsic size (display px @ zoom 100%); bumped on image load to re-trigger draw.
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);

  const sourceImgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Mirror of activeStroke — read in event handlers without stale closures.
  const activeStrokeRef = useRef<Stroke | null>(null);

  const canCommit = prompt.trim().length > 0;

  // ── Image load → size canvas to fit, trigger redraw (event handler — no set-state-in-effect) ──
  const handleImageLoad = useCallback(() => {
    const img = sourceImgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || img.naturalWidth === 0) return;
    const frame = computeFrameSize(window.innerWidth, window.innerHeight);
    const { w, h } = fitNaturalToFrame(img.naturalWidth, img.naturalHeight, frame);
    canvas.width = w;
    canvas.height = h;
    setCanvasSize({ w, h });
    log.info('handleImageLoad', 'canvas sized', {
      displayW: w,
      displayH: h,
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
    });
  }, []);

  // Callback ref: assign the node AND close the cached-image gap. A cached image can finish
  // loading before React attaches `onLoad` (or mount already `complete`), so `onLoad` never fires
  // and `canvasSize` stays null → the canvas never sizes/draws and marks paint nothing. When the
  // node is already decoded on attach, run the load path once. Deferred to a microtask so canvasRef
  // (attached AFTER this <img> in JSX order on first mount) is ready.
  const attachSourceImg = useCallback(
    (node: HTMLImageElement | null) => {
      sourceImgRef.current = node;
      if (node && node.complete && node.naturalWidth > 0) queueMicrotask(handleImageLoad);
    },
    [handleImageLoad],
  );

  // ── Workspace render: draw image then composite mark TRANSLUCENT (2-pass — no setState) ──
  // Mark is rendered to an OFFSCREEN canvas at full alpha, then drawn once with
  // globalAlpha=INPAINT_MARK_ALPHA, so overlapping strokes don't darken-stack (set-of-mark).
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = sourceImgRef.current;
    if (!canvas || !img || !canvasSize || img.naturalWidth === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (strokes.length > 0 || activeStroke) {
      const overlay = document.createElement('canvas');
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      const overlayCtx = overlay.getContext('2d');
      if (overlayCtx) {
        paintStrokesOnCtx(overlayCtx, strokes, activeStroke, canvas.width, canvas.height, 1, true);
        ctx.globalAlpha = INPAINT_MARK_ALPHA;
        ctx.drawImage(overlay, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
  }, [strokes, activeStroke, canvasSize]);

  // ── Pointer handlers (intrinsic-px mapping via rect → zoom-invariant, ⚡H) ──────────────
  const pointToIntrinsic = (e: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect(); // includes the shell's CSS scale
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { x, y } = pointToIntrinsic(e, canvas);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      // Mark stroke is ALWAYS paint mode + the fixed mark color (set-of-mark, not erase).
      const stroke: Stroke = {
        points: [norm(x, y, canvas.width, canvas.height)],
        size: brushSize,
        mode: 'paint',
        color: INPAINT_MARK_COLOR,
      };
      activeStrokeRef.current = stroke;
      setActiveStroke(stroke);
    },
    [brushSize],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = pointToIntrinsic(e, canvas);
    setCursorPos({ x, y }); // intrinsic px → brush ring scales with the shell transform
    const current = activeStrokeRef.current;
    if (!current) return;
    const updated: Stroke = {
      ...current,
      points: [...current.points, norm(x, y, canvas.width, canvas.height)],
    };
    activeStrokeRef.current = updated;
    setActiveStroke(updated);
  }, []);

  const handlePointerUp = useCallback(() => {
    const committed = activeStrokeRef.current;
    activeStrokeRef.current = null;
    setActiveStroke(null);
    if (!committed || committed.points.length === 0) return;
    setStrokes((s) => [...s, committed]);
    setRedoStack([]); // a fresh stroke starts a new history branch
    log.debug('handlePointerUp', 'mark stroke committed', { points: committed.points.length });
  }, []);

  const handlePointerLeave = useCallback(() => setCursorPos(null), []);

  // ── History (no UI buttons — hotkey-only per design §5) ───────────────────────
  const undo = useCallback(() => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, last]);
      log.debug('undo', 'mark popped', { remaining: prev.length - 1 });
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setStrokes((s) => [...s, last]);
      log.debug('redo', 'mark restored', { remaining: prev.length - 1 });
      return prev.slice(0, -1);
    });
  }, []);

  const resetStrokes = useCallback(() => {
    setStrokes([]);
    setRedoStack([]);
    setActiveStroke(null);
    activeStrokeRef.current = null;
  }, []);

  const afterCommit = resetStrokes; // keep prompt + model + refs; only the mask is cleared

  // Destructured for the same reason as `pickReference` below: `refs.clearImages()` / `prov.clearCache()`
  // would force the WHOLE (per-render fresh) hook objects into the deps, churning resetAll → the shell's
  // resetState/handleClose on every render. Both are stable `useCallback`s at their source.
  const { clearImages } = refs;
  const { clearCache: clearProvenanceCache } = prov;
  const resetAll = useCallback(() => {
    resetStrokes();
    setPrompt('');
    setModel(INPAINT_DEFAULT_MODEL);
    clearImages(); // modal close → drop reference images too (design §8.5)
    clearProvenanceCache(); // …and the provenance cache (never outlives the modal — §8 security)
  }, [resetStrokes, clearImages, clearProvenanceCache]);

  // ── Commit: composite mark (if drawn) → Gemini edit (design §3) ────────────────
  const commit = useCallback(
    async (version: Illustration): Promise<EditCommitResult> => {
      const img = sourceImgRef.current;
      const canvas = canvasRef.current;
      if (!img || img.naturalWidth === 0) throw new Error('Image not loaded');

      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      const payload: EditObjectImageParams = {
        prompt: prompt.trim(),
        imageUrl: version.media_url,
        aspectRatio: nearestAspectRatio(naturalW, naturalH), // always source ratio (aspect-guard)
        imageSize: INPAINT_IMAGE_SIZE,
        modelParams: { model }, // omit params → server temperature default 0.3
        ...(attribution ?? {}), // book snapshotId / remix remixId (attribution-only)
        ...(saveResource ? { saveResource } : {}),
      };

      if (strokes.length > 0 && canvas) {
        const regionB64 = compositeMark(
          img,
          strokes,
          INPAINT_MARK_COLOR,
          INPAINT_MARK_ALPHA,
          naturalW,
          naturalH,
          canvas.width,
          canvas.height,
        );
        // Pre-flight size guard — abort BEFORE the API call (no 400 round-trip).
        if (exceedsRegionSizeCap(regionB64)) {
          throw new EditApiError('Region too large', { errorCode: 'REGION_TOO_LARGE' });
        }
        payload.regionAnnotation = { base64Data: regionB64, mimeType: 'image/png' };
      }

      // Reference images (picked provenance refs + upload GỘP). Only sent when non-empty. NO item
      // carries `description` today (§8.1); the spread stays for upstream ReferenceImage compat.
      if (refs.images.length > 0) {
        payload.referenceImages = refs.images.map((i) => ({
          base64Data: i.base64Data,
          mimeType: i.mimeType,
          ...(i.description ? { description: i.description } : {}),
        }));
      }

      log.info('commit', 'inpaint start', {
        promptLen: payload.prompt.length,
        strokeCount: strokes.length,
        hasRegion: !!payload.regionAnnotation,
        refCount: refs.images.length,
        model,
        aspectRatio: payload.aspectRatio,
      });

      const res = await callEditObjectImage(payload);
      if (!res.success || !res.data) {
        const failure = res as ImageApiFailure;
        log.warn('commit', 'inpaint failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
        throw new EditApiError(failure.error ?? 'Inpaint failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
      }

      log.info('commit', 'inpaint success', { processingMs: res.meta?.processingTime });
      return { imageUrl: res.data.imageUrl, aiRequestId: res.data.aiRequestId };
    },
    [prompt, model, strokes, refs.images, attribution, saveResource],
  );

  // Bind the resolved aiRequestId into the pick call (the picker stays provenance-id agnostic — it
  // just hands back the clicked candidate). No id ⇒ the grid can't be rendered, so this is a guard
  // against a stale click only. `onPick` is destructured on purpose: `refs.onPick(...)` would make
  // the React Compiler infer the WHOLE (per-render fresh) `refs` object as the dep, which would
  // churn this callback — and with it the memoized ParamsPanel — on every brush-move render.
  const { onPick: pickReference } = refs;
  const provAiRequestId = prov.aiRequestId;
  const handlePickProvenance = useCallback(
    (candidate: ReferenceImageCandidate) => {
      if (!provAiRequestId) {
        log.debug('handlePickProvenance', 'ignored — no resolved aiRequestId');
        return;
      }
      void pickReference(candidate, provAiRequestId);
    },
    [provAiRequestId, pickReference],
  );

  // ── ParamsPanel (Model + Brush + Reference Images + Prompt — no History UI) ────
  // The picker owns the 5-state provenance UI (§8.2), so the whole `prov` view is threaded through:
  // `status` picks the branch, `source`/`resolvedFromAncestor` the caption lines, `errorCode` +
  // `httpStatus` the error message, `aiRequestId` the `prov:{id}:{index}` dedupe key.
  const ParamsPanel = useMemo<ReactNode>(
    () => (
      <InpaintParamsPanel
        model={model}
        onModelChange={setModel}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
        prompt={prompt}
        onPromptChange={setPrompt}
        picker={{
          images: refs.images,
          max: INPAINT_REF_MAX,
          fileInputRef: refs.inputRef,
          onOpenUpload: refs.openPicker,
          onFilesSelected: refs.handleFilesSelected,
          onRemove: refs.removeImage,
          provenanceStatus: prov.status,
          candidates: prov.candidates,
          aiRequestId: prov.aiRequestId,
          resolvedFromAncestor: prov.resolvedFromAncestor,
          source: prov.source,
          errorCode: prov.errorCode,
          httpStatus: prov.httpStatus,
          onPick: handlePickProvenance,
          onRetry: prov.retry,
        }}
      />
    ),
    [
      model,
      brushSize,
      prompt,
      refs.images,
      refs.inputRef,
      refs.openPicker,
      refs.handleFilesSelected,
      refs.removeImage,
      prov.status,
      prov.candidates,
      prov.aiRequestId,
      prov.resolvedFromAncestor,
      prov.source,
      prov.errorCode,
      prov.httpStatus,
      prov.retry,
      handlePickProvenance,
    ],
  );

  // ── CanvasLayer (rendered in the shell stage when canvasMode='paint') ─────────
  // Zoom = CSS width/height on the canvas display (NOT transform:scale) so the modal's scroll
  // container can reach every part of the zoomed content (codebase convention — ⚡H).
  const cursorDiameter = brushSize * 2; // intrinsic px
  const scaleFactor = zoom / 100;
  const displayW = canvasSize ? Math.round(canvasSize.w * scaleFactor) : undefined;
  const displayH = canvasSize ? Math.round(canvasSize.h * scaleFactor) : undefined;
  const CanvasLayer = useMemo<ReactNode>(
    () => (
      <div
        className="relative leading-[0]"
        style={displayW && displayH ? { width: displayW, height: displayH } : undefined}
      >
        {/* Hidden source — drawImage origin for the workspace canvas. crossorigin so toDataURL
            isn't CORS-tainted. Keyed by url so a version swap reliably re-fires onLoad. */}
        <img
          key={selectedVersion?.media_url ?? 'none'}
          ref={attachSourceImg}
          src={selectedVersion?.media_url}
          alt=""
          crossOrigin="anonymous"
          className="hidden"
          onLoad={handleImageLoad}
        />
        <canvas
          ref={canvasRef}
          className="block cursor-none"
          style={{ width: '100%', height: '100%' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
        />
        {cursorPos && (
          <div
            className="pointer-events-none absolute rounded-full"
            style={{
              width: cursorDiameter * scaleFactor,
              height: cursorDiameter * scaleFactor,
              left: (cursorPos.x - cursorDiameter / 2) * scaleFactor,
              top: (cursorPos.y - cursorDiameter / 2) * scaleFactor,
              backgroundColor: BRUSH_RING_FILL,
              boxShadow: '0 0 0 1px #fff, 0 0 0 2px #000',
            }}
          />
        )}
      </div>
    ),
    [
      selectedVersion?.media_url,
      cursorPos,
      cursorDiameter,
      scaleFactor,
      displayW,
      displayH,
      attachSourceImg,
      handleImageLoad,
      handlePointerDown,
      handlePointerMove,
      handlePointerUp,
      handlePointerLeave,
    ],
  );

  return {
    ParamsPanel,
    CanvasLayer,
    canCommit,
    hasUncommitted: strokes.length > 0,
    commit,
    afterCommit,
    resetStrokes,
    resetAll,
    undo,
    redo,
  };
}
