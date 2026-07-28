// parametric-slot-utils.ts — PURE derivation helpers for EditParametricSlotModal.
// No React, no store, no throw, no I/O — everything here is unit-testable in isolation
// (parametric-slot-utils.test.ts). The shell owns state + the single write path; this
// module only answers "what values exist", "what is this key called" and "what payload
// does the API want".
// Design ref: edit-parametric-slot-modal/README.md §2.3 / §4.2 / §4.3 + 01-visuals-tab.md §4.3.
//
// Contract:
// - `book.parametric_slot` is normalized at ingress via normalizeParametricSlot() (same
//   entry discipline as item-slot-options.ts) — callers may pass raw/absent config.
// - An unknown / no-longer-configured key returns an EMPTY domain, never a throw: the shell
//   renders every stored value as dangling + a "fix it in Config" banner (§4.3).
// - Dangling data is a routine DISPLAY state → logged at `debug`, never `warn` (these run
//   on every render).

import type { Book } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Illustration } from '@/types/prop-types';
import type { ItemParametricSlot, ItemParametricSlotValue } from '@/types/spread-types';
import type { GenerateParametricVariantPayload } from '@/apis/image-api';
import type { SaveResourceDirective } from '@/types/save-resource';
import {
  AGE_HARD_LIMITS,
  normalizeParametricSlot,
} from '@/features/editor/components/config-creative-space/parametric-slot-helpers';
import {
  PHOTO_ORIGINAL_VALUE,
  splitCharacterAxis,
} from '@/features/editor/components/objects-creative-space/item-slot-modal/item-slot-options';
import { GENDER_OPTIONS } from '@/constants/character-constants';
import { getCountryName } from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ParametricSlotUtils');

// ── Types ─────────────────────────────────────────────────────────────────────

/** One value offered by the axis config (the "domain"). */
export interface ParametricDomainValue {
  value: string;
  label: string;
}

/** A rendered VALUES-sidebar row = domain ∪ item, decorated with item state. */
export interface ParametricValueRowData {
  value: string;
  label: string;
  /** Stored on the item but no longer in the axis domain (config changed after generation). */
  isDangling: boolean;
  /** illustrations.length of the matching entry (0 when no entry yet — lazy). */
  count: number;
  isDefault: boolean;
}

/** Axis discriminator resolved from `slot.key` (01-visuals-tab.md §4.3). `null` ⇒ the axis
 *  cannot be generated (photo) — the caller disables Generate instead of calling the API. */
export interface ParametricAxisDescriptor {
  axisKind: 'character' | 'country' | 'religion';
  axisName?: 'gender' | 'age';
  characterName?: string;
}

/** Photo-axis modes. `real`/`styled` are filled at READ time by the person reading the book
 *  ⇒ pre-generating them is semantically wrong (README §2.3). `original` is re-exported from
 *  the init modal (ONE definition of the seed value — do not fork the string). */
export const PHOTO_MODE_ORIGINAL = PHOTO_ORIGINAL_VALUE;
export const PHOTO_MODE_REAL = 'real';
export const PHOTO_MODE_STYLED = 'styled';

/** Fixed API image size — the modal exposes no control (parity inpaint/outpaint). */
export const PARAMETRIC_IMAGE_SIZE = '2K' as const;

// ── Key parsing ───────────────────────────────────────────────────────────────

// `splitCharacterAxis` (last-dot rule for `<char_key>.gender|age`) is REUSED from
// item-slot-modal/item-slot-options.ts — two copies of the key grammar would drift and the
// init modal writes the keys this modal reads. Re-exported so consumers of this feature's
// barrel get it from one place.
export { splitCharacterAxis };

/** A key that is neither shared (country/religion) nor a character axis is a photo key. */
export function isPhotoAxisKey(key: string): boolean {
  return key !== 'country' && key !== 'religion' && splitCharacterAxis(key) === null;
}

/** `real`/`styled` of a photo axis: readable + deletable, but NEVER generated/uploaded
 *  up-front (README §2.3 ⚡ photo runtime-fill). */
export function isRuntimeOnlyValue(key: string, value: string): boolean {
  return isPhotoAxisKey(key) && (value === PHOTO_MODE_REAL || value === PHOTO_MODE_STYLED);
}

// ── Domain derivation (§2.3) ──────────────────────────────────────────────────

/**
 * Every value the axis currently allows, in RENDER order (= config order).
 * Empty array = "axis not configured / no enabled value" → the shell shows the dangling
 * banner rather than an error (§4.3).
 */
export function domainValues(
  key: string,
  book: Book | null,
  characters: Character[],
): ParametricDomainValue[] {
  const normalized = normalizeParametricSlot(book?.parametric_slot ?? null);
  if (!normalized || key.length === 0) {
    log.debug('domainValues', 'parametric_slot not configured', { key });
    return [];
  }

  if (key === 'country') {
    return normalized.country.values
      .filter((v) => v.is_enabled)
      .map((v) => ({ value: v.code, label: getCountryName(v.code) || v.code }));
  }

  if (key === 'religion') {
    return normalized.religion.values
      .filter((v) => v.is_enabled)
      .map((v) => ({ value: v.name, label: v.name }));
  }

  const charAxis = splitCharacterAxis(key);
  if (charAxis) {
    const entry = normalized.characters.find((c) => c.key === charAxis.charKey);
    if (!entry) {
      log.debug('domainValues', 'character axis missing in book config', { key });
      return [];
    }
    if (charAxis.axis === 'gender') {
      // Book config stores ONE default gender, not a list → the domain is the character-form
      // vocabulary (SSOT @/constants/character-constants).
      if (entry.gender === null) {
        log.debug('domainValues', 'gender axis disabled in book config', { key });
        return [];
      }
      const out: ParametricDomainValue[] = GENDER_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
      }));
      // ⚡ The item's OWN seeded default must always be inside the domain (README §2.3 ⚡), but
      // both seed sources are free text: `basic_info.gender` is unconstrained (AI-authored /
      // imported characters carry 'Nam', 'Male', …) and the Config panel writes the literal
      // 'unspecified' when a character has no gender. Without this union those items would open
      // with their own default value marked dangling — exactly the failure the shared vocab
      // exists to prevent. Extras append AFTER the canonical four, label = raw value.
      const seeds = [entry.gender, characters.find((c) => c.key === charAxis.charKey)?.basic_info?.gender];
      for (const seed of seeds) {
        const v = (seed ?? '').trim();
        if (v.length === 0 || out.some((o) => o.value === v)) continue;
        log.debug('domainValues', 'gender seed outside the canonical vocab, kept in domain', {
          key,
          value: v,
        });
        out.push({ value: v, label: v });
      }
      return out;
    }
    // age — paired bounds; a lone bound is normalized to "axis OFF" upstream.
    if (entry.age_min === null || entry.age_max === null) {
      log.debug('domainValues', 'age axis disabled in book config', { key });
      return [];
    }
    // Clamp against the hard limits so corrupt config can never build a million rows.
    const from = Math.max(AGE_HARD_LIMITS.min, entry.age_min);
    const to = Math.min(AGE_HARD_LIMITS.max, entry.age_max);
    const out: ParametricDomainValue[] = [];
    for (let n = from; n <= to; n += 1) out.push({ value: String(n), label: String(n) });
    return out;
  }

  const photo = normalized.photos.find((p) => p.key === key);
  if (!photo || !photo.is_enabled) {
    log.debug('domainValues', 'unknown or disabled photo key', { key });
    return [];
  }
  const modes: ParametricDomainValue[] = [];
  if (photo.original) modes.push({ value: PHOTO_MODE_ORIGINAL, label: PHOTO_MODE_ORIGINAL });
  if (photo.real) modes.push({ value: PHOTO_MODE_REAL, label: PHOTO_MODE_REAL });
  if (photo.styled) modes.push({ value: PHOTO_MODE_STYLED, label: PHOTO_MODE_STYLED });
  return modes;
}

/**
 * Which value the item treats as default. Reader tolerance (§4.3):
 * - exactly one `is_default` → that one
 * - several → the first flagged one (the next write normalizes the whole array)
 * - none but entries exist → the FIRST entry
 * - no entries at all → null (the shell falls back to `rows[0]`)
 *
 * ⚠ `debug`, NOT `warn`: this runs on the RENDER path (a `useMemo` keyed on `slot`), so a
 * `warn` — which is not DEV-gated — would re-fire in production on every slot mutation for
 * as long as the data stays in that shape. Same rule as the file header.
 */
export function resolveDefaultValue(slot: ItemParametricSlot): string | null {
  const flagged = slot.values.filter((v) => v.is_default);
  if (flagged.length === 1) return flagged[0].value;
  if (flagged.length > 1) {
    log.debug('resolveDefaultValue', 'several is_default entries, using the first', {
      key: slot.key,
      flaggedCount: flagged.length,
    });
    return flagged[0].value;
  }
  if (slot.values.length > 0) {
    log.debug('resolveDefaultValue', 'no is_default entry, treating the first as default', {
      key: slot.key,
      valueCount: slot.values.length,
    });
    return slot.values[0].value;
  }
  return null;
}

/**
 * VALUES sidebar rows = domain (config order) followed by DANGLING item values (stored but
 * dropped from the config). Values without an entry are still listed — the user needs to see
 * what is left to generate (never-hide-disabled-UI).
 */
export function mergeRows(
  domain: ParametricDomainValue[],
  values: ItemParametricSlotValue[],
  defaultValue: string | null,
): ParametricValueRowData[] {
  const rows: ParametricValueRowData[] = domain.map((d) => {
    const entry = values.find((v) => v.value === d.value);
    return {
      value: d.value,
      label: d.label,
      isDangling: false,
      count: entry?.illustrations.length ?? 0,
      isDefault: d.value === defaultValue,
    };
  });

  const inDomain = new Set(domain.map((d) => d.value));
  for (const entry of values) {
    if (inDomain.has(entry.value)) continue;
    rows.push({
      value: entry.value,
      label: entry.value,
      isDangling: true,
      count: entry.illustrations.length,
      isDefault: entry.value === defaultValue,
    });
  }
  return rows;
}

// ── Labels (§4.2) ─────────────────────────────────────────────────────────────

/** CONTROL KEY chip content. `isDangling` = the character behind a `<char>.*` key is gone
 *  from the snapshot → the chip shows the raw key + a ⚠ badge. */
export function formatControlKey(
  key: string,
  characters: Character[],
): { label: string; isDangling: boolean } {
  if (key === 'country' || key === 'religion') {
    return { label: `Shared · ${key}`, isDangling: false };
  }
  const charAxis = splitCharacterAxis(key);
  if (charAxis) {
    const char = characters.find((c) => c.key === charAxis.charKey);
    const name = (char?.name ?? '').trim();
    return {
      label: `${name || charAxis.charKey} · ${charAxis.axis}`,
      isDangling: !char,
    };
  }
  return { label: `Photo · ${key}`, isDangling: false };
}

/** Prompt-facing label for a value (01-visuals-tab.md §4.3). `undefined` = send the raw value
 *  (gender / religion already read fine in a prompt). */
export function labelFor(key: string, value: string): string | undefined {
  if (splitCharacterAxis(key)?.axis === 'age') return `${value} tuổi`;
  if (key === 'country') return getCountryName(value) || undefined;
  return undefined;
}

/** Axis descriptor for the API payload. `null` ⇒ photo axis ⇒ generation is not supported. */
export function axisFromKey(key: string, characters: Character[]): ParametricAxisDescriptor | null {
  if (key === 'country') return { axisKind: 'country' };
  if (key === 'religion') return { axisKind: 'religion' };
  const charAxis = splitCharacterAxis(key);
  if (charAxis) {
    const name = (characters.find((c) => c.key === charAxis.charKey)?.name ?? '').trim();
    return {
      axisKind: 'character',
      axisName: charAxis.axis,
      ...(name ? { characterName: name } : {}),
    };
  }
  log.debug('axisFromKey', 'photo/unknown axis is not generatable', { key });
  return null;
}

// ── Immutable slot mutations (the shell is the single writer) ─────────────────

/** Map ONE entry immutably. Unknown value → the slot is returned unchanged (same reference,
 *  so the caller can skip a pointless write). */
export function mapValue(
  slot: ItemParametricSlot,
  value: string,
  fn: (entry: ItemParametricSlotValue) => ItemParametricSlotValue,
): ItemParametricSlot {
  if (!slot.values.some((v) => v.value === value)) {
    log.debug('mapValue', 'value has no entry, skip', { value });
    return slot;
  }
  return { ...slot, values: slot.values.map((v) => (v.value === value ? fn(v) : v)) };
}

/** Lazily create the `values[]` entry for `value` (README §2.1 #3). Existing → unchanged
 *  reference. The very first entry of a slot becomes the default. */
export function withValueEntry(slot: ItemParametricSlot, value: string): ItemParametricSlot {
  if (slot.values.some((v) => v.value === value)) return slot;
  return {
    ...slot,
    values: [
      ...slot.values,
      { value, is_default: slot.values.length === 0, illustrations: [] },
    ],
  };
}

/** Prepend a freshly generated/uploaded version as the selected one (newest-first). */
export function withPrependedIllustration(
  slot: ItemParametricSlot,
  value: string,
  illustration: Illustration,
): ItemParametricSlot {
  const base = withValueEntry(slot, value);
  return mapValue(base, value, (entry) => ({
    ...entry,
    illustrations: [
      { ...illustration, is_selected: true },
      ...entry.illustrations.map((i) => ({ ...i, is_selected: false })),
    ],
  }));
}

/** Mark version `idx` of `value` as the selected one. */
export function withSelectedIllustration(
  slot: ItemParametricSlot,
  value: string,
  idx: number,
): ItemParametricSlot {
  return mapValue(slot, value, (entry) => ({
    ...entry,
    illustrations: entry.illustrations.map((i, k) => ({ ...i, is_selected: k === idx })),
  }));
}

/** Delete version `idx`; if it was the selected one, the new first version takes over. */
export function withoutIllustration(
  slot: ItemParametricSlot,
  value: string,
  idx: number,
): ItemParametricSlot {
  return mapValue(slot, value, (entry) => {
    const wasSelected = entry.illustrations[idx]?.is_selected === true;
    const next = entry.illustrations.filter((_, k) => k !== idx);
    if (wasSelected && next.length > 0) next[0] = { ...next[0], is_selected: true };
    return { ...entry, illustrations: next };
  });
}

/** Move the default flag onto `value` (creating its entry if needed) and clear every other. */
export function withDefaultValue(slot: ItemParametricSlot, value: string): ItemParametricSlot {
  const base = withValueEntry(slot, value);
  return { ...base, values: base.values.map((v) => ({ ...v, is_default: v.value === value })) };
}

/** Drop every version of `value` but KEEP the entry (preserves is_default + position). */
export function withClearedIllustrations(
  slot: ItemParametricSlot,
  value: string,
): ItemParametricSlot {
  return mapValue(slot, value, (entry) => ({ ...entry, illustrations: [] }));
}

/** Total versions stored across every value — used by the destructive-confirm copy. */
export function countIllustrations(slot: ItemParametricSlot): number {
  return slot.values.reduce((sum, v) => sum + v.illustrations.length, 0);
}

// ── saveResource anchor (README §4.4) ─────────────────────────────────────────

/**
 * COLUMN-RELATIVE `saveResource` anchor of ONE value entry:
 * `col:illustration/spread:<id>/key:images/find:id=<id>/key:parametric_slot/key:values/find:value=<v>`
 *
 * ⚠ Column-relative BY CONTRACT — the result must NOT start with `table:`. The snapshot root is
 * prepended exactly once, by the modal shell via `withSnapshotRoot` (one root-injection site
 * repo-wide); prepending it here too would produce a doubled root.
 *
 * ⚡ `encodeURIComponent` on the value is REQUIRED, not incidental: `/` separates path steps and
 * `=` separates the find field from its value, so a raw free-text value (religion, free-text
 * gender) would fracture the grammar. The BE `unquote`s the find value — it is the authoritative
 * side of this seam, so do NOT drop the encode here.
 */
export function buildParametricValueSaveResourcePath(
  spreadId: string,
  imageId: string,
  value: string,
): string {
  return (
    `col:illustration/spread:${spreadId}/key:images/find:id=${imageId}` +
    `/key:parametric_slot/key:values/find:value=${encodeURIComponent(value)}`
  );
}

// ── API payload (01-visuals-tab.md §4.3) ──────────────────────────────────────

export interface BuildParametricPayloadArgs {
  slot: ItemParametricSlot;
  characters: Character[];
  sourceImageUrl: string;
  sourceValue: string;
  targetValue: string;
  prompt?: string;
  referenceImages?: Array<{ base64Data: string; mimeType: string }>;
  attribution?: { snapshotId?: string; remixId?: string };
  /** FULL directive path (already root-prepended by the opener via `withSnapshotRoot`). */
  saveResourcePath?: string;
}

/**
 * Build the generate request body. Returns `null` for a non-generatable axis (photo) so the
 * caller can bail BEFORE burning an AI call — the UI already disables the button there.
 * ⚠ Deliberately never sets `aspectRatio`: the server derives it from the source image.
 */
export function buildParametricPayload(
  args: BuildParametricPayloadArgs,
): GenerateParametricVariantPayload | null {
  const axis = axisFromKey(args.slot.key, args.characters);
  if (!axis) {
    log.debug('buildParametricPayload', 'axis not generatable, skip', { key: args.slot.key });
    return null;
  }

  const sourceValueLabel = labelFor(args.slot.key, args.sourceValue);
  const targetValueLabel = labelFor(args.slot.key, args.targetValue);
  const prompt = args.prompt?.trim();
  const saveResource: SaveResourceDirective | undefined = args.saveResourcePath
    ? { type: 'image_version', action: 'create', path: args.saveResourcePath }
    : undefined;

  return {
    ...axis,
    sourceImageUrl: args.sourceImageUrl,
    sourceValue: args.sourceValue,
    targetValue: args.targetValue,
    ...(sourceValueLabel ? { sourceValueLabel } : {}),
    ...(targetValueLabel ? { targetValueLabel } : {}),
    ...(prompt ? { prompt } : {}),
    ...(args.referenceImages?.length ? { referenceImages: args.referenceImages } : {}),
    imageSize: PARAMETRIC_IMAGE_SIZE,
    ...(args.attribution?.snapshotId ? { snapshotId: args.attribution.snapshotId } : {}),
    ...(args.attribution?.remixId ? { remixId: args.attribution.remixId } : {}),
    ...(saveResource ? { saveResource } : {}),
  };
}
