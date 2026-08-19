// collect-spread-media.test.ts — unit tests for the edition-aware auto_pic
// preload collection: classic collects the effective STATIC url only (never the
// animated media_url); dynamic/interactive classify the animated file by ext.
import { describe, it, expect, vi, afterEach } from "vitest";
import { collectSpreadMedia } from "./collect-spread-media";
import { setActiveMediaQuality } from "../media-quality";
import type { PlayableSpread } from "@/types/playable-types";

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function baseSpread(over: Partial<PlayableSpread> = {}): PlayableSpread {
  return {
    id: "sp-1",
    images: [],
    auto_pics: [],
    videos: [],
    audios: [],
    auto_audios: [],
    quizzes: [],
    animations: [],
    textboxes: [],
    ...over,
  } as unknown as PlayableSpread;
}

describe("collectSpreadMedia — auto_pics, classic edition", () => {
  it("collects only the effective static url (kind auto_pic_img), never the animated media_url", () => {
    const spread = baseSpread({
      auto_pics: [
        {
          id: "ap-1",
          media_url: "https://example.test/animated.webp",
          static_image: {
            illustrations: [{ media_url: "https://example.test/static.png", is_selected: true, created_time: "t" }],
          },
        },
      ] as never,
    });
    const items = collectSpreadMedia(spread, "en_US", "en_US", "classic");
    expect(items).toEqual([{ url: "https://example.test/static.png", kind: "auto_pic_img", channel: undefined }]);
  });

  it("skips an auto_pic with no static_image (missing-static, no fallback)", () => {
    const spread = baseSpread({
      auto_pics: [
        { id: "ap-1", media_url: "https://example.test/animated.webp", static_image: undefined },
      ] as never,
    });
    const items = collectSpreadMedia(spread, "en_US", "en_US", "classic");
    expect(items).toEqual([]);
  });
});

describe("collectSpreadMedia — auto_pics, dynamic/interactive edition (unchanged)", () => {
  it("classifies .webp animated media_url as auto_pic_img", () => {
    const spread = baseSpread({
      auto_pics: [{ id: "ap-1", media_url: "https://example.test/animated.webp" }] as never,
    });
    const items = collectSpreadMedia(spread, "en_US", "en_US", "dynamic");
    expect(items).toEqual([{ url: "https://example.test/animated.webp", kind: "auto_pic_img", channel: undefined }]);
  });

  it("classifies .webm animated media_url as auto_pic_vid", () => {
    const spread = baseSpread({
      auto_pics: [{ id: "ap-1", media_url: "https://example.test/animated.webm" }] as never,
    });
    const items = collectSpreadMedia(spread, "en_US", "en_US", "interactive");
    expect(items).toEqual([{ url: "https://example.test/animated.webm", kind: "auto_pic_vid", channel: undefined }]);
  });

  it("ignores static_image when present — dynamic never preloads it", () => {
    const spread = baseSpread({
      auto_pics: [
        {
          id: "ap-1",
          media_url: undefined,
          static_image: {
            illustrations: [{ media_url: "https://example.test/static.png", is_selected: true, created_time: "t" }],
          },
        },
      ] as never,
    });
    const items = collectSpreadMedia(spread, "en_US", "en_US", "dynamic");
    expect(items).toEqual([]);
  });
});

describe("collectSpreadMedia — regular images unaffected by edition", () => {
  it("always collects image.media_url regardless of edition", () => {
    const spread = baseSpread({ images: [{ id: "img-1", media_url: "https://example.test/a.png" }] as never });
    expect(collectSpreadMedia(spread, "en_US", "en_US", "classic")).toEqual([
      { url: "https://example.test/a.png", kind: "image", channel: undefined },
    ]);
    expect(collectSpreadMedia(spread, "en_US", "en_US", "dynamic")).toEqual([
      { url: "https://example.test/a.png", kind: "image", channel: undefined },
    ]);
  });
});

describe("collectSpreadMedia — media quality (ADR-057)", () => {
  afterEach(() => setActiveMediaQuality(null));

  it("appends ?quality= to visual kinds but never to audio when a quality is active", () => {
    setActiveMediaQuality(2240);
    const spread = baseSpread({
      images: [{ id: "img-1", media_url: "https://example.test/a.png" }] as never,
      videos: [{ id: "vid-1", media_url: "https://example.test/v.mp4" }] as never,
      auto_pics: [{ id: "ap-1", media_url: "https://example.test/animated.webp" }] as never,
      audios: [{ id: "au-1", media_url: "https://example.test/s.mp3" }] as never,
    });
    const items = collectSpreadMedia(spread, "en_US", "en_US", "dynamic");
    expect(items).toEqual([
      { url: "https://example.test/a.png?quality=2240", kind: "image", channel: undefined },
      { url: "https://example.test/animated.webp?quality=2240", kind: "auto_pic_img", channel: undefined },
      { url: "https://example.test/v.mp4?quality=2240", kind: "video", channel: undefined },
      { url: "https://example.test/s.mp3", kind: "audio", channel: "sfx" },
    ]);
  });

  it("appends quality to the classic effective static url", () => {
    setActiveMediaQuality(1600);
    const spread = baseSpread({
      auto_pics: [
        {
          id: "ap-1",
          media_url: "https://example.test/animated.webp",
          static_image: {
            illustrations: [{ media_url: "https://example.test/static.png", is_selected: true, created_time: "t" }],
          },
        },
      ] as never,
    });
    const items = collectSpreadMedia(spread, "en_US", "en_US", "classic");
    expect(items).toEqual([{ url: "https://example.test/static.png?quality=1600", kind: "auto_pic_img", channel: undefined }]);
  });

  it("leaves every URL untouched when no quality is active", () => {
    const spread = baseSpread({
      images: [{ id: "img-1", media_url: "https://example.test/a.png" }] as never,
    });
    expect(collectSpreadMedia(spread, "en_US", "en_US", "dynamic")).toEqual([
      { url: "https://example.test/a.png", kind: "image", channel: undefined },
    ]);
  });
});
