// use-clone-raw.test.ts — scene lineage birth point (invariant L1).
// Clone raw → playable image MUST stamp original_image_id = raw.id: the source is always a
// raw_images[] entry, so its id IS the scene id.
// See ai-storybook-design/snapshot/illustration-structure.md#scene-lineage-original_image_id.

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { useCloneRaw } from "./use-clone-raw";
import type { BaseSpread, SpreadImage } from "@/types/canvas-types";

const RAW_IMAGE: SpreadImage = {
  id: "raw-1",
  title: "Scene A",
  geometry: { x: 0, y: 0, w: 100, h: 100 },
  media_url: "https://s/raw-1.png",
};

const SPREAD = {
  id: "spread-1",
  raw_images: [RAW_IMAGE],
  images: [],
} as unknown as BaseSpread;

type CloneRawActions = Parameters<typeof useCloneRaw>[2];

function setup() {
  const addRetouchImage = vi.fn();
  const actions = { addRetouchImage } as unknown as CloneRawActions;
  const { result } = renderHook(() => useCloneRaw([SPREAD], "spread-1", actions));
  return { addRetouchImage, result };
}

describe("useCloneRaw.cloneRawImage — scene lineage (L1)", () => {
  it("stamps original_image_id with the source raw image id and mints a fresh item id", () => {
    const { addRetouchImage, result } = setup();

    result.current.cloneRawImage(RAW_IMAGE);

    expect(addRetouchImage).toHaveBeenCalledTimes(1);
    const [spreadId, newImage] = addRetouchImage.mock.calls[0] as [string, SpreadImage];

    expect(spreadId).toBe("spread-1");
    expect(newImage.original_image_id).toBe("raw-1");
    // New identity — the clone is an independent playable item, not a raw alias.
    expect(newImage.id).not.toBe("raw-1");
  });

  it("gives every clone of the same raw the same scene id (group-by-scene stays intact)", () => {
    const { addRetouchImage, result } = setup();

    result.current.cloneRawImage(RAW_IMAGE);
    result.current.cloneRawImage(RAW_IMAGE);

    const [, first] = addRetouchImage.mock.calls[0] as [string, SpreadImage];
    const [, second] = addRetouchImage.mock.calls[1] as [string, SpreadImage];

    expect(first.original_image_id).toBe("raw-1");
    expect(second.original_image_id).toBe("raw-1");
    expect(first.id).not.toBe(second.id);
  });
});
