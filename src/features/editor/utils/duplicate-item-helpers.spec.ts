// duplicate-item-helpers.spec.ts — Unit tests for nextTopZInTier
// Covers: empty tier, single item, source-included-in-max, excludeId, count>1,
// ceiling clamp + warn log, undefined z-index fallback.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures warnSpy is available when the vi.mock factory runs (which is hoisted).
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

import { cloneItemWithNewId, nextTopZInTier } from "./duplicate-item-helpers";
import { LAYER_CONFIG } from "@/constants/spread-constants";

const MEDIA = LAYER_CONFIG.MEDIA;
const OBJECTS = LAYER_CONFIG.OBJECTS;
const TEXT = LAYER_CONFIG.TEXT;

describe("nextTopZInTier", () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it("empty pictorial tier → returns tier.min", () => {
    const spread = { images: [], videos: [] };
    expect(nextTopZInTier(spread, "pictorial")).toBe(MEDIA.min);
  });

  it("single image z=5 → returns 6", () => {
    const spread = { images: [{ id: "a", "z-index": 5 }] };
    expect(nextTopZInTier(spread, "pictorial")).toBe(6);
  });

  it("source item IS included in max calc when no excludeId", () => {
    // Two items: source z=10, other z=5. maxZ = 10. Result = 11.
    const spread = {
      images: [
        { id: "source", "z-index": 10 },
        { id: "other", "z-index": 5 },
      ],
    };
    expect(nextTopZInTier(spread, "pictorial")).toBe(11);
  });

  it("excludeId removes that item from max scan", () => {
    // Source z=10 excluded, other z=5 remains. maxZ = 5. Result = 6.
    const spread = {
      images: [
        { id: "source", "z-index": 10 },
        { id: "other", "z-index": 5 },
      ],
    };
    expect(nextTopZInTier(spread, "pictorial", { excludeId: "source" })).toBe(6);
  });

  it("count=3 with maxZ=5 → returns 6 (caller assigns 6,7,8)", () => {
    const spread = { images: [{ id: "a", "z-index": 5 }] };
    expect(nextTopZInTier(spread, "pictorial", { count: 3 })).toBe(6);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ceiling hit: maxZ=MEDIA.max → clamps firstZ to MEDIA.max and logs warn", () => {
    const spread = { images: [{ id: "a", "z-index": MEDIA.max }] };
    const result = nextTopZInTier(spread, "pictorial");
    expect(result).toBe(MEDIA.max);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      "nextTopZInTier",
      "ceiling hit — clamping",
      expect.objectContaining({ tier: "pictorial", maxZ: MEDIA.max })
    );
  });

  it("items with undefined z-index fall back to tier.min - 1", () => {
    // Only item has no z-index → falls back to MEDIA.min - 1 = 0. maxZ = 0. Result = 1 = MEDIA.min.
    const spread = { images: [{ id: "a", "z-index": undefined }] };
    expect(nextTopZInTier(spread, "pictorial")).toBe(MEDIA.min);
  });

  it("mix tier: collects shapes + audios + quizzes", () => {
    const spread = {
      shapes: [{ id: "s1", "z-index": 510 }],
      audios: [{ id: "a1", "z-index": 520 as number }],
      quizzes: [{ id: "q1", "z-index": 505 as number }],
    };
    expect(nextTopZInTier(spread, "mix")).toBe(521);
  });

  it("text tier: collects textboxes only", () => {
    const spread = {
      textboxes: [
        { id: "t1", "z-index": 650 },
        { id: "t2", "z-index": 630 },
      ],
    };
    expect(nextTopZInTier(spread, "text")).toBe(651);
  });

  it("pictorial tier: includes auto_pics in max scan", () => {
    const spread = {
      images: [{ id: "img", "z-index": 10 }],
      auto_pics: [{ id: "ap", "z-index": 20 }],
    };
    expect(nextTopZInTier(spread, "pictorial")).toBe(21);
  });

  it("empty mix tier → returns OBJECTS.min", () => {
    expect(nextTopZInTier({}, "mix")).toBe(OBJECTS.min);
  });

  it("empty text tier → returns TEXT.min", () => {
    expect(nextTopZInTier({}, "text")).toBe(TEXT.min);
  });
});

// Pins the structuredClone behaviour against a regression to hand-picked field copying, which
// would silently drop scene lineage on Ctrl+D / raw duplicate (invariant L2 — verbatim copy).
describe("cloneItemWithNewId — scene lineage passthrough", () => {
  it("carries original_image_id verbatim while minting a new id", () => {
    const item = {
      id: "img-1",
      original_image_id: "scene-9",
      geometry: { x: 10, y: 10, w: 20, h: 20 },
    };

    const clone = cloneItemWithNewId(item);

    expect(clone.original_image_id).toBe("scene-9");
    expect(clone.id).not.toBe("img-1");
  });

  it("leaves the key absent when the source has none (no lineage invented)", () => {
    const clone = cloneItemWithNewId({ id: "img-2", geometry: { x: 0, y: 0, w: 10, h: 10 } });

    expect(Object.prototype.hasOwnProperty.call(clone, "original_image_id")).toBe(false);
  });
});
