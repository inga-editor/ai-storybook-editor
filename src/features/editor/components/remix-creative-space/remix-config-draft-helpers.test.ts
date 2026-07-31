// remix-config-draft-helpers.test.ts — pure-reducer coverage: upsert-vs-insert
// by identity key, patch merge, and input immutability.

import { describe, it, expect } from 'vitest';
import {
  upsertPresetChoice,
  upsertBranchChoice,
  upsertCharacterChoice,
  upsertVoiceChoice,
  upsertLanguageChoice,
  patchMemories,
} from './remix-config-draft-helpers';
import { TRAIT_TYPES } from '@/constants/trait-constants';
import type { RemixConfig } from '@/types/remix';

function baseConfig(): RemixConfig {
  return {
    story: {
      presets: [{ axis_id: 'ax1', preset_id: 'p1' }],
      branches: [{ spread_id: 's1', section_id: 'sec1' }],
    },
    characters: [
      {
        key: 'c1',
        human_id: null,
        visual: null,
        traits: TRAIT_TYPES.map((type) => ({ type, is_enabled: true })),
        base_image_url: null,
        is_enabled: true,
      },
    ],
    memories: { is_enabled: false, style: 'styled', photos: [] },
    voices: [{ key: 'narrator', name: 'Narrator', voice_id: null, is_enabled: true }],
    languages: [{ name: 'English', code: 'en', is_enabled: true }],
  };
}

const frozen = () => JSON.parse(JSON.stringify(baseConfig()));

describe('upsertPresetChoice', () => {
  it('updates an existing axis entry (no duplicate)', () => {
    const cfg = baseConfig();
    const out = upsertPresetChoice(cfg, 'ax1', 'p2');
    expect(out.story.presets).toEqual([{ axis_id: 'ax1', preset_id: 'p2' }]);
    expect(cfg).toEqual(frozen()); // immutable
  });
  it('inserts a new axis entry', () => {
    const out = upsertPresetChoice(baseConfig(), 'ax2', 'pX');
    expect(out.story.presets).toContainEqual({ axis_id: 'ax2', preset_id: 'pX' });
    expect(out.story.presets).toHaveLength(2);
  });
});

describe('upsertBranchChoice', () => {
  it('updates an existing spread entry', () => {
    const out = upsertBranchChoice(baseConfig(), 's1', 'sec2');
    expect(out.story.branches).toEqual([{ spread_id: 's1', section_id: 'sec2' }]);
  });
  it('inserts a new spread entry', () => {
    const out = upsertBranchChoice(baseConfig(), 's2', 'secX');
    expect(out.story.branches).toHaveLength(2);
  });
});

describe('upsertCharacterChoice', () => {
  it('patch-merges an existing character', () => {
    const out = upsertCharacterChoice(baseConfig(), 'c1', { human_id: 'h9', is_enabled: false });
    expect(out.characters[0]).toMatchObject({ human_id: 'h9', is_enabled: false });
    expect(out.characters).toHaveLength(1);
  });
  it('initializes a missing character with 5 enabled traits + patch override', () => {
    const out = upsertCharacterChoice(baseConfig(), 'c2', { visual: 'vpX' });
    const added = out.characters.find((c) => c.key === 'c2')!;
    expect(added.traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(added.traits.every((t) => t.is_enabled)).toBe(true);
    expect(added.visual).toBe('vpX');
    expect(added.is_enabled).toBe(true);
  });
});

describe('upsertVoiceChoice / upsertLanguageChoice', () => {
  it('updates existing voice by key', () => {
    const out = upsertVoiceChoice(baseConfig(), 'narrator', { voice_id: 'v1' });
    expect(out.voices[0].voice_id).toBe('v1');
  });
  it('inserts a new voice slot when key absent', () => {
    const out = upsertVoiceChoice(baseConfig(), 'c1', { voice_id: 'v2', is_enabled: true });
    expect(out.voices).toHaveLength(2);
  });
  it('updates existing language by code', () => {
    const out = upsertLanguageChoice(baseConfig(), 'en', { is_enabled: false });
    expect(out.languages[0].is_enabled).toBe(false);
  });
});

describe('patchMemories', () => {
  it('merges the memories slice, preserving other fields', () => {
    const cfg = baseConfig();
    const out = patchMemories(cfg, { is_enabled: true, style: 'real' });
    expect(out.memories).toEqual({ is_enabled: true, style: 'real', photos: [] });
    expect(cfg).toEqual(frozen());
  });
});
