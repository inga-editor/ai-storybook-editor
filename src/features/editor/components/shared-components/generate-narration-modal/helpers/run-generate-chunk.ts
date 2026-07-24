// run-generate-chunk.ts — Pure orchestration for the per-chunk Generate flow.
// Extracted from use-narration-modal-state.ts to keep that file under the
// 500-LOC budget. Receives the in-flight chunk + dependencies as a plain
// object; returns either a successful API result + new TextboxAudioResult or
// an error code to surface in the chunk UI.

import {
  callNarrateScript,
  type NarrateScriptErrorCode,
} from '@/apis/narrate-script-api';
import { NARRATION_OUTPUT_FORMAT } from '@/types/textbox-audio-adapter';
import type { TextboxAudioResult } from '@/types/spread-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import type { Voice } from '@/types/voice';

import type { ChunkDraft } from '../components/chunk-types';
import { validateChunk } from './validate-chunk';
import { mapSettingsToApiPayload } from './settings-mapper';
import { buildNarrateScriptText } from './narration-script-builder';

export interface GenerateChunkSuccess {
  ok: true;
  result: TextboxAudioResult;
}

export interface GenerateChunkFailure {
  ok: false;
  reason: 'invalid' | 'aborted' | 'api';
  errorCode?: NarrateScriptErrorCode;
}

export type GenerateChunkOutcome = GenerateChunkSuccess | GenerateChunkFailure;

export interface RunGenerateChunkParams {
  chunk: ChunkDraft;
  voicesById: Map<string, Voice>;
  signal: AbortSignal;
  /** Attribution-only — spread-narration is book-scoped → ai_service_logs.snapshot_id. */
  snapshotId?: string;
  /** Opt-in auto-persist directive (textbox_audio_chunk anchor). Undefined ⇒ not opted in. */
  saveResource?: SaveResourceDirective;
}

/**
 * Validate + call narrate-script for a single chunk. Caller is responsible
 * for surfacing the outcome to React state (set ui.isGenerating, append result,
 * invalidate combined fields, etc.).
 */
export async function runGenerateChunk(
  params: RunGenerateChunkParams,
): Promise<GenerateChunkOutcome> {
  const { chunk, voicesById, signal, snapshotId, saveResource } = params;

  const validation = validateChunk(chunk, voicesById);
  if (!validation.ok) {
    return { ok: false, reason: 'invalid' };
  }

  const voice = voicesById.get(chunk.voice_id);
  const elevenId = voice?.elevenId ?? null;
  if (!elevenId) {
    return { ok: false, reason: 'invalid', errorCode: 'INVALID_VOICE_ID' };
  }

  // buildNarrateScriptText throws InvalidElevenIdError on regex mismatch.
  // Keep it inside try so a malformed elevenId doesn't escape and leave
  // ui.isGenerating stuck true on the caller's chunk.
  try {
    const scriptText = buildNarrateScriptText(elevenId, chunk.script);
    const res = await callNarrateScript(
      {
        script: scriptText,
        modelId: 'eleven_v3',
        settings: mapSettingsToApiPayload({
          stability: chunk.stability,
          similarity: chunk.similarity,
          exaggeration: chunk.exaggeration,
          speed: chunk.speed,
        }),
        outputFormat: NARRATION_OUTPUT_FORMAT,
        snapshotId,
        // Undefined ⇒ client drops the field (strict backward-compat). Client warns on soft-fail.
        saveResource,
      },
      { signal },
    );

    if (!res.success) {
      return { ok: false, reason: 'api', errorCode: res.errorCode };
    }

    const result: TextboxAudioResult = {
      url: res.data.audioUrl,
      word_timings: res.data.words,
      raw_alignment: res.data.rawAlignment,
      created_time: new Date().toISOString(),
      is_selected: true,
    };
    return { ok: true, result };
  } catch (err) {
    const aborted = signal.aborted;
    if (aborted) return { ok: false, reason: 'aborted', errorCode: 'ABORT' };
    // InvalidElevenIdError surfaces as INVALID_VOICE_ID; everything else UNKNOWN.
    const errorCode: NarrateScriptErrorCode =
      err instanceof Error && err.name === 'InvalidElevenIdError'
        ? 'INVALID_VOICE_ID'
        : 'UNKNOWN';
    return { ok: false, reason: 'api', errorCode };
  }
}
