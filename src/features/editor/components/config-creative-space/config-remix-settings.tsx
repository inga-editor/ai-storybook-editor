// config-remix-settings.tsx — Remix availability config panel (4-tab reshape
// 2026-07-31: STORY / CAST / VOICES / LANGUAGES; props dropped).
// Toggles persist immediately via updateBook. Entries are upserted (preserved
// when toggled OFF) so per-trait / per-row config survives a re-toggle. Names
// are materialized from the live snapshot on every upsert. Rows derive from
// their source of truth (snapshot characters / parametric photo slots) —
// book.remix is an overlay.

import * as React from 'react';
import {
  useCurrentBook,
  useBookRemix,
  useBookParametricSlot,
  useBookActions,
} from '@/stores/book-store';
import { useCharacters } from '@/stores/snapshot-store/selectors';
import {
  DEFAULT_REMIX,
  NARRATOR_VOICE_KEY,
  REMIX_LANGUAGES,
  REMIX_SETTINGS_DEFAULT_TAB,
  REMIX_STORY_FEATURES,
  makeDefaultRemixMemories,
  makeDefaultRemixStory,
  makeDefaultTraits,
  normalizeRemixTraits,
  type RemixSettingsTab,
  type RemixStoryFeatureKey,
} from '@/constants/config-constants';
import type {
  BookRemix,
  RemixLanguageEntry,
  RemixVoiceEntry,
  ParametricPhotoEntry,
} from '@/types/editor';
import type { TraitType } from '@/types/human';
import type { Character } from '@/types/character-types';
import { Switch } from '@/components/ui/switch';
import { RemixSettingsTabHeader } from './remix/remix-settings-tab-header';
import { StoryFeatureRow } from './remix/story-feature-row';
import { CharacterRemixRow } from './remix/character-remix-row';
import { MemoryRemixRow } from './remix/memory-remix-row';
import { LanguageRemixRow } from './remix/language-remix-row';
import { VoiceRemixRow } from './remix/voice-remix-row';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigRemixSettings');

function GroupHeader({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between border-b pb-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {children}
      </p>
      {trailing}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-xs italic text-muted-foreground">{children}</p>;
}

function summarizeRemix(remix: BookRemix) {
  return {
    presetOn: remix.story.preset.is_enabled,
    branchOn: remix.story.branch.is_enabled,
    chars: remix.characters.length,
    memPhotos: remix.memories.photos.length,
    memGate: remix.memories.is_enabled,
    langs: remix.languages.length,
    voices: remix.voices.length,
  };
}

export function ConfigRemixSettings() {
  const book = useCurrentBook();
  const remixRaw = useBookRemix();
  const parametricSlot = useBookParametricSlot();
  const { updateBook } = useBookActions();
  const snapshotChars = useCharacters();
  const [activeTab, setActiveTab] = React.useState<RemixSettingsTab>(REMIX_SETTINGS_DEFAULT_TAB);

  if (!book) return null;

  const remix: BookRemix = {
    story:      remixRaw?.story      ?? makeDefaultRemixStory(),
    characters: remixRaw?.characters ?? DEFAULT_REMIX.characters,
    memories:   remixRaw?.memories   ?? makeDefaultRemixMemories(),
    voices:     remixRaw?.voices     ?? DEFAULT_REMIX.voices,
    languages:  remixRaw?.languages  ?? DEFAULT_REMIX.languages,
  };
  const photoSlots: ParametricPhotoEntry[] = parametricSlot?.photos ?? [];

  const persist = (next: BookRemix) => {
    log.debug('persist', 'updating remix', summarizeRemix(next));
    void updateBook(book.id, { remix: next });
  };

  const handleTabChange = (tab: RemixSettingsTab) => {
    log.info('handleTabChange', 'switch', { tab });
    setActiveTab(tab);
  };

  // ── STORY ──────────────────────────────────────────────────────────────────

  const toggleStoryFeature = (key: RemixStoryFeatureKey, isEnabled: boolean) => {
    log.info('toggleStoryFeature', 'start', { key, enabled: isEnabled });
    persist({ ...remix, story: { ...remix.story, [key]: { is_enabled: isEnabled } } });
  };

  // ── CAST: characters ───────────────────────────────────────────────────────

  const upsertCharacter = (ch: Character, patch: { is_enabled: boolean }) => {
    log.info('upsertCharacter', 'start', { key: ch.key, enabled: patch.is_enabled });
    const next = [...remix.characters];
    const idx = next.findIndex((c) => c.key === ch.key);
    if (idx >= 0) {
      log.debug('upsertCharacter', 'update', { idx });
      next[idx] = { ...next[idx], ...patch, name: ch.name, traits: normalizeRemixTraits(next[idx].traits) };
    } else {
      log.debug('upsertCharacter', 'insert', { key: ch.key });
      next.push({ key: ch.key, name: ch.name, is_enabled: patch.is_enabled, traits: makeDefaultTraits() });
    }
    persist({ ...remix, characters: next });
  };

  const upsertCharacterTrait = (ch: Character, type: TraitType, isEnabled: boolean) => {
    log.info('upsertCharacterTrait', 'start', { key: ch.key, type, enabled: isEnabled });
    const next = [...remix.characters];
    let idx = next.findIndex((c) => c.key === ch.key);
    if (idx < 0) {
      log.debug('upsertCharacterTrait', 'insert default entry', { key: ch.key });
      next.push({ key: ch.key, name: ch.name, is_enabled: false, traits: makeDefaultTraits() });
      idx = next.length - 1;
    }
    const traits = normalizeRemixTraits(next[idx].traits).map((t) =>
      t.type === type ? { ...t, is_enabled: isEnabled } : t,
    );
    next[idx] = { ...next[idx], name: ch.name, traits };
    persist({ ...remix, characters: next });
  };

  // ── CAST: memories ─────────────────────────────────────────────────────────

  const toggleMemoriesGate = (isEnabled: boolean) => {
    // Section gate only — photos[] is intentionally left untouched (gate-preserve).
    log.info('toggleMemoriesGate', 'start', { enabled: isEnabled });
    persist({ ...remix, memories: { ...remix.memories, is_enabled: isEnabled } });
  };

  const upsertMemoryPhoto = (slot: ParametricPhotoEntry, patch: { is_enabled: boolean }) => {
    log.info('upsertMemoryPhoto', 'start', { key: slot.key, enabled: patch.is_enabled });
    const next = [...remix.memories.photos];
    const idx = next.findIndex((p) => p.key === slot.key);
    if (idx >= 0) {
      log.debug('upsertMemoryPhoto', 'update', { idx });
      next[idx] = { ...next[idx], ...patch };
    } else {
      log.debug('upsertMemoryPhoto', 'insert', { key: slot.key });
      next.push({ key: slot.key, is_enabled: patch.is_enabled });
    }
    persist({ ...remix, memories: { ...remix.memories, photos: next } });
  };

  // ── VOICES ─────────────────────────────────────────────────────────────────

  const upsertVoice = (subj: { key: string; name: string }, patch: { is_enabled: boolean }) => {
    log.info('upsertVoice', 'start', { key: subj.key, enabled: patch.is_enabled });
    const next = [...remix.voices];
    const idx = next.findIndex((v) => v.key === subj.key);
    if (idx >= 0) {
      log.debug('upsertVoice', 'update', { idx });
      next[idx] = { ...next[idx], ...patch, name: subj.name };
    } else {
      log.debug('upsertVoice', 'insert', { key: subj.key });
      next.push({ key: subj.key, name: subj.name, is_enabled: patch.is_enabled });
    }
    persist({ ...remix, voices: next });
  };

  // ── LANGUAGES ──────────────────────────────────────────────────────────────

  const upsertLanguageEntry = (
    lang: (typeof REMIX_LANGUAGES)[number],
    patch: Partial<Pick<RemixLanguageEntry, 'is_enabled'>>,
  ) => {
    log.info('upsertLanguageEntry', 'start', { code: lang.code, patch });
    const next = [...remix.languages];
    const idx = next.findIndex((l) => l.code === lang.code);
    if (idx >= 0) {
      log.debug('upsertLanguageEntry', 'update', { idx });
      next[idx] = { ...next[idx], ...patch, name: lang.name };
    } else {
      log.debug('upsertLanguageEntry', 'insert', { code: lang.code });
      next.push({ code: lang.code, name: lang.name, is_enabled: false, ...patch });
    }
    persist({ ...remix, languages: next });
  };

  // Voice subjects: one per character, narrator last (matches mock).
  const seenVoiceKeys = new Set<string>();
  const voiceSubjects: { key: string; name: string }[] = [];
  for (const ch of snapshotChars) {
    if (seenVoiceKeys.has(ch.key)) {
      log.warn('voiceSubjects', 'duplicate character key skipped', { key: ch.key });
      continue;
    }
    seenVoiceKeys.add(ch.key);
    voiceSubjects.push({ key: ch.key, name: ch.name });
  }
  voiceSubjects.push({ key: NARRATOR_VOICE_KEY, name: 'Narrator' });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <RemixSettingsTabHeader activeTab={activeTab} onTabChange={handleTabChange} />
      <div className="flex flex-col gap-6 overflow-y-auto p-4">
        {activeTab === 'story' && (
          <div className="flex flex-col">
            {REMIX_STORY_FEATURES.map((feat) => (
              <StoryFeatureRow
                key={feat.key}
                label={feat.label}
                checked={remix.story[feat.key].is_enabled}
                onToggle={(next) => toggleStoryFeature(feat.key, next)}
              />
            ))}
          </div>
        )}

        {activeTab === 'cast' && (
          <>
            <div>
              <GroupHeader>Characters</GroupHeader>
              {snapshotChars.length === 0 ? (
                <EmptyState>No characters in book yet</EmptyState>
              ) : (
                <div className="flex flex-col">
                  {snapshotChars.map((ch) => {
                    const entry = remix.characters.find((c) => c.key === ch.key);
                    const isEnabled = entry?.is_enabled ?? false;
                    const traits = normalizeRemixTraits(entry?.traits);
                    return (
                      <CharacterRemixRow
                        key={ch.key}
                        name={ch.name}
                        checked={isEnabled}
                        traits={traits}
                        onToggle={(next) => upsertCharacter(ch, { is_enabled: next })}
                        onTraitToggle={(type, next) => upsertCharacterTrait(ch, type, next)}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <GroupHeader
                trailing={
                  <Switch
                    checked={remix.memories.is_enabled}
                    disabled={photoSlots.length === 0}
                    onCheckedChange={toggleMemoriesGate}
                    aria-label="Toggle memories remix"
                  />
                }
              >
                Memories
              </GroupHeader>
              {photoSlots.length === 0 ? (
                <EmptyState>No photo slots — add in Parametric settings</EmptyState>
              ) : (
                <div className="flex flex-col">
                  {photoSlots.map((slot) => {
                    const entry = remix.memories.photos.find((p) => p.key === slot.key);
                    return (
                      <MemoryRemixRow
                        key={slot.key}
                        label={slot.key}
                        checked={entry?.is_enabled ?? false}
                        disabled={!remix.memories.is_enabled}
                        onToggle={(next) => upsertMemoryPhoto(slot, { is_enabled: next })}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'voices' && (
          <div className="flex flex-col">
            {voiceSubjects.map((subj) => {
              const entry = remix.voices.find((v: RemixVoiceEntry) => v.key === subj.key);
              const isEnabled = entry?.is_enabled ?? false;
              return (
                <VoiceRemixRow
                  key={subj.key}
                  name={subj.name}
                  checked={isEnabled}
                  onToggle={(next) => upsertVoice(subj, { is_enabled: next })}
                />
              );
            })}
          </div>
        )}

        {activeTab === 'languages' && (
          <div className="flex flex-col">
            {REMIX_LANGUAGES.map((lang) => {
              const entry = remix.languages.find((l) => l.code === lang.code);
              const isEnabled = entry?.is_enabled ?? false;
              return (
                <LanguageRemixRow
                  key={lang.code}
                  label={lang.label}
                  checked={isEnabled}
                  onToggle={(next) => upsertLanguageEntry(lang, { is_enabled: next })}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
