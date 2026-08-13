import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { toast } from 'sonner';
import {
  AudioLibraryHeader,
  AudioLibraryToolbar,
  AudioLibraryList,
  EditAudioModal,
  DeleteAudioDialog,
  UploadAudioModal,
  applyFilters,
  distinctTags,
  durationBoundsOf,
  useSingletonAudioPlayer,
  type AudioFilterState,
  type AudioResource,
} from '@/features/audio-library';
import { GenerateMusicModal } from '@/features/musics/components/generate-music-modal/generate-music-modal';
import { DEFAULT_MUSICS_FILTERS } from '@/features/musics/constants';
import {
  useMusics,
  useMusicsActions,
  useMusicsLoading,
} from '@/stores/musics-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Musics', 'MusicsPage');

// Both key roots: new storage-service `uploads/audios/…` (ADR-054) AND legacy
// Supabase prefixes — delete cleanup must parse either while both coexist in DB.
const MUSICS_PATH_PREFIXES = [
  'uploads/audios/musics-uploaded',
  'uploads/audios/musics',
  'musics-uploaded',
  'musics',
];
const MUSIC_AUDIO_MIME = ['audio/mpeg', 'audio/wav', 'audio/ogg'] as const;

type MusicsActiveModal = 'upload' | 'generate' | null;

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading musics"
      className="flex flex-col gap-3 px-6 py-4"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
      ))}
    </div>
  );
}

export function MusicsPage() {
  const musics = useMusics();
  const isLoading = useMusicsLoading();
  const { fetchMusics, upsertLocal, removeLocal } = useMusicsActions();
  const { playingId, play, stop } = useSingletonAudioPlayer();

  const [filters, setFilters] = useState<AudioFilterState>(DEFAULT_MUSICS_FILTERS);
  const [editingItem, setEditingItem] = useState<AudioResource | null>(null);
  const [deletingItem, setDeletingItem] = useState<AudioResource | null>(null);
  const [activeModal, setActiveModal] = useState<MusicsActiveModal>(null);

  useEffect(() => {
    log.info('mount', 'fetching musics');
    fetchMusics();
  }, [fetchMusics]);

  const availableTags = useMemo(() => distinctTags(musics), [musics]);
  const durationBounds = useMemo(() => durationBoundsOf(musics), [musics]);
  const filtered = useMemo(() => applyFilters(musics, filters), [musics, filters]);

  const handlePlay = useCallback(
    (musicId: string) => {
      const music = musics.find((m) => m.id === musicId);
      if (!music) {
        log.warn('handlePlay', 'music not found', { musicId });
        return;
      }
      log.debug('handlePlay', 'play music', { musicId, loop: music.loop });
      play(music.id, music.mediaUrl, music.loop);
    },
    [musics, play],
  );

  const handleStop = useCallback(() => stop(), [stop]);

  const handleEdit = useCallback((music: AudioResource) => {
    log.debug('handleEdit', 'open edit', { id: music.id });
    setEditingItem(music);
  }, []);

  const handleDelete = useCallback((music: AudioResource) => {
    log.debug('handleDelete', 'open delete', { id: music.id });
    setDeletingItem(music);
  }, []);

  const handleOpenUpload = useCallback(() => setActiveModal('upload'), []);
  const handleOpenGenerate = useCallback(() => setActiveModal('generate'), []);

  const renderActiveModal = () => {
    if (activeModal === 'generate') {
      return (
        <GenerateMusicModal
          onClose={() => setActiveModal(null)}
          onSaved={(music) => {
            log.info('renderActiveModal', 'generate saved', { id: music.id });
            upsertLocal(music);
            toast.success(`Music "${music.name}" generated`);
            setActiveModal(null);
          }}
        />
      );
    }
    if (activeModal === 'upload') {
      return (
        <UploadAudioModal
          tableName="musics"
          resourceTitle="Music"
          uploadPathPrefix="musics-uploaded"
          maxSizeMb={30}
          mimeWhitelist={MUSIC_AUDIO_MIME}
          influenceValue={null}
          namePlaceholder="e.g., Forest Adventure"
          descriptionPlaceholder="Briefly describe this music..."
          tagsPlaceholder="e.g., cinematic, calm, intro (comma separated)"
          defaultLoop
          onClose={() => setActiveModal(null)}
          onSaved={(music) => {
            log.info('renderActiveModal', 'upload saved', { id: music.id });
            upsertLocal(music);
          }}
        />
      );
    }
    return null;
  };

  return (
    <main
      aria-labelledby="musics-heading"
      className="w-full"
    >
      <AudioLibraryHeader
        title="Musics"
        titleId="musics-heading"
        onOpenUpload={handleOpenUpload}
        onOpenGenerate={handleOpenGenerate}
      />
      <AudioLibraryToolbar
        filters={filters}
        count={filtered.length}
        availableTags={availableTags}
        durationBounds={durationBounds}
        searchPlaceholder="Search music..."
        searchAriaLabel="Search music"
        countLabelSingular="track"
        countLabelPlural="tracks"
        durationStepMs={5000}
        onChange={setFilters}
      />
      {isLoading ? (
        <ListSkeleton rows={5} />
      ) : (
        <AudioLibraryList
          items={filtered}
          isLibraryEmpty={musics.length === 0}
          resourceLabel="music"
          emptyIcon={AudioLines}
          emptyHeadingNoYet="No music yet"
          emptyHeadingNoMatch="No music found"
          emptyHint="Upload an audio file or generate one from a text prompt."
          uploadCtaLabel="Upload Music"
          generateCtaLabel="Generate Music"
          playingId={playingId}
          onPlay={handlePlay}
          onStop={handleStop}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onOpenUpload={handleOpenUpload}
          onOpenGenerate={handleOpenGenerate}
        />
      )}

      {renderActiveModal()}
      {editingItem ? (
        <EditAudioModal
          tableName="musics"
          resourceTitle="Music"
          item={editingItem}
          tagsPlaceholder="cinematic, orchestral, intro"
          onClose={() => setEditingItem(null)}
          onSaved={(updated) => upsertLocal(updated)}
        />
      ) : null}
      {deletingItem ? (
        <DeleteAudioDialog
          tableName="musics"
          pathPrefixes={MUSICS_PATH_PREFIXES}
          resourceLabel="music"
          item={deletingItem}
          onClose={() => setDeletingItem(null)}
          onDeleted={(id) => {
            removeLocal(id);
            if (playingId === id) stop();
          }}
        />
      ) : null}
    </main>
  );
}
