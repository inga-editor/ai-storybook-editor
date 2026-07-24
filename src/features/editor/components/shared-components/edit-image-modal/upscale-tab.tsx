// upscale-tab.tsx — Upscale tab (design 03-upscale-tab.md): AI super-resolution of the
// selected version (Replicate, sync). The hook owns model + scale + faceEnhance params; it
// returns a Handle (ParamsPanel + canCommit + commit) the shell consumes — mirror of
// useRemoveBgTabState (same `preview` contract, no paint). commit → callImageUpscale → a
// permanent Storage URL; the shell prepends it as a new `type='edited'` version.
//
// Per-model gating (UPSCALE_MODEL_CAPS): recraft is fixed-ratio native passthrough → Scale AND
// Face Enhance are disabled (changing them is a no-op upstream). Switching model keeps the
// scale/faceEnhance state — only the disabled flag changes (03 §4).

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';
import { createLogger } from '@/utils/logger';
import { callImageUpscale } from '@/apis/image-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import {
  UPSCALE_MODEL_OPTIONS,
  DEFAULT_UPSCALE_MODEL,
  UPSCALE_MODEL_CAPS,
  SCALE,
  DEFAULT_FACE_ENHANCE,
  DEFAULT_GRAIN_ENABLED,
  GRAIN_AMP,
  GRAIN_BLUR,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
  Z_INDEX,
  type UpscaleModel,
  type EditImageAttribution,
  type EditCommitResult,
} from './edit-image-modal-constants';
import { EditApiError, buildUpscalePayload } from './edit-image-modal-utils';

const log = createLogger('Editor', 'UpscaleTab');

// Radix popper copies the content's computed z onto its portal wrapper — without this the
// dropdown (shadcn default z-50) paints behind the full-screen modal (z-4000). See memory.
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };
const DARK_TRIGGER_CLASS = `w-full ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`;
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';
const RECRAFT_HINT = 'Crisp sharpen — fixed ratio, no scale control';
/** Face Enhance disabled-on-anime hint: GFPGAN is a no-op on the xinntao Anime variant. */
const ANIME_FACE_ENHANCE_HINT = 'Face enhance không áp dụng cho variant Anime';

export interface UpscaleTabApi {
  ParamsPanel: ReactNode;
  /** Always true when a version is selected (model + scale are always valid — hard allowlist + clamp). */
  canCommit: boolean;
  /** Resolves to the new permanent Storage URL + aiRequestId; throws EditApiError on API failure. */
  commit: (version: Illustration) => Promise<EditCommitResult>;
}

interface UseUpscaleTabOptions {
  selectedVersion: Illustration | null;
  /** AI-usage attribution (book snapshotId / remix remixId) forwarded into the upscale call. */
  attribution?: EditImageAttribution;
  /** Opt-in double-write directive (parent-resolved path). Undefined → payload omits it. */
  saveResource?: SaveResourceDirective;
}

export function useUpscaleTabState({ selectedVersion, attribution, saveResource }: UseUpscaleTabOptions): UpscaleTabApi {
  const [model, setModel] = useState<UpscaleModel>(DEFAULT_UPSCALE_MODEL);
  const [scale, setScale] = useState<number>(SCALE.default);
  const [faceEnhance, setFaceEnhance] = useState<boolean>(DEFAULT_FACE_ENHANCE);
  // Grain state — MODEL-AGNOSTIC: switching model NEVER touches these (no caps gate). Default ON.
  const [grainEnabled, setGrainEnabled] = useState<boolean>(DEFAULT_GRAIN_ENABLED);
  const [grainAmp, setGrainAmp] = useState<number>(GRAIN_AMP.default);
  const [grainBlur, setGrainBlur] = useState<number>(GRAIN_BLUR.default);

  // Per-model gate — switching model keeps scale/faceEnhance state, only flips disabled flags.
  const caps = useMemo(() => UPSCALE_MODEL_CAPS[model], [model]);

  // AMP/BLUR greyed (disabled, NOT hidden) when the Grain toggle is OFF. Pure derive — no
  // useEffect+setState (React 19 lints set-state-in-effect as an error); never read ref.current.
  const grainControlsDisabled = !grainEnabled;

  // Face Enhance disabled tooltip is model-specific: recraft has no field (RECRAFT_HINT);
  // xinntao's Anime variant makes GFPGAN a no-op (ANIME_FACE_ENHANCE_HINT).
  const faceEnhanceHint = model === 'xinntao/realesrgan' ? ANIME_FACE_ENHANCE_HINT : RECRAFT_HINT;

  const handleModelChange = useCallback((value: string) => {
    const next = value as UpscaleModel;
    log.debug('handleModelChange', 'upscale model selected', { model: next });
    setModel(next);
  }, []);

  const handleGrainToggle = useCallback((next: boolean) => {
    log.debug('handleGrainToggle', 'grain toggled', { grainEnabled: next });
    setGrainEnabled(next);
  }, []);

  const canCommit = !!selectedVersion;

  const commit = useCallback(
    async (version: Illustration): Promise<EditCommitResult> => {
      // Always build an explicit grain object — model-agnostic, even when toggle OFF
      // (API omit=off, but the FE never omits → send `{enabled:false,...}`).
      const grain = { enabled: grainEnabled, amp: grainAmp, blur: grainBlur };
      const payload = {
        ...buildUpscalePayload(model, scale, faceEnhance, version.media_url, grain),
        ...(attribution ?? {}), // book snapshotId / remix remixId (attribution-only)
        ...(saveResource ? { saveResource } : {}),
      };
      log.info('commit', 'upscale start', {
        imageUrl: version.media_url.slice(0, 60),
        model,
        scale,
        faceEnhance: payload.modelParams.params.faceEnhance,
        grainEnabled,
        grainAmp,
        grainBlur,
      });

      const res = await callImageUpscale(payload);
      if (!res.success || !res.data) {
        const failure = res as ImageApiFailure;
        log.warn('commit', 'upscale failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
        throw new EditApiError(failure.error ?? 'Upscale failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
      }

      log.info('commit', 'upscale success', {
        fixedRatio: res.meta?.fixedRatio,
        width: res.data.width,
        height: res.data.height,
        grainApplied: res.meta?.grainApplied,
      });
      return { imageUrl: res.data.imageUrl, aiRequestId: res.data.aiRequestId };
    },
    [model, scale, faceEnhance, grainEnabled, grainAmp, grainBlur, attribution, saveResource],
  );

  const ParamsPanel = useMemo<ReactNode>(
    () => (
      <div className="flex flex-col gap-5 px-4 py-4">
        <section>
          <p className={SECTION_LABEL_CLASS}>Model</p>
          <Select value={model} onValueChange={handleModelChange}>
            <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Upscale model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={SELECT_CONTENT_STYLE}>
              {UPSCALE_MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section>
          <div className="grid grid-cols-2 gap-3">
            {/* Scale — disabled for recraft (fixed-ratio native passthrough). */}
            <div
              className={caps.supportsScale ? undefined : 'opacity-40'}
              title={caps.supportsScale ? undefined : RECRAFT_HINT}
            >
              <p className={SECTION_LABEL_CLASS}>Scale</p>
              <NumberStepper
                value={scale}
                min={SCALE.min}
                max={SCALE.max}
                step={SCALE.step}
                onChange={setScale}
                disabled={!caps.supportsScale}
              />
            </div>

            {/* Face Enhance — disabled for recraft (no field) + xinntao (anime no-op).
                ⚡ default OFF (sent explicit). */}
            <div
              className={caps.supportsFaceEnhance ? undefined : 'opacity-40'}
              title={caps.supportsFaceEnhance ? undefined : faceEnhanceHint}
            >
              <p className={SECTION_LABEL_CLASS}>Face Enhance</p>
              <div className="flex items-center gap-2">
                <Switch
                  checked={faceEnhance}
                  onCheckedChange={setFaceEnhance}
                  disabled={!caps.supportsFaceEnhance}
                  aria-label="Face enhance"
                />
                <span className="text-[11px] font-medium text-[var(--swap-modal-text-muted)]">
                  {faceEnhance ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
          </div>

          {!caps.supportsScale && (
            <p className="mt-2 text-[11px] text-[var(--swap-modal-text-muted)]">{RECRAFT_HINT}</p>
          )}
        </section>

        {/* Grain post-process — MODEL-AGNOSTIC: NOT gated by UPSCALE_MODEL_CAPS, so the toggle
            stays enabled for every model (incl. recraft). AMP/BLUR are greyed (disabled, NOT
            hidden) only when the Grain toggle itself is OFF (memory: never hide disabled UI). */}
        <section>
          <div>
            <p className={SECTION_LABEL_CLASS}>Grain</p>
            <div className="flex items-center gap-2">
              <Switch
                checked={grainEnabled}
                onCheckedChange={handleGrainToggle}
                aria-label="Grain"
              />
              <span className="text-[11px] font-medium text-[var(--swap-modal-text-muted)]">
                {grainEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className={grainControlsDisabled ? 'opacity-40' : undefined}>
              <p className={SECTION_LABEL_CLASS}>Amp</p>
              <NumberStepper
                value={grainAmp}
                min={GRAIN_AMP.min}
                max={GRAIN_AMP.max}
                step={GRAIN_AMP.step}
                onChange={setGrainAmp}
                disabled={grainControlsDisabled}
              />
            </div>

            <div className={grainControlsDisabled ? 'opacity-40' : undefined}>
              <p className={SECTION_LABEL_CLASS}>Blur</p>
              <NumberStepper
                value={grainBlur}
                min={GRAIN_BLUR.min}
                max={GRAIN_BLUR.max}
                step={GRAIN_BLUR.step}
                onChange={setGrainBlur}
                disabled={grainControlsDisabled}
              />
            </div>
          </div>
        </section>
      </div>
    ),
    [
      model,
      scale,
      faceEnhance,
      caps,
      faceEnhanceHint,
      handleModelChange,
      grainEnabled,
      grainAmp,
      grainBlur,
      grainControlsDisabled,
      handleGrainToggle,
    ],
  );

  return { ParamsPanel, canCommit, commit };
}
