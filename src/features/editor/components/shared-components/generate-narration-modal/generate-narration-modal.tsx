// generate-narration-modal.tsx — Per-textbox narration modal (chunks shape).
// Spec: ai-storybook-design/component/editor-page/objects-creative-space/07-generate-narration-modal.md
// Phase 04 rewrite: orchestrates the chunks list + combined preview, delegates
// per-chunk render to NarrationChunkCard, drives Generate / Combine flows via
// useNarrationModalState. Bubbles full TextboxAudio to parent on every state
// change; flush on close gives parent a final draft to persist.

'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useInteractionLayer } from '@/features/editor/contexts';
import { createLogger } from '@/utils/logger';
import { useBookNarrator, useCurrentBook } from '@/stores/book-store';
import { useVoices } from '@/stores/voices-store';
import { useCharacters } from '@/stores/snapshot-store/selectors';
import type { TextboxAudio } from '@/types/spread-types';

import { NarrationChunkCard } from './components/narration-chunk-card';
import { CombinedFallback } from './components/combined-fallback';
import { CombinedPlayerRow } from './components/combined-player-row';
import { useNarrationModalState } from './use-narration-modal-state';
import {
  buildVoiceOptions,
  resolveNarratorVoiceId,
} from './helpers/build-voice-options';

const log = createLogger('Editor', 'GenerateNarrationModal');

// ── Props ───────────────────────────────────────────────────────────────────

export interface GenerateNarrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  textboxTitle?: string;
  textboxText: string;
  existingAudio: TextboxAudio | null;
  currentLanguage: string;
  /** Anchor context for opt-in save_resource — the spread + textbox this modal edits. */
  spreadId: string;
  textboxId: string;
  onAudioChange: (audio: TextboxAudio) => void;
}

// ── Component ───────────────────────────────────────────────────────────────

export function GenerateNarrationModal({
  isOpen,
  onClose,
  textboxTitle,
  textboxText,
  existingAudio,
  currentLanguage,
  spreadId,
  textboxId,
  onAudioChange,
}: GenerateNarrationModalProps) {
  const dialogContentRef = useRef<HTMLDivElement>(null);

  // ── Store data ──
  const book = useCurrentBook();
  const narrator = useBookNarrator();
  const voices = useVoices();
  const characters = useCharacters();

  const voicesById = useMemo(
    () => new Map(voices.map((v) => [v.id, v])),
    [voices],
  );

  const defaultNarratorVoiceId = useMemo(
    () =>
      resolveNarratorVoiceId(
        narrator,
        currentLanguage,
        book?.original_language ?? null,
      ),
    [narrator, currentLanguage, book?.original_language],
  );

  const voiceOptions = useMemo(
    () =>
      buildVoiceOptions({
        narrator,
        characters,
        voicesById,
        currentLanguage,
        originalLanguage: book?.original_language ?? null,
      }),
    [narrator, characters, voicesById, currentLanguage, book?.original_language],
  );

  // ── State hook (owns chunks + combined + handlers) ──
  const state = useNarrationModalState({
    isOpen,
    textboxText,
    existingAudio,
    defaultNarratorVoiceId,
    voicesById,
    onAudioChange,
    spreadId,
    textboxId,
    currentLanguage,
  });

  // ── Open/close logging ──
  useEffect(() => {
    if (!isOpen) return;
    log.info('open', 'modal opened', {
      currentLanguage,
      hasExistingAudio: existingAudio != null,
      // Optional chain on chunks too — legacy shape may have no `chunks` field;
      // adapter coerces inside the state hook, but this log runs on raw props.
      chunkCount: existingAudio?.chunks?.length ?? 0,
      textLength: textboxText.length,
    });
    return () => {
      log.info('close', 'modal closed');
    };
  }, [isOpen, currentLanguage, existingAudio, textboxText.length]);

  // ── Close handler ──
  // Draft state already bubbles via onAudioChange on every mutation — no extra
  // flush-on-close is needed.
  const handleClose = useCallback(() => {
    if (state.anyGenerating) {
      log.debug('handleClose', 'blocked while generating');
      toast.warning('Đang generate, vui lòng đợi…');
      return;
    }
    state.abortInFlight();
    onClose();
  }, [state, onClose]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) handleClose();
    },
    [handleClose],
  );

  // ── Interaction Layer registration ──
  useInteractionLayer(
    'modal',
    isOpen
      ? {
          id: 'generate-narration-modal',
          ref: dialogContentRef,
          hotkeys: ['Escape'],
          onHotkey: (key) => {
            if (key === 'Escape' && !state.anyGenerating) handleClose();
          },
          onClickOutside: () => {
            if (!state.anyGenerating) handleClose();
          },
          captureClickOutside: true,
          // Radix Select / Popover portals — guard against closing the modal
          // when a popover inside a chunk card opens. Re-selecting the same
          // value unmounts the portal synchronously, so pointerup lands on a
          // detached node — without dropdownSelectors snapshot the resolver
          // would mis-classify it as outside and close the modal.
          portalSelectors: [
            '[data-radix-popper-content-wrapper]',
            '[data-radix-select-content]',
            '[role="listbox"]',
          ],
          dropdownSelectors: [
            '[data-radix-select-content]',
            '[data-radix-popover-content]',
            '[data-radix-popper-content-wrapper]',
          ],
          // Force-pop bypasses anyGenerating guard intentionally: when a
          // higher-priority slot replaces us, the contract is to close —
          // AbortController stops the in-flight network call cleanly.
          onForcePop: () => {
            state.abortInFlight();
            onClose();
          },
        }
      : null,
  );

  // ── Generate wrapper: surface overlap rejection as toast ──
  const onGenerate = useCallback(
    async (clientId: string) => {
      log.info('onGenerate', 'request', { clientId });
      const result = await state.handleGenerateChunk(clientId);
      if (!result.ok && result.reason === 'overlap') {
        toast.warning('Đợi chunk hiện tại generate xong rồi thử lại.');
      }
    },
    [state],
  );

  // ── Refresh combined wrapper: surface error as toast ──
  const onRefresh = useCallback(async () => {
    log.info('onRefresh', 'request', { chunkCount: state.chunks.length });
    await state.handleRefreshCombined();
  }, [state]);

  // Surface combine errors via toast after they appear (one-shot per code).
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state.combinedError) {
      lastErrorRef.current = null;
      return;
    }
    if (lastErrorRef.current === state.combinedError) return;
    lastErrorRef.current = state.combinedError;
    toast.error('Combine audio thất bại — kiểm tra chi tiết bên dưới.');
  }, [state.combinedError]);

  // ── Render ──
  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={dialogContentRef}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="sm:max-w-[640px] max-h-[80vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{textboxTitle ?? 'Textbox'} - Narration</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          {/* Combined preview — player when URL exists, fallback otherwise. */}
          {state.combinedAudioUrl ? (
            <CombinedPlayerRow
              audioUrl={state.combinedAudioUrl}
              chunkCount={state.chunks.length}
              isMerging={state.isMergingCombined}
              refreshDisabled={!state.canCombine}
              isStale={!state.audioIsSync}
              autoPlayToken={state.combinedAutoPlayToken}
              onRefresh={onRefresh}
            />
          ) : (
            <CombinedFallback
              canCombine={state.canCombine}
              isMerging={state.isMergingCombined}
              error={state.combinedError}
              onRefresh={onRefresh}
            />
          )}

          {/* Chunk list */}
          <div className="flex flex-col gap-3">
            {state.chunks.map((chunk, idx) => (
              <NarrationChunkCard
                key={chunk.client_id}
                chunk={chunk}
                index={idx}
                totalChunks={state.chunks.length}
                voiceOptions={voiceOptions}
                voicesById={voicesById}
                currentLanguage={currentLanguage}
                onScriptChange={(s) => state.handleScriptChange(chunk.client_id, s)}
                onVoiceChange={(rk, v) =>
                  state.handleVoiceChange(chunk.client_id, rk, v)
                }
                onParamChange={(p) => state.handleParamChange(chunk.client_id, p)}
                onResetParams={() => state.handleResetParams(chunk.client_id)}
                onSelectResult={(i) => state.handleSelectResult(chunk.client_id, i)}
                onToggleExpanded={() => state.handleToggleExpanded(chunk.client_id)}
                onToggleAdvance={() => state.handleToggleAdvance(chunk.client_id)}
                onGenerate={() => {
                  void onGenerate(chunk.client_id);
                }}
              />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default GenerateNarrationModal;
