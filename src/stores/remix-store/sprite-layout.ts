// sprite-layout.ts — Client-side sprite-sheet layout for the Variants tab
// (sprite-swap batch model). Mirrors `crop-sheet-layout.ts` (the mix plane) but
// on the `remixes.sprites[]` column and SINGLE-SUBJECT: each crop is ONE
// character/prop variant's ORIGINAL artwork (not a multi-subject spread crop).
//
// LAYOUT ENGINE REUSE (divergence from plan §02 — fallback 3B, by design):
// `utils/crop-sheet-layout-engine.ts::computeCropSheetLayout` is already
// key-agnostic — it takes `CropInput[]` (id + widthPct/heightPct + objectKey
// affinity) and packs into K sheets via potpack + entity-affinity partition. We
// reuse it VERBATIM for sprites rather than extracting a separate `pack` util +
// refactoring the mix engine: the engine IS the shared pack, so DRY is already
// satisfied and the mix path stays byte-for-byte untouched (zero Batches
// regression risk — golden test trivially passes). Sprite cells use the
// variant artwork's NATURAL dimensions (measured client-side per layout, never
// persisted) against a synthetic SQUARE cap-sized spread (sprite sheets are
// NOT tied to the book canvas dimension); a single global factor down-scales
// every cell together when the longest edge exceeds the cap, preserving the
// TRUE relative proportions between variants.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import { getImageNaturalDimensionsFromUrl } from '@/utils/aspect-ratio-utils';
import { newUuid } from '@/utils/uuid';
import type {
  Remix,
  RemixCharacter,
  RemixSpriteCropSheet,
  RemixSpriteEntry,
  SpriteCrop,
} from '@/types/remix';
import { computeCropSheetLayout } from '@/utils/crop-sheet-layout-engine';
import type {
  CropInput,
  CropSheetLayoutResult,
} from '@/utils/crop-sheet-layout-engine';
import { SHEET_MIN } from './crop-sheet-layout';
import type { RelayoutDeps } from './crop-sheet-layout';

const log = createLogger('Store', 'SpriteLayout');

/** A remix must keep at least this many sprites. The last sprite cannot be
 *  removed (caller also hides the affordance). */
export const SPRITE_MIN = 1;

/**
 * Per-cell LONGEST-EDGE cap (px) for the sprite layout, chosen by how many
 * cells share ONE sheet. This cap is NOT cosmetic — it bounds BOTH:
 *   (a) the build-crop-sheet composition box → Gemini swap INPUT fidelity, and
 *   (b) the post-swap resize target in image-api `sprite_cut.py` (each swapped
 *       piece is resized DOWN to its `crop.geometry`) → the RESOLUTION CEILING
 *       of the final swapped variant artwork.
 * Fewer cells → a larger cap (each gets more of Gemini's ~4K output budget);
 * more cells → a smaller cap so the composed sheet stays under the swap
 * endpoint's sheet caps (clamped defensively in `buildSpriteSheetsFromLayout`).
 * Cells keep their NATURAL aspect — the cap only bounds the longest edge via a
 * single global factor across all cells (see `partitionByObjectAffinity`).
 * Tiers (cells-per-sheet → px): ≤2→2000, >2→1000.
 */
function spriteCapDim(cellsPerSheet: number): number {
  return cellsPerSheet <= 2 ? 2000 : 1000;
}

/** Padding (px) on EACH side of every sprite cell, EQUAL on both axes → the gap
 *  between adjacent cells is `2·SPRITE_GUTTER = 64px` horizontally AND
 *  vertically. Square cells look lopsided under the engine's asymmetric default
 *  (gutterX=4 / gutterY=32); 64px each way is uniform and still tall enough for
 *  the ordinal badge baked into the top gutter (cap ≤50px). */
const SPRITE_GUTTER = 32;

/** Uniform OUTER margin (px) on all four sides after re-framing (see
 *  `buildSpriteSheetsFromLayout`). Equal on every side so a square cell grid
 *  frames to a 1:1 sheet; the top side still needs ≥ the ordinal badge height
 *  (~50px), hence 64. */
const SPRITE_MARGIN = 64;

/** Sheet caps mirrored from image-api `build_crop_sheet.py` (MAX_SHEET_DIM /
 *  MAX_SHEET_PIXELS — reused by the swap-sprite-sheet endpoint). The endpoint
 *  REJECTS any sheet exceeding either, so we clamp the layout here: a
 *  many-variant sheet degrades resolution gracefully instead of failing the
 *  swap job later. Keep in sync with the Python constants. */
const MAX_SHEET_DIM = 8192;
const MAX_SHEET_PIXELS = 32_000_000;

/** Pre-geometry sprite cell (engine input meta) — a `SpriteCrop` minus the
 *  engine-computed `geometry`, plus the artwork's measured natural dimensions.
 *  `width`/`height` are TRANSIENT engine input only — measured per layout and
 *  stripped before persisting (`toSpriteCrop`); the persisted `SpriteCrop`
 *  schema is unchanged. */
export type SpriteCell = Omit<SpriteCrop, 'geometry'> & {
  /** Natural artwork width (px) — transient, engine input only. */
  width?: number;
  /** Natural artwork height (px) — transient, engine input only. */
  height?: number;
};

/** Stable per-cell key — `${type}/${object_key}/${variant_key}`. Single source
 *  of truth for selection sets, ownership keys, and engine `CropInput.id`. */
export function spriteCellKey(cell: {
  type: string;
  object_key: string;
  variant_key: string;
}): string {
  return `${cell.type}/${cell.object_key}/${cell.variant_key}`;
}

/** Builds the title for sheet `index` — `"sheet <n+1>"` (1-based, mix parity). */
function sheetTitle(index: number): string {
  return `sheet ${index + 1}`;
}

/**
 * Resolve a variant's ORIGINAL artwork URL: selected illustration → first
 * illustration → null. NEVER reads `visual_swap_url` (sprite-swap must run on
 * the source artwork, not a prior swap output — avoids re-swap compounding).
 */
export function originalVariantArtwork(variant: {
  illustrations?: { media_url: string; is_selected: boolean }[];
}): string | null {
  const list = variant.illustrations ?? [];
  const selected = list.find((i) => i.is_selected);
  return selected?.media_url ?? list[0]?.media_url ?? null;
}

/** True when a character is VISUAL-swappable in the remix config (drives sprite
 *  scope). ⚡2026-08-06: requires the entry to carry a `traits` key (presence =
 *  visual-availability marker) — a text-only personalize entry (no `traits`) is
 *  NOT sprite-swapped. Char absent from `remix_config.characters` → excluded. */
function isCharacterEnabled(remix: Remix, charKey: string): boolean {
  const cfg = remix.remix_config.characters.find((c) => c.key === charKey);
  return !!cfg && cfg.is_enabled && cfg.traits != null;
}

/**
 * Collect the sprite cells for a remix: every variant (with resolvable artwork)
 * of every ENABLED character, in `remix.characters` order. char-only v1 — props
 * are excluded from the layout. De-duplicated by `spriteCellKey`.
 */
export function groupVariantsForSprite(remix: Remix): SpriteCell[] {
  const cells: SpriteCell[] = [];
  const seen = new Set<string>();

  const pushVariants = (
    chars: RemixCharacter[],
    type: 'character',
  ): void => {
    for (const char of chars) {
      if (!isCharacterEnabled(remix, char.key)) continue;
      for (const variant of char.variants ?? []) {
        const media_url = originalVariantArtwork(variant);
        if (!media_url) continue; // no artwork → cannot swap; skip
        const cell: SpriteCell = {
          type,
          object_key: char.key,
          variant_key: variant.key,
          media_url,
        };
        const key = spriteCellKey(cell);
        if (seen.has(key)) continue;
        seen.add(key);
        cells.push(cell);
      }
    }
  };

  pushVariants(remix.characters, 'character');

  log.debug('groupVariantsForSprite', 'grouped', {
    charCount: remix.characters.length,
    cellCount: cells.length,
  });
  return cells;
}

/** Materialize engine output into `RemixSpriteCropSheet[]`. Each placement's
 *  geometry (px, sheet-relative — engine output) is attached to the matching
 *  cell. `image_url` always '' (client composes from crops); `swap_results`
 *  always [] (fresh layout → any prior swap is stale geometry). */
/** Down-scale factor bringing a sheet within BOTH caps (1 = already within).
 *  Uses sqrt for the pixel cap so area scales linearly with the factor. */
function capScaleFactor(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  const dimF = Math.min(1, MAX_SHEET_DIM / width, MAX_SHEET_DIM / height);
  const pxF =
    width * height > MAX_SHEET_PIXELS
      ? Math.sqrt(MAX_SHEET_PIXELS / (width * height))
      : 1;
  return Math.min(dimF, pxF);
}

/** Persisted-schema projection: picks ONLY `SpriteCrop` fields off a cell,
 *  stripping the transient measured `width`/`height` (a naive spread would
 *  leak them into the persisted `sprites` column). */
function toSpriteCrop(
  cell: SpriteCell,
  geometry: SpriteCrop['geometry'],
): SpriteCrop {
  return {
    type: cell.type,
    object_key: cell.object_key,
    variant_key: cell.variant_key,
    media_url: cell.media_url,
    geometry,
  };
}

/** Measure every cell's natural artwork dimensions in parallel. Per-cell
 *  isolation: a failed/degenerate read logs a warning and yields null — the
 *  caller falls back to a square cap-sized cell so one bad image never sinks
 *  the whole layout. Re-measured on every layout (browser-cached → cheap);
 *  dimensions are never persisted. */
async function measureCellDims(
  cells: SpriteCell[],
): Promise<Map<string, { width: number; height: number } | null>> {
  const entries = await Promise.all(
    cells.map(async (cell) => {
      const key = spriteCellKey(cell);
      try {
        const dim = await getImageNaturalDimensionsFromUrl(cell.media_url);
        if (dim.width <= 0 || dim.height <= 0) {
          throw new Error(`degenerate dimensions ${dim.width}×${dim.height}`);
        }
        return [key, dim] as const;
      } catch (e) {
        log.warn('measureCellDims', 'dim read failed — fallback square cell', {
          cellKey: key,
          url: cell.media_url,
          error: e instanceof Error ? e.message : String(e),
        });
        return [key, null] as const;
      }
    }),
  );
  return new Map(entries);
}

function buildSpriteSheetsFromLayout(
  layout: CropSheetLayoutResult,
  cellByKey: Record<string, SpriteCell>,
  inputIndex: Record<string, number>,
): RemixSpriteCropSheet[] {
  return layout.sheets.map((sheet) => {
    // Sort by INPUT order (remix.characters order) so `crops[]` — and thus the
    // 1..N ordinal badges — follow character order even though potpack places
    // boxes size-sorted (geometric position is fill-optimized, not ordered).
    const placed = sheet.placements
      .filter((p) => cellByKey[p.id])
      .sort((a, b) => (inputIndex[a.id] ?? 0) - (inputIndex[b.id] ?? 0));
    if (placed.length === 0) {
      return {
        title: sheetTitle(sheet.index),
        sheet_geometry: sheet.sheetGeometry,
        image_url: '',
        swap_results: [],
        original_crops: [],
      };
    }

    // 1. Re-frame: hug the packed content with an EQUAL SPRITE_MARGIN on all
    //    sides. The engine snaps each sheet to one of its allowed ratios, which
    //    stretches one axis (a square 2×2[2,1] grid → a 4:3 sheet with a wide
    //    empty right strip). Tightening to content + symmetric margins removes
    //    that waste → a square cell grid yields a 1:1 sheet, while keeping the
    //    badge's top-gutter room (margin ≥ badge height).
    const minX = Math.min(...placed.map((p) => p.geometry.x));
    const minY = Math.min(...placed.map((p) => p.geometry.y));
    const maxR = Math.max(...placed.map((p) => p.geometry.x + p.geometry.w));
    const maxB = Math.max(...placed.map((p) => p.geometry.y + p.geometry.h));
    const dx = SPRITE_MARGIN - minX;
    const dy = SPRITE_MARGIN - minY;
    let width = maxR - minX + 2 * SPRITE_MARGIN;
    let height = maxB - minY + 2 * SPRITE_MARGIN;
    let geoms = placed.map((p) => ({
      id: p.id,
      x: p.geometry.x + dx,
      y: p.geometry.y + dy,
      w: p.geometry.w,
      h: p.geometry.h,
    }));

    // 2. Cap guard on the tightened sheet — floor sheet + floor crops keeps every
    //    crop within the (smaller) sheet and strictly under both caps:
    //    floor(x·f)+floor(w·f) ≤ floor((x+w)·f) ≤ sheetW.
    const f = capScaleFactor(width, height);
    if (f < 1) {
      log.warn('buildSpriteSheetsFromLayout', 'sheet exceeds caps — scaling down', {
        sheetIndex: sheet.index,
        width,
        height,
        factor: Number(f.toFixed(4)),
      });
      width = Math.floor(width * f);
      height = Math.floor(height * f);
      geoms = geoms.map((g) => ({
        id: g.id,
        x: Math.floor(g.x * f),
        y: Math.floor(g.y * f),
        w: Math.max(1, Math.floor(g.w * f)),
        h: Math.max(1, Math.floor(g.h * f)),
      }));
    }

    return {
      title: sheetTitle(sheet.index),
      sheet_geometry: { width, height },
      image_url: '',
      swap_results: [],
      original_crops: geoms.map((g) =>
        toSpriteCrop(cellByKey[g.id], { x: g.x, y: g.y, w: g.w, h: g.h }),
      ),
    };
  });
}

/** Re-group cells so variants of one `object_key` sit ADJACENT, keeping the
 *  object_keys' first-appearance order and the original order within a group.
 *  Stored sheet order can interleave characters — a K≥2 layout splits an
 *  over-budget cluster crop-by-crop across sheets, and the next relayout reads
 *  cells back in sheet order (e.g. [leela/e, didi/b, leela/s]). Without this
 *  normalization that interleaving leaks into `crops[]` → ordinals AND
 *  (equal-size) placement stop grouping a character's variants together. */
function groupCellsByObjectKey(cells: SpriteCell[]): SpriteCell[] {
  const order: string[] = [];
  const groups = new Map<string, SpriteCell[]>();
  for (const c of cells) {
    let g = groups.get(c.object_key);
    if (!g) {
      g = [];
      groups.set(c.object_key, g);
      order.push(c.object_key);
    }
    g.push(c);
  }
  return order.flatMap((key) => groups.get(key)!);
}

/**
 * Partition sprite cells into K sheets via the shared layout engine. Affinity
 * key = `object_key` (variants of one character stay on the same sheet where
 * possible). Input is normalized via `groupCellsByObjectKey` first — variants
 * of one character are ALWAYS adjacent in `crops[]`/ordinals, whatever order
 * the caller carried (seed order is already grouped; relayout/subset order may
 * be interleaved by a prior multi-sheet split). Cells carry the artwork's
 * NATURAL dimensions (measured per layout from `media_url`), capped on the
 * longest edge by a SINGLE global factor so the relative proportions between
 * variants stay true; measurement failure falls back to a square cap-sized
 * cell. Async — callers await.
 */
export async function partitionByObjectAffinity(
  cells: SpriteCell[],
  k: number,
): Promise<RemixSpriteCropSheet[]> {
  cells = groupCellsByObjectKey(cells);
  const sheetCount = Math.max(1, k);
  // Cap keys off how many cells share ONE sheet (≈ even split), so a sprite
  // re-laid-out across more sheets gets larger, higher-res cells.
  const cellsPerSheet = Math.ceil(cells.length / sheetCount);
  const cap = spriteCapDim(cellsPerSheet);

  const dims = await measureCellDims(cells);
  const sized = cells.map((cell) => {
    const d = dims.get(spriteCellKey(cell));
    return d ? { cell, w: d.width, h: d.height } : { cell, w: cap, h: cap };
  });

  // ONE global factor for ALL cells, keyed off the single longest edge — keeps
  // every variant's size relative to the others true. Never upscales (≤ 1).
  const longest = sized.reduce((m, s) => Math.max(m, s.w, s.h), 0);
  const factor = longest > cap ? cap / longest : 1;
  if (factor < 1) {
    log.debug('partitionByObjectAffinity', 'global down-scale to cap', {
      longest,
      cap,
      factor: Number(factor.toFixed(4)),
    });
  }

  const cellByKey: Record<string, SpriteCell> = {};
  const inputIndex: Record<string, number> = {};
  const inputs: CropInput[] = sized.map(({ cell, w, h }, i) => {
    const id = spriteCellKey(cell);
    cellByKey[id] = cell;
    inputIndex[id] = i;
    // % of the synthetic `cap`-square spread → engine emits w·factor × h·factor
    // px. factor already pins the longest edge ≤ cap, so pct ≤ 100 (the min is
    // defensive only).
    return {
      id,
      widthPct: Math.min(100, ((w * factor) / cap) * 100),
      heightPct: Math.min(100, ((h * factor) / cap) * 100),
      objectKey: cell.object_key,
    };
  });
  const layout = computeCropSheetLayout(inputs, {
    sheetCount,
    spread: { width: cap, height: cap },
    // Equal padding on both axes → uniform 64px gaps between cells (the engine
    // default gutterX=4 made horizontal gaps 8× tighter than vertical). The
    // ordinal badge still fits the 64px top gutter.
    gutterX: SPRITE_GUTTER,
    gutterY: SPRITE_GUTTER,
    // τ=0.1: accept a landscape grid when within 10% fill of the best ratio.
    // Without it, near-square cells snap tighter to portrait ratios → 2–3 cells
    // pack into a TALL single-column 9:16 stack (lopsided). 0.1 gives N=2 →
    // 2-col row and N=3 → 2-col [2,1], while leaving perfect-fill grids (N=1
    // 1:1, N=4 2×2, N=6 3:2) intact; 0.2+ starts degrading those (1 cell → 5:4).
    landscapeTolerance: 0.1,
    // Cluster (sheet-assignment) order follows remix.characters appearance
    // instead of area-desc, AND potpack breaks equal-size ties by input order
    // (equal cells place top-left → bottom-right in character order, matching
    // the ordinal badges). Ordinal order itself comes from the inputIndex sort
    // in buildSpriteSheetsFromLayout. Mix plane never sets this flag.
    preserveInputOrder: true,
  });
  return buildSpriteSheetsFromLayout(layout, cellByKey, inputIndex);
}

/** Distinct (deduped) cells currently living on a sprite — reads ONLY pre-swap
 *  `sheet.original_crops[]` (never `swap_results[].crops[]`). Dedup key = cellKey. */
export function currentCellsOfSprite(sprite: RemixSpriteEntry): SpriteCrop[] {
  const seen = new Set<string>();
  const out: SpriteCrop[] = [];
  for (const sheet of sprite.crop_sheets) {
    for (const crop of sheet.original_crops) {
      const key = spriteCellKey(crop);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(crop);
    }
  }
  return out;
}

/** Build the K=1 sheet set for a NEW sprite from a selected subset of the active
 *  sprite's cells (modal "Add as Sprite"). `media_url` is the ORIGINAL artwork
 *  carried on the active sprite's pre-swap crops. Returns [] when nothing
 *  matched (caller throws on stale selection). */
export async function addSpriteSubset(
  activeSprite: RemixSpriteEntry,
  selectedCellKeys: ReadonlySet<string>,
): Promise<RemixSpriteCropSheet[]> {
  const subset: SpriteCell[] = currentCellsOfSprite(activeSprite)
    .filter((c) => selectedCellKeys.has(spriteCellKey(c)))
    .map((c) => ({
      type: c.type,
      object_key: c.object_key,
      variant_key: c.variant_key,
      media_url: c.media_url,
    }));
  if (subset.length === 0) return [];
  return partitionByObjectAffinity(subset, 1);
}

/** Make a fresh persisted sprite entry skeleton (mirror makeBatchSkeleton). */
export function makeSpriteSkeleton(order: number, name: string): RemixSpriteEntry {
  return { id: newUuid(), order, name, crop_sheets: [] };
}

/**
 * Seed an initial sprite (K=1, all enabled-character variants) into the insert
 * payload / remix IN PLACE when none exists. Idempotent — no-op when
 * `sprites.length >= 1`. Returns the seeded entry, or null when already seeded
 * / no cells to lay out.
 */
export async function buildSeedSprite(remix: Remix): Promise<RemixSpriteEntry | null> {
  if (remix.sprites.length >= 1) return null;
  const cells = groupVariantsForSprite(remix);
  if (cells.length === 0) {
    log.warn('buildSeedSprite', 'no variant cells to seed — skip', {
      remixId: remix.id,
    });
    return null;
  }
  const entry: RemixSpriteEntry = {
    ...makeSpriteSkeleton(0, 'Sprite 1'),
    crop_sheets: await partitionByObjectAffinity(cells, 1),
  };
  log.info('buildSeedSprite', 'seeded', {
    remixId: remix.id,
    sheetCount: entry.crop_sheets.length,
    cellCount: cells.length,
  });
  return entry;
}

// ── Persistence helpers (sprites column) — mirror crop-sheet-layout ───────────

/** Persist the `sprites` column with the freshest in-store value, rolling back
 *  to `prevRemix` on error. Shared by add/remove/seed/relayout. */
async function persistSprites(
  deps: RelayoutDeps,
  remixId: string,
  prevRemix: Remix,
  action: string,
): Promise<boolean> {
  const { set, get } = deps;
  const remixAfter = get().remixes.find((r) => r.id === remixId);
  if (!remixAfter) {
    log.warn(action, 'remix gone before persist — skip', { remixId });
    return false;
  }
  const { error } = await supabase
    .from('remixes')
    .update({ sprites: remixAfter.sprites })
    .eq('id', remixId);
  if (error) {
    log.error(action, 'persist failed — rollback', { remixId, error: error.message });
    set((s) => ({
      remixes: s.remixes.map((r) => (r.id === remixId ? prevRemix : r)),
    }));
    return false;
  }
  return true;
}

/**
 * Re-layouts ALL sheets of ONE sprite at `currentSheetCount + delta`, clamped to
 * `[SHEET_MIN, cropCount]` (a sheet holds ≥1 cell). Re-packs the sprite's OWN cells (pre-swap
 * `sheet.original_crops[]`, scoped to the sprite — subset sprites carry a subset).
 *
 * SWAP-RESULTS CONTRACT (callers MUST gate): a successful re-layout REBUILDS the
 * sprite's sheets (swap_results cleared — stale geometry). Caller gates on
 * existing swap_results (confirm dialog).
 *
 * Returns false on guard hit (missing remix/sprite, no-op count, empty cells,
 * persist error rolled back); true after persist.
 */
export async function relayoutSpriteSheets(
  deps: RelayoutDeps,
  remixId: string,
  spriteId: string,
  delta: number,
): Promise<boolean> {
  const { set, get } = deps;
  log.info('relayoutSpriteSheets', 'start', { remixId, spriteId, delta });

  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('relayoutSpriteSheets', 'remix not found — abort', { remixId });
    return false;
  }
  const sprite = prevRemix.sprites.find((s) => s.id === spriteId);
  if (!sprite) {
    log.warn('relayoutSpriteSheets', 'sprite not found — abort', { remixId, spriteId });
    return false;
  }

  // Re-pack the sprite's own cells (ORIGINAL artwork carried on the crops).
  const cells: SpriteCell[] = currentCellsOfSprite(sprite).map((c) => ({
    type: c.type,
    object_key: c.object_key,
    variant_key: c.variant_key,
    media_url: c.media_url,
  }));
  if (cells.length === 0) {
    log.warn('relayoutSpriteSheets', 'no cells to layout — abort', { remixId, spriteId });
    return false;
  }

  const currentCount = sprite.crop_sheets.length;
  // Cap K at the sprite's crop count — a sheet must hold ≥1 cell, so requesting
  // more sheets than cells only yields empties (replaces the old SHEET_MAX=10).
  const nextCount = Math.min(cells.length, Math.max(SHEET_MIN, currentCount + delta));
  if (nextCount === currentCount) {
    log.debug('relayoutSpriteSheets', 'no count change — skip', {
      remixId,
      spriteId,
      currentCount,
    });
    return false;
  }
  const newSheets = await partitionByObjectAffinity(cells, nextCount);

  set((s) => ({
    remixes: s.remixes.map((r) =>
      r.id === remixId
        ? {
            ...r,
            sprites: r.sprites.map((sp) =>
              sp.id === spriteId ? { ...sp, crop_sheets: newSheets } : sp,
            ),
          }
        : r,
    ),
  }));

  log.debug('relayoutSpriteSheets', 'optimistic replaceAll', {
    remixId,
    spriteId,
    currentCount,
    nextCount,
    cellCount: cells.length,
  });

  const ok = await persistSprites(deps, remixId, prevRemix, 'relayoutSpriteSheets');
  if (ok) log.info('relayoutSpriteSheets', 'done', { remixId, spriteId, nextCount });
  return ok;
}

/**
 * Append a NEW sprite as a SUBSET clone of the active sprite (modal "Add as
 * Sprite" with per-cell selection). `selectedCellKeys` = cellKeys picked off the
 * active sprite's pre-swap crops. K=1 sheet from the subset; ordered
 * `max(order)+1`. Optimistic push + `sprites` persist with rollback.
 *
 * Throws on empty selection / zero match (stale keys). Returns the new sprite
 * id on persist success, null on guard miss / persist failure.
 */
export async function addSprite(
  deps: RelayoutDeps,
  remixId: string,
  activeSpriteId: string,
  selectedCellKeys: ReadonlySet<string>,
): Promise<string | null> {
  const { set, get } = deps;
  log.info('addSprite', 'start', {
    remixId,
    activeSpriteId,
    selectionSize: selectedCellKeys.size,
  });

  if (selectedCellKeys.size === 0) {
    log.warn('addSprite', 'empty selection — throw', { remixId, activeSpriteId });
    throw new Error('addSprite requires a non-empty cell selection');
  }

  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('addSprite', 'remix not found — abort', { remixId });
    return null;
  }

  const activeSprite =
    prevRemix.sprites.find((s) => s.id === activeSpriteId) ?? prevRemix.sprites[0];
  if (!activeSprite) {
    log.warn('addSprite', 'no active sprite — abort', { remixId, activeSpriteId });
    return null;
  }

  const newSheets = await addSpriteSubset(activeSprite, selectedCellKeys);
  if (newSheets.length === 0) {
    log.warn('addSprite', 'selection has zero matches in active sprite — throw', {
      remixId,
      activeSpriteId,
      selectionSize: selectedCellKeys.size,
    });
    throw new Error(
      'addSprite: selection does not match any cell of the active sprite (stale)',
    );
  }

  const order = prevRemix.sprites.reduce((max, s) => Math.max(max, s.order), -1) + 1;
  const newSprite: RemixSpriteEntry = {
    ...makeSpriteSkeleton(order, `Sprite ${prevRemix.sprites.length + 1}`),
    crop_sheets: newSheets,
  };

  set((s) => ({
    remixes: s.remixes.map((r) =>
      r.id === remixId ? { ...r, sprites: [...r.sprites, newSprite] } : r,
    ),
  }));

  log.debug('addSprite', 'optimistic push', {
    remixId,
    spriteId: newSprite.id,
    order,
    sheetCount: newSprite.crop_sheets.length,
  });

  const ok = await persistSprites(deps, remixId, prevRemix, 'addSprite');
  if (!ok) return null;
  log.info('addSprite', 'done', { remixId, spriteId: newSprite.id });
  return newSprite.id;
}

/**
 * Remove a sprite by id. Guarded so the last sprite cannot be removed
 * (`sprites.length > SPRITE_MIN`). Optimistic filter + `sprites` persist with
 * rollback. Returns true on success.
 */
export async function removeSprite(
  deps: RelayoutDeps,
  remixId: string,
  spriteId: string,
): Promise<boolean> {
  const { set, get } = deps;
  log.info('removeSprite', 'start', { remixId, spriteId });

  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('removeSprite', 'remix not found — abort', { remixId });
    return false;
  }
  if (!prevRemix.sprites.some((s) => s.id === spriteId)) {
    log.warn('removeSprite', 'sprite not found — abort', { remixId, spriteId });
    return false;
  }
  if (prevRemix.sprites.length <= SPRITE_MIN) {
    log.warn('removeSprite', 'cannot remove last sprite — abort', {
      remixId,
      spriteId,
      count: prevRemix.sprites.length,
    });
    return false;
  }

  set((s) => ({
    remixes: s.remixes.map((r) =>
      r.id === remixId
        ? { ...r, sprites: r.sprites.filter((sp) => sp.id !== spriteId) }
        : r,
    ),
  }));

  log.debug('removeSprite', 'optimistic remove', { remixId, spriteId });
  return persistSprites(deps, remixId, prevRemix, 'removeSprite');
}

/**
 * Seed an initial sprite into a remix when none exists (lazy, modal-mount).
 * Idempotent — no-op (returns false) when the remix already has ≥1 sprite or
 * there are no variant cells. Optimistic push + persist with rollback.
 */
export async function seedInitialSpriteIfMissing(
  deps: RelayoutDeps,
  remixId: string,
): Promise<boolean> {
  const { set, get } = deps;
  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('seedInitialSpriteIfMissing', 'remix not found — skip', { remixId });
    return false;
  }
  if (prevRemix.sprites.length >= 1) {
    log.debug('seedInitialSpriteIfMissing', 'sprite already present — skip', {
      remixId,
      spriteCount: prevRemix.sprites.length,
    });
    return false;
  }
  const entry = await buildSeedSprite(prevRemix);
  if (!entry) return false;

  // Re-check emptiness inside the updater — the await above (async dim
  // measurement) opens a window where a concurrent mount could already have
  // seeded; seeding twice would orphan a sprite. The loser must also skip
  // persist: persisting would be a duplicate write, and its failure path would
  // roll back to prevRemix (sprites: []), transiently wiping the winner.
  let applied = false;
  set((s) => ({
    remixes: s.remixes.map((r) => {
      if (r.id !== remixId || r.sprites.length !== 0) return r;
      applied = true;
      return { ...r, sprites: [entry] };
    }),
  }));
  if (!applied) {
    log.debug('seedInitialSpriteIfMissing', 'lost seed race — skip persist', {
      remixId,
    });
    return false;
  }

  log.info('seedInitialSpriteIfMissing', 'optimistic seed', {
    remixId,
    spriteId: entry.id,
  });
  return persistSprites(deps, remixId, prevRemix, 'seedInitialSpriteIfMissing');
}
