// video-worker/src/transcode.ts
// Single-decode multi-output downscale of a QHD master MP4 → fhd/hd/sd
// (design service/video-worker/08-transcode-downscale.md §3).
//
// One ffmpeg process decodes the master ONCE, `split`s into N branches, scales
// each to its RESOLUTION_DIMS target and encodes per-output with audio `-c:a
// copy` (BGM/narration already baked into the master). All-or-nothing: a single
// command, so any branch failure fails the whole call (decode is the dominant
// cost — per-res isolation is deferred, design §6).
//
// Storage posture (design 08 §2): out/{fhd,hd,sd} are scratch — the server PUTs
// each output to the storage-service then unlinks the local copy. This module
// stays storage-agnostic (renders to out/{res} and returns local metadata).
//
// Encoder profile (CPU libx264 / NVENC / QSV) is resolved at boot by
// encoder-probe.ts. A runtime hw-encode failure (driver/GPU-OOM mid-encode) is
// retried ONCE with the CPU profile (resilience — design §3.1).
//
// Pure helpers (`outputFileName`, `buildFilterComplex`, `buildFfmpegArgs`,
// `parseFfprobe`) are unit-tested without spawning ffmpeg.

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { RESOLUTION_DIMS, type ResolutionKey } from "@/remotion/composition-metadata";

import { OUT_DIR, tierOutDir, TRANSCODE_TIMEOUT_MS } from "./paths.js";
import { TranscodeTimeoutError } from "./errors.js";
import { buildEncoderProfile, type EncoderProfile } from "./encoder-probe.js";

/** Resolutions the endpoint can downscale to (qhd is the input, never a target). */
export type TranscodeTarget = "fhd" | "hd" | "sd";
export const TRANSCODE_TARGETS: readonly TranscodeTarget[] = ["fhd", "hd", "sd"];

export interface TranscodeOutput {
  resolution: TranscodeTarget;
  // Relative `/files/{tier}/{fileName}` fallback; the server rewrites it to the
  // storage-service URL when storage is configured + bookId present (design 08 §2).
  url: string;
  /** Storage key `videos/books/{bookId}/{res}/{fileName}` — set by the server
   *  after a successful PUT; absent in the legacy local fallback. */
  storageKey?: string;
  fileName: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  durationInFrames: number;
}

export interface TranscodeResult {
  outputs: TranscodeOutput[];
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
}

export interface ProbeInfo {
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
}

// ── pure helpers ───────────────────────────────────────────────────────────────

/** `{masterBase}-{res}.mp4` — masterBase = sourceFileName minus a trailing `.mp4`.
 *  Stable suffix → re-transcode overwrites the same file (idempotent, no orphans). */
export function outputFileName(sourceFileName: string, res: TranscodeTarget): string {
  const base = path.basename(sourceFileName).replace(/\.mp4$/i, "");
  return `${base}-${res}.mp4`;
}

/** Build the `-filter_complex` string: split the decoded master into N branches
 *  and scale each to its RESOLUTION_DIMS target. Branch label = the resolution key. */
export function buildFilterComplex(targets: TranscodeTarget[], profile: EncoderProfile): string {
  const n = targets.length;
  const splitOuts = targets.map((_, i) => `[v${i}]`).join("");
  const splitClause = `[0:v]split=${n}${splitOuts}`;
  const scaleClauses = targets.map((res, i) => {
    const { width, height } = RESOLUTION_DIMS[res as ResolutionKey];
    return `[v${i}]${profile.scaleFilter}=${width}:${height}${profile.scaleSuffix}[${res}]`;
  });
  return [splitClause, ...scaleClauses].join("; ");
}

/** Full ffmpeg argv for the single-decode multi-output command. */
export function buildFfmpegArgs(
  masterPath: string,
  targets: TranscodeTarget[],
  profile: EncoderProfile,
  outPathFor: (res: TranscodeTarget) => string,
): string[] {
  const args: string[] = ["-hide_banner", "-y", ...profile.hwaccelIn, "-i", masterPath];
  args.push("-filter_complex", buildFilterComplex(targets, profile));
  for (const res of targets) {
    args.push(
      "-map", `[${res}]`,
      "-map", "0:a?",
      "-c:v", profile.venc,
      ...profile.encOpts,
      // -pix_fmt only for CPU (yuv420p); GPU frames stay hardware-side (see EncoderProfile.pixFmt).
      ...(profile.pixFmt ? ["-pix_fmt", profile.pixFmt] : []),
      "-c:a", "copy",
      "-movflags", "+faststart",
      outPathFor(res),
    );
  }
  return args;
}

/** Parse `ffprobe -of json` output (stream + format) → fps / durationInFrames / dims.
 *  durationInFrames prefers integer `nb_frames`; falls back to round(duration*fps). */
export function parseFfprobe(jsonText: string): ProbeInfo {
  const data = JSON.parse(jsonText) as {
    streams?: Array<{
      r_frame_rate?: string;
      avg_frame_rate?: string;
      nb_frames?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const stream = data.streams?.[0] ?? {};

  const parseRate = (r?: string): number => {
    if (!r || r === "0/0") return 0;
    const [num, den] = r.split("/").map(Number);
    if (!den) return num || 0;
    return num / den;
  };
  const fps = parseRate(stream.r_frame_rate) || parseRate(stream.avg_frame_rate) || 30;

  const durationSec =
    Number(stream.duration) || Number(data.format?.duration) || 0;

  let durationInFrames = Number(stream.nb_frames);
  if (!Number.isFinite(durationInFrames) || durationInFrames <= 0) {
    durationInFrames = durationSec > 0 ? Math.round(durationSec * fps) : 0;
  }

  return {
    fps: Math.round(fps) || 30,
    durationInFrames,
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
  };
}

// ── process helpers (I/O) ───────────────────────────────────────────────────────

function runFfprobe(masterPath: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames,width,height,duration",
        "-show_entries", "format=duration",
        "-of", "json",
        masterPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => err.push(d));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`));
        return;
      }
      try {
        resolve(parseFfprobe(Buffer.concat(out).toString()));
      } catch (e) {
        reject(new Error(`ffprobe parse failed: ${String(e)}`));
      }
    });
    proc.on("error", reject);
  });
}

/** Run ffmpeg with a wall-clock timeout. Throws TranscodeTimeoutError on timeout,
 *  Error(stderr tail) on non-zero exit. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, TRANSCODE_TIMEOUT_MS);

    proc.stderr.on("data", (d: Buffer) => err.push(d));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new TranscodeTimeoutError(`ffmpeg exceeded ${TRANSCODE_TIMEOUT_MS}ms`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-1000)}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── orchestration ────────────────────────────────────────────────────────────

const _QHD_W = 1920;
const _QHD_H = 1440;

/**
 * Downscale `masterPath` into all `targets` in one ffmpeg pass.
 *
 * @param masterPath  Absolute path to the QHD master (already resolved + verified).
 * @param sourceFileName  Master file name (drives output naming `{base}-{res}.mp4`).
 * @param targets  Non-empty, deduped subset of {fhd,hd,sd}.
 * @param profile  Encoder profile from probeEncoder().
 */
export async function transcodeDownscale(
  masterPath: string,
  sourceFileName: string,
  targets: TranscodeTarget[],
  profile: EncoderProfile,
): Promise<TranscodeResult> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  // Each tier is filed in its own subdir (out/{fhd,hd,sd}) — storage classification.
  for (const res of targets) {
    await fs.mkdir(tierOutDir(res), { recursive: true });
  }

  const probe = await runFfprobe(masterPath);
  if (probe.width && probe.height && (probe.width !== _QHD_W || probe.height !== _QHD_H)) {
    console.warn(
      `[transcode] master dims ${probe.width}x${probe.height} != expected ${_QHD_W}x${_QHD_H}`
    );
  }

  const outPathFor = (res: TranscodeTarget) =>
    path.join(tierOutDir(res), outputFileName(sourceFileName, res));

  // ── single ffmpeg pass; on hw-encode failure retry once with CPU profile ──
  let usedProfile = profile;
  try {
    await runFfmpeg(buildFfmpegArgs(masterPath, targets, usedProfile, outPathFor));
  } catch (err) {
    if (err instanceof TranscodeTimeoutError) throw err;
    if (profile.name !== "cpu") {
      console.warn(
        `[transcode] hw encode failed (encoder=${profile.name}) — retry cpu: ${String(err).slice(-300)}`
      );
      usedProfile = buildEncoderProfile("cpu");
      await runFfmpeg(buildFfmpegArgs(masterPath, targets, usedProfile, outPathFor));
    } else {
      throw err;
    }
  }

  // ── stat each output → fileSizeBytes ──
  const outputs: TranscodeOutput[] = [];
  for (const res of targets) {
    const fileName = outputFileName(sourceFileName, res);
    const outPath = path.join(tierOutDir(res), fileName);
    const stat = await fs.stat(outPath);
    const { width, height } = RESOLUTION_DIMS[res as ResolutionKey];
    outputs.push({
      resolution: res,
      url: `/files/${res}/${fileName}`,
      fileName,
      width,
      height,
      fileSizeBytes: stat.size,
      durationInFrames: probe.durationInFrames,
    });
  }

  return {
    outputs,
    fps: probe.fps,
    durationInFrames: probe.durationInFrames,
    width: probe.width || _QHD_W,
    height: probe.height || _QHD_H,
  };
}
