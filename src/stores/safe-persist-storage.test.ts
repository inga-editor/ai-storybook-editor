// safe-persist-storage.test.ts — the persist storage must degrade to memory when
// localStorage throws (Safari ITP in a 3rd-party iframe), never crash at boot.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSafePersistStorage } from './safe-persist-storage';

afterEach(() => vi.restoreAllMocks());

describe('createSafePersistStorage', () => {
  it('round-trips through localStorage when available', () => {
    const storage = createSafePersistStorage();
    storage.setItem('probe-key', { state: { volume: 42 }, version: 0 });
    const read = storage.getItem('probe-key');
    expect(read).toEqual({ state: { volume: 42 }, version: 0 });
    storage.removeItem('probe-key');
    expect(storage.getItem('probe-key')).toBeNull();
  });

  it('falls back to in-memory when localStorage.setItem throws (does not crash)', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked by ITP');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked by ITP');
    });

    const storage = createSafePersistStorage();
    // Must NOT throw despite localStorage being blocked.
    expect(() => storage.setItem('mem-key', { state: { volume: 7 }, version: 1 })).not.toThrow();
    // Reads come back from the in-memory fallback.
    expect(storage.getItem('mem-key')).toEqual({ state: { volume: 7 }, version: 1 });
  });

  it('returns null (not throw) when getItem is blocked and nothing was written', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });
    const storage = createSafePersistStorage();
    expect(storage.getItem('never-written-key')).toBeNull();
  });
});
