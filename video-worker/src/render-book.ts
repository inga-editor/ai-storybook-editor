// video-worker/src/render-book.ts
// Full-book render pipeline (design 06-book-render.md §7):
//   1. selectComposition("book-video", inputProps) → durationInFrames (via calculateMetadata in bundle)
//   2. resolveBookSequence + planChunks (Node-side via tsx @/ resolution)
//   3. Sequential chunk loop: renderMedia(frameRange, closedGOP) → chunk-{i}.mp4  [retry CHUNK_RETRY]
//   4. ffmpeg -f concat -safe 0 -i list.txt -c copy → book-concat.mp4
//   5. Optional BGM mux (mux-bgm.ts) → book-{ts}-{uuid8}.mp4; degrade on fail
//   6. Cleanup chunks + intermediates
//
// Closed-GOP strategy: gopSize = chunkFrames (I-frame at chunk start) +
//   ffmpegOverride appends --no-open-gop so no B-frame references cross a seam.
//   This satisfies the concat demuxer's requirement for bit-exact GOP boundaries.
//   Fallback: if -c copy seam produces glitches, re-encode with -c:v libx264.
//
// @/ imports work at runtime because the worker is launched via `npx tsx` (or
// `node --import=tsx`) which reads video-worker/tsconfig.json paths: @/* → ../src/*.
// DO NOT import `@/` in type position if it triggers Vite-only virtual modules.

import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { renderMedia, selectComposition } from "@remotion/renderer";

// @/ resolves via tsx (worker tsconfig.json: "@/*" → "../src/*")
import { resolveBookSequence } from "@/features/editor/components/playable-spread-view/resolve-book-sequence";
import { planChunks } from "@/remotion/plan-chunks";
import {
  BOOK_COMPOSITION_ID,
  CHUNK_RETRY,
  MAX_BOOK_SPREADS,
  type ResolutionKey,
} from "@/remotion/composition-metadata";

import { getBundle } from "./render.js";
import { OUT_DIR, tierOutDir, MASTER_TIER } from "./paths.js";
import { muxBgm, type BgmInput } from "./mux-bgm.js";

// Per-chunk timeout. Book chunks don't share the 120s /render cap.
// 10 min per chunk allows a 5-spread chunk at 30fps to render even on slow machines.
const CHUNK_TIMEOUT_MS = 10 * 60 * 1000;

// Render concurrency per-chunk (keep same as single-spread for consistency).
const RENDER_CONCURRENCY = 2;

export interface BookRenderInput {
  spreads: unknown[];
  sections?: unknown[];
  edition: "classic" | "dynamic";
  language: string;
  startSpreadId?: string;
  bgm?: BgmInput | null;
  /** Book sizing (job 07 supplies these): the composition derives the design-canvas
   *  width — which scales render font/border px to match the live player — from
   *  dimension (+ bleed) via the player's table. Omitted → 800×600 fallback. */
  dimension?: number;
  bleedMm?: number;
  /** Page-turn SFX URL (book.sound.transition_id resolved upstream). When set, the
   *  composition plays it at each turn segment's start frame. */
  transitionSfxUrl?: string | null;
}

export interface BookRenderResult {
  fileName: string;
  outputLocation: string;
  // Relative fallback URL "/files/{tier}/{fileName}" (MASTER_TIER=qhd). The server
  // overrides this with the storage-service URL when storage is configured + bookId
  // present (design 06 §6.1); out/qhd is scratch/cache in that posture.
  publicUrl: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  spreadsRendered: number;
  truncatedByCycle: boolean;
  truncatedByCap: boolean;
  warnings: string[];
  elapsedMs: number;
}

/**
 * Render the full book as a single MP4.
 *
 * @param input  Validated render input (spreads/sections/edition/language/bgm).
 * @param fileName  Output file name (caller generates: book-{ts}-{uuid8}.mp4 used
 *                  as the FINAL name; concat intermediate uses book-concat-{uuid8}.mp4).
 */
export async function renderBook(
  input: BookRenderInput,
  fileName: string
): Promise<BookRenderResult> {
  const start = Date.now();
  const warnings: string[] = [];

  await fs.mkdir(OUT_DIR, { recursive: true });
  const serveUrl = await getBundle();

  // ── 1. Resolve sequence (Node-side, same fn as calculateMetadata) ─────────
  // Typed cast: spreads/sections come from JSON body (unknown[]) — walker only
  // accesses known fields (id, branch_setting, animations); extra fields are fine.
  const spreadsArr = input.spreads as Parameters<typeof resolveBookSequence>[0];
  const sectionsArr = (input.sections ?? []) as Parameters<typeof resolveBookSequence>[1];

  const sequence = resolveBookSequence(spreadsArr, sectionsArr, {
    startSpreadId: input.startSpreadId,
    edition: input.edition,
  });

  // ── 2. Validate sequence length ───────────────────────────────────────────
  // Caller (server.ts) also checks this, but guard here for direct callers.
  if (sequence.ordered.length === 0) {
    throw new Error("EMPTY_SEQUENCE");
  }
  if (sequence.ordered.length > MAX_BOOK_SPREADS) {
    throw new Error("BOOK_TOO_LARGE");
  }

  const spreadsRendered = sequence.ordered.length;

  // ── 3. Compose inputProps for the composition (matches BookVideoInputProps) ─
  const resolution: ResolutionKey = "qhd";
  const inputProps = {
    spreads: spreadsArr,
    sections: sectionsArr,
    edition: input.edition,
    language: input.language,
    startSpreadId: input.startSpreadId,
    resolution,
    ...(input.dimension != null ? { dimension: input.dimension } : {}),
    ...(input.bleedMm != null ? { bleedMm: input.bleedMm } : {}),
    ...(input.transitionSfxUrl ? { transitionSfxUrl: input.transitionSfxUrl } : {}),
  } as unknown as Record<string, unknown>;

  // ── 4. selectComposition → durationInFrames (calculateMetadata in bundle) ──
  const composition = await selectComposition({
    serveUrl,
    id: BOOK_COMPOSITION_ID,
    inputProps,
  });

  const { durationInFrames, width, height, fps } = composition;
  console.log(`[render-book] composition id=${BOOK_COMPOSITION_ID} frames=${durationInFrames} ${width}x${height}@${fps}`);

  // ── 5. Plan chunks (Node-side, same pure function as worker-side plan) ────
  // Edition MUST match selectComposition above — otherwise spread durations
  // diverge from the composition's durationInFrames (classic filters animations
  // → shorter spreads) and the last chunk overruns. Bug 2026-06-06.
  const chunks = planChunks(sequence, fps, input.edition);
  console.log(`[render-book] ${spreadsRendered} spreads → ${chunks.length} chunks (truncByCycle=${sequence.truncatedByCycle} truncByCap=${sequence.truncatedByCap})`);

  // ── 6. Render each chunk ──────────────────────────────────────────────────
  const chunkPaths: string[] = [];
  const runId = randomUUID().slice(0, 8);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkFile = `chunk-${runId}-${i}.mp4`;
    const chunkPath = path.join(OUT_DIR, chunkFile);

    await renderChunkWithRetry({
      serveUrl,
      composition,
      inputProps,
      frameRange: [chunk.start, chunk.end - 1], // Remotion frameRange is [start, endInclusive]
      outputLocation: chunkPath,
      chunkIndex: i,
      totalChunks: chunks.length,
    });

    chunkPaths.push(chunkPath);
    console.log(`[render-book] chunk ${i + 1}/${chunks.length} done → ${chunkFile}`);
  }

  // ── 7. ffmpeg concat → book-concat-{runId}.mp4 ───────────────────────────
  const concatPath = path.join(OUT_DIR, `book-concat-${runId}.mp4`);
  await ffmpegConcat(chunkPaths, concatPath);
  console.log(`[render-book] concat done → ${path.basename(concatPath)}`);

  // Cleanup chunk files immediately after concat
  await Promise.all(chunkPaths.map((p) => fs.unlink(p).catch(() => undefined)));

  // ── 8. BGM mux (optional, degrade on fail) ───────────────────────────────
  // Final master is filed under the qhd tier (out/qhd) for storage classification.
  const masterDir = tierOutDir(MASTER_TIER);
  await fs.mkdir(masterDir, { recursive: true });
  const finalPath = path.join(masterDir, fileName);

  if (input.bgm?.url) {
    const muxResult = await muxBgm(concatPath, finalPath, input.bgm, durationInFrames, fps);
    if (muxResult.skippedReason) {
      warnings.push(`bgm_skipped:${muxResult.skippedReason}`);
      console.warn(`[render-book] BGM degraded: ${muxResult.skippedReason}`);
    } else {
      console.log(`[render-book] BGM muxed → ${fileName}`);
    }
  } else {
    // No BGM — rename concat to final output
    await fs.rename(concatPath, finalPath);
  }

  const elapsedMs = Date.now() - start;
  console.log(`[render-book] done fileName=${fileName} frames=${durationInFrames} spreads=${spreadsRendered} ${elapsedMs}ms`);

  return {
    fileName,
    outputLocation: finalPath,
    publicUrl: `/files/${MASTER_TIER}/${fileName}`,
    width,
    height,
    fps,
    durationInFrames,
    spreadsRendered,
    truncatedByCycle: sequence.truncatedByCycle,
    truncatedByCap: sequence.truncatedByCap,
    warnings,
    elapsedMs,
  };
}

// ── Chunk render with retry ──────────────────────────────────────────────────

interface ChunkRenderParams {
  serveUrl: string;
  composition: Awaited<ReturnType<typeof selectComposition>>;
  inputProps: Record<string, unknown>;
  frameRange: [number, number];
  outputLocation: string;
  chunkIndex: number;
  totalChunks: number;
}

async function renderChunkWithRetry(params: ChunkRenderParams): Promise<void> {
  const { chunkIndex, totalChunks, frameRange } = params;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= CHUNK_RETRY; attempt++) {
    if (attempt > 0) {
      console.warn(`[render-book] chunk ${chunkIndex + 1}/${totalChunks} retry ${attempt}/${CHUNK_RETRY}`);
      // Remove partial output before retry
      await fs.unlink(params.outputLocation).catch(() => undefined);
    }

    try {
      await renderChunk(params);
      return; // success
    } catch (err) {
      lastErr = err;
      console.error(`[render-book] chunk ${chunkIndex + 1}/${totalChunks} attempt ${attempt} failed: ${String(err)}`);
    }
  }

  throw new Error(
    `Chunk ${chunkIndex} [${frameRange[0]},${frameRange[1]}] failed after ${CHUNK_RETRY + 1} attempts: ${String(lastErr)}`
  );
}

async function renderChunk(params: ChunkRenderParams): Promise<void> {
  const { serveUrl, composition, inputProps, frameRange, outputLocation, chunkIndex, totalChunks } = params;

  // Closed-GOP: gopSize = frames in this chunk so an I-frame is forced at frame 0.
  // ffmpegOverride adds --no-open-gop so no B-frame references cross a seam boundary.
  // This makes concat demuxer -c copy produce clean, seek-aligned MP4s.
  const chunkFrameCount = frameRange[1] - frameRange[0] + 1;

  await renderMedia({
    serveUrl,
    composition,
    codec: "h264",
    outputLocation,
    inputProps,
    frameRange,
    // Force I-frame at the very first frame of this chunk (closed GOP).
    // gopSize ≥ chunkFrameCount means exactly one keyframe group per chunk.
    gopSize: chunkFrameCount,
    // x264Preset "medium" balances encode speed vs file-size; chunks are short.
    x264Preset: "medium",
    // Append --no-open-gop so x264 never emits recovery points that reference
    // frames outside this chunk's frameRange.
    ffmpegOverride: ({ args }) => [...args, "-x264-params", "no-open-gop=1"],
    concurrency: RENDER_CONCURRENCY,
    timeoutInMilliseconds: CHUNK_TIMEOUT_MS,
    chromiumOptions: { gl: "angle" },
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100);
      if (pct % 25 === 0) {
        console.log(`[render-book] chunk ${chunkIndex + 1}/${totalChunks} frames=[${frameRange[0]},${frameRange[1]}] ${pct}%`);
      }
    },
  });
}

// ── ffmpeg concat demuxer ────────────────────────────────────────────────────

async function ffmpegConcat(chunkPaths: string[], outputPath: string): Promise<void> {
  if (chunkPaths.length === 0) {
    throw new Error("ffmpegConcat: no chunk files");
  }

  // Write concat list file
  const listPath = outputPath + ".list.txt";
  const listContent = chunkPaths.map((p) => `file '${p}'`).join("\n");
  await fs.writeFile(listPath, listContent, "utf8");

  try {
    await runProcess("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);
  } finally {
    await fs.unlink(listPath).catch(() => undefined);
  }
}

// ── Process helper ────────────────────────────────────────────────────────────

function runProcess(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => stdout.push(d));
    proc.stderr.on("data", (d: Buffer) => stderr.push(d));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString());
      } else {
        const errText = Buffer.concat(stderr).toString().slice(-1000);
        reject(new Error(`${cmd} exited ${code}: ${errText}`));
      }
    });
    proc.on("error", reject);
  });
}
