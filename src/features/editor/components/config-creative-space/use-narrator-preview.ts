import { useCallback, useEffect, useRef, useState } from 'react';

import {
  callNarrateScript,
  type NarrateScriptErrorCode,
  type NarrateScriptSettings,
} from '@/apis/narrate-script-api';
import {
  DEFAULT_INFERENCE_PARAMS,
  PREVIEW_TEXTS,
} from '@/constants/config-constants';
import { useCurrentBook } from '@/stores/book-store';
import { useVoicesStore } from '@/stores/voices-store';
import type {
  NarratorInferenceParams,
  NarratorLanguageEntry,
  NarratorSettings,
} from '@/types/editor';
import { createLogger } from '@/utils/logger';

import { buildNextNarratorWithMediaUrl } from './narrator-helpers';
import { getNarratorErrorMessage } from './narrator-error-messages';

// ─────────────────────────────────────────────────────────────────────────────
// useNarratorPreview — orchestrates preview generation for narrator voice cards.
//
// Validation Session 1 rule: `requestPreview` ALWAYS fires the API — no cache
// short-circuit on existing media_url. Backend cache (SHA256 of script+settings)
// provides fast path when settings unchanged; FE never inspects cache state.
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger('Editor', 'NarratorPreview');

export interface NarratorPreviewError {
  langCode: string;
  code: NarrateScriptErrorCode | 'NO_VOICE' | 'VOICE_MISSING_ELEVEN_ID' | 'UNSUPPORTED_LANG';
  message: string;
}

export interface NarratorPreviewApi {
  playingLangCode: string | null;
  generatingLangCode: string | null;
  previewError: NarratorPreviewError | null;
  requestPreview: (langCode: string) => Promise<void>;
  setPlayingLang: (code: string | null) => void;
  stopPlayback: () => void;
  clearError: () => void;
}

/**
 * Build the `@{eleven_id}: {preview_text}` script passed to the narrate-script
 * endpoint. Returns null if language has no preview text configured.
 */
export function buildPreviewScript(
  elevenId: string,
  langCode: string,
): string | null {
  const previewText = PREVIEW_TEXTS[langCode];
  if (!previewText) return null;
  return `@${elevenId}: ${previewText}`;
}

/**
 * Map book narrator inference params → narrate-script API settings payload.
 * IMPORTANT: `speaker_boost` is a UI-only hint, NOT sent to the API per spec.
 */
function buildApiSettings(
  inference: NarratorInferenceParams,
): NarrateScriptSettings {
  return {
    stability: inference.stability,
    similarityBoost: inference.similarity,
    style: inference.exaggeration,
    speed: inference.speed,
    // seed: not exposed in UI yet → omit
    // speaker_boost: intentionally omitted (UI-only)
  };
}

/**
 * Resolve inference params from narrator settings, falling back to defaults
 * field-by-field when narrator is null or a field is missing/non-numeric.
 */
function resolveInferenceParams(
  narrator: NarratorSettings | null,
): NarratorInferenceParams {
  if (!narrator) return { ...DEFAULT_INFERENCE_PARAMS };
  return {
    speed:
      typeof narrator.speed === 'number'
        ? narrator.speed
        : DEFAULT_INFERENCE_PARAMS.speed,
    stability:
      typeof narrator.stability === 'number'
        ? narrator.stability
        : DEFAULT_INFERENCE_PARAMS.stability,
    similarity:
      typeof narrator.similarity === 'number'
        ? narrator.similarity
        : DEFAULT_INFERENCE_PARAMS.similarity,
    exaggeration:
      typeof narrator.exaggeration === 'number'
        ? narrator.exaggeration
        : DEFAULT_INFERENCE_PARAMS.exaggeration,
    speaker_boost:
      typeof narrator.speaker_boost === 'boolean'
        ? narrator.speaker_boost
        : DEFAULT_INFERENCE_PARAMS.speaker_boost,
  };
}

export interface UseNarratorPreviewOptions {
  /** Draft narrator params (voice_id + inference) — preview runs against these. */
  narrator: NarratorSettings | null;
  /** Cache the returned media_url into the section draft (persisted on Save). */
  onNarratorPatch: (recipe: (prev: NarratorSettings) => NarratorSettings) => void;
}

export function useNarratorPreview({
  narrator,
  onNarratorPatch,
}: UseNarratorPreviewOptions): NarratorPreviewApi {
  const book = useCurrentBook();

  const [playingLangCode, setPlayingLangCode] = useState<string | null>(null);
  const [generatingLangCode, setGeneratingLangCode] = useState<string | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<NarratorPreviewError | null>(
    null,
  );

  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight request on unmount.
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  const clearError = useCallback(() => {
    setPreviewError(null);
  }, []);

  const stopPlayback = useCallback(() => {
    log.debug('stopPlayback', 'clear playing lang');
    setPlayingLangCode(null);
  }, []);

  const setPlayingLang = useCallback((code: string | null) => {
    log.debug('setPlayingLang', 'set', { code });
    setPlayingLangCode(code);
  }, []);

  const requestPreview = useCallback(
    async (langCode: string): Promise<void> => {
      log.info('requestPreview', 'start', { langCode });

      if (!book) {
        log.warn('requestPreview', 'no current book');
        setPreviewError({
          langCode,
          code: 'VALIDATION_ERROR',
          message: getNarratorErrorMessage('VALIDATION_ERROR'),
        });
        return;
      }

      // Validate preview text exists for this language.
      if (!PREVIEW_TEXTS[langCode]) {
        log.warn('requestPreview', 'no preview text for lang', { langCode });
        setPreviewError({
          langCode,
          code: 'UNSUPPORTED_LANG',
          message: 'Ngôn ngữ này chưa có nội dung preview.',
        });
        return;
      }

      // Resolve language entry → voice_id.
      const entry = (narrator?.[langCode] ?? null) as
        | NarratorLanguageEntry
        | null;
      if (!entry || typeof entry !== 'object' || !entry.voice_id) {
        log.debug('requestPreview', 'no voice selected for lang', { langCode });
        setPreviewError({
          langCode,
          code: 'NO_VOICE',
          message: 'Chưa chọn giọng đọc cho ngôn ngữ này.',
        });
        return;
      }

      // Resolve voice → eleven_id (voices store is synchronous snapshot).
      const voices = useVoicesStore.getState().voices;
      const voice = voices.find((v) => v.id === entry.voice_id);
      if (!voice) {
        log.warn('requestPreview', 'voice not found in store', {
          voiceId: entry.voice_id,
        });
        setPreviewError({
          langCode,
          code: 'VALIDATION_ERROR',
          message: 'Không tìm thấy giọng đọc trong hệ thống.',
        });
        return;
      }
      if (!voice.elevenId) {
        log.warn('requestPreview', 'voice missing eleven_id', {
          voiceId: voice.id,
        });
        setPreviewError({
          langCode,
          code: 'VOICE_MISSING_ELEVEN_ID',
          message: 'Giọng đọc chưa có ID ElevenLabs, vui lòng chọn giọng khác.',
        });
        return;
      }

      const script = buildPreviewScript(voice.elevenId, langCode);
      if (!script) {
        // Defensive — already covered above but keeps type safety.
        setPreviewError({
          langCode,
          code: 'UNSUPPORTED_LANG',
          message: 'Ngôn ngữ này chưa có nội dung preview.',
        });
        return;
      }

      const inference = resolveInferenceParams(narrator);
      const settings = buildApiSettings(inference);

      // Abort any prior in-flight request (lang switch mid-flight).
      if (abortRef.current) {
        log.debug('requestPreview', 'aborting previous request');
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;

      setPreviewError(null);
      setGeneratingLangCode(langCode);

      try {
        const result = await callNarrateScript(
          {
            script,
            modelId: 'eleven_v3',
            settings,
            // Voice-config preview is book-level (not snapshot-bound) → attribute by bookId.
            bookId: book.id,
          },
          { signal: controller.signal },
        );

        // If this controller was superseded, ignore result.
        if (abortRef.current !== controller) {
          log.debug('requestPreview', 'stale result ignored', { langCode });
          return;
        }

        if (!result.success) {
          if (result.errorCode === 'ABORT') {
            log.info('requestPreview', 'aborted', { langCode });
            return;
          }
          log.error('requestPreview', 'api failure', {
            langCode,
            errorCode: result.errorCode,
            httpStatus: result.httpStatus,
          });
          setPreviewError({
            langCode,
            code: result.errorCode,
            message: getNarratorErrorMessage(result.errorCode),
          });
          return;
        }

        // Success path: persist media_url + auto-play.
        const audioUrl = result.data.audioUrl;
        log.info('requestPreview', 'success', {
          langCode,
          durationMs: result.data.durationMs,
        });

        // Cache media_url onto the LATEST draft (producer form) so a concurrent
        // inference edit made during the async call is not clobbered.
        onNarratorPatch((prev) => buildNextNarratorWithMediaUrl(prev, langCode, audioUrl));
        setPlayingLangCode(langCode);
      } catch (err) {
        // callNarrateScript handles known errors; this catches truly unexpected.
        log.error('requestPreview', 'unexpected error', {
          langCode,
          msg: err instanceof Error ? err.message.slice(0, 100) : String(err),
        });
        setPreviewError({
          langCode,
          code: 'UNKNOWN',
          message: getNarratorErrorMessage('UNKNOWN'),
        });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setGeneratingLangCode((cur) => (cur === langCode ? null : cur));
      }
    },
    [book, narrator, onNarratorPatch],
  );

  return {
    playingLangCode,
    generatingLangCode,
    previewError,
    requestPreview,
    setPlayingLang,
    stopPlayback,
    clearError,
  };
}
