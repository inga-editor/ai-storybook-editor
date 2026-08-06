// parametric-slot-helpers.ts — Pure helpers + config constants for
// ConfigParametricSlotSettings. Mirror of distribution-helpers.ts: side-effect-free
// logic (validate / seed / clamp / normalize / buildDisplayValues) + seed lists,
// no React, no store. The panel imports and calls these; tested standalone in
// parametric-slot-helpers.test.ts. Design ref: 12-config-parametric-slot-settings.md.
//
// Contract:
// - `parametric_slot` column is nullable → readers coalesce to DEFAULT_PARAMETRIC_SLOT.
// - Character entry present in characters[] = enabled (no is_enabled flag).
// - photos[] entries are user-created (auto key photo_N) and carry is_enabled —
//   they have no snapshot source to derive a disabled row from.
// - country/religion seed lists materialize into DB only on first master-toggle ON.

import type {
  BookParametricSlot,
  ParametricCharacterEntry,
  ParametricCountryValue,
  ParametricPhotoEntry,
  ParametricReligionValue,
} from '@/types/editor';
import { createLogger } from '@/utils/logger';

const log = createLogger('Utils', 'ParametricSlot');

// ── Tab keys (local UI state, not persisted) ──────────────────────────────────

export type ParametricSlotTab = 'characters' | 'photos' | 'shared';
export const PARAMETRIC_DEFAULT_TAB: ParametricSlotTab = 'characters';

/** Axes backed by a user-defined value list (2 stacked sections on the SHARED tab). */
export type ParametricAxis = 'country' | 'religion';

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_PARAMETRIC_SLOT: BookParametricSlot = {
  characters: [],
  photos: [],
  country: { is_enabled: false, values: [] },
  religion: { is_enabled: false, values: [] },
};

// "+ Add" photo seeds all 3 mode flags ON (matches mock — 3 checked checkboxes).
export const DEFAULT_PHOTO_FLAGS = {
  is_enabled: true,
  original: true,
  real: true,
  styled: true,
} as const;

export const DEFAULT_AGE_RANGE = { age_min: 0, age_max: 15 } as const;
export const AGE_HARD_LIMITS = { min: 0, max: 100 } as const;

// Fallback gender value seeded when a character has no snapshot gender but the
// gender axis is turned ON (enable-character default + manual re-check). Keeps the
// gender checkbox ON by default on enable (user decision, overrides design §4.4).
export const UNSPECIFIED_GENDER = 'unspecified';

// Seed values[] materialized into DB when a master toggle is turned ON for the
// first time (values[] empty). FE constant, NOT a DB lookup table — matches the
// list in recording parametric-slot.mov. Design §2.2 / §4.2.
export const SEED_COUNTRY_CODES: string[] = [
  'CN', 'IN', 'US', 'ID', 'PK', 'NG', 'BR', 'BD', 'RU', 'MX',
  'JP', 'ET', 'PH', 'EG', 'VN', 'CD', 'IR', 'TR', 'DE', 'TH',
];

export const SEED_RELIGIONS: string[] = [
  'Christianity', 'Islam', 'Hinduism', 'Buddhism', 'Judaism',
  'Sikhism', 'Taoism', 'Shinto', "Baha'i", 'Jainism',
  'Confucianism', 'Zoroastrianism', 'Folk religion', 'Secular',
];

// ── Seed builders ─────────────────────────────────────────────────────────────

export function seedCountryValues(): ParametricCountryValue[] {
  return SEED_COUNTRY_CODES.map((code) => ({ code, is_enabled: true }));
}

export function seedReligionValues(): ParametricReligionValue[] {
  return SEED_RELIGIONS.map((name) => ({ name, is_enabled: true }));
}

// ── Photo key allocation ──────────────────────────────────────────────────────

/** Next auto photo key: "photo_{N}" with the smallest positive N not in use.
 *  Deleted keys ARE reused (design §4.2 — accepted v1 trade-off: a dangling
 *  media/execution ref to the old key rebinds to the new slot). */
export function nextPhotoKey(existing: ParametricPhotoEntry[]): string {
  const used = new Set(existing.map((p) => p.key));
  let n = 1;
  while (used.has(`photo_${n}`)) n += 1;
  return `photo_${n}`;
}

// ── Gender seed (empty snapshot gender → null axis) ───────────────────────────

/** Normalize a snapshot `basic_info.gender` into a seed value: blank → null so
 *  the gender checkbox starts OFF for characters without a defined gender. */
export function normalizeGenderSeed(raw: string | null | undefined): string | null {
  const g = (raw ?? '').trim();
  return g.length > 0 ? g : null;
}

// ── Validators (normalize + validate; null = invalid) ─────────────────────────

const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/;

/** Country code: uppercase, exactly 2 A–Z letters, not a duplicate of an
 *  existing code (case-insensitive). Returns normalized code or null. */
export function validateCountryCode(raw: string, existing: string[]): string | null {
  const code = raw.trim().toUpperCase();
  if (!COUNTRY_CODE_REGEX.test(code)) {
    log.debug('validateCountryCode', 'invalid format', { len: code.length });
    return null;
  }
  if (existing.some((c) => c.toUpperCase() === code)) {
    log.debug('validateCountryCode', 'duplicate', { code });
    return null;
  }
  return code;
}

/** Religion name: trimmed, non-empty, not a duplicate (case-insensitive).
 *  Preserves the caller's casing on the returned value. */
export function validateReligionName(raw: string, existing: string[]): string | null {
  const name = raw.trim();
  if (name.length === 0) {
    log.debug('validateReligionName', 'empty', {});
    return null;
  }
  if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) {
    log.debug('validateReligionName', 'duplicate', { name });
    return null;
  }
  return name;
}

// ── Age clamp ─────────────────────────────────────────────────────────────────

/** Clamp a stepper value against the entry's current pair:
 *  age_min ∈ [0, age_max]; age_max ∈ [age_min, 100]. Null pair falls back to the
 *  hard limits so a lone stepper still clamps sanely. */
export function clampAge(
  field: 'age_min' | 'age_max',
  value: number,
  entry: Pick<ParametricCharacterEntry, 'age_min' | 'age_max'>,
): number {
  const curMin = entry.age_min ?? AGE_HARD_LIMITS.min;
  const curMax = entry.age_max ?? AGE_HARD_LIMITS.max;
  const v = Number.isFinite(value) ? value : AGE_HARD_LIMITS.min;
  if (field === 'age_min') {
    return Math.min(Math.max(v, AGE_HARD_LIMITS.min), curMax);
  }
  return Math.max(Math.min(v, AGE_HARD_LIMITS.max), curMin);
}

// ── Normalize (JSONB ingress; null-safe, idempotent) ──────────────────────────

/**
 * Coerce raw `books.parametric_slot` JSONB into a full BookParametricSlot shape.
 * Returns null only when raw is null/undefined (preserves the "not configured"
 * empty-state branch). Fills missing arrays/axes, dedupes keys, clamps stray age
 * pairs. Idempotent — an already-normalized value round-trips unchanged.
 */
export function normalizeParametricSlot(raw: unknown): BookParametricSlot | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    log.warn('normalizeParametricSlot', 'unexpected non-object', { type: typeof raw });
    return null;
  }
  const r = raw as Partial<BookParametricSlot>;
  return {
    characters: normalizeCharacters(r.characters),
    photos: normalizePhotos(r.photos),
    country: normalizeCountryAxis(r.country),
    religion: normalizeReligionAxis(r.religion),
  };
}

function normalizePhotos(raw: unknown): ParametricPhotoEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ParametricPhotoEntry[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const entry = p as Partial<ParametricPhotoEntry>;
    if (typeof entry.key !== 'string' || entry.key.trim().length === 0) continue;
    const key = entry.key.trim();
    if (seen.has(key)) {
      log.warn('normalizePhotos', 'duplicate key skipped', { key });
      continue;
    }
    seen.add(key);
    // Absent booleans default true (same tolerance as values[].is_enabled).
    out.push({
      key,
      is_enabled: typeof entry.is_enabled === 'boolean' ? entry.is_enabled : true,
      original: typeof entry.original === 'boolean' ? entry.original : true,
      real: typeof entry.real === 'boolean' ? entry.real : true,
      styled: typeof entry.styled === 'boolean' ? entry.styled : true,
    });
  }
  return out;
}

function normalizeCharacters(raw: unknown): ParametricCharacterEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ParametricCharacterEntry[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const entry = c as Partial<ParametricCharacterEntry>;
    if (typeof entry.key !== 'string' || entry.key.length === 0) continue;
    if (seen.has(entry.key)) {
      log.warn('normalizeCharacters', 'duplicate key skipped', { key: entry.key });
      continue;
    }
    seen.add(entry.key);

    let ageMin = typeof entry.age_min === 'number' ? entry.age_min : null;
    let ageMax = typeof entry.age_max === 'number' ? entry.age_max : null;
    if (ageMin == null || ageMax == null) {
      // Age is a paired axis — a lone bound means "age OFF".
      ageMin = null;
      ageMax = null;
    } else if (ageMin > ageMax) {
      log.warn('normalizeCharacters', 'age_min > age_max, clamping', { key: entry.key });
      ageMax = ageMin; // §4.4: age_max = max(age_min, age_max)
    }

    // Zodiac (1..12): absent → null (axis OFF); out-of-range / non-integer →
    // null + warn (external data). No seed here — enableCharacter seeds DEFAULT_ZODIAC.
    let zodiac: number | null = null;
    if (typeof entry.zodiac === 'number') {
      if (Number.isInteger(entry.zodiac) && entry.zodiac >= 1 && entry.zodiac <= 12) {
        zodiac = entry.zodiac;
      } else {
        log.warn('normalizeCharacters', 'zodiac out of 1..12, nulling', { key: entry.key });
      }
    }

    out.push({
      key: entry.key,
      name: typeof entry.name === 'string' ? entry.name : null,
      gender: typeof entry.gender === 'string' ? entry.gender : null,
      age_min: ageMin,
      age_max: ageMax,
      zodiac,
    });
  }
  return out;
}

function normalizeCountryAxis(raw: unknown): BookParametricSlot['country'] {
  const axis = raw && typeof raw === 'object' ? (raw as { is_enabled?: unknown; values?: unknown }) : {};
  const values: ParametricCountryValue[] = [];
  const seen = new Set<string>();
  if (Array.isArray(axis.values)) {
    for (const v of axis.values) {
      if (!v || typeof v !== 'object') continue;
      const raw2 = v as Partial<ParametricCountryValue>;
      if (typeof raw2.code !== 'string' || raw2.code.trim().length === 0) continue;
      const code = raw2.code.trim().toUpperCase();
      if (seen.has(code)) continue;
      seen.add(code);
      values.push({ code, is_enabled: typeof raw2.is_enabled === 'boolean' ? raw2.is_enabled : true });
    }
  }
  return { is_enabled: axis.is_enabled === true, values };
}

function normalizeReligionAxis(raw: unknown): BookParametricSlot['religion'] {
  const axis = raw && typeof raw === 'object' ? (raw as { is_enabled?: unknown; values?: unknown }) : {};
  const values: ParametricReligionValue[] = [];
  const seen = new Set<string>();
  if (Array.isArray(axis.values)) {
    for (const v of axis.values) {
      if (!v || typeof v !== 'object') continue;
      const raw2 = v as Partial<ParametricReligionValue>;
      if (typeof raw2.name !== 'string' || raw2.name.trim().length === 0) continue;
      const name = raw2.name.trim();
      const dedupeKey = name.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      values.push({ name, is_enabled: typeof raw2.is_enabled === 'boolean' ? raw2.is_enabled : true });
    }
  }
  return { is_enabled: axis.is_enabled === true, values };
}

// ── Display values (preview-seed vs persisted) ────────────────────────────────

export interface DisplayValue {
  label: string; // country → code, religion → name
  is_enabled: boolean;
}

export interface DisplayValuesResult {
  values: DisplayValue[];
  isPreviewSeed: boolean; // true = greyed seed preview, not yet persisted
}

/**
 * Map a persisted axis into display rows for ParametricValueList.
 * Master OFF + values[] empty → SEED preview list (greyed, not persisted).
 * Otherwise map the persisted values[]. Note: an axis with is_enabled true but
 * empty values[] (external data) is NOT re-seeded — renders as an empty list
 * (§4.4).
 */
export function buildDisplayValues(
  axis: ParametricAxis,
  slot: BookParametricSlot,
): DisplayValuesResult {
  if (axis === 'country') {
    const st = slot.country;
    if (!st.is_enabled && st.values.length === 0) {
      return {
        values: seedCountryValues().map((v) => ({ label: v.code, is_enabled: v.is_enabled })),
        isPreviewSeed: true,
      };
    }
    return {
      values: st.values.map((v) => ({ label: v.code, is_enabled: v.is_enabled })),
      isPreviewSeed: false,
    };
  }
  const st = slot.religion;
  if (!st.is_enabled && st.values.length === 0) {
    return {
      values: seedReligionValues().map((v) => ({ label: v.name, is_enabled: v.is_enabled })),
      isPreviewSeed: true,
    };
  }
  return {
    values: st.values.map((v) => ({ label: v.name, is_enabled: v.is_enabled })),
    isPreviewSeed: false,
  };
}
