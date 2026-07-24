// remove-bg-tab.tsx — Remove BG tab (design 01-remove-bg-tab.md): AI background removal of
// the selected version. The hook owns model + output-background params; it returns a Handle
// (ParamsPanel + canCommit + commit) the shell consumes. commit → callImageRemoveBg → a
// permanent Storage URL; the shell prepends it as a new `type='edited'` version.
// Edge Refinement + Output Background Blur/Overlay are deferred (rendered disabled — the API
// 04-image-remove-bg has no support yet).

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
import { createLogger } from '@/utils/logger';
import { callImageRemoveBg, type ImageRemoveBgResult } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import {
  RMBG_MODEL_OPTIONS,
  DEFAULT_RMBG_MODEL,
  DEFAULT_OUTPUT_BG,
  DEFAULT_OUTPUT_COLOR,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
  Z_INDEX,
  type RmbgModel,
  type OutputBgMode,
  type EditImageAttribution,
  type EditCommitResult,
} from './edit-image-modal-constants';
import { EditApiError } from './edit-image-modal-utils';

const log = createLogger('Editor', 'RemoveBgTab');

// Radix popper copies the content's computed z onto its portal wrapper — without this the
// dropdown (shadcn default z-50) paints behind the full-screen modal (z-4000). See memory.
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };
const DARK_TRIGGER_CLASS = `w-full ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`;
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';

export interface RemoveBgTabApi {
  ParamsPanel: ReactNode;
  /** Always true when a version is selected (model is always valid — hard-coded allowlist). */
  canCommit: boolean;
  /** Resolves to the new permanent Storage URL + aiRequestId; throws EditApiError on API failure. */
  commit: (version: Illustration) => Promise<EditCommitResult>;
}

interface UseRemoveBgTabOptions {
  selectedVersion: Illustration | null;
  /** AI-usage attribution (book snapshotId / remix remixId) forwarded into the remove-bg call. */
  attribution?: EditImageAttribution;
  /** Opt-in double-write directive (parent-resolved path). Undefined → payload omits it. */
  saveResource?: SaveResourceDirective;
}

export function useRemoveBgTabState({ selectedVersion, attribution, saveResource }: UseRemoveBgTabOptions): RemoveBgTabApi {
  const [model, setModel] = useState<RmbgModel>(DEFAULT_RMBG_MODEL);
  const [outputBg, setOutputBg] = useState<OutputBgMode>(DEFAULT_OUTPUT_BG);
  const [color, setColor] = useState(DEFAULT_OUTPUT_COLOR);

  const canCommit = !!selectedVersion;

  const commit = useCallback(
    async (version: Illustration): Promise<EditCommitResult> => {
      // backgroundColor: color → flatten onto solid; transparent → null (RGBA). blur/overlay
      // can't reach here (those options are disabled while deferred).
      const backgroundColor = outputBg === 'color' ? color : null;
      log.info('commit', 'remove bg start', {
        imageUrl: version.media_url.slice(0, 60),
        model,
        outputBg,
      });

      const res = await callImageRemoveBg({
        imageUrl: version.media_url,
        model,
        backgroundColor,
        ...(attribution ?? {}),
        ...(saveResource ? { saveResource } : {}),
      });
      if (!res.success || !res.data) {
        const failure = res as ImageApiFailure;
        log.warn('commit', 'remove bg failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
        throw new EditApiError(failure.error ?? 'Remove background failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
      }

      const ok = res as ImageRemoveBgResult;
      log.info('commit', 'remove bg success', { processingMs: ok.meta?.processingTime });
      return { imageUrl: ok.data!.imageUrl, aiRequestId: ok.data!.aiRequestId };
    },
    [model, outputBg, color, attribution, saveResource],
  );

  const ParamsPanel = useMemo<ReactNode>(
    () => (
      <div className="flex flex-col gap-5 px-4 py-4">
        <section>
          <p className={SECTION_LABEL_CLASS}>Model</p>
          <Select value={model} onValueChange={(v) => setModel(v as RmbgModel)}>
            <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Remove background model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={SELECT_CONTENT_STYLE}>
              {RMBG_MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        {/* ⏳ Defer — API has no edge-refinement param (01 §4). Disabled + tooltip. */}
        <section title="Coming soon" aria-disabled="true" className="opacity-40">
          <p className={SECTION_LABEL_CLASS}>
            <span>Edge Refinement</span>
            <span className="normal-case">⏳ Coming soon</span>
          </p>
          <div className="flex items-center gap-2 text-[11px] text-[var(--swap-modal-text-muted)]">
            <span>SOFT</span>
            <Slider value={[50]} min={0} max={100} step={1} disabled className="flex-1" />
            <span>HARD</span>
          </div>
        </section>

        <section>
          <p className={SECTION_LABEL_CLASS}>Output Background</p>
          <div className="flex items-center gap-2">
            <Select value={outputBg} onValueChange={(v) => setOutputBg(v as OutputBgMode)}>
              <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Output background mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={SELECT_CONTENT_STYLE}>
                <SelectItem value="transparent">Transparent</SelectItem>
                <SelectItem value="color">Color</SelectItem>
                {/* ⏳ Defer — API flattens solid color only (01 §4). */}
                <SelectItem value="blur" disabled>
                  Blur (coming soon)
                </SelectItem>
                <SelectItem value="overlay" disabled>
                  Overlay (coming soon)
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Color picker enabled only when outputBg === 'color' (01 §Color picker gating). */}
            <label
              className={`flex items-center gap-1.5 rounded-md border border-[var(--swap-modal-border-strong)] px-2 py-1.5 ${
                outputBg === 'color' ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
              }`}
              title={outputBg === 'color' ? 'Pick background color' : 'Select Color mode to enable'}
            >
              <span
                className="h-4 w-4 rounded-sm border border-[var(--swap-modal-border-strong)]"
                style={{ backgroundColor: color }}
              />
              <span className="font-mono text-xs text-[var(--swap-modal-text-primary)]">{color}</span>
              <input
                type="color"
                value={color}
                disabled={outputBg !== 'color'}
                onChange={(e) => {
                  setColor(e.target.value);
                  log.debug('ParamsPanel', 'color change', { color: e.target.value });
                }}
                className="sr-only"
                aria-label="Background color"
              />
            </label>
          </div>
        </section>
      </div>
    ),
    [model, outputBg, color],
  );

  return { ParamsPanel, canCommit, commit };
}
