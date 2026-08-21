// sketch-base-api.test.ts — pins the group-based `targetGroup` wiring (⚡REV 2026-08-21).
//
// WHY this is worth its own test file: api 05/06 are STATELESS. Each writes whatever entity rows it
// is given into whatever `targetGroup` it is told, with NO server-side cross-check — so a mismatch
// between "which entities" and "which sheet node" is silent data corruption. The client selects the
// route by the group's KIND and ALWAYS ships `targetGroup` (the group key); these tests pin that,
// the client-side format guard, and the echo-mismatch alarm.

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
  targetGroup: 'character_sheet',
};

const okResponse = (targetGroup?: string) => ({
  success: true,
  data: {
    imageUrl: 'raw.png',
    storagePath: 'p/raw.png',
    cellOrder: ['hero'],
    grid: { cols: 1, rows: 1, cellWidth: 256, cellHeight: 256 },
    ...(targetGroup ? { targetGroup } : {}),
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

describe('callGenerateBaseSheet — route dispatch + targetGroup', () => {
  it('characters kind → route 05, always ships targetGroup', async () => {
    await callGenerateBaseSheet('characters', PARAMS);
    const [path, body] = lastCall();
    expect(path).toBe('/api/sketch/generate-base-character-sheet');
    expect(body.targetGroup).toBe('character_sheet');
  });

  it('an arbitrary character group key → still route 05, group echoed in the body', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('alter_character_sheet'));
    await callGenerateBaseSheet('characters', { ...PARAMS, targetGroup: 'alter_character_sheet' });
    const [path, body] = lastCall();
    // The group key is a BODY field, NOT a separate route — one route per kind, N groups per kind.
    expect(path).toBe('/api/sketch/generate-base-character-sheet');
    expect(body.targetGroup).toBe('alter_character_sheet');
  });

  it('props kind → route 06, ships targetGroup', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('prop_sheet'));
    await callGenerateBaseSheet('props', { ...PARAMS, targetGroup: 'prop_sheet' });
    const [path, body] = lastCall();
    expect(path).toBe('/api/sketch/generate-base-prop-sheet');
    expect(body.targetGroup).toBe('prop_sheet');
  });

  it('the base body carries exactly the required fields (+targetGroup, no stray keys)', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('character_sheet'));
    await callGenerateBaseSheet('characters', PARAMS);
    const [, body] = lastCall();
    expect(Object.keys(body).sort()).toEqual(
      ['artStyleId', 'entities', 'referenceImages', 'stylePrompt', 'targetGroup'].sort(),
    );
  });

  it('optional fields still attach only when present (modelParams · snapshotId · saveResource)', async () => {
    await callGenerateBaseSheet('characters', {
      ...PARAMS,
      snapshotId: 'snap-1',
      modelParams: { model: 'm', params: { temperature: 0.5 } },
    });
    const [, body] = lastCall();
    expect(body.snapshotId).toBe('snap-1');
    expect(body.modelParams).toEqual({ model: 'm', params: { temperature: 0.5 } });
    expect('saveResource' in body).toBe(false);
  });

  it('returns the result verbatim, including the targetGroup echo', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('alter_character_sheet'));
    const res = await callGenerateBaseSheet('characters', { ...PARAMS, targetGroup: 'alter_character_sheet' });
    expect(res).toMatchObject({ success: true, data: { targetGroup: 'alter_character_sheet' } });
  });

  it('an echo that disagrees with the request is logged as an error, not swallowed', async () => {
    // Stateless endpoint → a wrong echo means the sheet landed in the wrong node server-side.
    mockedCallImageApi.mockResolvedValue(okResponse('character_sheet'));
    const res = await callGenerateBaseSheet('characters', { ...PARAMS, targetGroup: 'alter_character_sheet' });

    expect(mockedLog.error).toHaveBeenCalledWith('callGenerateBaseSheet', 'targetGroup echo mismatch', {
      group: 'alter_character_sheet',
      requested: 'alter_character_sheet',
      echoed: 'character_sheet',
    });
    // The call still returns — the caller owns error handling.
    expect(res).toMatchObject({ success: true });
  });

  it('a MATCHING echo logs no error (the guard does not cry wolf)', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse('character_sheet'));
    await callGenerateBaseSheet('characters', PARAMS);
    expect(mockedLog.error).not.toHaveBeenCalled();
  });

  it('no echo back is NOT reported as a mismatch', async () => {
    mockedCallImageApi.mockResolvedValue(okResponse());
    await callGenerateBaseSheet('characters', PARAMS);
    expect(mockedLog.error).not.toHaveBeenCalled();
  });

  it('a malformed targetGroup short-circuits to a synthetic failure — request never sent', async () => {
    const res = await callGenerateBaseSheet('characters', { ...PARAMS, targetGroup: 'Bad Group!' });
    expect(mockedCallImageApi).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: false, errorCode: 'INVALID_TARGET_GROUP' });
    expect(mockedLog.error).toHaveBeenCalledWith(
      'callGenerateBaseSheet',
      'invalid targetGroup format — request not sent',
      { kind: 'characters', targetGroup: 'Bad Group!' },
    );
  });
});
