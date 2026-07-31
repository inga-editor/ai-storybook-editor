// text-swap-engine.ts — Phase 1 client-side text swap for createRemix.
// Pure function: swaps `character.name` → resolved `humans.display_name[lang]`
// across `illustration.spreads[].textboxes[lang].text` + each
// `textbox[lang].audio.chunks[].script`. Marks affected chunks
// `script_synced = false` so Phase 2 (audio regen) picks them up.
//
// Invariants (per Validation Session 1):
//   - DOES NOT mutate input.illustration (cloned via structuredClone).
//   - DOES NOT touch `langBlock.audio.combined_audio_url`,
//     `langBlock.audio.word_timings`, or `chunk.results[].url` — Phase 2 owns
//     audio regen invalidation. Player may speak old names briefly.
//   - Warning kinds: 5 (no `short_source_name` — false-positive risk on CJK).
//
// Spec: ai-storybook-design/component/stores/remix-store.md §10.

import type {
  RemixCharacter,
  RemixCharacterChoice,
  RemixIllustration,
  RemixSpread,
  TextSwapInput,
  TextSwapResult,
  TextSwapWarning,
} from '@/types/remix';
import type {
  SpreadTextbox,
  SpreadTextboxContent,
  TextboxAudio,
} from '@/types/spread-types';
import { escapeRegExp } from '@/utils/escape-regexp';
import { isTextboxContent } from '@/utils/spread-textbox-guards';
import { createLogger } from '@/utils/logger';
import { resolveDisplayName } from '@/features/humans/utils/display-name-helpers';

const log = createLogger('Remix', 'TextSwapEngine');

/** Languages without inter-word spaces — regex MUST NOT use boundary lookaround. */
export const NO_SPACE_LANGUAGES = new Set<string>([
  'zh_CN', 'zh_TW', 'ja_JP', 'ko_KR', 'th_TH', 'lo_LA', 'my_MM',
]);

type SwapMap = Record<string, Record<string, string>>;

/** Build per-language { source → target } swap map.
 *  Emits warnings inline for skipped/degenerate cases. */
function buildSwapMap(
  input: TextSwapInput,
  warnings: TextSwapWarning[],
): SwapMap {
  const map: SwapMap = {};
  const remixByKey = new Map<string, RemixCharacter>(
    input.remixCharacters.map((c) => [c.key, c]),
  );

  for (const cfg of input.configCharacters) {
    if (!cfg.is_enabled) continue;

    if (cfg.human_id === null) {
      warnings.push({ kind: 'no_human_picked', characterKey: cfg.key });
      continue;
    }

    const remixChar = remixByKey.get(cfg.key);
    if (!remixChar) continue; // orphan cfg — silent skip per spec §10.2

    // ⚠️ Amend 2026-07-31: a chosen actor plays a ROLE — the text uses the
    // displaced default's name, so the map (actorKey → narrative name) wins;
    // plain characters / kept defaults have no entry → their own name.
    const source = (input.castingNameMap[cfg.key] ?? remixChar.name ?? '').trim();
    if (source === '') {
      warnings.push({ kind: 'empty_source_name', characterKey: cfg.key });
      continue;
    }

    const human = input.humans[cfg.human_id];
    if (!human) {
      warnings.push({ kind: 'stale_human_fk', characterKey: cfg.key });
      continue;
    }

    for (const lang of input.enabledLanguages) {
      const target = resolveDisplayName(human, lang);
      if (!target || target === '') continue;

      if (target === source) {
        warnings.push({
          kind: 'no_op_swap',
          characterKey: cfg.key,
          language: lang,
          source,
        });
        continue;
      }

      if (!human.displayName?.[lang]) {
        warnings.push({
          kind: 'missing_display_name',
          characterKey: cfg.key,
          language: lang,
          target,
        });
      }

      const langMap = (map[lang] ??= {});
      if (langMap[source] !== undefined && langMap[source] !== target) {
        // Two config entries resolved the SAME source name (likelier since the
        // casting name map re-keys role names) — last write wins, surfaced.
        warnings.push({
          kind: 'duplicate_source',
          characterKey: cfg.key,
          language: lang,
          source,
          target,
        });
      }
      langMap[source] = target;
    }
  }

  return map;
}

/** Compile alternation regex for `sources` in `lang`. Sources sorted by length
 *  DESC so longer names match before shorter prefixes (e.g. "Maria" vs "Mar").
 *  Space langs use case-insensitive match (`i` flag) so "Anh nông dân" also
 *  catches "anh nông dân" / "ANH NÔNG DÂN". No-space langs (CJK) unchanged —
 *  no case concept. */
function buildPattern(lang: string, sources: string[]): RegExp | null {
  if (sources.length === 0) return null;

  const sorted = [...sources].sort((a, b) => b.length - a.length);
  const alternation = sorted.map(escapeRegExp).join('|');

  if (NO_SPACE_LANGUAGES.has(lang)) {
    return new RegExp(`(${alternation})`, 'gu');
  }

  return new RegExp(
    `(?<=^|\\s|\\p{P})(${alternation})(?=$|\\s|\\p{P})`,
    'giu',
  );
}

/** Build matched-string → target lookup. Space langs fold case (matched
 *  capture may differ from source key in case); no-space langs preserve
 *  exact lookup. Collision policy: last write wins (acceptable — two source
 *  names colliding under case-fold is degenerate config). */
function buildLookup(
  lang: string,
  langMap: Record<string, string>,
): (matched: string) => string | undefined {
  if (NO_SPACE_LANGUAGES.has(lang)) {
    return (m) => langMap[m];
  }
  const lower: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(langMap)) {
    lower[src.toLowerCase()] = tgt;
  }
  return (m) => lower[m.toLowerCase()];
}

/** Apply pattern to text. Returns new text + count of replacements. */
function applySwapToText(
  text: string,
  pattern: RegExp,
  lookup: (matched: string) => string | undefined,
): { newText: string; delta: number } {
  let delta = 0;
  const newText = text.replace(pattern, (match, source: string) => {
    const target = lookup(source);
    if (target === undefined) return match;
    delta++;
    return target;
  });
  return { newText, delta };
}

/** Recompute audio.is_sync rollup = chunks.every(script_synced && params_synced). */
function recomputeAudioIsSync(audio: TextboxAudio): void {
  const chunks = audio.chunks ?? [];
  audio.is_sync = chunks.every((c) => c.script_synced && c.params_synced);
}

/** Per-spread / textbox / lang apply loop. Mutates `cloned` in place. */
function applyToSpreads(
  spreads: RemixSpread[],
  patterns: Record<string, RegExp>,
  swapMap: SwapMap,
  enabledLanguages: string[],
): { matchCount: number; chunksMarkedUnsynced: number } {
  let matchCount = 0;
  let chunksMarkedUnsynced = 0;

  const lookups: Record<string, (m: string) => string | undefined> = {};
  for (const lang of enabledLanguages) {
    if (patterns[lang]) lookups[lang] = buildLookup(lang, swapMap[lang] ?? {});
  }

  for (const spread of spreads) {
    const textboxes: SpreadTextbox[] = spread.textboxes ?? [];
    for (const textbox of textboxes) {
      for (const lang of enabledLanguages) {
        const pattern = patterns[lang];
        if (!pattern) continue;

        const langBlock = (textbox as Record<string, unknown>)[lang];
        if (!isTextboxContent(langBlock)) continue;
        const content = langBlock as SpreadTextboxContent;
        const lookup = lookups[lang];

        if (content.text) {
          const { newText, delta } = applySwapToText(content.text, pattern, lookup);
          if (newText !== content.text) {
            content.text = newText;
            matchCount += delta;
          }
        }

        const audio = content.audio;
        if (audio?.chunks?.length) {
          for (const chunk of audio.chunks) {
            const { newText: newScript, delta } = applySwapToText(
              chunk.script,
              pattern,
              lookup,
            );
            if (newScript !== chunk.script) {
              chunk.script = newScript;
              chunk.script_synced = false;
              chunksMarkedUnsynced++;
              matchCount += delta;
            }
          }
          recomputeAudioIsSync(audio);
        }
      }
    }
  }

  return { matchCount, chunksMarkedUnsynced };
}

/** Pure function. Returns cloned illustration with swaps applied + warnings.
 *  Input is never mutated. Deterministic given same input. */
export function applyTextSwap(input: TextSwapInput): TextSwapResult {
  log.info('applyTextSwap', 'start', {
    charCount: input.configCharacters.length,
    langCount: input.enabledLanguages.length,
    spreadCount: input.illustration.spreads.length,
  });

  const warnings: TextSwapWarning[] = [];
  const swapMap = buildSwapMap(input, warnings);

  log.debug('applyTextSwap', 'swap map built', {
    languages: Object.keys(swapMap),
    totalEntries: Object.values(swapMap).reduce(
      (n, m) => n + Object.keys(m).length,
      0,
    ),
  });

  const patterns: Record<string, RegExp> = {};
  for (const lang of input.enabledLanguages) {
    const sources = Object.keys(swapMap[lang] ?? {});
    const pattern = buildPattern(lang, sources);
    if (pattern) patterns[lang] = pattern;
  }

  const cloned: RemixIllustration = structuredClone(input.illustration);
  const { matchCount, chunksMarkedUnsynced } = applyToSpreads(
    cloned.spreads,
    patterns,
    swapMap,
    input.enabledLanguages,
  );

  for (const w of warnings) {
    log.warn('applyTextSwap', 'warning', {
      kind: w.kind,
      characterKey: w.characterKey,
      language: w.language,
    });
  }

  log.info('applyTextSwap', 'done', {
    matchCount,
    chunksMarkedUnsynced,
    warningCount: warnings.length,
  });

  return { illustration: cloned, warnings, matchCount, chunksMarkedUnsynced };
}

// Type-only re-export for consumer convenience.
export type { RemixCharacterChoice };
