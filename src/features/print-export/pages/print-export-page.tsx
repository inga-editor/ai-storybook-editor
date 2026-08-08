// print-export-page.tsx — Standalone route /print/:id?token=<jwt> rendering exactly
// one spread @300 DPI for the headless Chromium screenshot job.
//
// Flow: parse token (query) → POST get-render-preview (1 call, source-agnostic,
// token in body, NO X-API-Key) → hydrate full-bleed canvas size + book store →
// render PrintSpreadList → gate window.__PRINT_READY__ on fonts + image decode.
//
// Zero coupling to GSAP/playback/audio: the static render path (PrintSpreadCanvas)
// reads only editor-settings-store (canvasSize/zoom) + book-store. No playback
// initialize()/teardown() and no music/sound hydration are needed (decision #1).
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PrintSpreadList } from "../components/print-spread-list";
import {
  loadRenderPreview,
  RenderPreviewError,
  type RenderPreviewResult,
} from "@/apis/share-api";
import { useEditorSettingsActions } from "@/stores/editor-settings-store";
import { useBookStore } from "@/stores/book-store";
import { createLogger } from "@/utils/logger";
import { mapBookPreviewToBook } from "@/features/player-core/hydration/map-book-preview-to-book";
import type { IllustrationData } from "@/types/illustration-types";

const log = createLogger("PrintExport", "PrintExportPage");

type PrintExportStatus = "loading" | "ready" | "error";

// Print builds the editor Book via the shared mapper with `includeAudio:false`
// — print is a silent static raster, so narrator/music/sound are nulled. Reusing
// the shared mapper keeps this mapping in sync with the player/share consumers.

export function PrintExportPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const { hydrateBleedCanvas } = useEditorSettingsActions();

  const [status, setStatus] = useState<PrintExportStatus>("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [data, setData] = useState<RenderPreviewResult | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [imagesDecoded, setImagesDecoded] = useState(false);

  // Reset the capture flag on entry so a reused browser context (or a retried
  // navigation) never lets the screenshot job read a stale `true` before this
  // render has actually painted. Synchronous window write — not React state.
  useEffect(() => {
    window.__PRINT_READY__ = false;
  }, []);

  // === Load render preview ===
  useEffect(() => {
    if (!token) return; // missing-token is derived at render — no setState here
    let active = true;
    log.info("load", "loading render preview", { bookId: id, hasToken: true });
    loadRenderPreview(token)
      .then((result) => {
        if (!active) return;
        log.info("load", "render preview loaded", {
          spreadId: result.renderConfig.spread_id,
          edition: result.renderConfig.edition,
          language: result.renderConfig.language,
        });
        setData(result);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        const httpStatus = err instanceof RenderPreviewError ? err.status : 0;
        const message =
          httpStatus === 401
            ? "Token invalid or expired."
            : httpStatus === 404
            ? "Book/remix/spread not found."
            : "Failed to load preview.";
        log.error("load", "render preview failed", { status: httpStatus });
        setErrorMsg(message);
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [token, id]);

  // === Hydrate canvas size (full-bleed) + book store ===
  useEffect(() => {
    if (!data) return;
    const { book, renderConfig } = data;
    // ADR-023: sets canvasSize = full DPS + bleed (DIMENSION_CANVAS_SIZE = page×2).
    hydrateBleedCanvas(book.dimension ?? null, renderConfig.bleed_mm);
    useBookStore.getState().setCurrentBook(mapBookPreviewToBook(book, { includeAudio: false }));
    log.info("hydrate", "canvas + book hydrated", {
      bookId: book.id,
      dimension: book.dimension,
      bleedMm: renderConfig.bleed_mm,
    });
    return () => {
      log.debug("hydrate", "cleanup — reset book store");
      useBookStore.getState().setCurrentBook(null);
      // Zoom intentionally NOT reset (decision #4).
    };
  }, [data, hydrateBleedCanvas]);

  // === Readiness gate → window.__PRINT_READY__ ===
  useEffect(() => {
    if (!fontsReady || !imagesDecoded) return;
    const raf = requestAnimationFrame(() => {
      window.__PRINT_READY__ = true;
      log.info("readiness", "print ready signalled");
    });
    return () => cancelAnimationFrame(raf);
  }, [fontsReady, imagesDecoded]);

  // Missing token is derived directly (no effect/setState) — the load effect
  // early-returns, so status stays 'loading' forever without this guard.
  if (!token) {
    log.warn("render", "missing token in query");
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-white">
        <span className="text-sm text-red-500">Missing render token.</span>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-white">
        <span className="text-sm text-gray-400">Loading…</span>
      </div>
    );
  }

  if (status === "error" || !data) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-white">
        <span className="text-sm text-red-500">{errorMsg || "Error"}</span>
      </div>
    );
  }

  // Ready state MUST size to the canvas (not the viewport): the spread renders at
  // the full-bleed × PRINT_RENDER_ZOOM(400) pixel count (e.g. 5175×2623 @300 DPI).
  // A `h-screen w-screen overflow-hidden` wrapper would clip it to the headless
  // viewport (1280×720) and — because clipped overflow does NOT extend document
  // scroll size — `page.screenshot({ fullPage:true })` would capture only the
  // viewport. `width:max-content` lets html/body grow to the canvas so fullPage
  // captures the whole spread. NO overflow/height clamp on this path.
  return (
    <div className="bg-white" style={{ width: "max-content" }}>
      <PrintSpreadList
        illustration={data.illustration as unknown as IllustrationData}
        languageKey={data.renderConfig.language}
        pageNumbering={data.book.template_layout?.page_numbering ?? null}
        onFontsReady={() => setFontsReady(true)}
        onAllImagesDecoded={() => setImagesDecoded(true)}
      />
    </div>
  );
}
