// resolve-auto-pic-display-source.test.ts — unit tests for the shared-verbatim
// effective-URL resolver + edition display-source discriminator.
//
// The single most regression-prone invariant: `resolveEffectiveStaticUrl` must
// NEVER fall back to `media_url` (the animated file). A classic auto_pic with a
// media_url but no static_image must resolve to `missing-static`, not borrow the
// animated URL — see header comment in the source module (ADR-035 contract).
// Pure helper module — no logger import, no mock needed (see source header:
// "Pure, no logging (called in render loops)").
import { describe, it, expect } from "vitest";
import {
  resolveEffectiveStaticUrl,
  resolveAutoPicDisplaySource,
  type AutoPicStaticImage,
} from "./resolve-auto-pic-display-source";
import type { SpreadAutoPic } from "@/types/spread-types";

function autoPic(over: Record<string, unknown> = {}): SpreadAutoPic {
  return {
    id: "ap-1",
    geometry: { x: 0, y: 0, w: 10, h: 10 } as never,
    "z-index": 1,
    player_visible: true,
    editor_visible: true,
    ...over,
  } as SpreadAutoPic;
}

describe("resolveEffectiveStaticUrl", () => {
  it("prioritises final_hires_media_url", () => {
    const si: AutoPicStaticImage = {
      illustrations: [{ media_url: "https://example.test/a.png", is_selected: true, created_time: "t" }],
      final_hires_media_url: "https://example.test/hires.png",
    };
    expect(resolveEffectiveStaticUrl(si)).toBe("https://example.test/hires.png");
  });

  it("falls back to the is_selected illustration when no final_hires", () => {
    const si: AutoPicStaticImage = {
      illustrations: [
        { media_url: "https://example.test/a.png", is_selected: false, created_time: "t" },
        { media_url: "https://example.test/b.png", is_selected: true, created_time: "t" },
      ],
    };
    expect(resolveEffectiveStaticUrl(si)).toBe("https://example.test/b.png");
  });

  it("falls back to illustrations[0] when nothing is selected", () => {
    const si: AutoPicStaticImage = {
      illustrations: [
        { media_url: "https://example.test/a.png", is_selected: false, created_time: "t" },
        { media_url: "https://example.test/b.png", is_selected: false, created_time: "t" },
      ],
    };
    expect(resolveEffectiveStaticUrl(si)).toBe("https://example.test/a.png");
  });

  it("returns undefined for an empty illustrations array", () => {
    expect(resolveEffectiveStaticUrl({ illustrations: [] })).toBeUndefined();
  });

  it("returns undefined when static_image is absent", () => {
    expect(resolveEffectiveStaticUrl(undefined)).toBeUndefined();
  });
});

describe("resolveAutoPicDisplaySource — classic edition", () => {
  it("classic + has media_url + no static_image ⇒ missing-static (KHÔNG fallback file động)", () => {
    const ap = autoPic({
      media_url: "https://example.test/animated.webp",
      static_image: undefined,
    });
    expect(resolveAutoPicDisplaySource(ap, "classic")).toEqual({ mode: "missing-static" });
  });

  it("classic + static_image with illustrations ⇒ static (effective URL)", () => {
    const ap = autoPic({
      media_url: "https://example.test/animated.webp",
      static_image: {
        illustrations: [{ media_url: "https://example.test/static.png", is_selected: true, created_time: "t" }],
      },
    });
    expect(resolveAutoPicDisplaySource(ap, "classic")).toEqual({
      mode: "static",
      url: "https://example.test/static.png",
    });
  });

  it("classic + static_image.illustrations: [] ⇒ missing-static", () => {
    const ap = autoPic({ static_image: { illustrations: [] } });
    expect(resolveAutoPicDisplaySource(ap, "classic")).toEqual({ mode: "missing-static" });
  });
});

describe("resolveAutoPicDisplaySource — dynamic/interactive edition", () => {
  it("dynamic + media_url ⇒ animated", () => {
    const ap = autoPic({ media_url: "https://example.test/animated.webm" });
    expect(resolveAutoPicDisplaySource(ap, "dynamic")).toEqual({
      mode: "animated",
      url: "https://example.test/animated.webm",
    });
  });

  it("interactive + media_url ⇒ animated", () => {
    const ap = autoPic({ media_url: "https://example.test/animated.riv" });
    expect(resolveAutoPicDisplaySource(ap, "interactive")).toEqual({
      mode: "animated",
      url: "https://example.test/animated.riv",
    });
  });

  it("dynamic + no media_url ⇒ empty", () => {
    const ap = autoPic({ media_url: undefined });
    expect(resolveAutoPicDisplaySource(ap, "dynamic")).toEqual({ mode: "empty" });
  });

  it("dynamic + static_image set but no media_url ⇒ empty (static_image ignored off-classic)", () => {
    const ap = autoPic({
      media_url: undefined,
      static_image: {
        illustrations: [{ media_url: "https://example.test/static.png", is_selected: true, created_time: "t" }],
      },
    });
    expect(resolveAutoPicDisplaySource(ap, "dynamic")).toEqual({ mode: "empty" });
  });
});
