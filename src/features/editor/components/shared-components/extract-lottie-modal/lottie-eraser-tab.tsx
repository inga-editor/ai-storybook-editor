// lottie-eraser-tab.tsx — Eraser tab for the Extract-Lottie modal: client-side brush erase on the
// active part's selected version (mirrors edit-image-modal's Erasor tab, scoped to a part asset —
// no AI, no paint mode). The stage renders LottieMaskCanvas variant='erase' (live destination-out
// preview at the part bbox); this hook owns the stroke store + history + Apply. Strokes are keyed
// by part+version — switching part/version discards uncommitted strokes (parity with the
// edit-image-modal reset-on-source-change contract). Apply bakes the erase at ASSET NATURAL
// resolution (canvas buffer = natural px → brushScale 1), uploads, and appends a new `edited`
// version with the SAME bboxAtCrop (transparent pixels keep the rect; no coordinate drift).

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Undo2, Redo2, RotateCcw, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { createLogger } from '@/utils/logger';
import { type Stroke, paintStrokesOnCtx } from '../edit-image-modal/erase-stroke-engine';
import { uploadCroppedToStorage } from '../extract-image-modal/extract-image-modal-utils';
import type { LottiePart, LottiePartVersion } from './extract-lottie-modal-types';
import { selectedVersionOf } from './extract-lottie-modal-utils';
import {
  BRUSH,
  LOTTIE_PARTS_FOLDER,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
} from './extract-lottie-modal-constants';

const log = createLogger('Editor', 'LottieEraserTab');

const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load asset: ${url}`));
    img.src = url;
  });
}

export interface UseLottieEraserTabArgs {
  activePart: LottiePart | null;
  isProcessing: boolean;
  setProcessing: (v: boolean) => void;
  onAddVersion: (partId: string, version: LottiePartVersion) => void;
}

export interface LottieEraserTabApi {
  ParamsPanel: ReactNode;
  /** Strokes of the CURRENT part+version key (empty for any other target). */
  strokes: Stroke[];
  brushSize: number;
  hasAsset: boolean;
  onStrokeCommit: (stroke: Stroke) => void;
  undo: () => void;
  redo: () => void;
}

/** Stroke store scoped to one part+version — a key change (part/version switch) makes the store
 *  read as empty WITHOUT a set-state-in-effect; the stale store is simply replaced on the next
 *  stroke. */
interface StrokeStore {
  key: string;
  strokes: Stroke[];
  redo: Stroke[];
}
const EMPTY_STORE: StrokeStore = { key: '', strokes: [], redo: [] };

export function useLottieEraserTab({
  activePart,
  isProcessing,
  setProcessing,
  onAddVersion,
}: UseLottieEraserTabArgs): LottieEraserTabApi {
  const [brushSize, setBrushSize] = useState<number>(BRUSH.default);
  const [store, setStore] = useState<StrokeStore>(EMPTY_STORE);

  const selectedVersion = activePart ? selectedVersionOf(activePart) : null;
  const hasAsset = !!activePart && activePart.kind !== 'null' && !!selectedVersion;
  const key = hasAsset ? `${activePart!.id}:${selectedVersion!.id}` : '';

  const strokes = useMemo(
    () => (store.key === key && key !== '' ? store.strokes : []),
    [store, key],
  );
  const redoStack = store.key === key && key !== '' ? store.redo : [];

  const onStrokeCommit = useCallback(
    (stroke: Stroke) => {
      if (!key) return;
      setStore((prev) =>
        prev.key === key
          ? { key, strokes: [...prev.strokes, stroke], redo: [] }
          : { key, strokes: [stroke], redo: [] },
      );
    },
    [key],
  );

  const undo = useCallback(() => {
    setStore((prev) => {
      if (prev.key !== key || prev.strokes.length === 0) return prev;
      const last = prev.strokes[prev.strokes.length - 1];
      return { key, strokes: prev.strokes.slice(0, -1), redo: [...prev.redo, last] };
    });
  }, [key]);

  const redo = useCallback(() => {
    setStore((prev) => {
      if (prev.key !== key || prev.redo.length === 0) return prev;
      const last = prev.redo[prev.redo.length - 1];
      return { key, strokes: [...prev.strokes, last], redo: prev.redo.slice(0, -1) };
    });
  }, [key]);

  const reset = useCallback(() => setStore(EMPTY_STORE), []);

  // Apply: bake at natural resolution → upload → new `edited` version (auto-selected by shell).
  // Canvas buffer in LottieMaskCanvas = asset natural px, so strokes replay 1:1 (brushScale 1).
  const handleApply = useCallback(async () => {
    if (!activePart || !selectedVersion || strokes.length === 0 || isProcessing) return;
    const partId = activePart.id;
    setProcessing(true);
    log.info('handleApply', 'bake start', { partId, strokeCount: strokes.length });
    try {
      const img = await loadImage(selectedVersion.media_url);
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      if (!W || !H) throw new Error('Asset not loaded');
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.drawImage(img, 0, 0, W, H);
      paintStrokesOnCtx(ctx, strokes, null, W, H, 1, false);

      const url = await uploadCroppedToStorage(canvas.toDataURL('image/png'), LOTTIE_PARTS_FOLDER);
      const version: LottiePartVersion = {
        id: crypto.randomUUID(),
        media_url: url,
        type: 'edited',
        original_url: selectedVersion.media_url,
        bboxAtCrop: { ...selectedVersion.bboxAtCrop },
        created_time: new Date().toISOString(),
      };
      onAddVersion(partId, version);
      reset();
      toast.success('Đã xoá — version mới được chọn.');
    } catch (err) {
      log.error('handleApply', 'bake/upload failed', { partId, error: String(err) });
      toast.error('Không lưu được kết quả xoá — thử lại.');
    } finally {
      setProcessing(false);
    }
  }, [activePart, selectedVersion, strokes, isProcessing, setProcessing, onAddVersion, reset]);

  const ParamsPanel = useMemo<ReactNode>(() => {
    if (!hasAsset) {
      return (
        <div className="px-4 py-6 text-sm text-[var(--swap-modal-text-muted)]">
          Chọn một part đã crop để xoá bằng brush.
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-5 px-4 py-4">
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
            onValueChange={(v) => setBrushSize(v[0] ?? BRUSH.default)}
            aria-label="Brush size"
          />
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>History</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className={`flex-1 gap-1.5 ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`}
              onClick={undo}
              disabled={strokes.length === 0 || isProcessing}
              aria-label="Undo"
            >
              <Undo2 className="h-4 w-4" />
              Undo
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={`flex-1 gap-1.5 ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`}
              onClick={redo}
              disabled={redoStack.length === 0 || isProcessing}
              aria-label="Redo"
            >
              <Redo2 className="h-4 w-4" />
              Redo
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="flex-1 gap-1.5"
              onClick={reset}
              disabled={strokes.length === 0 || isProcessing}
              aria-label="Reset strokes"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          </div>
        </section>

        <button
          type="button"
          disabled={strokes.length === 0 || isProcessing}
          onClick={handleApply}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--swap-modal-accent)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--swap-modal-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check className="h-4 w-4" />
          {isProcessing ? 'Đang xử lý…' : 'Apply'}
        </button>
      </div>
    );
  }, [hasAsset, brushSize, strokes.length, redoStack.length, isProcessing, undo, redo, reset, handleApply]);

  return { ParamsPanel, strokes, brushSize, hasAsset, onStrokeCommit, undo, redo };
}
