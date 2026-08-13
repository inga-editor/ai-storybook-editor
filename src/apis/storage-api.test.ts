import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  uploadImageToStorage,
  uploadVideoToStorage,
  setImageUploader,
  type UploadResult,
} from './storage-api';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const uploadObject = vi.fn();
vi.mock('@/apis/storage-service-client', () => ({
  uploadObject: (...args: unknown[]) => uploadObject(...args),
}));

// Mock image-api (normalize) — not used by these tests, avoid pulling its deps.
vi.mock('./image-api', () => ({ normalizeImage: vi.fn() }));

const supabaseUpload = vi.fn();
const supabaseGetPublicUrl = vi.fn();
vi.mock('@/apis/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => supabaseUpload(...args),
        getPublicUrl: (...args: unknown[]) => supabaseGetPublicUrl(...args),
      }),
    },
  },
}));

function pngFile(name = 'x.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}
function mp4File(name = 'clip.mp4'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'video/mp4' });
}

beforeEach(() => {
  uploadObject.mockResolvedValue({
    success: true,
    data: { key: 'server-key', url: 'http://h/files/storybook-assets/server-key', bucket: 'storybook-assets', etag: 'e', bytes: 3, deduped: false },
  });
  supabaseUpload.mockResolvedValue({ data: { path: 'legacy-path' }, error: null });
  supabaseGetPublicUrl.mockReturnValue({ data: { publicUrl: 'http://supabase/legacy-path' } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('env-presence backend switch', () => {
  it('uses storage service when VITE_STORAGE_SERVICE_URL is set', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', 'http://localhost:8200');
    const res: UploadResult = await uploadImageToStorage(pngFile());
    expect(uploadObject).toHaveBeenCalledTimes(1);
    expect(supabaseUpload).not.toHaveBeenCalled();
    expect(res.publicUrl).toBe('http://h/files/storybook-assets/server-key');
    expect(res.path).toBe('server-key');
  });

  it('uses Supabase Storage when env is empty', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', '');
    const res: UploadResult = await uploadImageToStorage(pngFile());
    expect(supabaseUpload).toHaveBeenCalledTimes(1);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(res.path).toBe('legacy-path');
  });
});

describe('buildObjectKey — service branch key shape', () => {
  it('prepends uploads/images/ for an image', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', 'http://localhost:8200');
    await uploadImageToStorage(pngFile('photo.png'), 'characters');
    const arg = uploadObject.mock.calls[0][0] as { key: string };
    expect(arg.key).toMatch(/^uploads\/images\/characters\/\d+-photo\.png$/);
  });

  it('prepends uploads/videos/ for a video', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', 'http://localhost:8200');
    await uploadVideoToStorage(mp4File());
    const arg = uploadObject.mock.calls[0][0] as { key: string };
    expect(arg.key).toMatch(/^uploads\/videos\/videos\/\d+-clip\.mp4$/);
  });

  it('derives an extension from contentType when the filename has none', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', 'http://localhost:8200');
    await uploadImageToStorage(pngFile('noext'), 'characters');
    const arg = uploadObject.mock.calls[0][0] as { key: string };
    expect(arg.key).toMatch(/\.png$/);
  });

  it('legacy branch key has NO uploads/ root', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', '');
    await uploadVideoToStorage(mp4File());
    const legacyPath = supabaseUpload.mock.calls[0][0] as string;
    expect(legacyPath).toMatch(/^videos\/\d+-clip\.mp4$/);
    expect(legacyPath.startsWith('uploads/')).toBe(false);
  });
});

describe('validation before network', () => {
  it('rejects an unsupported mime before hitting any backend', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', 'http://localhost:8200');
    const bad = new File([new Uint8Array([1])], 'x.svg', { type: 'image/svg+xml' });
    await expect(uploadImageToStorage(bad)).rejects.toThrow();
    expect(uploadObject).not.toHaveBeenCalled();
    expect(supabaseUpload).not.toHaveBeenCalled();
  });

  it('rejects an oversized file before hitting any backend', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', 'http://localhost:8200');
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'x.png', { type: 'image/png' });
    await expect(uploadImageToStorage(big)).rejects.toThrow(/too large/i);
    expect(uploadObject).not.toHaveBeenCalled();
  });
});

// Kept LAST: the override mutates a module `let` (default uploader is not exported
// to restore); no test after this relies on the default in this file.
describe('setImageUploader seam', () => {
  it('lets a sub-app override the image uploader (neither backend touched)', async () => {
    vi.stubEnv('VITE_STORAGE_SERVICE_URL', 'http://localhost:8200');
    const custom = vi.fn().mockResolvedValue({ publicUrl: 'sub://x', path: 'sub-key' });
    setImageUploader(custom);
    const res = await uploadImageToStorage(pngFile());
    expect(custom).toHaveBeenCalledTimes(1);
    expect(res.path).toBe('sub-key');
    expect(uploadObject).not.toHaveBeenCalled();
    expect(supabaseUpload).not.toHaveBeenCalled();
  });
});
