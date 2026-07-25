// sketch-image-modal-adapters.ts — pure adapters bridging the sketch snapshot shape to the
// SHARED Edit/Extract image modals (which speak the illustration/SpreadImage shapes). Kept
// standalone (out of the canvas component) so they stay side-effect-free and unit-testable.
//
// caller-owns-write: the modals never touch the sketch store. Edit emits the full illustration
// list (onUpdateIllustrations); Extract emits ExtractResult[] (onCreateImages). The canvas reads
// the resolved url + provenance out of those and appends a NEW page-image version via
// addSketchSpreadImageVersion — these adapters only do the shape/url/provenance math.

import type { Illustration, IllustrationType } from '@/types/prop-types';
import type { Geometry, SpreadImage } from '@/types/spread-types';
import type { SketchSpreadIllustration, SketchSpreadImage } from '@/types/sketch';

/**
 * Seed the Edit modal: SketchSpreadIllustration[] → Illustration[]. Field-for-field — both shapes
 * are the same Illustration Entry (DB-CHANGELOG 2026-07-23), so ALL 6 fields copy through,
 * provenance included (`type`/`original_url`/`ai_request_id`).
 *
 * Copy is **omit-if-absent**: a field missing on the source stays missing on the output (never a
 * literal `undefined` key, never a fabricated default). The modal keeps its own coerce-on-read
 * (`coerceIllustrationType` → absent `type` reads as 'created'), and provenance features degrade
 * on absence rather than on a wrong value:
 *   • `ai_request_id` — feeds the Inpaint reference-image picker (§8.7); dropping it pinned this
 *     space at `status='idle'` forever (GAP as-built #18).
 *   • `type`/`original_url` — feed the Compare toggle + the §8.3 reverse-lookup chain.
 */
export function toIllustrations(sketchIllus: SketchSpreadIllustration[]): Illustration[] {
  return sketchIllus.map((i) => ({
    media_url: i.media_url,
    created_time: i.created_time,
    is_selected: i.is_selected,
    ...(i.type ? { type: i.type } : {}),
    ...(i.original_url ? { original_url: i.original_url } : {}),
    ...(i.ai_request_id ? { ai_request_id: i.ai_request_id } : {}),
  }));
}

/** Provenance metadata riding along with ONE new version appended from the Edit modal.
 *  Mirrors the Illustration Entry provenance triple; every field optional + omitted when absent
 *  so a non-AI commit (Erasor upload, CV crop) writes no empty keys. */
export interface PersistVersionMeta {
  /** Soft ref → ai_service_logs.id (absent for erasor upload / remove-bg / crop). */
  aiRequestId?: string;
  /** 'edited' for an Edit-modal commit; absent for callers that don't classify. */
  type?: IllustrationType;
  /** Pre-edit source URL → Compare toggle + §8.3 reverse-lookup chain. */
  originalUrl?: string;
}

export type EditCommit =
  | ({ kind: 'append'; url: string } & PersistVersionMeta)
  | { kind: 'select'; url: string }
  | { kind: 'noop' };

/**
 * Classify an Edit modal commit (onUpdateIllustrations) into the store write it implies. The modal
 * fires onUpdateIllustrations for BOTH a fresh edit AND any variant re-selection — a sketch page
 * image versions its variants with `is_selected`, so the two cases need different writes:
 *   • 'append' — the selected url is NOT among `existingUrls` → a genuinely new edited version;
 *                append it (addSketchSpreadImageVersion). Dedupe is against the WHOLE known list.
 *   • 'select' — the selected url IS an existing version → the user re-picked an older variant;
 *                flip is_selected (selectSketchSpreadImageVersion). Without this the re-selection
 *                was silently dropped and the sidebar highlight snapped back to the head version.
 *   • 'noop'   — empty list / no url on the selected (or first) entry.
 *
 * The 'append' branch also carries the entry's provenance so the store write can persist it
 * (omit-if-absent — see PersistVersionMeta). 'select'/'noop' carry none: re-selecting an EXISTING
 * version must not rewrite its metadata.
 */
export function classifyEditCommit(
  next: Illustration[],
  existingUrls: readonly string[],
): EditCommit {
  const selected = next.find((i) => i.is_selected) ?? next[0];
  const url = selected?.media_url ?? null;
  if (!url) return { kind: 'noop' };
  if (existingUrls.includes(url)) return { kind: 'select', url };
  return {
    kind: 'append',
    url,
    // Optional-chained: `selected` is non-null once `url` exists, but the guard is free insurance
    // (`?? next[0]` is only type-safe because noUncheckedIndexedAccess is off).
    ...(selected?.ai_request_id ? { aiRequestId: selected.ai_request_id } : {}),
    ...(selected?.type ? { type: selected.type } : {}),
    ...(selected?.original_url ? { originalUrl: selected.original_url } : {}),
  };
}

/**
 * Adapt a sketch page image to the `SpreadImage` the Extract modal consumes. Only the fields the
 * crop tab needs are synthesized: stable `id`, the locked per-page `geometry`, the effective
 * `media_url` (source to crop), and the variant `illustrations`.
 */
export function toSpreadImage(
  sketchImg: SketchSpreadImage,
  geometry: Geometry,
  url: string | null,
): SpreadImage {
  return {
    id: sketchImg.id,
    geometry,
    media_url: url ?? undefined,
    illustrations: toIllustrations(sketchImg.illustrations),
  };
}
