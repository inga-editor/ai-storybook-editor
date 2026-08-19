// player-messages.test.ts — inbound type guard (untrusted-data gate).
import { describe, it, expect } from 'vitest';
import { isInboundMessage, sanitizePlayerInitOptions } from './player-messages';

describe('isInboundMessage', () => {
  it('accepts a valid player:init', () => {
    expect(isInboundMessage({ v: 1, type: 'player:init', token: 'abc' })).toBe(true);
  });

  it('accepts player:init with options', () => {
    expect(
      isInboundMessage({ v: 1, type: 'player:init', token: 'abc', options: { language: 'vi' } }),
    ).toBe(true);
  });

  it('accepts a valid player:token-refresh', () => {
    expect(isInboundMessage({ v: 1, type: 'player:token-refresh', token: 'xyz' })).toBe(true);
  });

  it('rejects wrong version', () => {
    expect(isInboundMessage({ v: 2, type: 'player:init', token: 'abc' })).toBe(false);
  });

  it('rejects unknown type (other lib / extension)', () => {
    expect(isInboundMessage({ v: 1, type: 'vercel:toolbar', token: 'abc' })).toBe(false);
  });

  it('rejects missing/empty/non-string token', () => {
    expect(isInboundMessage({ v: 1, type: 'player:init' })).toBe(false);
    expect(isInboundMessage({ v: 1, type: 'player:init', token: '' })).toBe(false);
    expect(isInboundMessage({ v: 1, type: 'player:init', token: 123 })).toBe(false);
  });

  it('rejects non-object payloads without throwing', () => {
    expect(isInboundMessage(null)).toBe(false);
    expect(isInboundMessage(undefined)).toBe(false);
    expect(isInboundMessage('player:init')).toBe(false);
    expect(isInboundMessage(42)).toBe(false);
  });
});

describe('sanitizePlayerInitOptions', () => {
  it('passes undefined through', () => {
    expect(sanitizePlayerInitOptions(undefined)).toBeUndefined();
  });

  it('keeps a numeric mediaQuality (ladder values + out-of-ladder pass through)', () => {
    expect(sanitizePlayerInitOptions({ mediaQuality: 1600 })).toEqual({ mediaQuality: 1600 });
    expect(sanitizePlayerInitOptions({ mediaQuality: 2240 })).toEqual({ mediaQuality: 2240 });
    expect(sanitizePlayerInitOptions({ mediaQuality: 2752 })).toEqual({ mediaQuality: 2752 });
    // Out-of-ladder numbers are NOT rejected — nginx resolves them safely.
    expect(sanitizePlayerInitOptions({ mediaQuality: 9999 })).toEqual({ mediaQuality: 9999 });
  });

  it('drops a non-number mediaQuality but keeps other options', () => {
    const dirty = { language: 'vi', mediaQuality: '2240' } as never;
    expect(sanitizePlayerInitOptions(dirty)).toEqual({ language: 'vi' });
  });

  it('leaves options without mediaQuality untouched', () => {
    const opts = { language: 'vi', autoplay: true };
    expect(sanitizePlayerInitOptions(opts)).toBe(opts);
  });
});
