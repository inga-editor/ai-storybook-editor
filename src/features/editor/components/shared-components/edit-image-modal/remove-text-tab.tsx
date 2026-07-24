// remove-text-tab.tsx — Remove Text tab (design 06-remove-text-tab.md): AI removal of baked-in
// text/typography from the selected version. Simplest edit tab — the ParamsPanel is a single
// Model dropdown (no Edge Refinement / Output Background — those belong to Remove BG). The hook
// owns the model param and returns a Handle (ParamsPanel + canCommit + commit) the shell
// consumes. commit → callRemoveTextImage → a permanent Storage URL; the shell prepends it as a
// new `type='edited'` version. Mirrors remove-bg-tab; the endpoint takes a FLAT `model`.

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createLogger } from '@/utils/logger';
import { callRemoveTextImage, type RemoveTextImageResult } from '@/apis/retouch-api';
import type { ImageApiFailure } from '@/apis/image-api-client';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import {
  REMOVE_TEXT_MODEL_OPTIONS,
  DEFAULT_REMOVE_TEXT_MODEL,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
  Z_INDEX,
  type RemoveTextModel,
  type EditImageAttribution,
  type EditCommitResult,
} from './edit-image-modal-constants';
import { EditApiError } from './edit-image-modal-utils';

const log = createLogger('Editor', 'RemoveTextTab');

// Radix popper copies the content's computed z onto its portal wrapper — without this the
// dropdown (shadcn default z-50) paints behind the full-screen modal (z-4000). See memory.
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };
const DARK_TRIGGER_CLASS = `w-full ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`;
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';

export interface RemoveTextTabApi {
  ParamsPanel: ReactNode;
  /** Always true when a version is selected (model is always valid — hard-coded allowlist). */
  canCommit: boolean;
  /** Resolves to the new permanent Storage URL + aiRequestId; throws EditApiError on API failure. */
  commit: (version: Illustration) => Promise<EditCommitResult>;
}

interface UseRemoveTextTabOptions {
  selectedVersion: Illustration | null;
  /** AI-usage attribution (book snapshotId / remix remixId) forwarded into the remove-text call. */
  attribution?: EditImageAttribution;
  /** Opt-in double-write directive (parent-resolved path). Undefined → payload omits it. */
  saveResource?: SaveResourceDirective;
}

export function useRemoveTextTabState({ selectedVersion, attribution, saveResource }: UseRemoveTextTabOptions): RemoveTextTabApi {
  const [model, setModel] = useState<RemoveTextModel>(DEFAULT_REMOVE_TEXT_MODEL);

  const canCommit = !!selectedVersion;

  const commit = useCallback(
    async (version: Illustration): Promise<EditCommitResult> => {
      log.info('commit', 'remove text start', {
        imageUrl: version.media_url.slice(0, 60),
        model,
      });

      const res = await callRemoveTextImage({
        imageUrl: version.media_url,
        model,
        ...(attribution ?? {}),
        ...(saveResource ? { saveResource } : {}),
      });
      if (!res.success || !res.data) {
        const failure = res as ImageApiFailure;
        log.warn('commit', 'remove text failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
        throw new EditApiError(failure.error ?? 'Remove text failed', {
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
        });
      }

      const ok = res as RemoveTextImageResult;
      log.info('commit', 'remove text success', { processingMs: ok.meta?.processingTime });
      return { imageUrl: ok.data.imageUrl, aiRequestId: ok.data.aiRequestId };
    },
    [model, attribution, saveResource],
  );

  const ParamsPanel = useMemo<ReactNode>(
    () => (
      <div className="flex flex-col gap-5 px-4 py-4">
        <section>
          <p className={SECTION_LABEL_CLASS}>Model</p>
          <Select value={model} onValueChange={(v) => setModel(v as RemoveTextModel)}>
            <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Remove text model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={SELECT_CONTENT_STYLE}>
              {REMOVE_TEXT_MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>
      </div>
    ),
    [model],
  );

  return { ParamsPanel, canCommit, commit };
}
