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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { createLogger } from '@/utils/logger';
import { callEditObjectImage, type EditObjectImageParams } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { type Stroke, norm, paintStrokesOnCtx } from './erase-stroke-engine';
import {
  BRUSH,
  INPAINT_BRUSH_DEFAULT,
  INPAINT_MODEL_OPTIONS,
  INPAINT_DEFAULT_MODEL,
  INPAINT_MARK_COLOR,
  INPAINT_MARK_ALPHA,
  INPAINT_IMAGE_SIZE,
  INPAINT_PROMPT_MAX,
  INPAINT_REF_MAX,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
  Z_INDEX,
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
import { InpaintReferencePicker } from './inpaint-reference-picker';
import { useInpaintReferences } from './use-inpaint-references';

const log = createLogger('Editor', 'InpaintTab');

// Radix popper copies the content's computed z onto its portal wrapper — without this the
// dropdown (shadcn default z-50) paints behind the full-screen modal (z-4000). See memory.
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };
const DARK_TRIGGER_CLASS = `w-full ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`;
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';
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
  /** Shell zoom (50–400) — drives canvas display CSS size + brush-ring cursor scale (⚡H). */
  zoom: number;
  /** Parent-resolved prop-variant candidates (already filtered to non-null media_url). Undefined
   *  / empty → the picker only offers Upload. */
  referenceImageCandidates?: ReferenceImageCandidate[];
  /** AI-usage attribution (book snapshotId / remix remixId) forwarded into the edit call. */
  attribution?: EditImageAttribution;
  /** Opt-in double-write directive (parent-resolved path). Undefined → payload omits it. */
  saveResource?: SaveResourceDirective;
}

export function useInpaintTabState({
  selectedVersion,
  zoom,
  referenceImageCandidates,
  attribution,
  saveResource,
}: UseInpaintTabOptions): InpaintTabApi {
  const [model, setModel] = useState<InpaintModel>(INPAINT_DEFAULT_MODEL);
  // Reference-image picker + onPick (upload + picked prop-variant GỘP, cap = INPAINT_REF_MAX). Lives
  // in a hook so refs persist across version/tab switches; cleared only on modal close (resetAll).
  const refs = useInpaintReferences();
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

  const resetAll = useCallback(() => {
    resetStrokes();
    setPrompt('');
    setModel(INPAINT_DEFAULT_MODEL);
    refs.clearImages(); // modal close → drop reference images too (design §8.5)
  }, [resetStrokes, refs]);

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

      // Reference images (picked prop-variant + upload GỘP). Only sent when non-empty; picked items
      // carry `description` (identity mention), uploads omit it.
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

  // ── ParamsPanel (Model + Brush + Prompt — no History UI) ──────────────────────
  const ParamsPanel = useMemo<ReactNode>(
    () => (
      <div className="flex flex-col gap-5 px-4 py-4">
        <section>
          <p className={SECTION_LABEL_CLASS}>Model</p>
          <Select value={model} onValueChange={(v) => setModel(v as InpaintModel)}>
            <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Inpaint model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={SELECT_CONTENT_STYLE}>
              {INPAINT_MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>
            <span>Brush Size</span>
            <span className="normal-case tabular-nums text-[var(--swap-modal-text-secondary)]">
              {brushSize}px
            </span>
          </p>
          <Slider
            value={[brushSize]}
            min={BRUSH.min}
            max={BRUSH.max}
            step={BRUSH.step}
            onValueChange={(v) => setBrushSize(v[0] ?? INPAINT_BRUSH_DEFAULT)}
            aria-label="Brush size"
          />
        </section>

        <InpaintReferencePicker
          images={refs.images}
          candidates={referenceImageCandidates ?? []}
          max={INPAINT_REF_MAX}
          fileInputRef={refs.inputRef}
          onOpenUpload={refs.openPicker}
          onFilesSelected={refs.handleFilesSelected}
          onPick={refs.onPick}
          onRemove={refs.removeImage}
        />

        <section>
          <p className={SECTION_LABEL_CLASS}>Prompt</p>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={INPAINT_PROMPT_MAX}
            rows={3}
            placeholder="Describe what to paint in the marked region…"
            aria-label="Inpaint prompt"
            className="resize-none border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] placeholder:text-[var(--swap-modal-text-muted)] focus-visible:ring-[var(--swap-modal-accent)]"
          />
          <p className="mt-1 text-right text-[11px] tabular-nums text-[var(--swap-modal-text-muted)]">
            {prompt.length}/{INPAINT_PROMPT_MAX}
          </p>
        </section>
      </div>
    ),
    [model, brushSize, prompt, refs.images, refs.inputRef, refs.openPicker, refs.handleFilesSelected, refs.removeImage, refs.onPick, referenceImageCandidates],
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
