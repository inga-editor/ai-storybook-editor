// use-parametric-value-upload.ts — The `[⬆]` manual-upload flow of the Visuals tab
// (01-visuals-tab.md §3.2), split out of use-visuals-tab.ts for the 500-LOC budget.
//
// Same two invariants as the generate flow, on purpose:
//  • ENSURE-THEN-UPLOAD — the `values[]` entry is created and the client persist AWAITED first, so
//    an upload never lands on an entry the server has never seen. A rejection aborts the upload.
//  • STALE-GUARD — `bumpRunId()` before the first await, re-checked in then / catch / finally, so
//    a slow upload that resolves after the modal closed (or the item changed) is swallowed.
// No AI call here — this path never touches the image API.

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadImageToStorage } from '@/apis/storage-api';
import type { Illustration } from '@/types/prop-types';
import { createLogger } from '@/utils/logger';
import type { ParametricDisableReason } from './parametric-slot-modal-constants';
import {
  PARAMETRIC_ENSURE_ENTRY_ERROR,
  PARAMETRIC_UPLOAD_FAILED,
  PARAMETRIC_UPLOAD_MAX_BYTES,
  PARAMETRIC_UPLOAD_REJECTED,
  PARAMETRIC_UPLOAD_TYPES,
  slugifyParametricValue,
} from './parametric-generate-utils';

const log = createLogger('Editor', 'ParametricValueUpload');

export interface UseParametricValueUploadArgs {
  itemId: string;
  /** Value the upload belongs to (the tab's current selection). */
  value: string;
  /** Storage folder prefix, e.g. `parametric/<itemId>`. */
  pathPrefix: string;
  /** Non-null ⇒ the button is disabled; clicking is refused here too (defence in depth). */
  disabledReason: ParametricDisableReason | null;
  readRunId: () => number;
  bumpRunId: () => number;
  onEnsureValueEntry: (value: string) => Promise<void>;
  onPrependIllustration: (value: string, illustration: Illustration) => void;
  setBusy: (busy: boolean) => void;
}

export interface ParametricValueUpload {
  isUploading: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onUploadClick: () => void;
  onFileSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function useParametricValueUpload({
  itemId,
  value,
  pathPrefix,
  disabledReason,
  readRunId,
  bumpRunId,
  onEnsureValueEntry,
  onPrependIllustration,
  setBusy,
}: UseParametricValueUploadArgs): ParametricValueUpload {
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // `isUploading` is checked HERE rather than folded into `disabledReason` — the caller cannot
  // feed it back in without a dependency cycle (it owns the reason, this hook owns the flag).
  const onUploadClick = useCallback(() => {
    if (disabledReason || isUploading) {
      log.debug('onUploadClick', 'blocked', {
        reason: disabledReason ?? 'busy',
        value,
      });
      return;
    }
    inputRef.current?.click();
  }, [disabledReason, isUploading, value]);

  const onFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset immediately so re-picking the SAME file still fires `change`.
      e.target.value = '';
      if (!file) return;
      // Client-side gate is UX only — the storage helper validates again server-side.
      if (!PARAMETRIC_UPLOAD_TYPES.includes(file.type) || file.size > PARAMETRIC_UPLOAD_MAX_BYTES) {
        log.debug('onFileSelected', 'rejected by client gate', {
          type: file.type,
          size: file.size,
        });
        toast.error(PARAMETRIC_UPLOAD_REJECTED);
        return;
      }

      const runId = bumpRunId();
      setIsUploading(true);
      setBusy(true);
      log.info('onFileSelected', 'upload start', { itemId, value, size: file.size });

      let ensureFailed = false;
      void (async () => {
        try {
          try {
            await onEnsureValueEntry(value);
          } catch (err) {
            ensureFailed = true;
            throw err;
          }
          const { publicUrl } = await uploadImageToStorage(
            file,
            `${pathPrefix}/${slugifyParametricValue(value)}`,
          );
          if (runId !== readRunId()) {
            log.warn('onFileSelected', 'stale upload result swallowed', {
              runId,
              currentRunId: readRunId(),
            });
            return;
          }
          onPrependIllustration(value, {
            type: 'uploaded',
            media_url: publicUrl,
            created_time: new Date().toISOString(),
            is_selected: true,
          });
          log.info('onFileSelected', 'upload done', { itemId, value });
        } catch (err) {
          if (runId !== readRunId()) return;
          log.error('onFileSelected', 'upload failed', {
            itemId,
            value,
            ensureFailed,
            error: err instanceof Error ? err.message : String(err),
          });
          toast.error(ensureFailed ? PARAMETRIC_ENSURE_ENTRY_ERROR : PARAMETRIC_UPLOAD_FAILED);
        } finally {
          if (runId === readRunId()) {
            setIsUploading(false);
            setBusy(false);
          }
        }
      })();
    },
    [
      bumpRunId,
      readRunId,
      itemId,
      value,
      pathPrefix,
      setBusy,
      onEnsureValueEntry,
      onPrependIllustration,
    ],
  );

  return { isUploading, inputRef, onUploadClick, onFileSelected };
}
