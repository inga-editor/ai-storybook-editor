// http-image-uploader.test.ts — File → base64 → POST /api/editor/assets; never
// sends storagePath (BE extra=forbid); maps {url,storagePath} → UploadResult.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHttpImageUploader } from './http-image-uploader';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockCall = vi.hoisted(() => vi.fn());
vi.mock('./editor-service-client', () => ({ callEditorApi: mockCall }));

const af = vi.fn();
const upload = createHttpImageUploader(af);

beforeEach(() => {
  mockCall.mockReset();
});

describe('httpImageUploader', () => {
  it('base64-encodes the file, sends ONLY imageBase64, maps the response', async () => {
    mockCall.mockResolvedValue({
      url: 'https://cdn/mask.png',
      storagePath: 'editor-assets/2026/mask.png',
      contentType: 'image/png',
      bytes: 4,
    });

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'mask.png', { type: 'image/png' });
    const result = await upload(file);

    expect(result).toEqual({ publicUrl: 'https://cdn/mask.png', path: 'editor-assets/2026/mask.png' });

    const args = mockCall.mock.calls[0][0];
    expect(args).toMatchObject({ method: 'POST', path: '/api/editor/assets' });
    // btoa(String.fromCharCode(1,2,3,4)) === 'AQIDBA=='
    expect(args.body).toEqual({ imageBase64: 'AQIDBA==' });
    // Anti-spoof: the client MUST NOT supply a storagePath (BE extra=forbid).
    expect(args.body).not.toHaveProperty('storagePath');
  });

  it('propagates a callEditorApi failure', async () => {
    mockCall.mockRejectedValue(new Error('upload failed'));
    const file = new File([new Uint8Array([9])], 'x.png', { type: 'image/png' });
    await expect(upload(file)).rejects.toThrow('upload failed');
  });
});
