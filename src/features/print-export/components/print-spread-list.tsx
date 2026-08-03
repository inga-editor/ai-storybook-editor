// print-spread-list.tsx — Full-bleed page shell around PrintSpreadCanvas + the
// readiness handshake the headless Chromium screenshot job waits on.
//
// Renders EXACTLY ONE spread (illustration.spreads[0]) — per-spread render unit;
// the export job navigates spread-by-spread. Readiness = all <img> decoded
// (image.decode()) AND document.fonts.ready. Both are best-effort: a single
// decode rejection must NOT hang the job.
"use client";

import { useEffect, useMemo, useRef } from "react";
import { PrintSpreadCanvas } from "./print-spread-canvas";
import { createLogger } from "@/utils/logger";
import type { PlayableSpread } from "@/types/playable-types";
import type { IllustrationData } from "@/types/illustration-types";
import type { PageNumberingSettings } from "@/types/editor";

const log = createLogger("PrintExport", "PrintSpreadList");

export interface PrintSpreadListProps {
  illustration: IllustrationData; // contains exactly 1 spread (book|remix polymorphic)
  languageKey: string;
  pageNumbering?: PageNumberingSettings | null;
  onFontsReady?: () => void;
  onAllImagesDecoded?: () => void;
}

export function PrintSpreadList({
  illustration,
  languageKey,
  pageNumbering,
  onFontsReady,
  onAllImagesDecoded,
}: PrintSpreadListProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Cast BaseSpread → PlayableSpread (default animations[]) — mirrors share-preview.
  //
  // Spread Pool (phase 04): intentionally NO `filterDefaultStorySpreads` here. This
  // path always renders EXACTLY the one spread the server chose (`renderConfig.spread_id`,
  // via share/01 render-preview — the single source of truth, same authority the
  // share-preview client defers to). Default PDF scope is already pool-filtered
  // server-side (phase 01 `collect_spreads_in_scope`), so a hidden alternate never
  // reaches this component in default mode; when the user picks an explicit
  // `spread_ids=[<pool spread>]`, explicit wins (matches jobs/06) and the server passes
  // it verbatim — a client filter here would wrongly drop it. So: don't filter.
  const spread = useMemo<PlayableSpread | null>(() => {
    const raw = illustration.spreads?.[0];
    if (!raw) return null;
    return {
      ...(raw as Omit<PlayableSpread, "animations">),
      animations: (raw as Partial<PlayableSpread>).animations ?? [],
    };
  }, [illustration]);

  // Fonts readiness.
  useEffect(() => {
    document.fonts.ready.then(() => {
      log.info("fontsReady", "document fonts ready");
      onFontsReady?.();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Image decode readiness — run after the DOM has the <img> nodes (rAF).
  useEffect(() => {
    if (!spread) return;
    const raf = requestAnimationFrame(() => {
      const imgs = Array.from(
        wrapperRef.current?.querySelectorAll("img") ?? []
      ) as HTMLImageElement[];
      Promise.allSettled(imgs.map((img) => img.decode())).then((results) => {
        const rejected = results.filter((r) => r.status === "rejected").length;
        if (rejected > 0) {
          log.warn("imagesDecoded", "some images failed to decode", {
            spreadId: spread.id,
            imgCount: imgs.length,
            rejected,
          });
        } else {
          log.info("imagesDecoded", "all images decoded", {
            spreadId: spread.id,
            imgCount: imgs.length,
          });
        }
        onAllImagesDecoded?.();
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [spread]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!spread) {
    log.warn("render", "no spread in illustration — rendering null (job will time out)");
    return null;
  }

  return (
    <div ref={wrapperRef} className="print-spread-list">
      <div className="full-bleed-page relative" style={{ width: "max-content" }}>
        <PrintSpreadCanvas
          spread={spread}
          languageKey={languageKey}
          pageNumbering={pageNumbering}
        />
      </div>
    </div>
  );
}
