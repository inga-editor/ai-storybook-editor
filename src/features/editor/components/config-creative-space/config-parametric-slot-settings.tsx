// config-parametric-slot-settings.tsx — root panel for the Parametric Slot config
// section. 3 segmented sub-tabs (CHARACTERS / PHOTOS / SHARED). Characters derive
// from snapshot.characters[] (entry present in slot = enabled — NO is_enabled flag,
// unlike remix); photos are user-created slots (auto key photo_N, per-entry
// is_enabled); SHARED stacks the country + religion user-defined value lists
// (2 ParametricValueList sections). Every change persists immediately via
// updateBook (no Apply).
// Age steppers debounce ~400ms and flush on unmount / tab-switch / character-OFF;
// all other controls write per click. Design ref: 12-config-parametric-slot-settings.md.
// LWW note: each handler persists the full next slot (no merge/refetch), same as
// remix/distribution. This panel uniquely mixes immediate + debounced writers on one
// column, so out-of-order Supabase UPDATEs can widen the last-writer-wins window —
// accepted for v1 (validation S1).

import * as React from 'react';
import {
  useBookStore,
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

const log = createLogger('Editor', 'ConfigParametricSlotSettings');

const AGE_DEBOUNCE_MS = 400;

// Read the freshest slot straight from the store (optimistic `set` is synchronous)
// so debounced / interleaved writes always merge onto the latest value, never a
// stale render capture.
function readCurrentSlot(): BookParametricSlot {
  return (
    normalizeParametricSlot(useBookStore.getState().currentBook?.parametric_slot) ??
    DEFAULT_PARAMETRIC_SLOT
  );
}

type DraftAgeMap = Record<string, { age_min: number; age_max: number }>;

export function ConfigParametricSlotSettings() {
  const book = useCurrentBook();
  const rawSlot = useBookParametricSlot();
  const snapshotChars = useCharacters();
  const { updateBook } = useBookActions();

  const [activeTab, setActiveTab] = React.useState<ParametricSlotTab>(PARAMETRIC_DEFAULT_TAB);
  const [draftAges, setDraftAges] = React.useState<DraftAgeMap>({});

  const draftAgesRef = React.useRef<DraftAgeMap>(draftAges);
  const timerRef = React.useRef<number | null>(null);
  const bookIdRef = React.useRef<string | null>(book?.id ?? null);

  // Sync refs via effects (never read/write ref.current in render body — React 19).
  React.useEffect(() => {
    draftAgesRef.current = draftAges;
  }, [draftAges]);
  React.useEffect(() => {
    bookIdRef.current = book?.id ?? null;
  }, [book?.id]);

  // Normalized slot for DISPLAY only (writes read fresh via readCurrentSlot()).
  const slot = React.useMemo(
    () => normalizeParametricSlot(rawSlot) ?? DEFAULT_PARAMETRIC_SLOT,
    [rawSlot],
  );

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

  const flushAges = React.useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const drafts = draftAgesRef.current;
    const keys = Object.keys(drafts);
    if (keys.length === 0) return;
    const bookId = bookIdRef.current;
    if (!bookId) return;
    const base = readCurrentSlot();
    const characters = base.characters.map((c) =>
      drafts[c.key] ? { ...c, age_min: drafts[c.key].age_min, age_max: drafts[c.key].age_max } : c,
    );
    log.info('flushAges', 'commit debounced ages', { count: keys.length });
    void updateBook(bookId, { parametric_slot: { ...base, characters } });
    setDraftAges({});
  }, [updateBook]);

  // Latest-ref for flush so the unmount cleanup calls the current closure.
  const flushRef = React.useRef(flushAges);
  React.useEffect(() => {
    flushRef.current = flushAges;
  }, [flushAges]);
  React.useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, []);

  if (!book) {
    log.debug('render', 'no book — rendering null');
    return null;
  }

  const bookId = book.id;

  // ── Persist (each handler builds the full next slot from the freshest base) ──
  const persist = (next: BookParametricSlot) => {
    void updateBook(bookId, { parametric_slot: next });
  };
  const persistCountry = (base: BookParametricSlot, values: ParametricCountryValue[], isEnabled?: boolean) =>
    persist({ ...base, country: { is_enabled: isEnabled ?? base.country.is_enabled, values } });
  const persistReligion = (base: BookParametricSlot, values: ParametricReligionValue[], isEnabled?: boolean) =>
    persist({ ...base, religion: { is_enabled: isEnabled ?? base.religion.is_enabled, values } });

  // ── Character handlers ──────────────────────────────────────────────────────
  const enableCharacter = (ch: Character) => {
    const base = readCurrentSlot();
    if (base.characters.some((c) => c.key === ch.key)) return;
    log.info('enableCharacter', 'add entry', { key: ch.key });
    const entry = {
      key: ch.key,
      name: ch.name,
      // All 3 axes default ON when a character is enabled (user decision): gender
      // falls back to 'unspecified' when the snapshot has none so its checkbox is ON.
      gender: normalizeGenderSeed(ch.basic_info.gender) ?? UNSPECIFIED_GENDER,
      age_min: DEFAULT_AGE_RANGE.age_min,
      age_max: DEFAULT_AGE_RANGE.age_max,
    };
    persist({ ...base, characters: [...base.characters, entry] });
  };

  const disableCharacter = (ch: Character) => {
    flushAges(); // flush pending age drafts (other rows) before the structural change
    const base = readCurrentSlot();
    log.info('disableCharacter', 'remove entry', { key: ch.key });
    persist({ ...base, characters: base.characters.filter((c) => c.key !== ch.key) });
  };

  const toggleProperty = (ch: Character, prop: 'name' | 'gender' | 'age', next: boolean) => {
    // Flush pending age drafts first (same idiom as disableCharacter). Critical for
    // the age-OFF transition: without this, a late debounced flush would re-apply the
    // stale draft and silently resurrect the age pair AFTER we persist it null.
    flushAges();
    const base = readCurrentSlot();
    const idx = base.characters.findIndex((c) => c.key === ch.key);
    if (idx < 0) {
      log.warn('toggleProperty', 'no entry for character', { key: ch.key, prop });
      return;
    }
    log.info('toggleProperty', 'update', { key: ch.key, prop, next });
    const entry = { ...base.characters[idx] };
    if (prop === 'name') {
      entry.name = next ? ch.name : null;
    } else if (prop === 'gender') {
      entry.gender = next ? normalizeGenderSeed(ch.basic_info.gender) ?? UNSPECIFIED_GENDER : null;
    } else {
      entry.age_min = next ? DEFAULT_AGE_RANGE.age_min : null;
      entry.age_max = next ? DEFAULT_AGE_RANGE.age_max : null;
    }
    const characters = [...base.characters];
    characters[idx] = entry;
    persist({ ...base, characters });
  };

  const scheduleFlush = () => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, AGE_DEBOUNCE_MS);
  };

  const handleAgeChange = (ch: Character, field: 'age_min' | 'age_max', value: number) => {
    const base = readCurrentSlot();
    const entry = base.characters.find((c) => c.key === ch.key);
    if (!entry) {
      log.warn('handleAgeChange', 'no entry for character', { key: ch.key });
      return;
    }
    const cur = draftAges[ch.key] ?? {
      age_min: entry.age_min ?? DEFAULT_AGE_RANGE.age_min,
      age_max: entry.age_max ?? DEFAULT_AGE_RANGE.age_max,
    };
    const clamped = clampAge(field, value, cur);
    log.debug('handleAgeChange', 'draft age', { key: ch.key, field, value: clamped });
    // Spread from prev[key] (fall back to cur) so a sibling-field update within one
    // synchronous burst is never dropped by a render-captured base.
    setDraftAges((prev) => ({ ...prev, [ch.key]: { ...(prev[ch.key] ?? cur), [field]: clamped } }));
    scheduleFlush();
  };

  // ── Photo handlers (user-created slots, auto key photo_N) ───────────────────
  const addPhoto = () => {
    const base = readCurrentSlot();
    const key = nextPhotoKey(base.photos);
    log.info('addPhoto', 'append slot', { key });
    persist({ ...base, photos: [...base.photos, { key, ...DEFAULT_PHOTO_FLAGS }] });
  };

  const setPhotoEnabled = (key: string, next: boolean) => {
    const base = readCurrentSlot();
    log.info('setPhotoEnabled', 'toggle slot', { key, next });
    persist({
      ...base,
      photos: base.photos.map((p) => (p.key === key ? { ...p, is_enabled: next } : p)),
    });
  };

  const setPhotoFlag = (key: string, flag: PhotoFlag, next: boolean) => {
    const base = readCurrentSlot();
    log.info('setPhotoFlag', 'toggle mode', { key, flag, next });
    // All 3 flags false is valid (no hard validator) — execution layer treats the
    // slot as disabled (design §4.4).
    persist({
      ...base,
      photos: base.photos.map((p) => (p.key === key ? { ...p, [flag]: next } : p)),
    });
  };

  const deletePhoto = (key: string) => {
    const base = readCurrentSlot();
    log.info('deletePhoto', 'remove slot', { key });
    persist({ ...base, photos: base.photos.filter((p) => p.key !== key) });
  };

  // ── Country / Religion handlers (per-axis branches keep value types exact) ──
  const toggleAxis = (axis: 'country' | 'religion', next: boolean) => {
    const base = readCurrentSlot();
    log.info('toggleAxis', 'master toggle', { axis, next });
    if (axis === 'country') {
      const cur = base.country;
      const values = next && cur.values.length === 0 ? seedCountryValues() : cur.values;
      persistCountry(base, values, next);
    } else {
      const cur = base.religion;
      const values = next && cur.values.length === 0 ? seedReligionValues() : cur.values;
      persistReligion(base, values, next);
    }
  };

  const toggleValue = (axis: 'country' | 'religion', label: string, next: boolean) => {
    const base = readCurrentSlot();
    log.info('toggleValue', 'update', { axis, next });
    if (axis === 'country') {
      persistCountry(base, base.country.values.map((v) => (v.code === label ? { ...v, is_enabled: next } : v)));
    } else {
      persistReligion(base, base.religion.values.map((v) => (v.name === label ? { ...v, is_enabled: next } : v)));
    }
  };

  const deleteValue = (axis: 'country' | 'religion', label: string) => {
    const base = readCurrentSlot();
    log.info('deleteValue', 'remove', { axis });
    if (axis === 'country') {
      persistCountry(base, base.country.values.filter((v) => v.code !== label));
    } else {
      persistReligion(base, base.religion.values.filter((v) => v.name !== label));
    }
  };

  const addValue = (axis: 'country' | 'religion', label: string, checked: boolean) => {
    const base = readCurrentSlot();
    log.info('addValue', 'append', { axis, checked });
    if (axis === 'country') {
      persistCountry(base, [...base.country.values, { code: label, is_enabled: checked }]);
    } else {
      persistReligion(base, [...base.religion.values, { name: label, is_enabled: checked }]);
    }
  };

  const handleTabChange = (tab: ParametricSlotTab) => {
    flushAges(); // don't lose pending age drafts when leaving the characters tab
    log.info('handleTabChange', 'switch', { tab });
    setActiveTab(tab);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const country = buildDisplayValues('country', slot);
  const religion = buildDisplayValues('religion', slot);
  const existingCountryCodes = slot.country.values.map((v) => v.code);
  const existingReligionNames = slot.religion.values.map((v) => v.name);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <h3 className="text-sm font-semibold">Parametric Slot Settings</h3>
      </div>
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
                const draft = draftAges[ch.key];
                const displayEntry =
                  entry && draft
                    ? { ...entry, age_min: draft.age_min, age_max: draft.age_max }
                    : entry;
                return (
                  <CharacterParametricRow
                    key={ch.key}
                    characterName={ch.name}
                    enabled={enabled}
                    entry={displayEntry}
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
