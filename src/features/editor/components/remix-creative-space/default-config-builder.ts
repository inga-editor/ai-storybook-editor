// default-config-builder.ts — Pure helper to derive a fresh RemixConfig draft
// from the book-level BookRemix availability list.
//
// Reshape 2026-05-20/21: narrator singular → voices[] collection; characters[]
// carry per-trait toggles (traits[]) + a `base_image_url` slot for live swap.

import type { BookRemix } from '@/types/editor';
import type { RemixConfig } from '@/types/remix';
import { normalizeRemixTraits } from '@/constants/config-constants';

export function defaultConfigFromBookRemix(book: BookRemix): RemixConfig {
  return {
    characters: book.characters
      .filter((c) => c.is_enabled)
      .map((c) => ({
        key: c.key,
        human_id: null,
        visual: null,
        // Clone the book character's trait gate (5 canonical entries); a freshly
        // added character defaults every trait enabled (reader fills missing).
        traits: normalizeRemixTraits(c.traits).map((t) => ({
          type: t.type,
          is_enabled: t.is_enabled,
        })),
        base_image_url: null,
        is_enabled: true,
      })),
    // Reshape 2026-07-31: book.remix dropped props[] — new remixes seed an empty
    // props list (RemixConfig keeps the field so existing remix rows still parse).
    props: [],
    // Voice availability lives in book.voices[] (key='narrator' | <char.key>).
    // Concrete voice_id is chosen per-remix; name is materialized for fallback.
    voices: book.voices
      .filter((v) => v.is_enabled)
      .map((v) => ({
        key: v.key,
        name: v.name,
        voice_id: null,
        is_enabled: true,
      })),
    languages: book.languages
      .filter((l) => l.is_enabled)
      .map((l) => ({
        name: l.name,
        code: l.code,
        is_enabled: true,
      })),
  };
}

export function isBookRemixEmpty(book: BookRemix | null): boolean {
  if (!book) return true;
  // DELIBERATE: story/memories gates are NOT counted — the remix space has no
  // UI consuming them until the RemixConfigModal follow-up (reshape 2026-07-31).
  // A book enabling only story/memories still reads as "not configured" here.
  return (
    book.voices.every((v) => !v.is_enabled) &&
    book.characters.every((c) => !c.is_enabled) &&
    book.languages.every((l) => !l.is_enabled)
  );
}
