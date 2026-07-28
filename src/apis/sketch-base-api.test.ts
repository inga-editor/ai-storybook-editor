// sketch-base-api.test.ts — pins the `targetSheet` wiring (⚡2026-07-28, alter character).
//
// WHY this is worth its own test file: api 05 is STATELESS. It writes whatever entity rows it is
// given into whatever `targetSheet` it is told, with NO server-side cross-check — so a mismatch
// between "which entities" and "which sheet" is silent data corruption (the story cast overwriting
// the alter sheet, or vice versa). The client removes the possibility by DERIVING `targetSheet`
// from the same `kind` that selects the entity set; these tests pin that derivation, plus the
// route-06 carve-out (props is `extra="forbid"` → sending the field 400s).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callGenerateBaseSheet } from './sketch-base-api';

const mockedCallImageApi = vi.hoisted(() => vi.fn());
const mockedLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('./image-api-client', () => ({ callImageApi: mockedCallImageApi }));
vi.mock('@/utils/save-resource-path', () => ({ warnIfSaveResourceFailed: vi.fn() }));
vi.mock('@/utils/logger', () => ({ createLogger: () => mockedLog }));

const PARAMS = {
  entities: [{ key: 'hero', visualDescription: 'brave', artLanguage: '' }],
  artStyleId: 'style-1',
  stylePrompt: 'watercolor',
  referenceImages: [{ media_url: 'https://cdn/ref.png' }],
};

const okResponse = (targetSheet?: string) => ({
  success: true,
  data: {
    imageUrl: 'raw.png',
    storagePath: 'p/raw.png',
    cellOrder: ['hero'],
    grid: { cols: 1, rows: 1, cellWidth: 256, cellHeight: 256 },
    ...(targetSheet ? { targetSheet } : {}),
  },
});

/** [path, body] of the single call made in a test. */
function lastCall(): [string, Record<string, unknown>] {
  const [path, body] = mockedCallImageApi.mock.calls[0];
  return [path as string, body as Record<string, unknown>];
}

beforeEach(() => {
  mockedCallImageApi.mockReset().mockResolvedValue(okResponse('character_sheet'));
  Object.values(mockedLog).forEach((fn) => fn.mockReset());
});

describe('callGenerateBaseSheet — endpoint + targetSheet dispatch', () => {
  it('characters → route 05 with targetSheet "character_sheet"', async () => {
    await callGenerateBaseSheet('characters', PARAMS);
    const [path, body] = lastCall();
    expect(path).toBe('/api/sketch/generate-base-character-sheet');
    expect(body.targetSheet).toBe('character_sheet');
  });

  it('alter_characters → the SAME route 05, but targetSheet "alter_character_sheet"', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('alter_character_sheet'));
    await callGenerateBaseSheet('alter_characters', PARAMS);
    const [path, body] = lastCall();
    // One endpoint, two sheets — the discriminator is the body field, NOT a separate route.
    expect(path).toBe('/api/sketch/generate-base-character-sheet');
    expect(body.targetSheet).toBe('alter_character_sheet');
  });

  it('props → route 06 and NO targetSheet key at all (route 06 is extra="forbid" → 400)', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse());
    await callGenerateBaseSheet('props', PARAMS);
    const [path, body] = lastCall();
    expect(path).toBe('/api/sketch/generate-base-prop-sheet');
    expect('targetSheet' in body).toBe(false); // absent, not undefined
  });

  it('body is otherwise unchanged for props (no accidental extra fields)', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse());
    await callGenerateBaseSheet('props', PARAMS);
    const [, body] = lastCall();
    expect(Object.keys(body).sort()).toEqual(['artStyleId', 'entities', 'referenceImages', 'stylePrompt']);
  });

  it('optional fields still attach only when present (modelParams · snapshotId · saveResource)', async () => {
    await callGenerateBaseSheet('alter_characters', {
      ...PARAMS,
      snapshotId: 'snap-1',
      modelParams: { model: 'm', params: { temperature: 0.5 } },
    });
    const [, body] = lastCall();
    expect(body.snapshotId).toBe('snap-1');
    expect(body.modelParams).toEqual({ model: 'm', params: { temperature: 0.5 } });
    expect('saveResource' in body).toBe(false);
  });

  it('returns the result verbatim, including the targetSheet echo', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('alter_character_sheet'));
    const res = await callGenerateBaseSheet('alter_characters', PARAMS);
    expect(res).toMatchObject({ success: true, data: { targetSheet: 'alter_character_sheet' } });
  });

  it('an echo that disagrees with the request is logged as an error, not swallowed', async () => {
    // Stateless endpoint → a wrong echo means the sheet landed in the wrong node server-side.
    mockedCallImageApi.mockResolvedValue(okResponse('character_sheet'));
    const res = await callGenerateBaseSheet('alter_characters', PARAMS);

    expect(mockedLog.error).toHaveBeenCalledWith('callGenerateBaseSheet', 'targetSheet echo mismatch', {
      kind: 'alter_characters',
      requested: 'alter_character_sheet',
      echoed: 'character_sheet',
    });
    // The call still returns — the caller owns error handling.
    expect(res).toMatchObject({ success: true });
  });

  it('a MATCHING echo logs no error (the guard does not cry wolf)', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('alter_character_sheet'));
    await callGenerateBaseSheet('alter_characters', PARAMS);
    expect(mockedLog.error).not.toHaveBeenCalled();
  });

  it('props gets no echo back and that is NOT reported as a mismatch', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse());
    await callGenerateBaseSheet('props', PARAMS);
    expect(mockedLog.error).not.toHaveBeenCalled();
  });
});
