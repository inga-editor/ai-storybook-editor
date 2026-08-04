// config-narrator-settings.tsx
// Root panel: ElevenLabs inference params + per-language voice pickers (5 langs).
// Orchestrates preview hook (single-active player); edits update a local draft, persisted on [Save] (spec 15).

import * as React from 'react';

import { Separator } from '@/components/ui/separator';
import {
  DEFAULT_INFERENCE_PARAMS,
  DEFAULT_NARRATOR,
  NARRATOR_LANGUAGES,
} from '@/constants/config-constants';
import {
  useBookActions,
  useBookNarrator,
  useBookStore,
  useCurrentBook,
} from '@/stores/book-store';
import type { NarratorSettings } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import { VoiceInferenceParams } from '@/features/voices/components/voice-inference-params';
import type { VoiceInferenceParamsValue } from '@/features/voices/components/voice-inference-params';

import {
  extractInference,
  getLanguageEntry,
  buildNextNarratorWithVoiceChange,
} from './narrator-helpers';
import { useNarratorPreview } from './use-narrator-preview';
import { NarratorLanguageSection } from './narrator/narrator-language-section';
import {
  ConfigSectionHeader,
  assertPersisted,
  useConfigSectionDraft,
} from './explicit-save';

const log = createLogger('Editor', 'ConfigNarratorSettings');

export function ConfigNarratorSettings() {
  const book = useCurrentBook();
  const narrator = useBookNarrator();
  const { updateBook } = useBookActions();

  const bookId = book?.id ?? null;
  const source = React.useMemo<NarratorSettings>(() => narrator ?? DEFAULT_NARRATOR, [narrator]);
  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<NarratorSettings>({
    sectionKey: 'narrator',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      // `volume_scale` is owned by the Musics & Sounds section, not here — preserve
      // the LIVE store value so saving voice/inference never reverts a volume edit
      // made in the other section (mirrors Musics & Sounds' merge).
      const liveVol = useBookStore.getState().currentBook?.narrator?.volume_scale;
      const next: NarratorSettings =
        liveVol != null ? { ...d, volume_scale: liveVol } : d;
      log.info('persistFn', 'saving narrator', { bookId });
      assertPersisted(await updateBook(bookId, { narrator: next }), 'narrator');
      log.info('persistFn', 'narrator saved', { bookId });
    },
  });

  const {
    playingLangCode,
    generatingLangCode,
    previewError,
    requestPreview,
    setPlayingLang,
    clearError,
  } = useNarratorPreview({ narrator: draft, onNarratorPatch: patchDraft });

  // Inference slider values are derived straight from the draft (local state →
  // sliders track drag at 60fps without a network round-trip / debounce).
  const localInference = React.useMemo(() => extractInference(draft), [draft]);

  const handleInferenceChange = React.useCallback(
    (next: VoiceInferenceParamsValue) => {
      // Per Validation S1: do NOT wipe media_url — merge only the 5 inference fields.
      log.debug('handleInferenceChange', 'patch draft');
      patchDraft((prev) => ({ ...prev, ...next }));
    },
    [patchDraft],
  );

  const handleInferenceReset = React.useCallback(() => {
    log.debug('handleInferenceReset', 'patch draft — reset inference (media_url preserved)');
    patchDraft((prev) => ({ ...prev, ...DEFAULT_INFERENCE_PARAMS }));
  }, [patchDraft]);

  const handleVoiceChange = React.useCallback(
    (langCode: string, voiceId: string) => {
      log.debug('handleVoiceChange', 'patch draft — voice set', { langCode });
      patchDraft((prev) => buildNextNarratorWithVoiceChange(prev, langCode, voiceId));
    },
    [patchDraft],
  );

  const handleRequestPreview = React.useCallback(
    (langCode: string) => {
      log.info('handleRequestPreview', 'preview requested', { langCode });
      void requestPreview(langCode);
    },
    [requestPreview],
  );

  const handlePlayStart = React.useCallback(
    (langCode: string) => {
      log.debug('handlePlayStart', 'single-active player', { langCode });
      setPlayingLang(langCode);
    },
    [setPlayingLang],
  );

  if (!book) {
    log.debug('render', 'no book — rendering null');
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Narrator Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />

      <div className="flex flex-col gap-5 overflow-y-auto p-4">
        <VoiceInferenceParams
          value={localInference}
          onChange={handleInferenceChange}
          onReset={handleInferenceReset}
          disabled={generatingLangCode !== null}
        />

        <Separator />

        <div className="flex flex-col gap-5">
          {NARRATOR_LANGUAGES.map((lang) => (
            <NarratorLanguageSection
              key={lang.code}
              langCode={lang.code}
              langLabel={lang.label}
              entry={getLanguageEntry(draft, lang.code)}
              isGenerating={generatingLangCode === lang.code}
              isActivePlayer={playingLangCode === lang.code}
              error={
                previewError && previewError.langCode === lang.code
                  ? previewError.message
                  : null
              }
              onVoiceChange={(voiceId) => handleVoiceChange(lang.code, voiceId)}
              onRequestPreview={() => handleRequestPreview(lang.code)}
              onPlayStart={() => handlePlayStart(lang.code)}
              onDismissError={clearError}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
