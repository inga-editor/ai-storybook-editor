// sprite-swap-gating.ts — Pure swap-precondition resolver for the Variants tab
// (sprite plane). Sibling of `batch-swap-gating.ts`.
//
// CONTRACT (design §7): a sprite can only be swapped when EVERY enabled
// CHARACTER in its lineup has a COMPLETE swap config — a picked human, a picked
// visual, a resolved converted image, and ≥1 enabled trait (job 02 needs all of
// these; a partial config would slip through and fail server-side with
// MISSING_OBJECT_CONFIG). char-only v1 — props never gate.

import type { Human } from '@/types/human';
import type { Remix, RemixSprite } from '@/types/remix';
import {
  hasCompleteSwapConfig,
  spriteLineupObjects,
  type RemixConfigCharacterView,
} from '@/stores/remix-store';

/**
 * Build the per-character swap-config view map for a remix (frozen
 * `remix_config.characters` joined with the live humans cache for
 * `converted_image`). Mirrors the `useRemixConfigCharacter` selector but resolves
 * ALL characters in one pass so the tab can gate the whole lineup without a hook
 * loop. Pure — caller passes `useHumans()` output.
 */
export function buildSwapConfigViews(
  remix: Remix,
  humans: Human[],
): Map<string, RemixConfigCharacterView> {
  const map = new Map<string, RemixConfigCharacterView>();
  for (const cfg of remix.remix_config.characters) {
    // ⚡2026-08-06 — skip text-only personalize entries (no `traits` key): they
    // are NOT visual-swappable, so they never gate a sprite lineup.
    if (cfg.traits == null) continue;
    let convertedImage: string | null = null;
    if (cfg.human_id && cfg.visual) {
      const human = humans.find((h) => h.id === cfg.human_id);
      convertedImage =
        human?.visualProfiles.find((vp) => vp.name === cfg.visual)
          ?.convertedImage ?? null;
    }
    map.set(cfg.key, {
      human_id: cfg.human_id,
      visual: cfg.visual,
      traits: cfg.traits,
      converted_image: convertedImage,
    });
  }
  return map;
}

/** Lineup character object_keys of a sprite that still lack a complete swap
 *  config. Empty → the precondition is satisfied for every character. */
export function missingSwapConfigObjects(
  sprite: RemixSprite,
  viewByKey: ReadonlyMap<string, RemixConfigCharacterView>,
): string[] {
  return spriteLineupObjects(sprite).filter(
    (key) => !hasCompleteSwapConfig(viewByKey.get(key) ?? null),
  );
}
