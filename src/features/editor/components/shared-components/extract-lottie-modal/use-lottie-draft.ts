// use-lottie-draft.ts — localStorage draft persistence for the Extract-Lottie modal
// (design README §6). Pure helpers (draftKey / saveDraft / loadDraft / clearDraft) are exported
// for unit tests; `useLottieDraft` debounces autosave and exposes restore()/clear(). Only the
// serializable subset is stored — asset URLs, never base64 (bounded quota).

import { useCallback, useEffect, useRef } from 'react';
import { createLogger } from '@/utils/logger';
import type { ExtractLottieModalState, LottieDraft } from './extract-lottie-modal-types';
import { LOTTIE_DRAFT_DEBOUNCE_MS, LOTTIE_DRAFT_KEY_PREFIX } from './extract-lottie-modal-constants';

const log = createLogger('Editor', 'ExtractLottieDraft');

export function draftKey(imageId: string): string {
  return `${LOTTIE_DRAFT_KEY_PREFIX}${imageId}`;
}

/** Persist the serializable draft subset. Silently no-ops on quota/serialize failure. */
export function saveDraft(imageId: string, draft: LottieDraft): boolean {
  try {
    localStorage.setItem(draftKey(imageId), JSON.stringify(draft));
    return true;
  } catch (err) {
    log.warn('saveDraft', 'failed', { err: String(err) });
    return false;
  }
}

/** Load + parse a draft. Corrupt/absent → null (never throws). */
export function loadDraft(imageId: string): LottieDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(imageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LottieDraft;
    if (parsed?.version !== 1 || !Array.isArray(parsed.parts)) return null;
    return parsed;
  } catch (err) {
    log.warn('loadDraft', 'parse failed', { err: String(err) });
    return null;
  }
}

export function clearDraft(imageId: string): void {
  try {
    localStorage.removeItem(draftKey(imageId));
  } catch (err) {
    log.warn('clearDraft', 'failed', { err: String(err) });
  }
}

interface UseLottieDraftArgs {
  imageId: string | null;
  state: ExtractLottieModalState;
  sourceUrl: string;
  /** Gate autosave to when the modal is open (avoids writing on unmount teardown). */
  enabled: boolean;
}

interface UseLottieDraftApi {
  restore: () => LottieDraft | null;
  clear: () => void;
}

/**
 * Debounced (500ms) autosave of the serializable subset whenever `parts.length > 0`.
 * Caller owns the restore decision (stale-source confirm) via `restore()`.
 */
export function useLottieDraft({
  imageId,
  state,
  sourceUrl,
  enabled,
}: UseLottieDraftArgs): UseLottieDraftApi {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !imageId) return;
    if (state.parts.length === 0) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const draft: LottieDraft = {
        version: 1,
        sourceUrl,
        parts: state.parts,
        activeTab: state.activeTab,
        activePartId: state.activePartId,
        savedAt: new Date().toISOString(),
      };
      saveDraft(imageId, draft);
    }, LOTTIE_DRAFT_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, imageId, sourceUrl, state.parts, state.activeTab, state.activePartId]);

  const restore = useCallback(() => (imageId ? loadDraft(imageId) : null), [imageId]);
  const clear = useCallback(() => {
    if (imageId) clearDraft(imageId);
  }, [imageId]);

  return { restore, clear };
}
