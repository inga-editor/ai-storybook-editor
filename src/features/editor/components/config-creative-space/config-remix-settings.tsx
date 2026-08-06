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
  makeDefaultParams,
  makeDefaultRemixMemories,
  makeDefaultTraits,
  normalizeParams,
  normalizeRemixStory,
  type RemixSettingsTab,
  type RemixStoryFeatureKey,
} from '@/constants/config-constants';
import type {
  BookRemix,
  CharacterParamKey,
  RemixLanguageEntry,
  RemixVoiceEntry,
  ParametricPhotoEntry,
} from '@/types/editor';
import type { TraitType } from '@/types/human';
import type { Character } from '@/types/character-types';
import { Switch } from '@/components/ui/switch';
import { RemixSettingsTabHeader } from './remix/remix-settings-tab-header';
import { StoryFeatureRow } from './remix/story-feature-row';
import { CharacterRemixBlock } from './remix/character-remix-block';
import { MemoryRemixRow } from './remix/memory-remix-row';
import { LanguageRemixRow } from './remix/language-remix-row';
import { VoiceRemixRow } from './remix/voice-remix-row';
import { createLogger } from '@/utils/logger';
import {
  ConfigSectionHeader,
  assertPersisted,
  pruneDeriveKeyed,
  useConfigSectionDraft,
} from './explicit-save';

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
    poolOn: remix.story.spread_pool.is_enabled,
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

  const bookId = book?.id ?? null;
  const photoSlots: ParametricPhotoEntry[] = parametricSlot?.photos ?? [];

  // Source = normalized remix (normalizeRemixStory fills any missing gate incl.
  // legacy `spread_pool` so the STORY tab never reads `.is_enabled` on undefined).
  const source = React.useMemo<BookRemix>(
    () => ({
      story:      normalizeRemixStory(remixRaw?.story),
      characters: remixRaw?.characters ?? DEFAULT_REMIX.characters,
      memories:   remixRaw?.memories   ?? makeDefaultRemixMemories(),
      voices:     remixRaw?.voices     ?? DEFAULT_REMIX.voices,
      languages:  remixRaw?.languages  ?? DEFAULT_REMIX.languages,
    }),
    [remixRaw],
  );

  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<BookRemix>({
    sectionKey: 'remix',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      // Prune derive-keyed lists so Save never re-adds an entry a cascade-delete
      // removed: characters/voices derive from snapshot.characters[], memory photos
      // from parametric_slot.photos[]. Languages are static → no prune.
      const validCharKeys = new Set(snapshotChars.map((c) => c.key));
      const validPhotoKeys = new Set(photoSlots.map((p) => p.key));
      const validVoiceKeys = new Set([...validCharKeys, NARRATOR_VOICE_KEY]);
      const pruned: BookRemix = {
        ...d,
        characters: pruneDeriveKeyed(d.characters, validCharKeys, (c) => c.key),
        voices: pruneDeriveKeyed(d.voices, validVoiceKeys, (v) => v.key),
        memories: {
          ...d.memories,
          photos: pruneDeriveKeyed(d.memories.photos, validPhotoKeys, (p) => p.key),
        },
      };
      log.info('persistFn', 'saving remix', { bookId, ...summarizeRemix(pruned) });
      assertPersisted(await updateBook(bookId, { remix: pruned }), 'remix');
      log.info('persistFn', 'remix saved', { bookId });
    },
  });

  const remix = draft;

  if (!book) return null;

  const handleTabChange = (tab: RemixSettingsTab) => {
    log.debug('handleTabChange', 'switch sub-tab', { tab });
    setActiveTab(tab);
  };

  // ── STORY ──────────────────────────────────────────────────────────────────

  const toggleStoryFeature = (key: RemixStoryFeatureKey, isEnabled: boolean) => {
    log.debug('toggleStoryFeature', 'patch draft', { key, enabled: isEnabled });
    patchDraft((prev) => ({ ...prev, story: { ...prev.story, [key]: { is_enabled: isEnabled } } }));
  };

  // ── CAST: characters ───────────────────────────────────────────────────────

  // Master row toggle. New entries are built FRESH via makeDefaultParams so no
  // legacy top-level traits[] is ever re-emitted (double-write guard).
  const upsertCharacter = (ch: Character, patch: { is_enabled: boolean }) => {
    log.debug('upsertCharacter', 'patch draft', { key: ch.key, enabled: patch.is_enabled });
    patchDraft((prev) => {
      const next = [...prev.characters];
      const idx = next.findIndex((c) => c.key === ch.key);
      if (idx >= 0) {
        next[idx] = { ...next[idx], is_enabled: patch.is_enabled, name: ch.name, params: normalizeParams(next[idx]) };
      } else {
        next.push({ key: ch.key, name: ch.name, is_enabled: patch.is_enabled, params: makeDefaultParams() });
      }
      return { ...prev, characters: next };
    });
  };

  // Per-param toggle (name/gender/age/zodiac/visual). Enabling `visual` when its
  // traits[] is somehow empty re-seeds the 5 canonical traits (R6); un-checking
  // preserves the traits so a re-check restores prior gates.
  const upsertCharacterParam = (ch: Character, paramKey: CharacterParamKey, isEnabled: boolean) => {
    log.debug('upsertCharacterParam', 'patch draft', { key: ch.key, param: paramKey, enabled: isEnabled });
    patchDraft((prev) => {
      const next = [...prev.characters];
      let idx = next.findIndex((c) => c.key === ch.key);
      if (idx < 0) {
        next.push({ key: ch.key, name: ch.name, is_enabled: false, params: makeDefaultParams() });
        idx = next.length - 1;
      }
      const params = normalizeParams(next[idx]);
      if (paramKey === 'visual') {
        const traits = isEnabled && params.visual.traits.length === 0 ? makeDefaultTraits() : params.visual.traits;
        params.visual = { is_enabled: isEnabled, traits };
      } else {
        params[paramKey] = { is_enabled: isEnabled };
      }
      next[idx] = { ...next[idx], name: ch.name, params };
      return { ...prev, characters: next };
    });
  };

  const upsertCharacterTrait = (ch: Character, type: TraitType, isEnabled: boolean) => {
    log.debug('upsertCharacterTrait', 'patch draft', { key: ch.key, type, enabled: isEnabled });
    patchDraft((prev) => {
      const next = [...prev.characters];
      let idx = next.findIndex((c) => c.key === ch.key);
      if (idx < 0) {
        next.push({ key: ch.key, name: ch.name, is_enabled: false, params: makeDefaultParams() });
        idx = next.length - 1;
      }
      const params = normalizeParams(next[idx]);
      const traits = params.visual.traits.map((t) =>
        t.type === type ? { ...t, is_enabled: isEnabled } : t,
      );
      params.visual = { ...params.visual, traits };
      next[idx] = { ...next[idx], name: ch.name, params };
      return { ...prev, characters: next };
    });
  };

  // Bulk header — first-time gate (UI-only, no schema field). Acts ONLY when 0
  // rows are ON: enables every snapshot character (materializing absent entries)
  // in one patch. If ≥1 row is already ON (user has chosen) it is a no-op.
  const toggleAllCharacters = () => {
    patchDraft((prev) => {
      if (prev.characters.some((c) => c.is_enabled)) {
        log.debug('toggleAllCharacters', 'no-op — a row is already ON', {});
        return prev;
      }
      log.debug('toggleAllCharacters', 'first-time gate — enabling all rows', { chars: snapshotChars.length });
      const byKey = new Map(prev.characters.map((c) => [c.key, c]));
      const enabled = snapshotChars.map((ch) => {
        const existing = byKey.get(ch.key);
        return existing
          ? { ...existing, is_enabled: true, name: ch.name, params: normalizeParams(existing) }
          : { key: ch.key, name: ch.name, is_enabled: true, params: makeDefaultParams() };
      });
      // Preserve any dangling entries not present in the snapshot (pruned on save).
      const snapshotKeys = new Set(snapshotChars.map((c) => c.key));
      for (const c of prev.characters) if (!snapshotKeys.has(c.key)) enabled.push(c);
      return { ...prev, characters: enabled };
    });
  };

  // ── CAST: memories ─────────────────────────────────────────────────────────

  const toggleMemoriesGate = (isEnabled: boolean) => {
    // Section gate only — photos[] is intentionally left untouched (gate-preserve).
    log.debug('toggleMemoriesGate', 'patch draft', { enabled: isEnabled });
    patchDraft((prev) => ({ ...prev, memories: { ...prev.memories, is_enabled: isEnabled } }));
  };

  const upsertMemoryPhoto = (slot: ParametricPhotoEntry, patch: { is_enabled: boolean }) => {
    log.debug('upsertMemoryPhoto', 'patch draft', { key: slot.key, enabled: patch.is_enabled });
    patchDraft((prev) => {
      const next = [...prev.memories.photos];
      const idx = next.findIndex((p) => p.key === slot.key);
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...patch };
      } else {
        next.push({ key: slot.key, is_enabled: patch.is_enabled });
      }
      return { ...prev, memories: { ...prev.memories, photos: next } };
    });
  };

  // ── VOICES ─────────────────────────────────────────────────────────────────

  const upsertVoice = (subj: { key: string; name: string }, patch: { is_enabled: boolean }) => {
    log.debug('upsertVoice', 'patch draft', { key: subj.key, enabled: patch.is_enabled });
    patchDraft((prev) => {
      const next = [...prev.voices];
      const idx = next.findIndex((v) => v.key === subj.key);
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...patch, name: subj.name };
      } else {
        next.push({ key: subj.key, name: subj.name, is_enabled: patch.is_enabled });
      }
      return { ...prev, voices: next };
    });
  };

  // ── LANGUAGES ──────────────────────────────────────────────────────────────

  const upsertLanguageEntry = (
    lang: (typeof REMIX_LANGUAGES)[number],
    patch: Partial<Pick<RemixLanguageEntry, 'is_enabled'>>,
  ) => {
    log.debug('upsertLanguageEntry', 'patch draft', { code: lang.code, patch });
    patchDraft((prev) => {
      const next = [...prev.languages];
      const idx = next.findIndex((l) => l.code === lang.code);
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...patch, name: lang.name };
      } else {
        next.push({ code: lang.code, name: lang.name, is_enabled: false, ...patch });
      }
      return { ...prev, languages: next };
    });
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

  // Bulk-header state (derived): a row is ON when its entry.is_enabled is true.
  // The bulk toggle is a one-way first-time gate — interactive only when no row
  // is ON; once any row is ON it renders greyed/disabled (never hidden).
  const enabledCharKeys = new Set(
    remix.characters.filter((c) => c.is_enabled).map((c) => c.key),
  );
  const anyCharacterOn = enabledCharKeys.size > 0;
  const allCharactersOn =
    snapshotChars.length > 0 && snapshotChars.every((ch) => enabledCharKeys.has(ch.key));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Remix Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
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
              <GroupHeader
                trailing={
                  <Switch
                    checked={allCharactersOn}
                    disabled={anyCharacterOn || snapshotChars.length === 0}
                    onCheckedChange={toggleAllCharacters}
                    aria-label="Enable remix for all characters"
                  />
                }
              >
                Characters
              </GroupHeader>
              {snapshotChars.length === 0 ? (
                <EmptyState>No characters in book yet</EmptyState>
              ) : (
                <div className="flex flex-col">
                  {snapshotChars.map((ch) => {
                    const entry = remix.characters.find((c) => c.key === ch.key);
                    const isEnabled = entry?.is_enabled ?? false;
                    const params = normalizeParams(entry);
                    return (
                      <CharacterRemixBlock
                        key={ch.key}
                        name={ch.name}
                        checked={isEnabled}
                        params={params}
                        onToggle={(next) => upsertCharacter(ch, { is_enabled: next })}
                        onParamToggle={(paramKey, next) => upsertCharacterParam(ch, paramKey, next)}
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
