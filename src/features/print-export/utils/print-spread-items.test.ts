// print-spread-items.test.ts — Unit tests for the static print item-filter rules.
import { describe, it, expect } from "vitest";
import {
  autoPicAsStaticImage,
  resolvePrintTextboxes,
  shouldRenderPrintAutoPic,
  shouldRenderPrintImage,
  shouldRenderPrintShape,
} from "./print-spread-items";
import type { CompositeContext } from "@/features/editor/utils/composite-resolve-helpers";

// In-staging geometry (inside [-50,150] on both axes); off-staging is far outside.
const inStaging = { x: 10, y: 10, w: 40, h: 40 } as never;
const offStaging = { x: 500, y: 500, w: 10, h: 10 } as never;

const emptyCtx = new Map<string, CompositeContext>();

function img(over: Record<string, unknown> = {}) {
  return {
    id: "img-1",
    geometry: inStaging,
    media_url: "https://example.com/a.png",
    ...over,
  } as never;
}

function shape(over: Record<string, unknown> = {}) {
  return { id: "shp-1", geometry: inStaging, ...over } as never;
}

function autoPic(over: Record<string, unknown> = {}) {
  return {
    id: "ap-1",
    geometry: inStaging,
    "z-index": 10,
    player_visible: true,
    editor_visible: true,
    // Animated file present but MUST never leak into the print item — only
    // static_image drives the print URL resolve chain.
    media_url: "https://example.test/animated.webp",
    static_image: {
      illustrations: [{ media_url: "https://example.test/static.png", is_selected: true, created_time: "t" }],
    },
    ...over,
  } as never;
}

describe("shouldRenderPrintImage", () => {
  it("renders a visible, in-staging image with a URL", () => {
    expect(shouldRenderPrintImage(img(), undefined, emptyCtx)).toBe(true);
  });

  it("skips player_visible === false", () => {
    expect(shouldRenderPrintImage(img({ player_visible: false }), undefined, emptyCtx)).toBe(false);
  });

  it("skips images fully outside staging", () => {
    expect(shouldRenderPrintImage(img({ geometry: offStaging }), undefined, emptyCtx)).toBe(false);
  });

  it("skips images with no resolvable URL", () => {
    expect(
      shouldRenderPrintImage(
        img({ media_url: undefined, final_hires_media_url: undefined, illustrations: [] }),
        undefined,
        emptyCtx
      )
    ).toBe(false);
  });

  it("accepts URL from final_hires_media_url", () => {
    expect(
      shouldRenderPrintImage(
        img({ media_url: undefined, final_hires_media_url: "https://x/h.png" }),
        undefined,
        emptyCtx
      )
    ).toBe(true);
  });

  it("accepts URL from an illustration variant", () => {
    expect(
      shouldRenderPrintImage(
        img({ media_url: undefined, illustrations: [{ media_url: "https://x/v.png" }] }),
        undefined,
        emptyCtx
      )
    ).toBe(true);
  });

  it("skips an off-edition composite variant (in a composite but absent from ctx map)", () => {
    const composites = [
      { id: "c1", variants: [{ id: "img-1" }] },
    ] as never;
    expect(shouldRenderPrintImage(img(), composites, emptyCtx)).toBe(false);
  });

  it("renders an on-edition composite variant (present in ctx map)", () => {
    const composites = [{ id: "c1", variants: [{ id: "img-1" }] }] as never;
    const ctx = new Map<string, CompositeContext>([
      ["img-1", { compositeId: "c1", edition: "classic" } as never],
    ]);
    expect(shouldRenderPrintImage(img(), composites, ctx)).toBe(true);
  });
});

describe("shouldRenderPrintShape", () => {
  it("renders a visible, in-staging shape", () => {
    expect(shouldRenderPrintShape(shape())).toBe(true);
  });

  it("skips player_visible === false", () => {
    expect(shouldRenderPrintShape(shape({ player_visible: false }))).toBe(false);
  });

  it("skips shapes outside staging", () => {
    expect(shouldRenderPrintShape(shape({ geometry: offStaging }))).toBe(false);
  });
});

describe("shouldRenderPrintAutoPic", () => {
  it("renders when static_image resolves an effective URL", () => {
    expect(shouldRenderPrintAutoPic(autoPic(), undefined, emptyCtx)).toBe(true);
  });

  it("skips when static_image is missing (no fallback to animated media_url)", () => {
    expect(
      shouldRenderPrintAutoPic(autoPic({ static_image: undefined }), undefined, emptyCtx)
    ).toBe(false);
  });

  it("skips when static_image.illustrations is empty", () => {
    expect(
      shouldRenderPrintAutoPic(
        autoPic({ static_image: { illustrations: [] } }),
        undefined,
        emptyCtx
      )
    ).toBe(false);
  });

  it("skips player_visible === false (hidden)", () => {
    expect(shouldRenderPrintAutoPic(autoPic({ player_visible: false }), undefined, emptyCtx)).toBe(false);
  });

  it("skips fully outside staging", () => {
    expect(shouldRenderPrintAutoPic(autoPic({ geometry: offStaging }), undefined, emptyCtx)).toBe(false);
  });

  it("skips an off-edition composite variant (in a composite but absent from ctx map)", () => {
    const composites = [{ id: "c1", variants: [{ id: "ap-1" }] }] as never;
    expect(shouldRenderPrintAutoPic(autoPic(), composites, emptyCtx)).toBe(false);
  });
});

describe("autoPicAsStaticImage", () => {
  it("wraps the effective static illustrations/final_hires and clears media_url", () => {
    const illustrations = [{ media_url: "https://example.test/static.png", is_selected: true, created_time: "t" }];
    const ap = autoPic({
      static_image: { illustrations, final_hires_media_url: "https://example.test/hires.png" },
    });
    const wrapped = autoPicAsStaticImage(ap);
    expect(wrapped.media_url).toBeUndefined();
    expect(wrapped.illustrations).toEqual(illustrations);
    expect(wrapped.final_hires_media_url).toBe("https://example.test/hires.png");
    expect(wrapped.id).toBe("ap-1");
  });

  it("defaults to an empty illustrations array when static_image is absent", () => {
    const wrapped = autoPicAsStaticImage(autoPic({ static_image: undefined }));
    expect(wrapped.media_url).toBeUndefined();
    expect(wrapped.illustrations).toEqual([]);
    expect(wrapped.final_hires_media_url).toBeUndefined();
  });
});

describe("resolvePrintTextboxes", () => {
  const tb = (over: Record<string, unknown> = {}) =>
    ({
      id: "tb-1",
      en_US: {
        text: "Hello",
        geometry: inStaging,
        typography: {},
      },
      ...over,
    }) as never;

  it("returns empty for undefined textboxes", () => {
    expect(resolvePrintTextboxes(undefined, "en_US")).toEqual([]);
  });

  it("resolves a visible textbox for the language", () => {
    const out = resolvePrintTextboxes([tb()], "en_US");
    expect(out).toHaveLength(1);
    expect(out[0].data.text).toBe("Hello");
  });

  it("skips player_visible === false", () => {
    expect(resolvePrintTextboxes([tb({ player_visible: false })], "en_US")).toHaveLength(0);
  });

  it("skips empty text", () => {
    const empty = tb({ en_US: { text: "", geometry: inStaging, typography: {} } });
    expect(resolvePrintTextboxes([empty], "en_US")).toHaveLength(0);
  });

  it("skips textboxes outside staging", () => {
    const off = tb({ en_US: { text: "Hi", geometry: offStaging, typography: {} } });
    expect(resolvePrintTextboxes([off], "en_US")).toHaveLength(0);
  });
});
