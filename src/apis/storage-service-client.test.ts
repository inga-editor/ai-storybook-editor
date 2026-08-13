import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  uploadObject,
  deleteObject,
  deleteObjects,
  setStorageServiceBaseUrl,
} from './storage-service-client';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const getAuthHeader = vi.fn<() => Promise<string | undefined>>();
const refreshAuthHeader = vi.fn<() => Promise<string | undefined>>();
vi.mock('./supabase-auth-header', () => ({
  getAuthHeader: () => getAuthHeader(),
  refreshAuthHeader: () => refreshAuthHeader(),
}));

const BASE = 'http://localhost:8200';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  setStorageServiceBaseUrl(BASE);
  getAuthHeader.mockResolvedValue('Bearer tok-1');
  refreshAuthHeader.mockResolvedValue('Bearer tok-2');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('uploadObject — success', () => {
  it('POSTs multipart to /api/storage/uploads with Authorization and NO Content-Type / X-API-Key', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { bucket: 'storybook-assets', key: 'uploads/images/x.png', url: 'http://h/files/storybook-assets/uploads/images/x.png', etag: 'e', bytes: 3, deduped: false },
      }, 201),
    );
    const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });
    const res = await uploadObject({ file, key: 'uploads/images/x.png' });

    expect(res.success).toBe(true);
    if (res.success) expect(res.data.url).toBe('http://h/files/storybook-assets/uploads/images/x.png');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/storage/uploads`);
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer tok-1');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers['X-API-Key']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('key')).toBe('uploads/images/x.png');
    expect(form.get('bucket')).toBe('storybook-assets');
    expect(form.get('file')).toBeInstanceOf(File);
  });
});

describe('uploadObject — error mapping', () => {
  const cases: Array<[string, number, string]> = [
    ['PAYLOAD_TOO_LARGE', 413, 'File quá lớn so với giới hạn máy chủ.'],
    ['UNSUPPORTED_MEDIA_TYPE', 415, 'Định dạng file không được hỗ trợ.'],
    ['PREFIX_NOT_ALLOWED', 403, 'Không có quyền ghi vào thư mục này.'],
  ];
  it.each(cases)('maps %s → friendly message', async (code, status, message) => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: { code, message: 'raw' } }, status));
    const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    const res = await uploadObject({ file, key: 'uploads/images/x.png' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorCode).toBe(code);
      expect(res.httpStatus).toBe(status);
      expect(res.error).toBe(message);
    }
  });
});

describe('uploadObject — 401 retry', () => {
  it('refreshes token and retries exactly once', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'UNAUTHORIZED' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { key: 'k', url: 'u', bucket: 'b', etag: 'e', bytes: 1, deduped: false } }, 201));
    const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    const res = await uploadObject({ file, key: 'uploads/images/x.png' });

    expect(refreshAuthHeader).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers['Authorization']).toBe('Bearer tok-2');
    expect(res.success).toBe(true);
  });

  it('does not loop when the retry also 401s', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: { code: 'UNAUTHORIZED' } }, 401));
    const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    const res = await uploadObject({ file, key: 'uploads/images/x.png' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.success).toBe(false);
  });
});

describe('uploadObject — network error', () => {
  it('returns CONNECTION_ERROR failure with httpStatus 0', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    const res = await uploadObject({ file, key: 'uploads/images/x.png' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorCode).toBe('CONNECTION_ERROR');
      expect(res.httpStatus).toBe(0);
    }
  });
});

describe('deleteObject / deleteObjects', () => {
  it('DELETEs the escaped key path and returns deleted flag', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { deleted: true } }));
    const ok = await deleteObject('uploads/images/humans/a/1.png');
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/storage/objects/storybook-assets/uploads/images/humans/a/1.png`);
    expect(init.method).toBe('DELETE');
  });

  it('resolves false (no throw) on non-2xx', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: { code: 'X' } }, 500));
    await expect(deleteObject('uploads/images/x.png')).resolves.toBe(false);
  });

  it('deleted:false is not treated as an error but returns false', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { deleted: false } }));
    await expect(deleteObject('uploads/images/x.png')).resolves.toBe(false);
  });

  it('deleteObjects returns true only when all succeed', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { deleted: true } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { deleted: false } }));
    await expect(deleteObjects(['a.png', 'b.png'])).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deleteObjects on empty list resolves true without fetching', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await expect(deleteObjects([])).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
