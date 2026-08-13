import { useCallback, useEffect, useMemo, useState } from 'react';
import { Music } from 'lucide-react';
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
import { GenerateSoundModal } from '@/features/sounds/components/generate-sound-modal/generate-sound-modal';
import { DEFAULT_SOUNDS_FILTERS } from '@/features/sounds/constants';
import {
  useSounds,
  useSoundsActions,
  useSoundsLoading,
} from '@/stores/sounds-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Sounds', 'SoundsPage');

// Both key roots: new storage-service `uploads/audios/…` (ADR-054) AND legacy
// Supabase prefixes — delete cleanup must parse either while both coexist in DB.
const SOUNDS_PATH_PREFIXES = [
  'uploads/audios/sounds-uploaded',
  'uploads/audios/sound-effects',
  'sounds-uploaded',
  'sound-effects',
];
const SOUND_AUDIO_MIME = ['audio/mpeg', 'audio/wav', 'audio/ogg'] as const;

type SoundsActiveModal = 'upload' | 'generate' | null;

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading sounds"
      className="flex flex-col gap-3 px-6 py-4"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
      ))}
    </div>
  );
}

export function SoundsPage() {
  const sounds = useSounds();
  const isLoading = useSoundsLoading();
  const { fetchSounds, upsertLocal, removeLocal } = useSoundsActions();
  const { playingId, play, stop } = useSingletonAudioPlayer();

  const [filters, setFilters] = useState<AudioFilterState>(DEFAULT_SOUNDS_FILTERS);
  const [editingSound, setEditingSound] = useState<AudioResource | null>(null);
  const [deletingSound, setDeletingSound] = useState<AudioResource | null>(null);
  const [activeModal, setActiveModal] = useState<SoundsActiveModal>(null);

  useEffect(() => {
    log.info('mount', 'fetching sounds');
    fetchSounds();
  }, [fetchSounds]);

  const availableTags = useMemo(() => distinctTags(sounds), [sounds]);
  const durationBounds = useMemo(() => durationBoundsOf(sounds), [sounds]);
  const filtered = useMemo(() => applyFilters(sounds, filters), [sounds, filters]);

  const handlePlay = useCallback(
    (soundId: string) => {
      const sound = sounds.find((s) => s.id === soundId);
      if (!sound) {
        log.warn('handlePlay', 'sound not found', { soundId });
        return;
      }
      log.debug('handlePlay', 'play sound', { soundId, loop: sound.loop });
      play(sound.id, sound.mediaUrl, sound.loop);
    },
    [sounds, play],
  );

  const handleStop = useCallback(() => {
    stop();
  }, [stop]);

  const handleEdit = useCallback((sound: AudioResource) => {
    log.debug('handleEdit', 'open edit', { id: sound.id });
    setEditingSound(sound);
  }, []);

  const handleDelete = useCallback((sound: AudioResource) => {
    log.debug('handleDelete', 'open delete', { id: sound.id });
    setDeletingSound(sound);
  }, []);

  const handleOpenUpload = useCallback(() => setActiveModal('upload'), []);
  const handleOpenGenerate = useCallback(() => setActiveModal('generate'), []);

  const renderActiveModal = () => {
    if (activeModal === 'generate') {
      return (
        <GenerateSoundModal
          onClose={() => setActiveModal(null)}
          onSaved={(sound) => {
            log.info('renderActiveModal', 'generate saved', { id: sound.id });
            upsertLocal(sound);
            toast.success(`Sound "${sound.name}" generated`);
            setActiveModal(null);
          }}
        />
      );
    }
    if (activeModal === 'upload') {
      return (
        <UploadAudioModal
          tableName="sounds"
          resourceTitle="Sound"
          uploadPathPrefix="sounds-uploaded"
          maxSizeMb={20}
          mimeWhitelist={SOUND_AUDIO_MIME}
          influenceValue={null}
          namePlaceholder="e.g., Forest Ambience"
          descriptionPlaceholder="Briefly describe this sound..."
          tagsPlaceholder="e.g., ambient, nature, loop (comma separated)"
          onClose={() => setActiveModal(null)}
          onSaved={(sound) => {
            log.info('renderActiveModal', 'upload saved', { id: sound.id });
            upsertLocal(sound);
          }}
        />
      );
    }
    return null;
  };

  return (
    <main
      aria-labelledby="sounds-heading"
      className="w-full"
    >
      <AudioLibraryHeader
        title="Sounds"
        titleId="sounds-heading"
        onOpenUpload={handleOpenUpload}
        onOpenGenerate={handleOpenGenerate}
      />
      <AudioLibraryToolbar
        filters={filters}
        count={filtered.length}
        availableTags={availableTags}
        durationBounds={durationBounds}
        searchPlaceholder="Search sounds..."
        searchAriaLabel="Search sounds"
        countLabelSingular="sound"
        countLabelPlural="sounds"
        durationStepMs={1000}
        onChange={setFilters}
      />
      {isLoading ? (
        <ListSkeleton rows={5} />
      ) : (
        <AudioLibraryList
          items={filtered}
          isLibraryEmpty={sounds.length === 0}
          resourceLabel="sound"
          emptyIcon={Music}
          emptyHeadingNoYet="No sounds yet"
          emptyHeadingNoMatch="No sounds found"
          emptyHint="Add your first sound to get started."
          uploadCtaLabel="Upload Sound"
          generateCtaLabel="Generate Sound"
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
      {editingSound ? (
        <EditAudioModal
          tableName="sounds"
          resourceTitle="Sound"
          item={editingSound}
          tagsPlaceholder="ambient, nature, forest"
          onClose={() => setEditingSound(null)}
          onSaved={(updated) => {
            upsertLocal(updated);
          }}
        />
      ) : null}
      {deletingSound ? (
        <DeleteAudioDialog
          tableName="sounds"
          pathPrefixes={SOUNDS_PATH_PREFIXES}
          resourceLabel="sound"
          item={deletingSound}
          onClose={() => setDeletingSound(null)}
          onDeleted={(id) => {
            removeLocal(id);
            if (playingId === id) stop();
          }}
        />
      ) : null}
    </main>
  );
}
