import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pathFromStorageUrl, buildPublicUrl, assertKeyGrammar } from '../storage-url';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('pathFromStorageUrl — dual shape', () => {
  it('parses a legacy Supabase public URL', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/storybook-assets/humans/a/1.png';
    expect(pathFromStorageUrl(url)).toBe('humans/a/1.png');
  });

  it('parses a new /files/ storage-service URL', () => {
    const url = 'https://storage.example.com/files/storybook-assets/uploads/images/humans/a/1.png';
    expect(pathFromStorageUrl(url)).toBe('uploads/images/humans/a/1.png');
  });

  it('strips a query string', () => {
    const url = 'https://storage.example.com/files/storybook-assets/uploads/images/x.png?t=1';
    expect(pathFromStorageUrl(url)).toBe('uploads/images/x.png');
  });

  it('decodes percent-escapes', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/storybook-assets/sounds/forest%20wind.mp3';
    expect(pathFromStorageUrl(url)).toBe('sounds/forest wind.mp3');
  });

  it('returns null for a different bucket', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/other-bucket/x.png';
    expect(pathFromStorageUrl(url)).toBeNull();
  });

  it('returns null for a foreign host/path', () => {
    expect(pathFromStorageUrl('https://cdn.example.com/foo.png')).toBeNull();
  });

  it('returns null for empty / nullish input', () => {
    expect(pathFromStorageUrl(null)).toBeNull();
    expect(pathFromStorageUrl(undefined)).toBeNull();
    expect(pathFromStorageUrl('')).toBeNull();
  });
});

describe('buildPublicUrl', () => {
  it('builds {base}/files/{bucket}/{key}', () => {
    vi.stubEnv('VITE_STORAGE_PUBLIC_BASE_URL', 'https://storage.example.com/');
    expect(buildPublicUrl('uploads/images/x.png')).toBe(
      'https://storage.example.com/files/storybook-assets/uploads/images/x.png',
    );
  });
});

describe('assertKeyGrammar', () => {
  it('accepts a valid key', () => {
    expect(() => assertKeyGrammar('uploads/images/humans/a/123-x.png')).not.toThrow();
  });

  it('rejects a leading slash', () => {
    expect(() => assertKeyGrammar('/uploads/x.png')).toThrow();
  });

  it('rejects ".." and "//"', () => {
    expect(() => assertKeyGrammar('uploads/../x.png')).toThrow();
    expect(() => assertKeyGrammar('uploads//x.png')).toThrow();
  });

  it('rejects an illegal character', () => {
    expect(() => assertKeyGrammar('uploads/im ages/x.png')).toThrow();
  });

  it('rejects a missing extension', () => {
    expect(() => assertKeyGrammar('uploads/images/noext')).toThrow();
  });
});
