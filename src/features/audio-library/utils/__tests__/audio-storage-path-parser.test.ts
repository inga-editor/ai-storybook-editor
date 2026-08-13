import { describe, expect, it } from 'vitest';
import { parseStoragePathFromUrl } from '../audio-storage-path-parser';

describe('parseStoragePathFromUrl', () => {
  it('returns path for sounds-uploaded prefix', () => {
    const url =
      'https://x.supabase.co/storage/v1/object/public/storybook-assets/sounds-uploaded/u/1.mp3';
    expect(parseStoragePathFromUrl(url, ['sounds-uploaded', 'sound-effects'])).toBe(
      'sounds-uploaded/u/1.mp3',
    );
  });

  it('returns path for musics prefix', () => {
    const url =
      'https://x.supabase.co/storage/v1/object/public/storybook-assets/musics/abc.mp3';
    expect(parseStoragePathFromUrl(url, ['musics-uploaded', 'musics'])).toBe(
      'musics/abc.mp3',
    );
  });

  it('returns null when bucket pattern mismatches', () => {
    const url = 'https://cdn.example.com/foo.mp3';
    expect(parseStoragePathFromUrl(url, ['sounds-uploaded'])).toBeNull();
  });

  it('returns null when prefix mismatches (sounds path queried with musics prefix)', () => {
    const url =
      'https://x.supabase.co/storage/v1/object/public/storybook-assets/sounds-uploaded/u/1.mp3';
    expect(parseStoragePathFromUrl(url, ['musics-uploaded', 'musics'])).toBeNull();
  });

  it('returns null on empty url', () => {
    expect(parseStoragePathFromUrl(null, ['sounds-uploaded'])).toBeNull();
    expect(parseStoragePathFromUrl(undefined, ['sounds-uploaded'])).toBeNull();
    expect(parseStoragePathFromUrl('', ['sounds-uploaded'])).toBeNull();
  });

  it('returns null on invalid URL', () => {
    expect(parseStoragePathFromUrl('not-a-url', ['sounds-uploaded'])).toBeNull();
  });

  it('decodes URL-encoded characters', () => {
    const url =
      'https://x.supabase.co/storage/v1/object/public/storybook-assets/sounds-uploaded/u/forest%20wind.mp3';
    expect(parseStoragePathFromUrl(url, ['sounds-uploaded'])).toBe(
      'sounds-uploaded/u/forest wind.mp3',
    );
  });

  it('empty prefixes array allows any path under bucket', () => {
    const url =
      'https://x.supabase.co/storage/v1/object/public/storybook-assets/anything/x.mp3';
    expect(parseStoragePathFromUrl(url, [])).toBe('anything/x.mp3');
  });

  // ── New storage-service `/files/` shape (dual-shape compat, ADR-054) ──────────
  // Real FE-uploaded audio keys carry the `uploads/audios/` root — the page-level
  // prefix arrays must list that root or delete-cleanup silently skips new URLs.
  it('parses a new /files/ URL under uploads/audios/ root with matching prefix', () => {
    const url =
      'https://storage.example.com/files/storybook-assets/uploads/audios/sounds-uploaded/u/1.mp3';
    expect(
      parseStoragePathFromUrl(url, ['uploads/audios/sounds-uploaded', 'sounds-uploaded']),
    ).toBe('uploads/audios/sounds-uploaded/u/1.mp3');
  });

  it('legacy-only prefix does NOT match a new uploads/audios/ key (regression guard)', () => {
    const url =
      'https://storage.example.com/files/storybook-assets/uploads/audios/sounds-uploaded/u/1.mp3';
    // Pre-fix behavior: legacy prefixes alone miss the new root → null (orphan bug).
    expect(parseStoragePathFromUrl(url, ['sounds-uploaded', 'sound-effects'])).toBeNull();
  });

  it('still parses a legacy /files/ URL (no root) for back-compat', () => {
    const url =
      'https://storage.example.com/files/storybook-assets/sounds-uploaded/u/1.mp3';
    expect(parseStoragePathFromUrl(url, ['uploads/audios/sounds-uploaded', 'sounds-uploaded'])).toBe(
      'sounds-uploaded/u/1.mp3',
    );
  });
});
