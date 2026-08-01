// player-spread-stage.parity.test.tsx — parity GATE (ADR-035 Phase 05).
//
// Parity-by-construction: live + render drive the SAME PlayerSpreadStage, so the
// structural DOM (which items render, data-item-id, staging cull, visibility
// split, order, divider) is identical regardless of the injected leaf renderers /
// interactivity — only the media leaf differs (normalized away here). This test
// renders the stage with two different stub renderer sets + different interactivity
// and asserts the normalized structural skeleton matches, plus the individual
// structural invariants the cutover must never regress.

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlayableSpread } from "@/types/playable-types";
import { createReadAlongSpread } from "@/features/demo-spread-views/__mocks__/read-along-spread-fixture";

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PlayerSpreadStage } from "./player-spread-stage";
import type {
  StageItemRenderers,
  ItemInteractivity,
  ItemInteractivityContext,
} from "./play-clock";

const noopRegister = () => () => {};

// Stub leaf renderers — each emits a positioned div tagged with `data-leaf` so we
// can prove the WRAPPER skeleton is identical across renderer sets.
function stubRenderers(tag: string): StageItemRenderers {
  const leaf = (kind: string, geo: { x: number; y: number; w: number; h: number }, z?: number) => (
    <div
      data-leaf={`${tag}-${kind}`}
      style={{
        position: "absolute",
        left: `${geo.x}%`,
        top: `${geo.y}%`,
        width: `${geo.w}%`,
        height: `${geo.h}%`,
        zIndex: z,
      }}
    />
  );
  return {
    page: () => null,
    image: (i, _x, z) => leaf("image", i.geometry, z),
    shape: (s, _x, z) => leaf("shape", s.geometry, z),
    video: (v, _x, z) => leaf("video", v.geometry, z),
    autoPic: (a, _x, z, _source) => leaf("autoPic", a.geometry, z),
    audio: () => null,
    quiz: () => null,
    autoAudio: () => null,
    textbox: (c, _x, z) => leaf("textbox", c.geometry, z),
  };
}

const liveInteractivity = (ctx: ItemInteractivityContext): ItemInteractivity => ({
  className: "pointer-events-none ",
  onClick: () => void ctx.id,
});

function buildFixture(): PlayableSpread {
  const ra = createReadAlongSpread();
  const geo = (x: number, y: number) => ({ x, y, w: 10, h: 10 });
  return {
    id: "parity-fixture",
    pages: ra.pages,
    images: [
      { id: "img-visible", geometry: geo(10, 10), player_visible: true, "z-index": 100, media_url: "http://x/a.png", title: "A" },
      // Fully outside staging [-50,150] → culled.
      { id: "img-culled", geometry: geo(200, 10), player_visible: true, "z-index": 100, media_url: "http://x/b.png" },
      // player_visible=false visual → skipped entirely.
      { id: "img-hidden", geometry: geo(20, 20), player_visible: false, "z-index": 100, media_url: "http://x/c.png" },
    ],
    shapes: [{ id: "shape-1", geometry: geo(30, 30), player_visible: true, "z-index": 150 }],
    videos: [{ id: "vid-1", geometry: geo(40, 40), player_visible: true, "z-index": 200, media_url: "http://x/v.mp4" }],
    auto_pics: [{ id: "pic-1", geometry: geo(50, 50), player_visible: true, "z-index": 210, media_url: "http://x/p.webp" }],
    // audio/quiz hidden → render in DOM (visibility:hidden) for GSAP, no data-item-id.
    audios: [{ id: "aud-hidden", "z-index": 300, player_visible: false, media_url: "http://x/a.mp3" }],
    quizzes: [{ id: "quiz-hidden", "z-index": 400, player_visible: false }],
    textboxes: ra.textboxes,
    composites: [],
    auto_audios: [],
    animations: [],
    manuscript: "parity",
  } as unknown as PlayableSpread;
}

const spread = buildFixture();

function renderStage(tag: string, ix?: (c: ItemInteractivityContext) => ItemInteractivity) {
  return renderToStaticMarkup(
    <PlayerSpreadStage
      spread={spread}
      narrationLangCode="en_US"
      playEdition="interactive"
      registerRef={noopRegister}
      renderers={stubRenderers(tag)}
      getItemInteractivity={ix}
    />
  );
}

/** Strip the parts that legitimately differ between live and render: the leaf
 *  marker value and the interactivity className. What remains is the structural
 *  skeleton (wrappers, data-item-id, hidden style, divider, order). */
function normalize(html: string): string {
  return html
    .replace(/data-leaf="[^"]*"/g, 'data-leaf="LEAF"')
    .replace(/\s*class="[^"]*"/g, "");
}

describe("PlayerSpreadStage parity gate", () => {
  it("structural skeleton is identical across renderer sets + interactivity (live vs render)", () => {
    const a = normalize(renderStage("A", liveInteractivity)); // live-like (Editable* + interactivity)
    const b = normalize(renderStage("B", undefined)); // render-like (Remotion primitives, no interaction)
    expect(a).toBe(b);
  });

  it("data-item-id present only on in-staging, player_visible visual items", () => {
    const html = renderStage("X", liveInteractivity);
    const ids = [...html.matchAll(/data-item-id="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(
      ["img-visible", "pic-1", "shape-1", "vid-1", spread.textboxes![0].id].sort()
    );
    // staging-culled + player_visible=false visuals are absent
    expect(html).not.toContain("img-culled");
    expect(html).not.toContain("img-hidden");
  });

  it("audio/quiz render hidden (visibility:hidden) with NO data-item-id", () => {
    const html = renderStage("X", liveInteractivity);
    expect(html).toContain("visibility:hidden");
    expect(html).not.toContain('data-item-id="aud-hidden"');
    expect(html).not.toContain('data-item-id="quiz-hidden"');
  });

  it("renders the page divider", () => {
    const html = renderStage("X", liveInteractivity);
    expect(html).toContain("bg-gray-300");
  });

  it("interactivity injection never changes structure (className stripped → identical)", () => {
    const withIx = normalize(renderStage("A", liveInteractivity));
    const without = normalize(renderStage("A", undefined));
    expect(withIx).toBe(without);
  });
});

// ── classic auto_pic display-source gating (Phase 02) ───────────────────────
// showAuthoringHints controls whether a classic auto_pic with no static_image
// renders a placeholder (authoring/live) or is skipped entirely (share/print
// parity artifact). A classic auto_pic WITH static_image always renders and the
// leaf renderer must receive `source.mode === 'static'`.
describe("PlayerSpreadStage — classic auto_pic display-source gating", () => {
  function buildClassicFixture(autoPicOverride: Record<string, unknown>): PlayableSpread {
    const ra = createReadAlongSpread();
    return {
      id: "classic-fixture",
      pages: ra.pages,
      images: [],
      shapes: [],
      videos: [],
      auto_pics: [
        {
          id: "pic-classic",
          geometry: { x: 10, y: 10, w: 10, h: 10 },
          player_visible: true,
          "z-index": 100,
          ...autoPicOverride,
        },
      ],
      audios: [],
      quizzes: [],
      textboxes: [],
      composites: [],
      auto_audios: [],
      animations: [],
      manuscript: "classic-fixture",
    } as unknown as PlayableSpread;
  }

  function renderClassic(
    spread: PlayableSpread,
    showAuthoringHints: boolean,
    onAutoPic: (source: unknown) => void
  ) {
    const renderers: StageItemRenderers = {
      page: () => null,
      image: () => null,
      shape: () => null,
      video: () => null,
      autoPic: (_a, _x, _z, source) => {
        onAutoPic(source);
        return <div data-leaf="autoPic" />;
      },
      audio: () => null,
      quiz: () => null,
      autoAudio: () => null,
      textbox: () => null,
    };
    return renderToStaticMarkup(
      <PlayerSpreadStage
        spread={spread}
        narrationLangCode="en_US"
        playEdition="classic"
        registerRef={noopRegister}
        renderers={renderers}
        showAuthoringHints={showAuthoringHints}
      />
    );
  }

  it("classic + missing static + showAuthoringHints=false ⇒ item absent", () => {
    const spread = buildClassicFixture({ media_url: "http://x/animated.webp" }); // no static_image
    const calls: unknown[] = [];
    const html = renderClassic(spread, false, (s) => calls.push(s));
    expect(html).not.toContain('data-item-id="pic-classic"');
    expect(calls).toHaveLength(0);
  });

  it("classic + missing static + showAuthoringHints=true ⇒ item present (placeholder fallthrough)", () => {
    const spread = buildClassicFixture({ media_url: "http://x/animated.webp" }); // no static_image
    const calls: unknown[] = [];
    const html = renderClassic(spread, true, (s) => calls.push(s));
    expect(html).toContain('data-item-id="pic-classic"');
    expect(calls).toEqual([{ mode: "missing-static" }]);
  });

  it("classic + has static_image ⇒ item present, renderer receives source.mode==='static'", () => {
    const spread = buildClassicFixture({
      media_url: "http://x/animated.webp",
      static_image: {
        illustrations: [{ media_url: "http://x/static.png", is_selected: true, created_time: "t" }],
      },
    });
    const calls: Array<{ mode: string }> = [];
    const html = renderClassic(spread, false, (s) => calls.push(s as { mode: string }));
    expect(html).toContain('data-item-id="pic-classic"');
    expect(calls).toEqual([{ mode: "static", url: "http://x/static.png" }]);
  });
});
