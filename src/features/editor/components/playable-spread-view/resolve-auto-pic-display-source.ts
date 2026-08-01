// resolve-auto-pic-display-source.ts
//
// SHARED-VERBATIM module — imported by the live player (player-spread-stage /
// editable-auto-pic), the Remotion video renderer (render-stage-renderers) AND
// the print export path. All three MUST resolve the effective static URL the
// SAME way so live ⇄ render ⇄ print stay parity-by-construction (ADR-035).
//
// ⚠ CONTRACT: `resolveEffectiveStaticUrl` MUST NEVER fall back to `media_url`.
//   `media_url` is the ANIMATED file (.webp/.webm/.lottie/.riv); a static edition
//   that borrowed it would print/render a broken or animated frame. The static
//   URL comes ONLY from `static_image` (final_hires → is_selected → [0]).

import type { Illustration } from '@/types/prop-types';
import type { SpreadAutoPic } from '@/types/spread-types';
import type { PlayEdition } from '@/types/playable-types';

export interface AutoPicStaticImage {
  illustrations: Illustration[];
  final_hires_media_url?: string;
}

export type AutoPicDisplaySource =
  | { mode: 'animated'; url: string }        // dynamic | interactive, has media_url
  | { mode: 'static'; url: string }          // classic, has effective static URL
  | { mode: 'missing-static' }               // classic, no static_image → placeholder | skip
  | { mode: 'empty' };                       // dynamic/interactive but no media_url → skip

/**
 * Effective static URL for an auto_pic. Priority:
 *   final_hires_media_url → illustrations[is_selected] → illustrations[0] → undefined.
 * Pure, no logging (called in render loops). NEVER falls back to `media_url`.
 */
export function resolveEffectiveStaticUrl(
  si?: AutoPicStaticImage,
): string | undefined {
  if (!si) return undefined;
  return (
    si.final_hires_media_url ||
    si.illustrations?.find((i) => i.is_selected)?.media_url ||
    si.illustrations?.[0]?.media_url ||
    undefined
  );
}

/**
 * Discriminated display source for an auto_pic under a given edition.
 *   classic → 'static' (has effective static URL) | 'missing-static'.
 *   dynamic | interactive → 'animated' (has media_url) | 'empty'.
 * Pure, no logging.
 */
export function resolveAutoPicDisplaySource(
  ap: SpreadAutoPic,
  edition: PlayEdition,
): AutoPicDisplaySource {
  if (edition === 'classic') {
    const url = resolveEffectiveStaticUrl(ap.static_image);
    return url ? { mode: 'static', url } : { mode: 'missing-static' };
  }
  return ap.media_url ? { mode: 'animated', url: ap.media_url } : { mode: 'empty' };
}
