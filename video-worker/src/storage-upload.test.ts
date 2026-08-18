// Unit tests for the storage-upload seam — HTTP layer mocked (global fetch),
// fs mocked (no real file). Covers the retry/upsert/409/fail-fast policy from
// design 02 §2b + storage-service 03 §2.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";

// paths.js supplies storage config at import time — stub to a configured state.
vi.mock("./paths.js", () => ({
  STORAGE_SERVICE_URL: "http://storage.test",
  STORAGE_SERVICE_API_KEY: "test-key",
  STORAGE_BUCKET: "storybook-assets",
  tierOutDir: (tier: string) => `/out/${tier}`,
}));

// fs: stat → fixed size; createReadStream → an in-memory readable (partial mock).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const stat = (_p: string, cb: (e: unknown, s: { size: number }) => void) => cb(null, { size: 1234 });
  const createReadStream = () => Readable.from([Buffer.from("mp4-bytes")]);
  return {
    ...actual,
    default: { ...(actual as unknown as { default?: object }).default ?? actual, stat, createReadStream },
    stat,
    createReadStream,
  };
});

const unlinkMock = vi.fn().mockResolvedValue(undefined);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const unlink = (...a: unknown[]) => unlinkMock(...a);
  return { ...actual, default: { ...(actual as unknown as { default?: object }).default ?? actual, unlink }, unlink };
});

import {
  putBookArtifact,
  putObjectAtKey,
  uploadTranscodeOutputs,
  StorageUploadError,
  isStorageConfigured,
} from "./storage-upload.js";
import type { TranscodeOutput } from "./transcode.js";

const PARAMS = { tier: "qhd", bookId: "b1", fileName: "book-1-ab12cd34.mp4", filePath: "/out/qhd/x.mp4" };
const KEY = "videos/books/b1/qhd/book-1-ab12cd34.mp4";
const PUB_URL = `http://storage.test/files/storybook-assets/${KEY}`;

function ok(status = 201): Response {
  return new Response(JSON.stringify({ success: true, data: { url: PUB_URL, key: KEY } }), { status });
}
function err(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  unlinkMock.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** URLSearchParams of the `?upsert=` flag on the Nth fetch call. */
function upsertOf(call: number): string {
  const url = fetchMock.mock.calls[call][0] as string;
  return new URL(url).searchParams.get("upsert") ?? "";
}

describe("isStorageConfigured", () => {
  it("true when STORAGE_SERVICE_URL is set", () => {
    expect(isStorageConfigured()).toBe(true);
  });
});

describe("putBookArtifact", () => {
  it("success 201 → returns url + storageKey, upsert=false, correct headers/key", async () => {
    fetchMock.mockResolvedValueOnce(ok(201));
    const res = await putBookArtifact(PARAMS);
    expect(res).toEqual({ url: PUB_URL, storageKey: KEY });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://storage.test/api/storage/objects/storybook-assets/${KEY}?upsert=false`);
    expect(init.method).toBe("PUT");
    expect(init.headers["X-API-Key"]).toBe("test-key");
    expect(init.headers["Content-Type"]).toBe("video/mp4");
    expect(init.headers["Content-Length"]).toBe("1234");
  });

  it("upsertFirst=true → first attempt already upsert=true", async () => {
    fetchMock.mockResolvedValueOnce(ok(200));
    await putBookArtifact({ ...PARAMS, upsertFirst: true });
    expect(upsertOf(0)).toBe("true");
  });

  it("transport error then success → retry flips upsert to true", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(ok(200));
    const p = putBookArtifact(PARAMS);
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.storageKey).toBe(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(upsertOf(0)).toBe("false");
    expect(upsertOf(1)).toBe("true");
  });

  it("409 ALREADY_EXISTS on attempt 1 → immediate re-PUT with upsert", async () => {
    fetchMock.mockResolvedValueOnce(err(409, "ALREADY_EXISTS")).mockResolvedValueOnce(ok(200));
    const res = await putBookArtifact(PARAMS);
    expect(res.url).toBe(PUB_URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(upsertOf(0)).toBe("false");
    expect(upsertOf(1)).toBe("true");
  });

  it("401 → fail fast, no retry, throws StorageUploadError", async () => {
    fetchMock.mockResolvedValueOnce(err(401, "UNAUTHORIZED"));
    await expect(putBookArtifact(PARAMS)).rejects.toBeInstanceOf(StorageUploadError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausted retries (all 5xx) → throws StorageUploadError after 3 attempts", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => err(500, "STORAGE_IO_ERROR"));
    const p = putBookArtifact(PARAMS);
    const assertion = expect(p).rejects.toBeInstanceOf(StorageUploadError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("2xx but missing data.url → StorageUploadError (no retry)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {} }), { status: 201 }));
    await expect(putBookArtifact(PARAMS)).rejects.toBeInstanceOf(StorageUploadError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function output(res: "fhd" | "hd" | "sd"): TranscodeOutput {
  return {
    resolution: res,
    url: `/files/${res}/book-1-${res}.mp4`,
    fileName: `book-1-${res}.mp4`,
    width: 1,
    height: 1,
    fileSizeBytes: 1,
    durationInFrames: 1,
  };
}

describe("putObjectAtKey", () => {
  // ADR-057 sibling key: `@` is valid grammar and must reach storage-service
  // byte-for-byte, un-renamed (generic /transcode mode, design 08 §2b).
  const GENERIC_KEY = "uploads/videos/xyz.mp4@mobile.mp4";
  const GENERIC_URL = `http://storage.test/files/storybook-assets/${GENERIC_KEY}`;

  function okGeneric(status = 200): Response {
    return new Response(JSON.stringify({ success: true, data: { url: GENERIC_URL, key: GENERIC_KEY } }), { status });
  }

  it("PUTs at the EXACT key verbatim (no rename), upsert=true from attempt 1, correct content-type", async () => {
    fetchMock.mockResolvedValueOnce(okGeneric(200));
    const res = await putObjectAtKey({ key: GENERIC_KEY, filePath: "/out/single/xyz.mp4", contentType: "video/mp4" });
    expect(res).toEqual({ url: GENERIC_URL, storageKey: GENERIC_KEY });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://storage.test/api/storage/objects/storybook-assets/${GENERIC_KEY.split("/").map(encodeURIComponent).join("/")}?upsert=true`);
    expect(init.headers["Content-Type"]).toBe("video/mp4");
  });

  it("honors a webm contentType", async () => {
    fetchMock.mockResolvedValueOnce(okGeneric(200));
    await putObjectAtKey({ key: "uploads/videos/xyz.webm@sd.webm", filePath: "/out/single/xyz.webm", contentType: "video/webm" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("video/webm");
  });

  it("propagates StorageUploadError on a non-retryable 4xx (parity with putBookArtifact)", async () => {
    fetchMock.mockResolvedValueOnce(err(415, "UNSUPPORTED_MEDIA_TYPE"));
    await expect(
      putObjectAtKey({ key: GENERIC_KEY, filePath: "/out/single/xyz.mp4", contentType: "video/mp4" }),
    ).rejects.toBeInstanceOf(StorageUploadError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("uploadTranscodeOutputs", () => {
  it("PUTs each output (upsert=true from attempt 1), rewrites url + storageKey, unlinks local", async () => {
    fetchMock.mockImplementation(async () => ok(200));
    const res = await uploadTranscodeOutputs("b1", [output("fhd"), output("hd")]);
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ resolution: "fhd", url: PUB_URL, storageKey: "videos/books/b1/fhd/book-1-fhd.mp4" });
    expect(res[1]).toMatchObject({ resolution: "hd", url: PUB_URL, storageKey: "videos/books/b1/hd/book-1-hd.mp4" });
    expect(upsertOf(0)).toBe("true"); // upsertFirst
    expect(unlinkMock).toHaveBeenCalledTimes(2);
    expect(unlinkMock).toHaveBeenCalledWith("/out/fhd/book-1-fhd.mp4");
  });

  it("mid-loop PUT failure → throws StorageUploadError; only prior output unlinked", async () => {
    fetchMock.mockResolvedValueOnce(ok(200)).mockResolvedValueOnce(err(401, "UNAUTHORIZED"));
    await expect(
      uploadTranscodeOutputs("b1", [output("fhd"), output("hd")]),
    ).rejects.toBeInstanceOf(StorageUploadError);
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith("/out/fhd/book-1-fhd.mp4");
  });
});
