// config-musics-sounds-settings.tsx
// Root panel for the Musics & Sounds config section. Owns local tab state and
// fetches `musics`/`sounds` lists once on mount. Dispatches updateBook with the
// minimal field shape per panel (music | sound | narrator).

import * as React from 'react';

import {
  DEFAULT_NARRATOR,
  MUSICS_SOUNDS_DEFAULT_TAB,
  type MusicsSoundsTab,
} from '@/constants/config-constants';
import {
  useBookActions,
  useBookMusic,
  useBookNarratorVolume,
  useBookSound,
  useBookStore,
  useCurrentBook,
} from '@/stores/book-store';
import { useMusics, useMusicsActions } from '@/stores/musics-store';
import { useSounds, useSoundsActions } from '@/stores/sounds-store';
import type {
  BookMusicSettings,
  BookSoundSettings,
  NarratorSettings,
} from '@/types/editor';
import { createLogger } from '@/utils/logger';

import { MusicTabPanel } from './music-tab-panel';
import { NarratorTabPanel } from './narrator-tab-panel';
import { SoundTabPanel } from './sound-tab-panel';
import { TabHeader } from './tab-header';
import {
  ConfigSectionHeader,
  assertPersisted,
  useConfigSectionDraft,
} from '../explicit-save';

const log = createLogger('Editor', 'ConfigMusicsSoundsSettings');

interface MusicsSoundsDraft {
  music: BookMusicSettings | null;
  sound: BookSoundSettings | null;
  narratorVolumeScale: number;
}

export function ConfigMusicsSoundsSettings() {
  const book = useCurrentBook();
  const music = useBookMusic();
  const sound = useBookSound();
  const narratorVolume = useBookNarratorVolume();
  const { updateBook } = useBookActions();

  const musicsList = useMusics();
  const soundsList = useSounds();
  const { fetchMusics } = useMusicsActions();
  const { fetchSounds } = useSoundsActions();

  const [activeTab, setActiveTab] = React.useState<MusicsSoundsTab>(
    MUSICS_SOUNDS_DEFAULT_TAB,
  );

  // Fetch asset lists once on mount when empty (cache shared across editor).
  React.useEffect(() => {
    if (musicsList.length === 0) {
      log.debug('mount', 'fetching musics');
      void fetchMusics();
    }
    if (soundsList.length === 0) {
      log.debug('mount', 'fetching sounds');
      void fetchSounds();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchMusics, fetchSounds]);

  const bookId = book?.id ?? null;
  const source = React.useMemo<MusicsSoundsDraft>(
    () => ({ music, sound, narratorVolumeScale: narratorVolume }),
    [music, sound, narratorVolume],
  );
  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<MusicsSoundsDraft>({
    sectionKey: 'musics-sounds',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      // volume_scale merges into the narrator CURRENTLY in the store (not a stale
      // draft from the Narrator section) so we never clobber peer voice edits.
      const currentNarrator = useBookStore.getState().currentBook?.narrator ?? DEFAULT_NARRATOR;
      const nextNarrator: NarratorSettings = { ...currentNarrator, volume_scale: d.narratorVolumeScale };
      log.info('persistFn', 'saving musics & sounds', { bookId });
      assertPersisted(
        await updateBook(bookId, { music: d.music, sound: d.sound, narrator: nextNarrator }),
        'musics-sounds',
      );
      log.info('persistFn', 'musics & sounds saved', { bookId });
    },
  });

  const handleMusicChange = React.useCallback(
    (next: BookMusicSettings) => {
      log.debug('handleMusicChange', 'patch draft', { bgId: next.background_id, volume: next.volume_scale });
      patchDraft({ music: next });
    },
    [patchDraft],
  );

  const handleSoundChange = React.useCallback(
    (next: BookSoundSettings) => {
      log.debug('handleSoundChange', 'patch draft', { volume: next.volume_scale });
      patchDraft({ sound: next });
    },
    [patchDraft],
  );

  const handleNarratorVolumeChange = React.useCallback(
    (v: number) => {
      log.debug('handleNarratorVolumeChange', 'patch draft', { volume: v });
      patchDraft({ narratorVolumeScale: v });
    },
    [patchDraft],
  );

  if (!book) {
    log.debug('render', 'no book — rendering null');
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Musics & Sounds"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
      <TabHeader activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex flex-col gap-5 overflow-y-auto p-4">
        {activeTab === 'music' && (
          <MusicTabPanel
            music={draft.music}
            musicsList={musicsList}
            onChange={handleMusicChange}
          />
        )}
        {activeTab === 'sound' && (
          <SoundTabPanel
            sound={draft.sound}
            soundsList={soundsList}
            onChange={handleSoundChange}
          />
        )}
        {activeTab === 'narrator' && (
          <NarratorTabPanel
            volume={draft.narratorVolumeScale}
            onChange={handleNarratorVolumeChange}
          />
        )}
      </div>
    </div>
  );
}
