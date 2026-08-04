// config-parametric-slot-settings.tsx — root panel for the Parametric Slot config
// section. 3 segmented sub-tabs (CHARACTERS / PHOTOS / SHARED). Characters derive
// from snapshot.characters[] (entry present in slot = enabled — NO is_enabled flag,
// unlike remix); photos are user-created slots (auto key photo_N, per-entry
// is_enabled); SHARED stacks the country + religion user-defined value lists
// (2 ParametricValueList sections). Edits update a local draft; the full slot is
// persisted via updateBook once on [Save] (explicit-save model, spec 15).
// Design ref: 12-config-parametric-slot-settings.md.
// LWW note: persistFn writes the full next slot (no merge/refetch) once on [Save],
// same as remix/distribution — whole-column last-writer-wins, accepted for v1
// (validation S1).

import * as React from 'react';
import {
  useCurrentBook,
  useBookParametricSlot,
  useBookActions,
} from '@/stores/book-store';
import { useCharacters } from '@/stores/snapshot-store/selectors';
import type {
  BookParametricSlot,
  ParametricCountryValue,
  ParametricReligionValue,
} from '@/types/editor';
import type { Character } from '@/types/character-types';
import {
  DEFAULT_AGE_RANGE,
  DEFAULT_PARAMETRIC_SLOT,
  DEFAULT_PHOTO_FLAGS,
  PARAMETRIC_DEFAULT_TAB,
  buildDisplayValues,
  clampAge,
  nextPhotoKey,
  normalizeGenderSeed,
  normalizeParametricSlot,
  seedCountryValues,
  seedReligionValues,
  UNSPECIFIED_GENDER,
  validateCountryCode,
  validateReligionName,
  type ParametricSlotTab,
} from './parametric-slot-helpers';
import { ParametricSlotTabHeader } from './parametric-slot/parametric-slot-tab-header';
import { CharacterParametricRow } from './parametric-slot/character-parametric-row';
import { PhotoParametricRow, type PhotoFlag } from './parametric-slot/photo-parametric-row';
import { ParametricValueList } from './parametric-slot/parametric-value-list';
import { Plus } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import {
  ConfigSectionHeader,
  assertPersisted,
  pruneDeriveKeyed,
  useConfigSectionDraft,
} from './explicit-save';

const log = createLogger('Editor', 'ConfigParametricSlotSettings');

export function ConfigParametricSlotSettings() {
  const book = useCurrentBook();
  const rawSlot = useBookParametricSlot();
  const snapshotChars = useCharacters();
  const { updateBook } = useBookActions();

  const [activeTab, setActiveTab] = React.useState<ParametricSlotTab>(PARAMETRIC_DEFAULT_TAB);

  const bookId = book?.id ?? null;

  // De-dupe snapshot characters by key (first wins); stable ref for the row list.
  const uniqueChars = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Character[] = [];
    for (const ch of snapshotChars) {
      if (seen.has(ch.key)) {
        log.warn('uniqueChars', 'duplicate character key skipped', { key: ch.key });
        continue;
      }
      seen.add(ch.key);
      out.push(ch);
    }
    return out;
  }, [snapshotChars]);

  const source = React.useMemo<BookParametricSlot>(
    () => normalizeParametricSlot(rawSlot) ?? DEFAULT_PARAMETRIC_SLOT,
    [rawSlot],
  );

  const { draft, isDirty, isSaving, patchDraft, save } = useConfigSectionDraft<BookParametricSlot>({
    sectionKey: 'parametric-slot',
    source,
    persistFn: async (d) => {
      if (!bookId) throw new Error('No current book');
      // Characters derive from snapshot.characters[] → prune stale keys (cascade
      // delete). Photos / country / religion are user-created → no prune.
      const validCharKeys = new Set(snapshotChars.map((c) => c.key));
      const pruned: BookParametricSlot = {
        ...d,
        characters: pruneDeriveKeyed(d.characters, validCharKeys, (c) => c.key),
      };
      log.info('persistFn', 'saving parametric slot', { bookId, chars: pruned.characters.length });
      assertPersisted(await updateBook(bookId, { parametric_slot: pruned }), 'parametric_slot');
      log.info('persistFn', 'parametric slot saved', { bookId });
    },
  });

  const slot = draft;

  if (!book) {
    log.debug('render', 'no book — rendering null');
    return null;
  }

  // ── Patch helpers (all mutate the local draft from `prev` so consecutive edits
  //    accumulate; persist happens only on Save). ────────────────────────────────
  const patchCountry = (
    valuesOf: (values: ParametricCountryValue[]) => ParametricCountryValue[],
    isEnabled?: boolean,
  ) =>
    patchDraft((prev) => ({
      ...prev,
      country: {
        is_enabled: isEnabled ?? prev.country.is_enabled,
        values: valuesOf(prev.country.values),
      },
    }));
  const patchReligion = (
    valuesOf: (values: ParametricReligionValue[]) => ParametricReligionValue[],
    isEnabled?: boolean,
  ) =>
    patchDraft((prev) => ({
      ...prev,
      religion: {
        is_enabled: isEnabled ?? prev.religion.is_enabled,
        values: valuesOf(prev.religion.values),
      },
    }));

  // ── Character handlers ──────────────────────────────────────────────────────
  const enableCharacter = (ch: Character) => {
    log.debug('enableCharacter', 'patch draft — add entry', { key: ch.key });
    patchDraft((prev) => {
      if (prev.characters.some((c) => c.key === ch.key)) return prev;
      const entry = {
        key: ch.key,
        name: ch.name,
        // All 3 axes default ON when enabled (user decision); gender falls back to
        // 'unspecified' when the snapshot has none so its checkbox is ON.
        gender: normalizeGenderSeed(ch.basic_info.gender) ?? UNSPECIFIED_GENDER,
        age_min: DEFAULT_AGE_RANGE.age_min,
        age_max: DEFAULT_AGE_RANGE.age_max,
      };
      return { ...prev, characters: [...prev.characters, entry] };
    });
  };

  const disableCharacter = (ch: Character) => {
    log.debug('disableCharacter', 'patch draft — remove entry', { key: ch.key });
    patchDraft((prev) => ({
      ...prev,
      characters: prev.characters.filter((c) => c.key !== ch.key),
    }));
  };

  const toggleProperty = (ch: Character, prop: 'name' | 'gender' | 'age', next: boolean) => {
    log.debug('toggleProperty', 'patch draft', { key: ch.key, prop, next });
    patchDraft((prev) => {
      const idx = prev.characters.findIndex((c) => c.key === ch.key);
      if (idx < 0) {
        log.warn('toggleProperty', 'no entry for character', { key: ch.key, prop });
        return prev;
      }
      const entry = { ...prev.characters[idx] };
      if (prop === 'name') {
        entry.name = next ? ch.name : null;
      } else if (prop === 'gender') {
        entry.gender = next ? normalizeGenderSeed(ch.basic_info.gender) ?? UNSPECIFIED_GENDER : null;
      } else {
        entry.age_min = next ? DEFAULT_AGE_RANGE.age_min : null;
        entry.age_max = next ? DEFAULT_AGE_RANGE.age_max : null;
      }
      const characters = [...prev.characters];
      characters[idx] = entry;
      return { ...prev, characters };
    });
  };

  const handleAgeChange = (ch: Character, field: 'age_min' | 'age_max', value: number) => {
    log.debug('handleAgeChange', 'patch draft', { key: ch.key, field, value });
    patchDraft((prev) => {
      const idx = prev.characters.findIndex((c) => c.key === ch.key);
      if (idx < 0) {
        log.warn('handleAgeChange', 'no entry for character', { key: ch.key });
        return prev;
      }
      const entry = prev.characters[idx];
      const cur = {
        age_min: entry.age_min ?? DEFAULT_AGE_RANGE.age_min,
        age_max: entry.age_max ?? DEFAULT_AGE_RANGE.age_max,
      };
      const clamped = clampAge(field, value, cur);
      const characters = [...prev.characters];
      characters[idx] = { ...entry, ...cur, [field]: clamped };
      return { ...prev, characters };
    });
  };

  // ── Photo handlers (user-created slots, auto key photo_N) ───────────────────
  const addPhoto = () => {
    log.debug('addPhoto', 'patch draft — append slot');
    patchDraft((prev) => ({
      ...prev,
      photos: [...prev.photos, { key: nextPhotoKey(prev.photos), ...DEFAULT_PHOTO_FLAGS }],
    }));
  };

  const setPhotoEnabled = (key: string, next: boolean) => {
    log.debug('setPhotoEnabled', 'patch draft', { key, next });
    patchDraft((prev) => ({
      ...prev,
      photos: prev.photos.map((p) => (p.key === key ? { ...p, is_enabled: next } : p)),
    }));
  };

  const setPhotoFlag = (key: string, flag: PhotoFlag, next: boolean) => {
    log.debug('setPhotoFlag', 'patch draft', { key, flag, next });
    // All 3 flags false is valid (no hard validator) — execution layer treats the
    // slot as disabled (design §4.4).
    patchDraft((prev) => ({
      ...prev,
      photos: prev.photos.map((p) => (p.key === key ? { ...p, [flag]: next } : p)),
    }));
  };

  const deletePhoto = (key: string) => {
    log.debug('deletePhoto', 'patch draft — remove slot', { key });
    patchDraft((prev) => ({ ...prev, photos: prev.photos.filter((p) => p.key !== key) }));
  };

  // ── Country / Religion handlers (per-axis branches keep value types exact) ──
  const toggleAxis = (axis: 'country' | 'religion', next: boolean) => {
    log.debug('toggleAxis', 'patch draft', { axis, next });
    if (axis === 'country') {
      patchCountry((values) => (next && values.length === 0 ? seedCountryValues() : values), next);
    } else {
      patchReligion((values) => (next && values.length === 0 ? seedReligionValues() : values), next);
    }
  };

  const toggleValue = (axis: 'country' | 'religion', label: string, next: boolean) => {
    log.debug('toggleValue', 'patch draft', { axis, next });
    if (axis === 'country') {
      patchCountry((values) => values.map((v) => (v.code === label ? { ...v, is_enabled: next } : v)));
    } else {
      patchReligion((values) => values.map((v) => (v.name === label ? { ...v, is_enabled: next } : v)));
    }
  };

  const deleteValue = (axis: 'country' | 'religion', label: string) => {
    log.debug('deleteValue', 'patch draft', { axis });
    if (axis === 'country') {
      patchCountry((values) => values.filter((v) => v.code !== label));
    } else {
      patchReligion((values) => values.filter((v) => v.name !== label));
    }
  };

  const addValue = (axis: 'country' | 'religion', label: string, checked: boolean) => {
    log.debug('addValue', 'patch draft', { axis, checked });
    if (axis === 'country') {
      patchCountry((values) => [...values, { code: label, is_enabled: checked }]);
    } else {
      patchReligion((values) => [...values, { name: label, is_enabled: checked }]);
    }
  };

  const handleTabChange = (tab: ParametricSlotTab) => {
    log.debug('handleTabChange', 'switch sub-tab', { tab });
    setActiveTab(tab);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const country = buildDisplayValues('country', slot);
  const religion = buildDisplayValues('religion', slot);
  const existingCountryCodes = slot.country.values.map((v) => v.code);
  const existingReligionNames = slot.religion.values.map((v) => v.name);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfigSectionHeader
        title="Parametric Slot Settings"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={save}
      />
      <ParametricSlotTabHeader activeTab={activeTab} onTabChange={handleTabChange} />

      <div className="flex flex-col overflow-y-auto p-4">
        {activeTab === 'characters' &&
          (uniqueChars.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">No characters in book yet</p>
          ) : (
            <div className="flex flex-col">
              {uniqueChars.map((ch) => {
                const entry = slot.characters.find((c) => c.key === ch.key) ?? null;
                const enabled = entry != null;
                return (
                  <CharacterParametricRow
                    key={ch.key}
                    characterName={ch.name}
                    enabled={enabled}
                    entry={entry}
                    onToggle={(next) => (next ? enableCharacter(ch) : disableCharacter(ch))}
                    onPropToggle={(prop, next) => toggleProperty(ch, prop, next)}
                    onAgeChange={(field, value) => handleAgeChange(ch, field, value)}
                  />
                );
              })}
            </div>
          ))}

        {activeTab === 'photos' && (
          <div className="flex flex-col gap-2">
            {slot.photos.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">No photo slots yet</p>
            ) : (
              <div className="flex flex-col">
                {slot.photos.map((p) => (
                  <PhotoParametricRow
                    key={p.key}
                    entry={p}
                    onToggle={(next) => setPhotoEnabled(p.key, next)}
                    onFlagToggle={(flag, next) => setPhotoFlag(p.key, flag, next)}
                    onDelete={() => deletePhoto(p.key)}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={addPhoto}
              className="flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:text-primary/80"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        )}

        {activeTab === 'shared' && (
          <div className="flex flex-col gap-6">
            <ParametricValueList
              axisLabel="country"
              isEnabled={slot.country.is_enabled}
              values={country.values}
              isPreviewSeed={country.isPreviewSeed}
              inputPlaceholder="country code"
              addButtonLabel="Add"
              validate={(raw) => validateCountryCode(raw, existingCountryCodes)}
              onMasterToggle={(next) => toggleAxis('country', next)}
              onValueToggle={(label, next) => toggleValue('country', label, next)}
              onValueDelete={(label) => deleteValue('country', label)}
              onValueAdd={(label, checked) => addValue('country', label, checked)}
            />
            <ParametricValueList
              axisLabel="religion"
              isEnabled={slot.religion.is_enabled}
              values={religion.values}
              isPreviewSeed={religion.isPreviewSeed}
              inputPlaceholder="religion"
              addButtonLabel="Add"
              validate={(raw) => validateReligionName(raw, existingReligionNames)}
              onMasterToggle={(next) => toggleAxis('religion', next)}
              onValueToggle={(label, next) => toggleValue('religion', label, next)}
              onValueDelete={(label) => deleteValue('religion', label)}
              onValueAdd={(label, checked) => addValue('religion', label, checked)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
