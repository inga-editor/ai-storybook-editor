// use-narration-modal-state.ts — Owns the GenerateNarrationModal working state
// (chunks + combined fields) and exposes a single API surface to the modal
// component. API orchestration delegated to runGenerateChunk / runCombineChunks
// so this file stays under the 500-LOC budget.

import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/utils/logger';
import { NARRATOR_KEY } from '@/apis/text-api';
import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  DEFAULT_CHUNK_INFERENCE_PARAMS,
  coerceTextboxAudio,
} from '@/types/textbox-audio-adapter';
import type {
  TextboxAudio,
  WordTiming,
} from '@/types/spread-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import type { Voice } from '@/types/voice';

import type {
  ChunkDraft,
  InferenceParams,
} from './components/chunk-types';
import { buildTextboxAudio } from './helpers/build-textbox-audio';
import { runGenerateChunk } from './helpers/run-generate-chunk';
import { runCombineChunks } from './helpers/run-combine-chunks';

const log = createLogger('Editor', 'useNarrationModalState');

// ── Types ───────────────────────────────────────────────────────────────────

export type GenerateOverlapResult =
  | { ok: true }
  | { ok: false; reason: 'overlap' | 'invalid' };

export interface UseNarrationModalStateParams {
  isOpen: boolean;
  textboxText: string;
  existingAudio: TextboxAudio | null;
  defaultNarratorVoiceId: string | null;
  voicesById: Map<string, Voice>;
  onAudioChange: (audio: TextboxAudio) => void;
  /** Anchor context for opt-in save_resource — the spread + textbox this modal edits. */
  spreadId: string;
  textboxId: string;
  /** BCP-ish locale key (`en_US`) — the textbox language content currently edited. */
  currentLanguage: string;
}

export interface UseNarrationModalStateReturn {
  chunks: ChunkDraft[];
  combinedAudioUrl: string | null;
  combinedWordTimings: WordTiming[];
  /** Monotonic token bumped after each successful Combine — feeds player autoplay. */
  combinedAutoPlayToken: number;
  /** Rollup sync flag — derived from chunks (every chunk script_synced && params_synced). */
  audioIsSync: boolean;
  isMergingCombined: boolean;
  combinedError: string | null;
  anyGenerating: boolean;
  canCombine: boolean;
  handleScriptChange: (clientId: string, next: string) => void;
  handleVoiceChange: (clientId: string, readerKey: string, voiceId: string) => void;
  handleParamChange: (clientId: string, partial: Partial<InferenceParams>) => void;
  handleResetParams: (clientId: string) => void;
  handleSelectResult: (clientId: string, originalIdx: number) => void;
  handleToggleExpanded: (clientId: string) => void;
  handleToggleAdvance: (clientId: string) => void;
  handleGenerateChunk: (clientId: string) => Promise<GenerateOverlapResult>;
  handleRefreshCombined: () => Promise<void>;
  abortInFlight: () => void;
}

// ── Local helpers ───────────────────────────────────────────────────────────

function makeClientId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `chunk-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Full snapshot anchor down to the per-locale textbox audio object. Empty context ⇒ null
 *  (opt-out — client omits the field, client persist still lands via BE-first bubble). */
function buildTextboxLocaleRoot(
  snapshotId: string,
  spreadId: string,
  textboxId: string,
  lang: string,
): string | null {
  if (!snapshotId || !spreadId || !textboxId || !lang) return null;
  return `table:snapshots/id:${snapshotId}/col:illustration/spread:${spreadId}/key:textboxes/find:id=${textboxId}/locale:${lang}`;
}

function buildSeedDraft(voiceId: string | null, scriptSeed: string): ChunkDraft {
  return {
    voice_id: voiceId ?? '',
    // Seed defaults to narrator since defaultNarratorVoiceId drives the voice.
    // Keeps picker trigger label coherent with seeded voice on first open.
    reader_key: voiceId ? NARRATOR_KEY : undefined,
    script: scriptSeed,
    ...DEFAULT_CHUNK_INFERENCE_PARAMS,
    script_synced: false,
    params_synced: false,
    results: [],
    client_id: makeClientId(),
    ui: {
      isExpanded: true,
      isAdvanceOpen: false,
      isGenerating: false,
      error: null,
    },
  };
}

function draftFromPersisted(
  chunk: TextboxAudio['chunks'][number],
  index: number,
): ChunkDraft {
  return {
    voice_id: chunk.voice_id,
    reader_key: chunk.reader_key,
    script: chunk.script,
    stability: chunk.stability,
    similarity: chunk.similarity,
    exaggeration: chunk.exaggeration,
    speed: chunk.speed,
    script_synced: chunk.script_synced,
    params_synced: chunk.params_synced,
    results: chunk.results,
    client_id: makeClientId(),
    ui: {
      isExpanded: index === 0,
      isAdvanceOpen: false,
      isGenerating: false,
      error: null,
    },
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useNarrationModalState(
  params: UseNarrationModalStateParams,
): UseNarrationModalStateReturn {
  const {
    isOpen,
    textboxText,
    existingAudio,
    defaultNarratorVoiceId,
    voicesById,
    onAudioChange,
    spreadId,
    textboxId,
    currentLanguage,
  } = params;

  const [chunks, setChunks] = useState<ChunkDraft[]>([]);
  const [combinedAudioUrl, setCombinedAudioUrl] = useState<string | null>(null);
  const [combinedWordTimings, setCombinedWordTimings] = useState<WordTiming[]>(
    [],
  );
  const [isMergingCombined, setIsMergingCombined] = useState(false);
  const [combinedError, setCombinedError] = useState<string | null>(null);
  /**
   * True when the current chunk selection diverges from the cached
   * `combinedAudioUrl` — set by `handleSelectResult` when re-picking a prior
   * result, cleared by `handleRefreshCombined` / `handleGenerateChunk` /
   * modal reopen. Used to compute rollup `is_sync` without flipping per-chunk
   * sync flags (which would imply "regen needed" and gate the Combine button).
   */
  const [combinedSelectionDirty, setCombinedSelectionDirty] = useState(false);
  /** Bumped after a successful Combine to trigger autoplay on the player. */
  const [combinedAutoPlayToken, setCombinedAutoPlayToken] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  /** Latest snapshot mirror — read inside async handlers without stale closure. */
  const chunksRef = useRef<ChunkDraft[]>(chunks);
  chunksRef.current = chunks;
  /** Skip bubble effect on the very first reset commit. */
  const initRef = useRef(false);
  /**
   * Latest `onAudioChange` mirror. Parent recreates this callback on every
   * render (see ObjectsTextToolbar → buildTextToolbarContext), so depending on
   * it directly in the bubble effect produces "Maximum update depth exceeded":
   *   chunks change → bubble → parent setState → new onAudioChange ref →
   *   bubble re-fires → setState → … (infinite).
   * Mirror via ref so the bubble effect depends only on real state.
   */
  const onAudioChangeRef = useRef(onAudioChange);
  onAudioChangeRef.current = onAudioChange;
  /** Skip bubble when the produced TextboxAudio is value-equal to the previous one. */
  const lastBubbledRef = useRef<string | null>(null);

  // ── Pre-fill on open ──
  useEffect(() => {
    if (!isOpen) return;
    initRef.current = false;

    const audio = coerceTextboxAudio(existingAudio);
    if (audio && Array.isArray(audio.chunks) && audio.chunks.length > 0) {
      const drafts = audio.chunks.map((c, i) => draftFromPersisted(c, i));
      setChunks(drafts);
      setCombinedAudioUrl(audio.combined_audio_url ?? null);
      setCombinedWordTimings(audio.word_timings ?? []);
      // Reconcile dirty bit: persisted `is_sync=false` while chunks all synced
      // ⇒ the gap is the combined-selection-dirty marker. Preserve it so the
      // Stale badge survives modal reopen.
      const chunksSynced = drafts.every(
        (c) => c.script_synced && c.params_synced,
      );
      const dirty =
        chunksSynced &&
        audio.combined_audio_url != null &&
        audio.is_sync === false;
      setCombinedSelectionDirty(dirty);
      log.info('open', 'pre-fill from existing audio', {
        chunkCount: drafts.length,
        hasCombined: audio.combined_audio_url != null,
        isSync: audio.is_sync,
        rehydratedSelectionDirty: dirty,
      });
    } else {
      const seed = buildSeedDraft(defaultNarratorVoiceId, textboxText.trim());
      setChunks([seed]);
      setCombinedAudioUrl(null);
      setCombinedWordTimings([]);
      setCombinedSelectionDirty(false);
      log.info('open', 'seed default chunk', {
        hasNarratorVoice: defaultNarratorVoiceId != null,
        scriptLength: textboxText.trim().length,
      });
    }
    setCombinedError(null);

    const handle = setTimeout(() => {
      initRef.current = true;
    }, 0);
    return () => clearTimeout(handle);
    // Re-prefill only on open flip — external prop changes should not clobber edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ── Bubble lên parent ──
  // NOTE: `onAudioChange` deliberately NOT in deps — it's accessed via ref to
  // avoid an infinite update loop when the parent recreates the callback on
  // every render. See onAudioChangeRef declaration above.
  useEffect(() => {
    if (!isOpen || !initRef.current) return;
    const next = buildTextboxAudio(
      chunks,
      combinedAudioUrl,
      combinedWordTimings,
      combinedSelectionDirty,
    );
    const serialized = JSON.stringify(next);
    if (serialized === lastBubbledRef.current) return;
    lastBubbledRef.current = serialized;
    onAudioChangeRef.current(next);
  }, [
    isOpen,
    chunks,
    combinedAudioUrl,
    combinedWordTimings,
    combinedSelectionDirty,
  ]);

  // Reset the dedupe key when the modal closes so the next open re-bubbles.
  useEffect(() => {
    if (!isOpen) lastBubbledRef.current = null;
  }, [isOpen]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // ── Helpers ──
  const updateChunk = useCallback(
    (clientId: string, fn: (c: ChunkDraft) => ChunkDraft) => {
      setChunks((prev) =>
        prev.map((c) => (c.client_id === clientId ? fn(c) : c)),
      );
    },
    [],
  );

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      log.debug('abortInFlight', 'aborted pending request');
    }
  }, []);

  // ── Mutators ──
  // Sync flag matrix (DB-CHANGELOG 2026-04-29):
  //   script/voice change → flip script_synced=false only
  //   inference param/reset → flip params_synced=false only
  //   select result → no per-chunk flag change; preserve combined URL but
  //     mark `combinedSelectionDirty=true` so rollup is_sync goes false until
  //     user re-runs Combine. User may just want to A/B-listen without
  //     forcing a recombine.
  const handleScriptChange = useCallback(
    (clientId: string, next: string) => {
      log.debug('handleScriptChange', 'mutate', {
        clientId,
        length: next.length,
      });
      updateChunk(clientId, (c) => ({
        ...c,
        script: next,
        script_synced: false,
      }));
    },
    [updateChunk],
  );

  const handleVoiceChange = useCallback(
    (clientId: string, readerKey: string, voiceId: string) => {
      log.debug('handleVoiceChange', 'mutate', { clientId, readerKey, voiceId });
      updateChunk(clientId, (c) => ({
        ...c,
        voice_id: voiceId,
        reader_key: readerKey,
        script_synced: false,
      }));
    },
    [updateChunk],
  );

  const handleParamChange = useCallback(
    (clientId: string, partial: Partial<InferenceParams>) => {
      log.debug('handleParamChange', 'mutate', {
        clientId,
        keys: Object.keys(partial),
      });
      updateChunk(clientId, (c) => ({
        ...c,
        ...partial,
        params_synced: false,
      }));
    },
    [updateChunk],
  );

  const handleResetParams = useCallback(
    (clientId: string) => {
      log.debug('handleResetParams', 'mutate', { clientId });
      updateChunk(clientId, (c) => ({
        ...c,
        ...DEFAULT_CHUNK_INFERENCE_PARAMS,
        params_synced: false,
      }));
    },
    [updateChunk],
  );

  const handleSelectResult = useCallback(
    (clientId: string, originalIdx: number) => {
      // Skip when re-clicking the already-selected result — avoids spurious
      // combined invalidation + Stale badge flash.
      const chunk = chunksRef.current.find((c) => c.client_id === clientId);
      if (chunk?.results[originalIdx]?.is_selected) return;
      log.debug('handleSelectResult', 'mutate', { clientId, originalIdx });
      updateChunk(clientId, (c) => ({
        ...c,
        results: c.results.map((r, i) => ({
          ...r,
          is_selected: i === originalIdx,
        })),
        ui: {
          ...c.ui,
          autoPlayToken: (c.ui.autoPlayToken ?? 0) + 1,
        },
      }));
      // Preserve combinedAudioUrl/word_timings — user may just want to listen
      // to the prior result. Mark dirty so rollup is_sync flips to false until
      // a fresh Combine run replaces the cached URL.
      setCombinedSelectionDirty(true);
    },
    [updateChunk],
  );

  // Accordion behaviour — opening a chunk collapses every other chunk.
  // Toggling the already-open chunk still closes it (no chunk expanded).
  const handleToggleExpanded = useCallback((clientId: string) => {
    setChunks((prev) => {
      const target = prev.find((c) => c.client_id === clientId);
      if (!target) return prev;
      const willOpen = !target.ui.isExpanded;
      return prev.map((c) => ({
        ...c,
        ui: {
          ...c.ui,
          isExpanded: c.client_id === clientId ? willOpen : false,
        },
      }));
    });
  }, []);

  const handleToggleAdvance = useCallback(
    (clientId: string) => {
      updateChunk(clientId, (c) => ({
        ...c,
        ui: { ...c.ui, isAdvanceOpen: !c.ui.isAdvanceOpen },
      }));
    },
    [updateChunk],
  );

  // ── Generate ──
  const handleGenerateChunk = useCallback(
    async (clientId: string): Promise<GenerateOverlapResult> => {
      const snapshot = chunksRef.current;
      if (snapshot.some((c) => c.ui.isGenerating)) {
        log.warn('handleGenerateChunk', 'overlap rejected', { clientId });
        return { ok: false, reason: 'overlap' };
      }
      const target = snapshot.find((c) => c.client_id === clientId);
      if (!target) return { ok: false, reason: 'invalid' };

      // Mark generating + clear prior error.
      updateChunk(clientId, (c) => ({
        ...c,
        ui: { ...c.ui, isGenerating: true, error: null },
      }));

      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      log.info('handleGenerateChunk', 'start', {
        clientId,
        scriptLength: target.script.length,
      });

      // chunkIdx = position in the same chunks[] the modal renders — maps 1:1 to the
      // persisted audio.chunks[] slot the BE writes at (draftFromPersisted preserves order).
      const chunkIdx = snapshot.findIndex((c) => c.client_id === clientId);
      const snapshotId = useSnapshotStore.getState().meta.id || '';
      const localeRoot = buildTextboxLocaleRoot(
        snapshotId,
        spreadId,
        textboxId,
        currentLanguage,
      );
      const saveResource: SaveResourceDirective | undefined =
        localeRoot && chunkIdx >= 0
          ? {
              type: 'textbox_audio_chunk',
              path: `${localeRoot}/key:audio/key:chunks/idx:${chunkIdx}`,
            }
          : undefined;

      const outcome = await runGenerateChunk({
        chunk: target,
        voicesById,
        signal: controller.signal,
        // Attribution-only — spread narration is book-scoped (empty/absent → omit).
        snapshotId: snapshotId || undefined,
        saveResource,
      });

      if (abortRef.current === controller) abortRef.current = null;

      if (!outcome.ok) {
        log.warn('handleGenerateChunk', 'failed', {
          clientId,
          reason: outcome.reason,
          errorCode: outcome.errorCode,
        });
        updateChunk(clientId, (c) => ({
          ...c,
          ui: {
            ...c.ui,
            isGenerating: false,
            error: outcome.errorCode
              ? { errorCode: outcome.errorCode }
              : null,
          },
        }));
        return { ok: false, reason: 'invalid' };
      }

      log.info('handleGenerateChunk', 'success', {
        clientId,
        resetSyncFlags: true,
      });
      updateChunk(clientId, (c) => ({
        ...c,
        script_synced: true,
        params_synced: true,
        results: [
          ...c.results.map((r) => ({ ...r, is_selected: false })),
          outcome.result,
        ],
        ui: {
          ...c.ui,
          isGenerating: false,
          error: null,
          autoPlayToken: (c.ui.autoPlayToken ?? 0) + 1,
        },
      }));
      // Preserve combined_audio_url — same rationale as handleSelectResult.
      // Newly generated result auto-selects, so combined diverges from the
      // current selection until user re-runs Combine. Mark dirty (no-op when
      // no combined exists yet — guarded by checking current url).
      setCombinedSelectionDirty((prev) => prev || combinedAudioUrl != null);
      setCombinedError(null);
      return { ok: true };
    },
    [
      voicesById,
      updateChunk,
      combinedAudioUrl,
      spreadId,
      textboxId,
      currentLanguage,
    ],
  );

  // ── Refresh combined ──
  const handleRefreshCombined = useCallback(async () => {
    const snapshot = chunksRef.current;
    // Allow combine whenever every chunk has at least one selected result —
    // even if script_synced is false. Stale state already surfaces via the
    // "Out of sync" badge; user explicitly opts in by clicking Combine.
    const ready =
      snapshot.length > 0 && snapshot.every((c) => c.results.length > 0);
    if (!ready || isMergingCombined) {
      log.debug('handleRefreshCombined', 'guard', {
        ready,
        isMergingCombined,
      });
      return;
    }

    const selected = snapshot.map(
      (c) => c.results.find((r) => r.is_selected) ?? null,
    );
    if (selected.some((r) => r == null)) {
      setCombinedError('CHUNKS_NOT_READY');
      log.warn('handleRefreshCombined', 'invariant: missing selection');
      return;
    }
    setCombinedError(null);

    // 1-chunk shortcut
    if (snapshot.length === 1) {
      const only = selected[0]!;
      log.info('handleRefreshCombined', 'shortcut single chunk');
      setCombinedAudioUrl(only.url);
      setCombinedWordTimings(only.word_timings);
      setCombinedSelectionDirty(false);
      setCombinedAutoPlayToken((t) => t + 1);
      return;
    }

    setIsMergingCombined(true);
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    log.info('handleRefreshCombined', 'combine api start', {
      chunkCount: snapshot.length,
    });

    // Combine directive anchors at the locale (no idx). Only reachable on the
    // >=2-chunk path — the 1-chunk shortcut returned above and sends NO directive.
    const snapshotId = useSnapshotStore.getState().meta.id || '';
    const localeRoot = buildTextboxLocaleRoot(
      snapshotId,
      spreadId,
      textboxId,
      currentLanguage,
    );
    const saveResource: SaveResourceDirective | undefined = localeRoot
      ? { type: 'textbox_combined_audio', path: localeRoot }
      : undefined;

    const outcome = await runCombineChunks({
      chunks: snapshot,
      signal: controller.signal,
      saveResource,
    });
    if (abortRef.current === controller) abortRef.current = null;
    setIsMergingCombined(false);

    if (!outcome.ok) {
      if (outcome.reason === 'aborted') {
        log.info('handleRefreshCombined', 'aborted');
        return;
      }
      log.warn('handleRefreshCombined', 'api failure', {
        errorCode: outcome.errorCode,
      });
      setCombinedError(outcome.errorCode ?? 'UNKNOWN');
      return;
    }

    log.info('handleRefreshCombined', 'combine api success');
    setCombinedAudioUrl(outcome.audioUrl);
    setCombinedWordTimings(outcome.words);
    setCombinedSelectionDirty(false);
    setCombinedAutoPlayToken((t) => t + 1);
  }, [isMergingCombined, spreadId, textboxId, currentLanguage]);

  // ── Derived ──
  const anyGenerating = chunks.some((c) => c.ui.isGenerating);
  // canCombine intentionally does NOT require script_synced — Stale state is
  // surfaced via the badge; combining stale chunks is a valid user choice.
  const canCombine =
    chunks.length > 0 && chunks.every((c) => c.results.length > 0);
  const audioIsSync =
    chunks.length > 0 &&
    chunks.every((c) => c.script_synced && c.params_synced) &&
    !combinedSelectionDirty;

  return {
    chunks,
    combinedAudioUrl,
    combinedWordTimings,
    combinedAutoPlayToken,
    audioIsSync,
    isMergingCombined,
    combinedError,
    anyGenerating,
    canCombine,
    handleScriptChange,
    handleVoiceChange,
    handleParamChange,
    handleResetParams,
    handleSelectResult,
    handleToggleExpanded,
    handleToggleAdvance,
    handleGenerateChunk,
    handleRefreshCombined,
    abortInFlight,
  };
}
