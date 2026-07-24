// outpaint-tab.tsx — Outpaint tab (design 05-outpaint-tab.md): AI Gemini image extension. The
// user picks a DIRECTION + per-edge EXPAND RATIO (+ optional prompt); `[+]` calls
// callOutpaintImage → a permanent Storage URL the shell prepends as a new `type='edited'`
// version. canvasMode='preview' (no paint surface) — but the tab contributes ONE render-prop slot
// the canvas mounts:
//   • previewOverlay(box) — a dashed target frame that grows outward on the selected edges so
//     the user sees the new canvas before committing (design §5.2).
// Compare uses the shared CompareSlider (no override) — the larger outpaint result makes the
// contain-fit original read slightly large, accepted per product (design §5.3).
//
// Mirror of useUpscaleTabState (same `preview` contract: ParamsPanel + canCommit + commit) plus
// the preview slot. The hook takes NO `zoom` — geometry is a fraction of the scaled box the canvas
// passes in (already zoom-baked), so there is one geometry source and no zoom math here.

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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
import { callOutpaintImage } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import {
  OUTPAINT_MODEL_OPTIONS,
  OUTPAINT_DEFAULT_MODEL,
  OUTPAINT_RATIO,
  OUTPAINT_RATIO_SOFT_MAX,
  OUTPAINT_PROMPT_MAX,
  EXPAND_DIRECTION_OPTIONS,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
  Z_INDEX,
  type OutpaintModel,
  type ExpandDirection,
  type EditImageAttribution,
  type EditCommitResult,
} from './edit-image-modal-constants';
import { EditApiError, buildOutpaintPayload } from './edit-image-modal-utils';
import { OutpaintFrameOverlay } from './outpaint-overlays';

const log = createLogger('Editor', 'OutpaintTab');

// Radix popper copies the content's computed z onto its portal wrapper — without this the
// dropdown (shadcn default z-50) paints behind the full-screen modal (z-4000). See memory.
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };
const DARK_TRIGGER_CLASS = `w-full ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`;
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';

/** Box = the scaled image box (display px @ zoom) the canvas measures. */
interface Box {
  w: number;
  h: number;
}

export interface OutpaintTabApi {
  ParamsPanel: ReactNode;
  /** ratio>0 && a version is selected (prompt is OPTIONAL). */
  canCommit: boolean;
  /** Resolves to the new permanent Storage URL + aiRequestId; throws EditApiError on API failure. */
  commit: (version: Illustration) => Promise<EditCommitResult>;
  /** Dashed target-frame overlay for preview mode — canvas passes its measured scaled box. */
  previewOverlay: (box: Box) => ReactNode;
}

interface UseOutpaintTabOptions {
  selectedVersion: Illustration | null;
  /** AI-usage attribution (book snapshotId / remix remixId) forwarded into the outpaint call. */
  attribution?: EditImageAttribution;
  /** Opt-in double-write directive (parent-resolved path). Undefined → payload omits it. */
  saveResource?: SaveResourceDirective;
}

export function useOutpaintTabState({ selectedVersion, attribution, saveResource }: UseOutpaintTabOptions): OutpaintTabApi {
  const [model, setModel] = useState<OutpaintModel>(OUTPAINT_DEFAULT_MODEL);
  const [direction, setDirection] = useState<ExpandDirection>('all');
  const [ratio, setRatio] = useState<number>(OUTPAINT_RATIO.default);
  const [prompt, setPrompt] = useState('');

  const canCommit = ratio > 0 && !!selectedVersion;

  const commit = useCallback(
    async (version: Illustration): Promise<EditCommitResult> => {
      const payload = {
        ...buildOutpaintPayload(model, direction, ratio, prompt, version.media_url),
        ...(attribution ?? {}), // book snapshotId / remix remixId (attribution-only)
        ...(saveResource ? { saveResource } : {}),
      };
      log.info('commit', 'outpaint start', {
        imageUrl: version.media_url.slice(0, 60),
        direction,
        ratio,
        model,
      });

      const res = await callOutpaintImage(payload);
      if (!res.success || !res.data) {
        const failure = res as ImageApiFailure;
        log.warn('commit', 'outpaint failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
        throw new EditApiError(failure.error ?? 'Outpaint failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
      }

      log.info('commit', 'outpaint success', {
        canvasAspectRatio: res.meta?.canvasAspectRatio,
        outputWidth: res.meta?.outputWidth,
        outputHeight: res.meta?.outputHeight,
      });
      return { imageUrl: res.data.imageUrl, aiRequestId: res.data.aiRequestId };
    },
    [model, direction, ratio, prompt, attribution, saveResource],
  );

  const previewOverlay = useCallback(
    (box: Box) => <OutpaintFrameOverlay box={box} direction={direction} ratio={ratio} />,
    [direction, ratio],
  );

  const ParamsPanel = useMemo<ReactNode>(
    () => (
      <div className="flex flex-col gap-5 px-4 py-4">
        <section>
          <p className={SECTION_LABEL_CLASS}>Model</p>
          <Select value={model} onValueChange={(v) => setModel(v as OutpaintModel)}>
            <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Outpaint model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={SELECT_CONTENT_STYLE}>
              {OUTPAINT_MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>Expand Direction</p>
          <Select value={direction} onValueChange={(v) => setDirection(v as ExpandDirection)}>
            <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Expand direction">
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={SELECT_CONTENT_STYLE}>
              {EXPAND_DIRECTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>
            <span>Expand Ratio</span>
            <span className="normal-case tabular-nums text-[var(--swap-modal-text-secondary)]">
              {ratio}%
            </span>
          </p>
          <Slider
            value={[ratio]}
            min={OUTPAINT_RATIO.min}
            max={OUTPAINT_RATIO.max}
            step={OUTPAINT_RATIO.step}
            onValueChange={(v) => setRatio(v[0] ?? OUTPAINT_RATIO.default)}
            aria-label="Expand ratio"
          />
          {ratio > OUTPAINT_RATIO_SOFT_MAX && (
            <p className="mt-2 text-[11px] text-amber-400/90">
              Tỉ lệ lớn có thể giảm chất lượng.
            </p>
          )}
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>Prompt</p>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={OUTPAINT_PROMPT_MAX}
            rows={3}
            placeholder="Describe what to extend…"
            aria-label="Outpaint prompt"
            className="resize-none border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] placeholder:text-[var(--swap-modal-text-muted)] focus-visible:ring-[var(--swap-modal-accent)]"
          />
          <p className="mt-1 text-right text-[11px] tabular-nums text-[var(--swap-modal-text-muted)]">
            {prompt.length}/{OUTPAINT_PROMPT_MAX}
          </p>
        </section>
      </div>
    ),
    [model, direction, ratio, prompt],
  );

  return { ParamsPanel, canCommit, commit, previewOverlay };
}
