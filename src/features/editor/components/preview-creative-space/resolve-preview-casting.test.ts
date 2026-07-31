// resolve-preview-casting.test.ts — pure build-time casting resolver.
// Covers: effective-selection resolution, canonical castKey, per-image URL
// resolution (5-step + fallback), and applyCastingToSpreads clone/reference
// behavior. No node builtins (fixtures are inline).

import { describe, expect, it } from "vitest";
import type { CastingAxis } from "@/types/editor";
import type { BaseSpread, ItemCastingSlot, SpreadImage } from "@/types/spread-types";
import {
  applyCastingToSpreads,
  castKeyOf,
  resolveCastedImageUrl,
  resolveEffectiveCastSelection,
  buildActantAxisIndex,
  type EffectiveCastSelection,
} from "./resolve-preview-casting";

// ── Fixture ids ───────────────────────────────────────────────────────────────
const AX_ADULT = "ax-adult";
const AX_PET = "ax-pet";
const ACT_HERO = "act-hero";
const ACT_PET = "act-pet";

const URL_A = "https://example.test/actorA.png";
const URL_B = "https://example.test/actorB.png";
const URL_PET_DEFAULT = "https://example.test/pet-default.png";

function makeAxes(): CastingAxis[] {
  return [
    {
      id: AX_ADULT,
      name: "Adult",
      actants: [{ id: ACT_HERO, name: "Hero" }],
      presets: [
        {
          id: "p-a",
          name: "Preset A",
          is_default: true,
          actants: [{ actant_id: ACT_HERO, actor_id: "actorA", actor_type: 1 }],
        },
        {
          id: "p-b",
          name: "Preset B",
          is_default: false,
          actants: [{ actant_id: ACT_HERO, actor_id: "actorB", actor_type: 1 }],
        },
      ],
    },
    {
      id: AX_PET,
      name: "Pet",
      actants: [{ id: ACT_PET, name: "Pet" }],
      presets: [
        { id: "pp-1", name: "Pet Default", is_default: true, actants: [] },
        { id: "pp-2", name: "Pet Alt", is_default: false, actants: [] },
      ],
    },
  ];
}

function makeCastingSlot(): ItemCastingSlot {
  return {
    actant_id: ACT_HERO,
    actors: [
      { id: "actorA", actor_type: 1, media_url: URL_A, is_default: true },
      { id: "actorB", actor_type: 1, media_url: URL_B, is_default: false },
    ],
  };
}

function makeImage(over: Partial<SpreadImage> = {}): SpreadImage {
  return {
    id: over.id ?? "img-1",
    geometry: { x: 0, y: 0, w: 100, h: 100 },
    media_url: "https://example.test/normal-chain.png",
    ...over,
  };
}

function makeSpread(images: SpreadImage[]): BaseSpread {
  return {
    id: "spread-1",
    pages: [],
    images,
    textboxes: [],
  };
}

// ── resolveEffectiveCastSelection ─────────────────────────────────────────────

describe("resolveEffectiveCastSelection", () => {
  it("case 1: remix source → null", () => {
    expect(resolveEffectiveCastSelection("remix-x", makeAxes(), {})).toBeNull();
  });

  it("case 2: no axes → null", () => {
    expect(resolveEffectiveCastSelection(null, [], {})).toBeNull();
  });

  it("case 3: no override → every axis on is_default", () => {
    const sel = resolveEffectiveCastSelection(null, makeAxes(), {});
    expect(sel).toEqual({ [AX_ADULT]: "p-a", [AX_PET]: "pp-1" });
  });

  it("case 4: valid override → that axis flips, others keep default", () => {
    const sel = resolveEffectiveCastSelection(null, makeAxes(), {
      [AX_ADULT]: "p-b",
    });
    expect(sel).toEqual({ [AX_ADULT]: "p-b", [AX_PET]: "pp-1" });
  });

  it("case 5: stale override (deleted preset) → default, input map untouched", () => {
    const override = { [AX_ADULT]: "p-deleted" };
    const snapshot = { ...override };
    const sel = resolveEffectiveCastSelection(null, makeAxes(), override);
    expect(sel?.[AX_ADULT]).toBe("p-a");
    expect(override).toEqual(snapshot); // not mutated
  });

  it("case 6: axis with zero presets is skipped", () => {
    const axes = makeAxes();
    axes[1].presets = [];
    const sel = resolveEffectiveCastSelection(null, axes, {});
    expect(sel).toEqual({ [AX_ADULT]: "p-a" });
    expect(AX_PET in (sel ?? {})).toBe(false);
  });

  it("case 7: axis without is_default falls back to presets[0]", () => {
    const axes = makeAxes();
    axes[0].presets = axes[0].presets.map((p) => ({ ...p, is_default: false }));
    const sel = resolveEffectiveCastSelection(null, axes, {});
    expect(sel?.[AX_ADULT]).toBe("p-a"); // presets[0]
  });
});

// ── castKeyOf ─────────────────────────────────────────────────────────────────

describe("castKeyOf", () => {
  it("case 8: order-independent canonical string", () => {
    const a: EffectiveCastSelection = { [AX_ADULT]: "p-a", [AX_PET]: "pp-1" };
    const b: EffectiveCastSelection = { [AX_PET]: "pp-1", [AX_ADULT]: "p-a" };
    expect(castKeyOf(a)).toBe(castKeyOf(b));
    expect(castKeyOf(a)).toBe(`${AX_ADULT}=p-a,${AX_PET}=pp-1`);
  });

  it("case 9: null selection → null", () => {
    expect(castKeyOf(null)).toBeNull();
  });

  it("empty selection → null", () => {
    expect(castKeyOf({})).toBeNull();
  });
});

// ── resolveCastedImageUrl ─────────────────────────────────────────────────────

describe("resolveCastedImageUrl", () => {
  const axes = makeAxes();
  const index = buildActantAxisIndex(axes);
  const axisById = new Map(axes.map((a) => [a.id, a] as const));

  it("case 10: happy path → cast entry media_url", () => {
    const sel = { [AX_ADULT]: "p-b", [AX_PET]: "pp-1" };
    const url = resolveCastedImageUrl(makeCastingSlot(), index, axisById, sel);
    expect(url).toBe(URL_B);
  });

  it("case 11: preset does not cast this actant → default actor", () => {
    const slot: ItemCastingSlot = {
      actant_id: ACT_HERO,
      actors: [
        { id: "actorA", actor_type: 1, media_url: URL_A, is_default: true },
      ],
    };
    // preset pp for a different actant list — use axis with empty assignment
    const sel = { [AX_ADULT]: "p-a" };
    // swap preset p-a to not cast hero
    const localAxes = makeAxes();
    localAxes[0].presets[0].actants = [];
    const localIndex = buildActantAxisIndex(localAxes);
    const localAxisById = new Map(localAxes.map((a) => [a.id, a] as const));
    const url = resolveCastedImageUrl(slot, localIndex, localAxisById, sel);
    expect(url).toBe(URL_A); // default actor fallback
  });

  it("case 12: casted actor has no entry / empty media → default actor", () => {
    const slot: ItemCastingSlot = {
      actant_id: ACT_HERO,
      actors: [
        { id: "actorA", actor_type: 1, media_url: URL_A, is_default: true },
        // actorB entry missing → cast for p-b cannot resolve
      ],
    };
    const url = resolveCastedImageUrl(slot, index, axisById, {
      [AX_ADULT]: "p-b",
    });
    expect(url).toBe(URL_A);
  });

  it("case 13: dangling actant → default actor fallback", () => {
    const slot: ItemCastingSlot = {
      actant_id: "act-unknown",
      actors: [
        { id: "x", actor_type: 1, media_url: URL_PET_DEFAULT, is_default: true },
      ],
    };
    const url = resolveCastedImageUrl(slot, index, axisById, {
      [AX_ADULT]: "p-a",
    });
    expect(url).toBe(URL_PET_DEFAULT);
  });

  it("case 14: no is_default entry → null (keep normal chain)", () => {
    const slot: ItemCastingSlot = {
      actant_id: "act-unknown",
      actors: [
        { id: "x", actor_type: 1, media_url: URL_PET_DEFAULT, is_default: false },
      ],
    };
    const url = resolveCastedImageUrl(slot, index, axisById, {
      [AX_ADULT]: "p-a",
    });
    expect(url).toBeNull();
  });

  it("null selection → null", () => {
    expect(resolveCastedImageUrl(makeCastingSlot(), index, axisById, null)).toBeNull();
  });
});

// ── applyCastingToSpreads ─────────────────────────────────────────────────────

describe("applyCastingToSpreads", () => {
  const axes = makeAxes();

  it("case 15: selection null → legacy behavior, images keep reference", () => {
    const img = makeImage();
    const spread = makeSpread([img]);
    const [out] = applyCastingToSpreads([spread], axes, null);
    expect(out.animations).toEqual([]);
    expect(out.images[0]).toBe(img); // same reference
  });

  it("case 16: image without casting_slot keeps reference", () => {
    const img = makeImage();
    const spread = makeSpread([img]);
    const [out] = applyCastingToSpreads([spread], axes, {
      [AX_ADULT]: "p-b",
    });
    expect(out.images[0]).toBe(img);
  });

  it("case 17: casted image collapses chain (media_url + final_hires, illustrations undefined)", () => {
    const img = makeImage({
      id: "img-cast",
      casting_slot: makeCastingSlot(),
      illustrations: [
        { media_url: "https://example.test/old.png", is_selected: true } as never,
      ],
      final_hires_media_url: "https://example.test/old-hires.png",
    });
    const spread = makeSpread([img]);
    const [out] = applyCastingToSpreads([spread], axes, { [AX_ADULT]: "p-b" });
    const casted = out.images[0];
    expect(casted.media_url).toBe(URL_B);
    expect(casted.final_hires_media_url).toBe(URL_B);
    expect(casted.illustrations).toBeUndefined();
    expect(casted).not.toBe(img); // cloned
  });

  it("case 18: spread with no changed image returns no new images array", () => {
    const img = makeImage(); // no casting_slot
    const spread = makeSpread([img]);
    const [out] = applyCastingToSpreads([spread], axes, { [AX_ADULT]: "p-b" });
    expect(out.images).toBe(spread.images); // same array reference
  });

  it("case 19: image with both parametric_slot + casting_slot → casting wins", () => {
    const img = makeImage({
      id: "img-both",
      casting_slot: makeCastingSlot(),
      parametric_slot: { key: "country", values: [] },
    });
    const spread = makeSpread([img]);
    const [out] = applyCastingToSpreads([spread], axes, { [AX_ADULT]: "p-a" });
    expect(out.images[0].media_url).toBe(URL_A);
  });

  it("case 20: source input object is not mutated", () => {
    const img = makeImage({ id: "img-cast", casting_slot: makeCastingSlot() });
    const spread = makeSpread([img]);
    const before = JSON.parse(JSON.stringify(spread));
    applyCastingToSpreads([spread], axes, { [AX_ADULT]: "p-b" });
    expect(spread).toEqual(before);
  });
});
