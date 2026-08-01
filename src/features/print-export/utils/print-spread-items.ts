// print-spread-items.ts — Pure item-filter predicates for the static print render.
//
// Extracted from PrintSpreadCanvas so the "which items get printed" rules are
// unit-testable without mounting GSAP/Rive-heavy Editable* components. Mirrors
// the player-canvas static filters exactly: hidden (player_visible===false),
// outside staging, off-edition composite variants, and empty (no URL / no text).
import type { PlayableSpread } from "@/types/playable-types";
import type { SpreadTextboxContent } from "@/types/spread-types";
import { isInStaging } from "@/features/editor/components/playable-spread-view/player-utils";
import { resolveEffectiveStaticUrl } from "@/features/editor/components/playable-spread-view/resolve-auto-pic-display-source";
import {
  isVariantInAnyComposite,
  type CompositeContext,
} from "@/features/editor/utils/composite-resolve-helpers";
import { getTextboxContentForLanguage } from "@/features/editor/utils/textbox-helpers";

type SpreadImage = NonNullable<PlayableSpread["images"]>[number];
type SpreadShape = NonNullable<PlayableSpread["shapes"]>[number];
type SpreadTextbox = NonNullable<PlayableSpread["textboxes"]>[number];
type SpreadAutoPic = NonNullable<PlayableSpread["auto_pics"]>[number];

/** True when an image should be rendered for print. */
export function shouldRenderPrintImage(
  image: SpreadImage,
  composites: PlayableSpread["composites"],
  compositeCtxMap: Map<string, CompositeContext>
): boolean {
  if (image.player_visible === false) return false;
  if (!isInStaging(image.geometry)) return false;
  // Off-edition composite variant → not part of the 'classic' frame.
  const compositeCtx = compositeCtxMap.get(image.id);
  if (!compositeCtx && isVariantInAnyComposite({ composites }, image.id)) {
    return false;
  }
  const hasUrl =
    image.final_hires_media_url ||
    image.illustrations?.some((i) => i.media_url) ||
    image.media_url;
  return Boolean(hasUrl);
}

/** Wrap an auto_pic into a SpreadImage shape so it can reuse EditableImage's
 *  URL-resolve chain (final_hires → is_selected → [0]) at print time.
 *  ⚠ `media_url` MUST be undefined — the animated file (webp/webm/lottie/riv)
 *  must NEVER be embedded into the PDF; if left set, EditableImage's resolve
 *  chain would fall back to it. */
export function autoPicAsStaticImage(ap: SpreadAutoPic): SpreadImage {
  return {
    id: ap.id,
    geometry: ap.geometry,
    "z-index": ap["z-index"],
    player_visible: ap.player_visible,
    editor_visible: ap.editor_visible,
    title: ap.title,
    illustrations: ap.static_image?.illustrations ?? [],
    final_hires_media_url: ap.static_image?.final_hires_media_url,
    media_url: undefined, // ⚠ animated file never prints
  };
}

/** Print decision for an auto_pic — lets the caller distinguish the skip reason
 *  (warn on 'skip-missing-static' — an item that SHOULD show but has no static;
 *  debug on 'skip-hidden' — hidden/culled/off-edition, expected). */
export type PrintAutoPicDecision = "render" | "skip-missing-static" | "skip-hidden";

export function decidePrintAutoPic(
  autoPic: SpreadAutoPic,
  composites: PlayableSpread["composites"],
  compositeCtxMap: Map<string, CompositeContext>
): PrintAutoPicDecision {
  if (autoPic.player_visible === false) return "skip-hidden";
  if (!isInStaging(autoPic.geometry)) return "skip-hidden";
  const compositeCtx = compositeCtxMap.get(autoPic.id);
  if (!compositeCtx && isVariantInAnyComposite({ composites }, autoPic.id)) {
    return "skip-hidden";
  }
  // On-edition + visible + in-staging: the only remaining gate is static URL.
  if (!resolveEffectiveStaticUrl(autoPic.static_image)) return "skip-missing-static";
  return "render";
}

/** True when an auto_pic should be rendered for print. Same rule-set as
 *  shouldRenderPrintImage, but the URL comes from `static_image` (never the
 *  animated media_url). */
export function shouldRenderPrintAutoPic(
  autoPic: SpreadAutoPic,
  composites: PlayableSpread["composites"],
  compositeCtxMap: Map<string, CompositeContext>
): boolean {
  return decidePrintAutoPic(autoPic, composites, compositeCtxMap) === "render";
}

/** True when a shape should be rendered for print. */
export function shouldRenderPrintShape(shape: SpreadShape): boolean {
  if (shape.player_visible === false) return false;
  if (!isInStaging(shape.geometry)) return false;
  return true;
}

/** Resolve printable textboxes for the given language: visible, non-empty,
 *  in-staging — with the language-resolved content. */
export function resolvePrintTextboxes(
  textboxes: SpreadTextbox[] | undefined,
  languageKey: string
): Array<{ textbox: SpreadTextbox; data: SpreadTextboxContent }> {
  if (!textboxes) return [];
  const out: Array<{ textbox: SpreadTextbox; data: SpreadTextboxContent }> = [];
  for (const textbox of textboxes) {
    if (textbox.player_visible === false) continue;
    const result = getTextboxContentForLanguage(textbox, languageKey);
    if (!result?.content?.geometry) continue;
    if (!result.content.text) continue;
    if (!isInStaging(result.content.geometry)) continue;
    out.push({ textbox, data: result.content });
  }
  return out;
}
