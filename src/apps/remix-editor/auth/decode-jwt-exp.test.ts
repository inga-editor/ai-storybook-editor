// decode-jwt-exp.test.ts — payload decode for `exp` + `admin_ref`, never-throws contract.
import { describe, it, expect } from 'vitest';
import { decodeJwtExp } from './decode-jwt-exp';

/** Build a base64url JWT segment from an object (no signature verification involved). */
function makeToken(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('decodeJwtExp', () => {
  it('decodes exp (seconds → ms) and admin_ref', () => {
    const token = makeToken({ exp: 1_770_000_000, admin_ref: 'admin-opaque-1' });
    expect(decodeJwtExp(token)).toEqual({
      expMs: 1_770_000_000_000,
      adminRef: 'admin-opaque-1',
    });
  });

  it('handles base64url payloads that need padding', () => {
    // A payload whose base64 length is not a multiple of 4 (exercises the pad branch).
    const token = makeToken({ exp: 42 });
    expect(decodeJwtExp(token).expMs).toBe(42_000);
  });

  it('returns expMs null when exp is missing', () => {
    const token = makeToken({ admin_ref: 'x' });
    expect(decodeJwtExp(token)).toEqual({ expMs: null, adminRef: 'x' });
  });

  it('returns expMs null when exp is not a number', () => {
    const token = makeToken({ exp: 'soon' });
    expect(decodeJwtExp(token).expMs).toBeNull();
  });

  it('never throws on a malformed token (no dots / garbage)', () => {
    expect(decodeJwtExp('not-a-jwt')).toEqual({ expMs: null });
    expect(decodeJwtExp('a.!!!not-base64!!!.c')).toEqual({ expMs: null });
    expect(decodeJwtExp('')).toEqual({ expMs: null });
  });
});
