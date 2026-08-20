// edit-tab.tsx — Edit tab state + params panel (design 03-edit-tab.md). `useLottieEditTab` owns
// model / brush / prompt / references and the Send flow: composite the per-part mask over the
// selected part asset → callEditObjectImage (Gemini) → AUTO-CHAIN callImageRemoveBg → append an
// `edited` version. Mirrors edit-image-modal's Inpaint tab, scoped to a part asset with session-local
// references (no provenance). The mask strokes + version append live in the shell; this hook exposes
// `ParamsPanel` + `brushSize` (for the mask canvas) and drives Send.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
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
import { callEditObjectImage, callImageRemoveBg, type EditObjectImageParams } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import { useReferenceImagePicker } from '@/features/editor/hooks/use-reference-image-picker';
import {
  compositeMark,
  nearestAspectRatio,
  exceedsRegionSizeCap,
  mapEditError,
  EditApiError,
  urlToBase64,
} from '../edit-image-modal/edit-image-modal-utils';
import type { LottiePart, LottiePartVersion } from './extract-lottie-modal-types';
import { selectedVersionOf } from './extract-lottie-modal-utils';
import {
  DEFAULT_BRUSH_SIZE,
  INPAINT_DEFAULT_MODEL,
  INPAINT_MARK_COLOR,
  INPAINT_MARK_ALPHA,
  INPAINT_IMAGE_SIZE,
  INPAINT_MODEL_OPTIONS,
  INPAINT_REF_MAX,
  SWAP_MODAL_TOKENS,
  Z_INDEX,
} from './extract-lottie-modal-constants';
import { LottieReferencePicker, type LottieRefSource } from './lottie-reference-picker';

const log = createLogger('Editor', 'LottieEditTab');

// Reference-image concern (upload + session-source pick). Split from the presentational picker so
// that file exports only a component (react-refresh). Session sources (Ảnh gốc / other cropped parts)
// are converted-on-add (fetch URL → base64) with cap + dedupe; a fetch failure toasts, never blocks
// Send (refs are optional). NO provenance API — parts are session-local.
function useLottieReferences() {
  const refs = useReferenceImagePicker(INPAINT_REF_MAX);
  const { images, addReferenceImages } = refs;

  const onPickSession = useCallback(
    async (source: LottieRefSource) => {
      if (images.length >= INPAINT_REF_MAX) {
        toast.warning(`Tối đa ${INPAINT_REF_MAX} ảnh tham khảo`);
        return;
      }
      if (images.some((i) => i.id === source.id)) return;
      try {
        const { base64Data, mimeType } = await urlToBase64(source.url);
        addReferenceImages([
          {
            id: source.id,
            label: source.label,
            thumbUrl: source.url,
            base64Data,
            mimeType,
            source: 'provenance',
          },
        ]);
        log.info('onPickSession', 'reference added', { id: source.id, mimeType });
      } catch (err) {
        log.warn('onPickSession', 'reference fetch failed', { id: source.id, error: String(err) });
        toast.error('Không tải được ảnh tham khảo');
      }
    },
    [images, addReferenceImages],
  );

  return { ...refs, onPickSession };
}

const SELECT_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';
const BRUSH_MIN = 1;
const BRUSH_MAX = 100;
const PROMPT_MAX = 2000;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load asset: ${url}`));
    img.src = url;
  });
}

export interface UseLottieEditTabArgs {
  activePart: LottiePart | null;
  sourceUrl: string;
  parts: LottiePart[];
  attribution?: { snapshotId?: string };
  isProcessing: boolean;
  setProcessing: (v: boolean) => void;
  onAddVersion: (partId: string, version: LottiePartVersion) => void;
  onClearMask: (partId: string) => void;
}

export interface LottieEditTabApi {
  ParamsPanel: ReactNode;
  brushSize: number;
}

export function useLottieEditTab({
  activePart,
  sourceUrl,
  parts,
  attribution,
  isProcessing,
  setProcessing,
  onAddVersion,
  onClearMask,
}: UseLottieEditTabArgs): LottieEditTabApi {
  const [model, setModel] = useState<string>(INPAINT_DEFAULT_MODEL);
  const [brushSize, setBrushSize] = useState<number>(DEFAULT_BRUSH_SIZE);
  const [prompt, setPrompt] = useState('');
  const refs = useLottieReferences();

  const selectedVersion = activePart ? selectedVersionOf(activePart) : null;
  const hasAsset = activePart?.kind !== 'null' && !!activePart && !!selectedVersion;
  const canSend = hasAsset && prompt.trim().length > 0 && !isProcessing;

  // Session references: Ảnh gốc + other cropped normal parts' selected version (exclude active).
  const sessionSources = useMemo<LottieRefSource[]>(() => {
    const list: LottieRefSource[] = [{ id: 'src:original', label: 'Ảnh gốc', url: sourceUrl }];
    for (const p of parts) {
      if (p.id === activePart?.id || p.kind === 'null') continue;
      const v = selectedVersionOf(p);
      if (v) list.push({ id: `part:${p.id}`, label: p.name, url: v.media_url });
    }
    return list;
  }, [parts, activePart?.id, sourceUrl]);

  const { onPickSession } = refs;

  const handleSend = useCallback(async () => {
    if (!activePart || !selectedVersion || prompt.trim().length === 0 || isProcessing) return;
    const partId = activePart.id;
    const strokes = activePart.maskStrokes;
    setProcessing(true);
    log.info('handleSend', 'start', { partId, hasMask: strokes.length > 0, refCount: refs.images.length });
    try {
      const assetImg = await loadImage(selectedVersion.media_url);
      const assetW = assetImg.naturalWidth;
      const assetH = assetImg.naturalHeight;

      const payload: EditObjectImageParams = {
        prompt: prompt.trim(),
        imageUrl: selectedVersion.media_url,
        aspectRatio: nearestAspectRatio(assetW, assetH),
        imageSize: INPAINT_IMAGE_SIZE,
        modelParams: { model },
        ...(attribution ?? {}),
      };

      if (strokes.length > 0) {
        const regionB64 = compositeMark(
          assetImg,
          strokes,
          INPAINT_MARK_COLOR,
          INPAINT_MARK_ALPHA,
          assetW,
          assetH,
          assetW,
          assetH,
        );
        if (exceedsRegionSizeCap(regionB64)) {
          toast.error('Ảnh quá lớn để inpaint — chọn version nhỏ hơn.');
          setProcessing(false);
          return;
        }
        payload.regionAnnotation = { base64Data: regionB64, mimeType: 'image/png' };
      }

      if (refs.images.length > 0) {
        payload.referenceImages = refs.images.map((i) => ({
          base64Data: i.base64Data,
          mimeType: i.mimeType,
        }));
      }

      const res = await callEditObjectImage(payload);
      if (!res.success || !res.data) {
        const failure = res as ImageApiFailure;
        log.warn('handleSend', 'edit failed', { errorCode: failure.errorCode });
        toast.error(
          mapEditError(
            new EditApiError(failure.error ?? 'Inpaint failed', {
              errorCode: failure.errorCode,
              httpStatus: failure.httpStatus,
            }),
            { actionLabel: 'Inpaint' },
          ),
        );
        setProcessing(false);
        return;
      }

      // AUTO-CHAIN remove-bg — Gemini often returns an opaque background; the part needs RGBA.
      let finalUrl = res.data.imageUrl;
      const bgRes = await callImageRemoveBg({ imageUrl: finalUrl, ...(attribution ?? {}) });
      if (bgRes.success && bgRes.data) {
        finalUrl = bgRes.data.imageUrl;
      } else {
        toast.warning('Không tách được nền — giữ kết quả edit gốc');
      }

      const version: LottiePartVersion = {
        id: crypto.randomUUID(),
        media_url: finalUrl,
        type: 'edited',
        original_url: selectedVersion.media_url,
        bboxAtCrop: selectedVersion.bboxAtCrop,
        created_time: new Date().toISOString(),
      };
      onAddVersion(partId, version);
      onClearMask(partId); // keep prompt + refs
      log.info('handleSend', 'done', { partId });
    } catch (err) {
      log.error('handleSend', 'failed', { partId, error: String(err) });
      toast.error(mapEditError(err, { actionLabel: 'Inpaint' }));
    } finally {
      setProcessing(false);
    }
  }, [
    activePart,
    selectedVersion,
    prompt,
    isProcessing,
    model,
    attribution,
    refs.images,
    setProcessing,
    onAddVersion,
    onClearMask,
  ]);

  const ParamsPanel = useMemo<ReactNode>(() => {
    if (!hasAsset) {
      return (
        <div className="px-4 py-6 text-sm text-[var(--swap-modal-text-muted)]">
          Part này chưa có ảnh — crop ở tab Parts trước.
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-5 px-4 py-4">
        <section>
          <p className={SECTION_LABEL_CLASS}>Inpaint Model</p>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger
              className="w-full border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)]"
              aria-label="Inpaint model"
            >
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
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            step={1}
            onValueChange={(v) => setBrushSize(v[0] ?? DEFAULT_BRUSH_SIZE)}
            aria-label="Brush size"
          />
        </section>

        <LottieReferencePicker
          images={refs.images}
          max={INPAINT_REF_MAX}
          fileInputRef={refs.inputRef}
          onOpenUpload={refs.openPicker}
          onFilesSelected={refs.handleFilesSelected}
          onRemove={refs.removeImage}
          sessionSources={sessionSources}
          onPickSession={onPickSession}
        />

        <section>
          <p className={SECTION_LABEL_CLASS}>Prompt</p>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={PROMPT_MAX}
            rows={8}
            placeholder="Describe what to inpaint…"
            aria-label="Inpaint prompt"
            className="resize-y border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] placeholder:text-[var(--swap-modal-text-muted)] focus-visible:ring-[var(--swap-modal-accent)]"
          />
        </section>

        <button
          type="button"
          disabled={!canSend}
          onClick={handleSend}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--swap-modal-accent)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--swap-modal-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
          {isProcessing ? 'Đang xử lý…' : 'Send'}
        </button>
      </div>
    );
  }, [
    hasAsset,
    model,
    brushSize,
    prompt,
    canSend,
    isProcessing,
    sessionSources,
    onPickSession,
    handleSend,
    refs.images,
    refs.inputRef,
    refs.openPicker,
    refs.handleFilesSelected,
    refs.removeImage,
  ]);

  return { ParamsPanel, brushSize };
}
