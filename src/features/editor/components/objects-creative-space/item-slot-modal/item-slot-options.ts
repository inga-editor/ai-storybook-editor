// item-slot-options.ts — CONTROL KEY option building + default-value derivation
// for ItemSlotModal (parametric side). Pure: no React, no store, no throw.
// Split out of item-slot-logic.ts to stay under the 500-LOC file budget.
// Design ref: 19-item-slot-modal.md §2.3 / §2.4.
//
// Contract: `book.parametric_slot` is normalized at the ingress of every exported
// function via normalizeParametricSlot(); the rest assumes a complete shape.
// Dangling data (character removed from the snapshot, unknown key) is a routine
// DISPLAY state, surfaced structurally (`isDangling`) and logged at `debug` —
// never `warn`, because these run on every render of a list of items.

import type { BookParametricSlot } from '@/types/editor';
import type { Character } from '@/types/character-types';
import { normalizeParametricSlot } from '@/features/editor/components/config-creative-space/parametric-slot-helpers';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ItemSlotOptions');

export interface ParametricKeyOption {
  key: string;
  label: string;
}

/** `kind` is the discriminator — never branch on `groupKey`, a character whose
 *  snapshot key is literally 'photo'/'shared' would collide with the synthetic groups. */
export type ParametricKeyGroupKind = 'character' | 'photo' | 'shared';

export interface ParametricKeyGroup {
  kind: ParametricKeyGroupKind;
  groupKey: string; // character key | 'photo' | 'shared'
  header: string; // character name (fallback key) | 'PHOTO' | 'SHARED'
  isDangling: boolean; // character no longer present in the snapshot
  options: ParametricKeyOption[];
}

export const PHOTO_GROUP_KEY = 'photo';
export const SHARED_GROUP_KEY = 'shared';

/** Photo axis seed value — the book's own image (§2.4). */
export const PHOTO_ORIGINAL_VALUE = 'original';

// ── CONTROL KEY options (§2.3) ────────────────────────────────────────────────

/**
 * Build the grouped CONTROL KEY option list: one group per configured character
 * (gender / age), then PHOTO, then SHARED (country / religion).
 * Deliberately omits the `name` axis (text-only, no media variant) and `zodiac`
 * (present in the mock but absent from the DB shape — rejected 2026-07-27).
 */
export function buildParametricOptions(
  slot: BookParametricSlot | null,
  characters: Character[],
): ParametricKeyGroup[] {
  const normalized = normalizeParametricSlot(slot);
  if (!normalized) {
    log.debug('buildParametricOptions', 'parametric_slot not configured', {});
    return [];
  }

  const groups: ParametricKeyGroup[] = [];

  for (const entry of normalized.characters) {
    const options: ParametricKeyOption[] = [];
    if (entry.gender !== null) options.push({ key: `${entry.key}.gender`, label: 'gender' });
    if (entry.age_min !== null && entry.age_max !== null) {
      options.push({ key: `${entry.key}.age`, label: 'age' });
    }
    if (options.length === 0) continue;

    const snapChar = characters.find((c) => c.key === entry.key);
    if (!snapChar) {
      log.debug('buildParametricOptions', 'dangling character in parametric_slot', {
        key: entry.key,
      });
    }
    groups.push({
      kind: 'character',
      groupKey: entry.key,
      header: (snapChar?.name ?? '').trim() || entry.key,
      isDangling: !snapChar,
      options,
    });
  }

  const photoOptions = normalized.photos
    .filter((p) => p.is_enabled)
    .map((p) => ({ key: p.key, label: p.key }));
  if (photoOptions.length > 0) {
    groups.push({
      kind: 'photo',
      groupKey: PHOTO_GROUP_KEY,
      header: 'PHOTO',
      isDangling: false,
      options: photoOptions,
    });
  }

  const sharedOptions: ParametricKeyOption[] = [];
  if (normalized.country.is_enabled) sharedOptions.push({ key: 'country', label: 'country' });
  if (normalized.religion.is_enabled) sharedOptions.push({ key: 'religion', label: 'religion' });
  if (sharedOptions.length > 0) {
    groups.push({
      kind: 'shared',
      groupKey: SHARED_GROUP_KEY,
      header: 'SHARED',
      isDangling: false,
      options: sharedOptions,
    });
  }

  return groups;
}

/**
 * Trigger / summary label of a control key: `{Character name} · {axis}` for the
 * character groups, the bare option label for PHOTO / SHARED. An unknown key
 * (dangling axis) renders as the raw key so the user still sees what is stored.
 */
export function buildParametricTriggerLabel(key: string, groups: ParametricKeyGroup[]): string {
  for (const group of groups) {
    const option = group.options.find((o) => o.key === key);
    if (!option) continue;
    return group.kind === 'character' ? `${group.header} · ${option.label}` : option.label;
  }
  log.debug('buildParametricTriggerLabel', 'key not found in options', { key });
  return key;
}

// ── Seed value derivation (§2.4) ──────────────────────────────────────────────

function clampNumber(value: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * `basic_info.age` is free text ("3 tuổi") while the age axis values are numeric
 * buckets → take the FIRST number found and clamp it into [ageMin, ageMax].
 * No number at all → ageMin (never blocks init).
 */
export function parseAgeSeed(
  rawAge: string | undefined,
  ageMin: number,
  ageMax: number,
): string {
  const match = (rawAge ?? '').match(/\d+/);
  if (!match) {
    log.debug('parseAgeSeed', 'no digits in age, falling back to age_min', { ageMin });
    return String(ageMin);
  }
  const parsed = Number.parseInt(match[0], 10);
  if (!Number.isFinite(parsed)) return String(ageMin);
  return String(clampNumber(parsed, ageMin, ageMax));
}

/** Split `<char_key>.gender` / `<char_key>.age`; null when the key is not a
 *  character axis. Uses the LAST dot so character keys stay free-form.
 *  ORDERING DEPENDENCY: deriveParametricDefaultValue tries this BEFORE the photo
 *  lookup, so a photo key ending in `.gender`/`.age` would be claimed by the
 *  character branch and never reach `normalized.photos` — photo keys must never
 *  use those two suffixes. */
export function splitCharacterAxis(key: string): { charKey: string; axis: 'gender' | 'age' } | null {
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return null;
  const axis = key.slice(dot + 1);
  if (axis !== 'gender' && axis !== 'age') return null;
  return { charKey: key.slice(0, dot), axis };
}

/**
 * Default `value` seeded on init for the chosen axis. `null` = cannot seed
 * (caller blocks Init). gender/age read the SNAPSHOT first — the copy inside
 * `book.parametric_slot.characters[]` is only the seed captured when the axis was
 * enabled and goes stale after the user edits the character (chốt 2026-07-27).
 *
 * NOTE: assumes `key` came from buildParametricOptions (i.e. the axis is enabled).
 * Reusing this for a re-seed after a config change must re-check `is_enabled`.
 */
export function deriveParametricDefaultValue(
  key: string,
  slot: BookParametricSlot | null,
  characters: Character[],
): string | null {
  const normalized = normalizeParametricSlot(slot);
  if (!normalized || key.length === 0) return null;

  if (key === 'country') {
    const hit = normalized.country.values.find((v) => v.is_enabled);
    if (!hit) log.debug('deriveParametricDefaultValue', 'no enabled country value', {});
    return hit?.code ?? null;
  }

  if (key === 'religion') {
    const hit = normalized.religion.values.find((v) => v.is_enabled);
    if (!hit) log.debug('deriveParametricDefaultValue', 'no enabled religion value', {});
    return hit?.name ?? null;
  }

  const charAxis = splitCharacterAxis(key);
  if (charAxis) {
    const entry = normalized.characters.find((c) => c.key === charAxis.charKey);
    if (!entry) {
      log.debug('deriveParametricDefaultValue', 'character axis missing in book config', { key });
      return null;
    }
    const snapChar = characters.find((c) => c.key === charAxis.charKey);

    if (charAxis.axis === 'gender') {
      const fromSnapshot = (snapChar?.basic_info?.gender ?? '').trim();
      if (fromSnapshot.length > 0) return fromSnapshot;
      const fromBook = (entry.gender ?? '').trim();
      if (fromBook.length > 0) {
        log.debug('deriveParametricDefaultValue', 'gender fell back to book config', { key });
        return fromBook;
      }
      return null;
    }

    // age — paired bounds; a lone bound is normalized to "axis OFF".
    if (entry.age_min === null || entry.age_max === null) {
      log.debug('deriveParametricDefaultValue', 'age axis disabled in book config', { key });
      return null;
    }
    return parseAgeSeed(snapChar?.basic_info?.age, entry.age_min, entry.age_max);
  }

  const photo = normalized.photos.find((p) => p.key === key);
  if (photo) {
    if (photo.original) return PHOTO_ORIGINAL_VALUE;
    log.debug('deriveParametricDefaultValue', 'photo original mode disabled', { key });
    return null;
  }

  log.debug('deriveParametricDefaultValue', 'unknown control key', { key });
  return null;
}
