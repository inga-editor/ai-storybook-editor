// build-static-image-after-upload.test.ts — unit tests for the pure
// post-upload static_image builder (WYSIWYG contract, see source header).
import { describe, it, expect } from "vitest";
import { buildStaticImageAfterUpload } from "./build-static-image-after-upload";
import type { Illustration } from "@/types/prop-types";

const NOW = "2026-08-01T00:00:00.000Z";

describe("buildStaticImageAfterUpload", () => {
  it("prepends the new entry as is_selected:true", () => {
    const result = buildStaticImageAfterUpload([], "https://example.test/new.png", NOW);
    expect(result.illustrations[0]).toEqual({
      type: "uploaded",
      media_url: "https://example.test/new.png",
      created_time: NOW,
      is_selected: true,
    });
  });

  it("flips prior entries to is_selected:false while preserving the rest of their fields", () => {
    const prev: Illustration[] = [
      { media_url: "https://example.test/old-1.png", created_time: "t1", is_selected: true, type: "created" },
      { media_url: "https://example.test/old-2.png", created_time: "t2", is_selected: false, type: "uploaded" },
    ];
    const result = buildStaticImageAfterUpload(prev, "https://example.test/new.png", NOW);
    expect(result.illustrations).toHaveLength(3);
    expect(result.illustrations[1]).toEqual({
      media_url: "https://example.test/old-1.png",
      created_time: "t1",
      is_selected: false,
      type: "created",
    });
    expect(result.illustrations[2]).toEqual({
      media_url: "https://example.test/old-2.png",
      created_time: "t2",
      is_selected: false,
      type: "uploaded",
    });
  });

  it("always sets final_hires_media_url === undefined, even when prev had it", () => {
    // buildStaticImageAfterUpload takes only prevIllustrations (no prev final_hires
    // param) — the WYSIWYG contract is enforced unconditionally by the function
    // signature itself; this test locks the returned shape regardless of caller.
    const prev: Illustration[] = [
      { media_url: "https://example.test/old.png", created_time: "t1", is_selected: true },
    ];
    const result = buildStaticImageAfterUpload(prev, "https://example.test/new.png", NOW);
    expect(result.final_hires_media_url).toBeUndefined();
    expect("final_hires_media_url" in result).toBe(true); // explicit key, not omitted
  });

  it("does not spread unknown/stale keys from prior entries beyond the known shape", () => {
    const prev: Illustration[] = [
      { media_url: "https://example.test/old.png", created_time: "t1", is_selected: true },
    ];
    const result = buildStaticImageAfterUpload(prev, "https://example.test/new.png", NOW);
    expect(Object.keys(result).sort()).toEqual(["final_hires_media_url", "illustrations"]);
  });
});
