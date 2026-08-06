// text-swap-engine.test.ts — Unit tests for applyTextSwap pure function.
// Covers spec §10.5 (space-lang), §10.6 (no-space), §10.7 (idempotency),
// 5 warning kinds, audio chunk swap + is_sync rollup, audio invariants,
// purity (input not mutated).

import { describe, it, expect } from 'vitest';
import { applyTextSwap } from './text-swap-engine';
import type {
  RemixCharacter,
  RemixCharacterChoice,
  RemixIllustration,
  RemixSpread,
  TextSwapInput,
} from '@/types/remix';
import type {
  SpreadTextbox,
  SpreadTextboxContent,
  TextboxAudio,
  TextboxAudioChunk,
} from '@/types/spread-types';
import type { Human } from '@/types/human';

// ── Fixture builders ─────────────────────────────────────────────────────────

function makeHuman(
  id: string,
  sourceName: string,
  displayName: Record<string, string> = {},
): Human {
  return {
    id,
    sourceName,
    displayName,
    gender: null,
    zodiac: null,
    country: null,
    description: null,
    visualProfiles: [],
    voiceProfiles: [],
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeChunk(
  script: string,
  opts: { script_synced?: boolean; params_synced?: boolean } = {},
): TextboxAudioChunk {
  return {
    voice_id: 'v1',
    script,
    stability: 0.5,
    similarity: 0.5,
    exaggeration: 0,
    speed: 1,
    script_synced: opts.script_synced ?? true,
    params_synced: opts.params_synced ?? true,
    results: [],
  };
}

function makeAudio(chunks: TextboxAudioChunk[], opts: {
  combined_audio_url?: string | null;
  is_sync?: boolean;
} = {}): TextboxAudio {
  return {
    is_sync: opts.is_sync ?? true,
    combined_audio_url: opts.combined_audio_url ?? null,
    word_timings: [],
    chunks,
  };
}

function makeContent(text: string, audio?: TextboxAudio): SpreadTextboxContent {
  return {
    text,
    geometry: { x: 0, y: 0, w: 50, h: 20 },
    typography: {},
    ...(audio ? { audio } : {}),
  };
}

function makeTextbox(
  id: string,
  perLang: Record<string, SpreadTextboxContent>,
): SpreadTextbox {
  return { id, ...perLang } as unknown as SpreadTextbox;
}

function makeSpread(id: string, textboxes: SpreadTextbox[]): RemixSpread {
  return {
    id,
    pages: [{ number: 1, type: 'normal_page', layout: null, background: { color: '#fff', texture: null } }],
    images: [],
    textboxes,
  } as unknown as RemixSpread;
}

function makeIllustration(spreads: RemixSpread[]): RemixIllustration {
  return { spreads, sections: [] };
}

function makeRemixChar(key: string, name: string): RemixCharacter {
  return {
    key,
    name,
    description: '',
    variants: [],
  } as unknown as RemixCharacter;
}

function makeConfigChar(
  key: string,
  human_id: string | null,
  is_enabled = true,
): RemixCharacterChoice {
  return { key, human_id, visual: null, traits: [], base_image_url: null, is_enabled };
}

interface BuildInputOpts {
  spreads?: RemixSpread[];
  remixCharacters?: RemixCharacter[];
  configCharacters?: RemixCharacterChoice[];
  humans?: Human[];
  enabledLanguages?: string[];
  castingNameMap?: Record<string, string>;
  /** ⚡2026-08-06 — book `params.name` gate. Defaults to ALL config char keys
   *  (name-swap ON), preserving pre-per-param behavior for existing cases. */
  nameGateKeys?: Set<string>;
}

function makeInput(opts: BuildInputOpts = {}): TextSwapInput {
  const configCharacters = opts.configCharacters ?? [];
  return {
    illustration: makeIllustration(opts.spreads ?? []),
    remixCharacters: opts.remixCharacters ?? [],
    configCharacters,
    enabledLanguages: opts.enabledLanguages ?? ['vi_VN'],
    humans: Object.fromEntries((opts.humans ?? []).map((h) => [h.id, h])),
    castingNameMap: opts.castingNameMap ?? {},
    nameGateKeys: opts.nameGateKeys ?? new Set(configCharacters.map((c) => c.key)),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('applyTextSwap', () => {
  // ── buildSwapMap warnings ───────────────────────────────────────────────

  describe('buildSwapMap warnings', () => {
    it('emits no_human_picked when cfg.human_id is null', () => {
      const result = applyTextSwap(makeInput({
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', null)],
        humans: [],
      }));
      expect(result.warnings).toContainEqual({ kind: 'no_human_picked', characterKey: 'c1' });
    });

    it('emits stale_human_fk when humans cache missing', () => {
      const result = applyTextSwap(makeInput({
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h-missing')],
        humans: [],
      }));
      expect(result.warnings).toContainEqual({ kind: 'stale_human_fk', characterKey: 'c1' });
    });

    it('emits missing_display_name when human.displayName[lang] missing → fallback to en_US', () => {
      const result = applyTextSwap(makeInput({
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Charlie', { en_US: 'Charlie' })],
        enabledLanguages: ['vi_VN'],
      }));
      expect(result.warnings.some((w) => w.kind === 'missing_display_name' && w.language === 'vi_VN')).toBe(true);
    });

    it('emits no_op_swap when target === source', () => {
      const result = applyTextSwap(makeInput({
        remixCharacters: [makeRemixChar('c1', 'Charlie')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Charlie', { vi_VN: 'Charlie' })],
      }));
      expect(result.warnings.some((w) => w.kind === 'no_op_swap')).toBe(true);
    });

    it('emits empty_source_name when source.trim() is empty', () => {
      const result = applyTextSwap(makeInput({
        remixCharacters: [makeRemixChar('c1', '   ')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Charlie', { vi_VN: 'Charlie' })],
      }));
      expect(result.warnings).toContainEqual({ kind: 'empty_source_name', characterKey: 'c1' });
    });

    it('silent skip when cfg.is_enabled is false', () => {
      const result = applyTextSwap(makeInput({
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1', false)],
        humans: [makeHuman('h1', 'Charlie', { vi_VN: 'Charlie' })],
      }));
      expect(result.warnings).toHaveLength(0);
    });

    it('silent skip when orphan cfg (no remixChar)', () => {
      const result = applyTextSwap(makeInput({
        remixCharacters: [],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Charlie', { vi_VN: 'Charlie' })],
      }));
      expect(result.warnings).toHaveLength(0);
    });

    it('does NOT emit warning for 2-char CJK source name (regression guard)', () => {
      const result = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { zh_CN: makeContent('小猫跑了') })])],
        remixCharacters: [makeRemixChar('c1', '小猫')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', '小猫', { zh_CN: '咪咪' })],
        enabledLanguages: ['zh_CN'],
      }));
      expect(result.warnings.some((w) => w.characterKey === 'c1' && w.kind !== 'no_op_swap')).toBe(false);
    });
  });

  // ── Casting name map (amend 2026-07-31 — actor rows swap the ROLE name) ──

  describe('castingNameMap source resolution', () => {
    it('actor row swaps the displaced default NAME, not the actor name', () => {
      // c3 (actor "Leo") plays the role of "Miu" — text mentions Miu only.
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy đi.') })])],
        remixCharacters: [makeRemixChar('c3', 'Leo')],
        configCharacters: [makeConfigChar('c3', 'h1')],
        humans: [makeHuman('h1', 'Sophie', { vi_VN: 'Sophie' })],
        castingNameMap: { c3: 'Miu' },
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.text).toBe('Sophie chạy đi.');
      expect(r.matchCount).toBe(1);
    });

    it('emits duplicate_source when two entries resolve the same source (last write wins)', () => {
      // c1 keeps its own name "Miu"; c3 plays the role of "Miu" via the map →
      // both target source "Miu" with different humans.
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy đi.') })])],
        remixCharacters: [makeRemixChar('c1', 'Miu'), makeRemixChar('c3', 'Leo')],
        configCharacters: [makeConfigChar('c1', 'h1'), makeConfigChar('c3', 'h2')],
        humans: [
          makeHuman('h1', 'Sophie', { vi_VN: 'Sophie' }),
          makeHuman('h2', 'Bob', { vi_VN: 'Bob' }),
        ],
        castingNameMap: { c3: 'Miu' },
      }));
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ kind: 'duplicate_source', characterKey: 'c3', source: 'Miu' }),
      );
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.text).toBe('Bob chạy đi.'); // last write (c3) wins
    });

    it('key absent from the map falls back to the character own name', () => {
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy đi.') })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Sophie', { vi_VN: 'Sophie' })],
        castingNameMap: {},
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.text).toBe('Sophie chạy đi.');
    });
  });

  // ── Name gate (⚡2026-08-06 — params.name) ───────────────────────────────

  describe('nameGateKeys (params.name gate)', () => {
    it('key NOT in the gate → ORIGINAL name kept, no swap, no warning', () => {
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy đi.') })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Sophie', { vi_VN: 'Sophie' })],
        nameGateKeys: new Set(), // name param OFF for every character
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.text).toBe('Miu chạy đi.'); // unchanged
      expect(r.matchCount).toBe(0);
      expect(r.warnings).toHaveLength(0); // gated-out → silent, not a warning
    });

    it('key in the gate → swap runs (baseline parity)', () => {
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy đi.') })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Sophie', { vi_VN: 'Sophie' })],
        nameGateKeys: new Set(['c1']),
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.text).toBe('Sophie chạy đi.');
      expect(r.matchCount).toBe(1);
    });
  });

  // ── Space-lang boundaries (§10.5) ───────────────────────────────────────

  describe('space-language boundaries (vi_VN)', () => {
    function runSpaceSwap(text: string, source: string, target = 'Sophie') {
      return applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent(text) })])],
        remixCharacters: [makeRemixChar('c1', source)],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', target, { vi_VN: target })],
      }));
    }

    function textOf(input: ReturnType<typeof runSpaceSwap>): string {
      const tb = input.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      return tb.vi_VN.text;
    }

    it('matches at start of text', () => {
      const r = runSpaceSwap('Miu chạy đi.', 'Miu');
      expect(textOf(r)).toBe('Sophie chạy đi.');
      expect(r.matchCount).toBe(1);
    });

    it('matches multi-word source after punctuation', () => {
      const r = runSpaceSwap('Mèo Mun, hãy ngủ.', 'Mèo Mun');
      expect(textOf(r)).toBe('Sophie, hãy ngủ.');
    });

    it('matches after comma + space', () => {
      const r = runSpaceSwap('Hello, Miu!', 'Miu');
      expect(textOf(r)).toBe('Hello, Sophie!');
    });

    it('rejects partial match in middle of word', () => {
      const r = runSpaceSwap('Miumiu meow', 'Miu');
      expect(textOf(r)).toBe('Miumiu meow');
      expect(r.matchCount).toBe(0);
    });

    it('rejects when followed by letter (Mar vs Maria)', () => {
      const r = runSpaceSwap('Maria runs', 'Mar');
      expect(textOf(r)).toBe('Maria runs');
    });

    it('matches inside parentheses', () => {
      const r = runSpaceSwap('(Miu)', 'Miu');
      expect(textOf(r)).toBe('(Sophie)');
    });

    it('matches before hyphen punctuation', () => {
      const r = runSpaceSwap('Mèo Mun-Mun', 'Mèo Mun');
      expect(textOf(r)).toBe('Sophie-Mun');
    });

    it('case-insensitive: lowercase variant of source matches', () => {
      const r = runSpaceSwap('anh nông dân chạy.', 'Anh nông dân');
      expect(textOf(r)).toBe('Sophie chạy.');
      expect(r.matchCount).toBe(1);
    });

    it('case-insensitive: ALL CAPS variant matches', () => {
      const r = runSpaceSwap('MIU chạy đi.', 'Miu');
      expect(textOf(r)).toBe('Sophie chạy đi.');
    });

    it('case-insensitive: mixed-case variant matches', () => {
      const r = runSpaceSwap('Hello, mIu!', 'Miu');
      expect(textOf(r)).toBe('Hello, Sophie!');
    });

    it('case-insensitive: replacement preserves target literal case (not input case)', () => {
      const r = runSpaceSwap('miu and MIU', 'Miu', 'Sophie');
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.text).toBe('Sophie and Sophie');
    });

    it('case-insensitive: still respects punctuation boundary (no partial)', () => {
      const r = runSpaceSwap('miumiu meow', 'Miu');
      expect(textOf(r)).toBe('miumiu meow');
    });

    it('alternation prefers longer name (Mia vs Mar in "Maria và Mia")', () => {
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Maria và Mia') })])],
        remixCharacters: [makeRemixChar('c1', 'Mia'), makeRemixChar('c2', 'Mar')],
        configCharacters: [makeConfigChar('c1', 'h1'), makeConfigChar('c2', 'h2')],
        humans: [
          makeHuman('h1', 'Mia', { vi_VN: 'Linh' }),
          makeHuman('h2', 'Mar', { vi_VN: 'Tâm' }),
        ],
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.text).toBe('Maria và Linh');
    });
  });

  // ── No-space languages (§10.6) ──────────────────────────────────────────

  describe('no-space languages (zh_CN)', () => {
    function runZh(text: string, source: string, target = '咪咪') {
      return applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { zh_CN: makeContent(text) })])],
        remixCharacters: [makeRemixChar('c1', source)],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', source, { zh_CN: target })],
        enabledLanguages: ['zh_CN'],
      }));
    }

    function textOf(input: ReturnType<typeof runZh>): string {
      const tb = input.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      return tb.zh_CN.text;
    }

    it('matches plain substring', () => {
      const r = runZh('小猫跑了。', '小猫');
      expect(textOf(r)).toBe('咪咪跑了。');
    });

    it('partial overlap accepted per spec (no boundary check)', () => {
      const r = runZh('小猫咪', '小猫');
      expect(textOf(r)).toBe('咪咪咪');
      expect(r.matchCount).toBe(1);
    });

    it('matches multiple occurrences in same text', () => {
      const r = runZh('小猫和小猫的朋友', '小猫');
      expect(textOf(r)).toBe('咪咪和咪咪的朋友');
      expect(r.matchCount).toBe(2);
    });
  });

  // ── Audio chunks ────────────────────────────────────────────────────────

  describe('audio chunks', () => {
    it('swaps chunk.script and flips script_synced to false', () => {
      const audio = makeAudio([makeChunk('Miu nói xin chào.', { script_synced: true })]);
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('placeholder', audio) })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.audio!.chunks[0].script).toBe('Sophie nói xin chào.');
      expect(tb.vi_VN.audio!.chunks[0].script_synced).toBe(false);
      expect(r.chunksMarkedUnsynced).toBe(1);
    });

    it('leaves chunks without source name untouched', () => {
      const audio = makeAudio([makeChunk('Một cái cây cao.', { script_synced: true })]);
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('x', audio) })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.audio!.chunks[0].script_synced).toBe(true);
      expect(r.chunksMarkedUnsynced).toBe(0);
    });

    it('audio.is_sync becomes false when any chunk flipped', () => {
      const audio = makeAudio([
        makeChunk('Miu chào.', { script_synced: true }),
        makeChunk('Cây cao.', { script_synced: true }),
      ], { is_sync: true });
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('x', audio) })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.audio!.is_sync).toBe(false);
    });

    it('audio.is_sync stays true when no chunk changes (recompute from rollup)', () => {
      const audio = makeAudio([makeChunk('Cây cao.', { script_synced: true, params_synced: true })], { is_sync: true });
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('x', audio) })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      // No chunk changed → recompute reads rollup as true.
      expect(tb.vi_VN.audio!.is_sync).toBe(true);
    });

    it('does NOT mutate combined_audio_url, word_timings, or results[].url', () => {
      const audio = makeAudio(
        [{
          ...makeChunk('Miu chào.'),
          results: [{
            url: 'https://cdn/stale.mp3',
            word_timings: [{ text: 'Miu', startMs: 0, endMs: 100, charStart: 0, charEnd: 3 }],
            raw_alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
            created_time: '2026-01-01T00:00:00Z',
            is_selected: true,
          }],
        }],
        { combined_audio_url: 'https://cdn/stale-combined.mp3' },
      );
      audio.word_timings = [{ text: 'Miu', startMs: 0, endMs: 100, charStart: 0, charEnd: 3 }];

      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('x', audio) })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      expect(tb.vi_VN.audio!.combined_audio_url).toBe('https://cdn/stale-combined.mp3');
      expect(tb.vi_VN.audio!.word_timings).toEqual([{ text: 'Miu', startMs: 0, endMs: 100, charStart: 0, charEnd: 3 }]);
      expect(tb.vi_VN.audio!.chunks[0].results[0].url).toBe('https://cdn/stale.mp3');
    });
  });

  // ── Counters ────────────────────────────────────────────────────────────

  describe('counters', () => {
    it('matchCount counts replacements in text + chunks', () => {
      const audio = makeAudio([makeChunk('Miu chào Miu.')]);
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy.', audio) })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      }));
      // 1 in text + 2 in chunk script.
      expect(r.matchCount).toBe(3);
    });
  });

  // ── Idempotency (§10.7) ─────────────────────────────────────────────────

  describe('idempotency', () => {
    it('second run on swapped output yields zero matches', () => {
      const input = makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy.') })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      });
      const r1 = applyTextSwap(input);
      const r2 = applyTextSwap({ ...input, illustration: r1.illustration });
      expect(r1.matchCount).toBe(1);
      expect(r2.matchCount).toBe(0);
    });

    it('length-DESC alternation prevents target overlap chain', () => {
      // "Mar" → "Margaret"; another char source = "Margaret"
      // Should NOT double-swap because longer "Margaret" matches first.
      const r = applyTextSwap(makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Margaret và Mar') })])],
        remixCharacters: [makeRemixChar('c1', 'Mar'), makeRemixChar('c2', 'Margaret')],
        configCharacters: [makeConfigChar('c1', 'h1'), makeConfigChar('c2', 'h2')],
        humans: [
          makeHuman('h1', 'Mar', { vi_VN: 'Margaret' }),
          makeHuman('h2', 'Margaret', { vi_VN: 'Anna' }),
        ],
      }));
      const tb = r.illustration.spreads[0].textboxes![0] as Record<string, SpreadTextboxContent>;
      // "Margaret" → "Anna" (longer matches first), "Mar" → "Margaret".
      expect(tb.vi_VN.text).toBe('Anna và Margaret');
    });
  });

  // ── Purity ──────────────────────────────────────────────────────────────

  describe('purity', () => {
    it('does not mutate input illustration', () => {
      const input = makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy.') })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      });
      const before = structuredClone(input.illustration);
      applyTextSwap(input);
      expect(input.illustration).toEqual(before);
    });

    it('same input yields deep-equal output across two calls', () => {
      const input = makeInput({
        spreads: [makeSpread('s1', [makeTextbox('tb1', { vi_VN: makeContent('Miu chạy.') })])],
        remixCharacters: [makeRemixChar('c1', 'Miu')],
        configCharacters: [makeConfigChar('c1', 'h1')],
        humans: [makeHuman('h1', 'Miu', { vi_VN: 'Sophie' })],
      });
      const r1 = applyTextSwap(input);
      const r2 = applyTextSwap(input);
      expect(r1.illustration).toEqual(r2.illustration);
      expect(r1.matchCount).toBe(r2.matchCount);
    });
  });
});
