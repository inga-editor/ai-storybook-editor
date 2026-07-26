// lineup-content-area.tsx — the Lineup canvas (design 02). Locked crops stand side-by-side,
// bottom-aligned on a baseline, all scaled by ONE shared pxPerCm derived from each variant's
// real-world height; a 0.5 m ruler is drawn OVER them (chốt user: "vẽ đè lên").
//
// Presentational/dumb + read-only: no edit, no select, no ✏ (deviation vs mock, chốt user
// 2026-07-17). Zoom is owned by the root.
//
// Two constraints here are load-bearing and easy to "fix" wrongly:
//   • Zoom = CSS HEIGHT driver (stage height = `{zoom}%`), NEVER transform:scale — a transform
//     leaves layout at fit-size, so the overflow-auto scroll metrics go stale and the zoomed-in
//     content becomes unreachable (memory: zoom-via-css-width; pattern: generate-canvas.tsx).
//   • Crops are NEVER shrunk to fit horizontally — the row overflows into an x-scroll instead
//     (design §2.3). A 5 cm prop rendering tiny is the honest answer, not a bug: no min-size.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { LineupEntry, SketchLineupTab } from '@/types/sketch';
import { ZoomControl } from '@/features/editor/components/shared-components/zoom-control';
import { ZOOM, mentionOf } from './lineup-constants';
import { LineupTabStrip } from './lineup-tab-strip';
import {
  LINEUP_LAYOUT,
  LINEUP_ZOOM_STEP,
  computeLineupScale,
  imageHeightPx,
  type LineupRulerLine,
} from './lineup-scale-math';

const log = createLogger('Editor', 'LineupContentArea');

export interface LineupContentAreaProps {
  /** Checked AND selectable entries only, in SIDEBAR order (Validation S1 — render-time
   *  ordering; the persisted entries[] append-order carries no display semantics). */
  entries: LineupEntry[];
  /** 25..200; 100 = ruler fits the viewport height. */
  zoom: number;
  onChangeZoom: (zoom: number) => void;
  // ── Multi-tab (2026-07-25): the header hosts the tab strip + dangling chip ──
  /** Effective tabs (persisted, or the single virtual tab before first save). */
  tabs: SketchLineupTab[];
  activeTabId: string;
  /** Write affordances greyed (peer lock). Tab SELECT + zoom stay live. */
  writeDisabled: boolean;
  /** Members of the active tab that cannot render (deleted entity/variant or no image/height). */
  danglingCount: number;
  onSelectTab: (tabId: string) => void;
  onRequestRenameTab: (tabId: string) => void;
  onRequestDeleteTab: (tabId: string) => void;
  onCleanupDangling: () => void;
}

export function LineupContentArea({
  entries,
  zoom,
  onChangeZoom,
  tabs,
  activeTabId,
  writeDisabled,
  danglingCount,
  onSelectTab,
  onRequestRenameTab,
  onRequestDeleteTab,
  onCleanupDangling,
}: LineupContentAreaProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Measured, not computed: the stage height is `{zoom}%` of the scroll container, so only the
  // browser knows it. 0 until the observer fires — computeLineupScale guards that first frame.
  const [stageHeight, setStageHeight] = useState(0);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver((observed) => {
      const next = observed[0]?.contentRect.height ?? 0;
      // Ignore sub-pixel churn so a resize can never ping-pong with a re-render.
      setStageHeight((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Re-derives on entries (selection / peer edit) or stageHeight (zoom, container resize) — the
  // ONE place the shared scale comes from. Kept PURE: React may discard and recompute a useMemo,
  // so logging from inside it would double-fire under StrictMode.
  const { pxPerCm, baselineY, lines, topMeters } = useMemo(
    () => computeLineupScale(entries, stageHeight),
    [entries, stageHeight],
  );

  // Post-commit → the log reports scales that actually rendered, once each.
  useEffect(() => {
    log.debug('computeScale', 'lineup scale derived', {
      count: entries.length,
      stageHeight: Math.round(stageHeight),
      topMeters,
      pxPerCm: Number(pxPerCm.toFixed(3)),
    });
  }, [entries.length, stageHeight, topMeters, pxPerCm]);

  return (
    <section
      className="flex h-full min-w-[480px] flex-1 flex-col bg-muted/20"
      aria-label="Lineup canvas"
    >
      {/* Header — ONE h-11 row, aligned with the sidebar header + every other editor space
          (design 02 §2.1): tab strip (left, flexes + x-scrolls) · dangling chip (appears only when
          > 0) · zoom (right). NO ✏ (design §2.4); ＋ lives in the sidebar header only. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
        <LineupTabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          disabled={writeDisabled}
          onSelectTab={onSelectTab}
          onRequestRenameTab={onRequestRenameTab}
          onRequestDeleteTab={onRequestDeleteTab}
        />
        {danglingCount > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
            {danglingCount} mục không khả dụng ·
            <button
              type="button"
              disabled={writeDisabled}
              title={writeDisabled ? 'Another editor is editing the Lineup' : 'Remove unavailable entries from this tab'}
              className={cn('font-medium underline-offset-2', writeDisabled ? 'opacity-50' : 'hover:underline')}
              onClick={onCleanupDangling}
            >
              Dọn
            </button>
          </span>
        )}
        <ZoomControl
          value={zoom}
          onChange={onChangeZoom}
          min={ZOOM.min}
          max={ZOOM.max}
          step={LINEUP_ZOOM_STEP}
        />
      </div>

      {/* Scroll container. `overflow-x: SCROLL` (not auto) is load-bearing, not a style choice:
          the stage height is a % of THIS box and crop widths derive from that height via each
          image's natural ratio, so an h-scrollbar that appears/disappears would feed back —
          bar appears → steals ~15px of height → crops get narrower → contentW drops under
          viewportW → bar disappears → crops widen → bar returns. React sits inside that loop via
          the ResizeObserver, so the browser's own single-pass relayout guard doesn't stop it.
          Reserving the h-bar unconditionally keeps clientH independent of contentW and removes the
          feedback edge entirely. (`scrollbar-gutter: stable` does NOT work here — it reserves the
          INLINE axis only, leaving clientH still scrollbar-dependent. Verified in Chromium.)
          overflow-y stays `auto`: a v-bar only steals WIDTH, and nothing derives from width — no
          loop. Invisible on macOS/overlay scrollbars either way; this is for Windows/Linux. */}
      <div
        className="relative flex-1 overflow-x-scroll overflow-y-auto"
        role="tabpanel"
        aria-labelledby={`lineup-tab-${activeTabId}`}
      >
        {/* Stage. `w-max min-w-full` lets the crop row dictate the width (so the ruler spans the
            whole scrollable area for free) while still filling the viewport when it is narrower.
            `isolate` pins the z-band locally: the ruler must paint over the images, and a stray
            stacking context on an ancestor must never be able to invert that
            (memory: container-type-leaks-over-portal → isolation, not a global z-index bump). */}
        <div
          ref={stageRef}
          className="relative isolate w-max min-w-full"
          style={{ height: `${zoom}%` }}
        >
          {entries.length === 0 ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
              {/* Same translucent chip as the metre labels — the 2 m ruler is drawn over this. */}
              <p className="rounded bg-background/70 px-2 py-1 text-center text-sm text-muted-foreground backdrop-blur-[2px]">
                Select characters or props to build the lineup
              </p>
            </div>
          ) : (
            <div
              className="relative z-10 flex h-full items-end"
              style={{
                gap: LINEUP_LAYOUT.cropGapPx,
                paddingLeft: LINEUP_LAYOUT.sidePaddingPx,
                paddingRight: LINEUP_LAYOUT.sidePaddingPx,
                paddingTop: LINEUP_LAYOUT.topPaddingPx,
                // Reserves the label strip → `items-end` lands the crops on the baseline.
                paddingBottom: LINEUP_LAYOUT.labelStripPx,
              }}
            >
              {entries.map((entry, index) => (
                // Keyed on the URL too: a peer locking a different crop swaps the image, and the
                // key change resets this cell's load state without an effect.
                <LineupCrop
                  key={`${entry.ref}:${entry.imageUrl ?? 'none'}`}
                  entry={entry}
                  heightPx={imageHeightPx(entry, pxPerCm)}
                  // Stagger: even above, odd below — mentions of neighbouring crops never collide.
                  staggerPx={index % 2 === 0 ? 0 : LINEUP_LAYOUT.labelStaggerPx}
                />
              ))}
            </div>
          )}

          {/* Always last + z-20 → the ruler reads over the artwork, even when nothing is selected. */}
          <LineupRulerOverlay lines={lines} baselineY={baselineY} />
        </div>
      </div>
    </section>
  );
}

/** Dashed 0.5 m lines + the solid baseline, spanning the full stage width. Decorative: the height
 *  is already announced on each crop's label, so the whole layer is aria-hidden (design §2.7). */
function LineupRulerOverlay({
  lines,
  baselineY,
}: {
  lines: LineupRulerLine[];
  baselineY: number;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-hidden="true">
      {lines.map((line) => (
        <div
          key={line.meters}
          className="absolute inset-x-0 border-t border-dashed border-muted-foreground/40"
          style={{ top: line.y }}
        >
          {/* sticky → the metre label rides along the left edge while scrolling horizontally;
              the translucent chip keeps it legible where it sits on top of a crop. */}
          <span className="sticky left-2 inline-block -translate-y-1/2 rounded bg-background/70 px-1 text-xs text-muted-foreground backdrop-blur-[2px]">
            {line.meters} m
          </span>
        </div>
      ))}
      <div
        className="absolute inset-x-0 border-t-2 border-foreground/60"
        style={{ top: baselineY }}
      />
    </div>
  );
}

type CropStatus = 'loading' | 'loaded' | 'error';

/** One crop: image scaled to `heightPx` (width stays natural — never distorted), plus its mention
 *  below the baseline. Skeleton while loading, framed placeholder + mention on failure. */
function LineupCrop({
  entry,
  heightPx,
  staggerPx,
}: {
  entry: LineupEntry;
  heightPx: number;
  staggerPx: number;
}) {
  const [status, setStatus] = useState<CropStatus>('loading');
  // Display uses the design's mention form; `entry.ref` stays identity-only (review M2).
  const label = `${mentionOf(entry)}, ${entry.heightCm ?? 0} cm`;
  // `entries` are pre-filtered to selectable, so a null URL is defensive only.
  const failed = status === 'error' || entry.imageUrl == null;

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-end',
        // Before the image reports its natural width the cell would collapse to 0 and the skeleton
        // would spill over its neighbours — hold a minimum until it loads.
        !failed && status === 'loading' && 'min-w-8',
      )}
      style={{ height: heightPx }}
    >
      {failed ? (
        <div
          role="img"
          aria-label={label}
          className="flex h-full items-center justify-center overflow-hidden rounded border border-dashed border-muted-foreground/50 bg-muted/30 px-1"
          style={{ width: Math.max(48, Math.round(heightPx * 0.45)) }}
        >
          <span className="truncate text-[10px] text-muted-foreground">{mentionOf(entry)}</span>
        </div>
      ) : (
        <>
          <img
            src={entry.imageUrl ?? undefined}
            alt={label}
            loading="lazy"
            draggable={false}
            onLoad={() => setStatus('loaded')}
            onError={() => {
              log.warn('LineupCrop', 'crop image failed to load', { ref: entry.ref });
              setStatus('error');
            }}
            className={cn(
              'h-full w-auto max-w-none select-none object-contain',
              status !== 'loaded' && 'invisible',
            )}
          />
          {status === 'loading' && (
            <div
              className="absolute inset-0 animate-pulse rounded bg-muted"
              aria-hidden="true"
            />
          )}
        </>
      )}

      {/* Mention — centred on the crop, hanging in the label strip under the baseline. Visual only:
          the ref + height are already announced by the image's own label, so a screen reader would
          otherwise hear the ref twice per crop (design §2.7 makes the same call for the ruler). */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-full -translate-x-1/2 whitespace-nowrap text-sm text-muted-foreground"
        style={{ marginTop: staggerPx + 6 }}
      >
        {mentionOf(entry)}
      </span>
    </div>
  );
}
