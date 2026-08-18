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

import { OUT_DIR, tierOutDir, TRANSCODE_TIMEOUT_MS, TRANSCODE_CRF } from "./paths.js";
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
  /** ffprobe `pix_fmt` of stream 0 (e.g. `yuv420p`, `yuva420p`). Empty string
   *  when ffprobe didn't report one. Drives alpha detection for generic-mode
   *  webm output (design 08 §2b: `yuva*` → alpha-preserving encode). */
  pixFmt: string;
  /** ffprobe stream tag `alpha_mode` (Matroska/WebM side-data marker set by
   *  the encoder for VP8/VP9 alpha via BlockAdditional). ffmpeg's NATIVE vp9
   *  decoder does NOT decode that alpha plane — `pix_fmt` still reports
   *  `yuv420p` for a real alpha source, so this tag is the reliable alpha
   *  signal for webm (`transcodeSingle` ORs it with the `pix_fmt` check).
   *  Empty string when absent. */
  alphaModeTag: string;
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
      pix_fmt?: string;
      tags?: { alpha_mode?: string };
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
    pixFmt: typeof stream.pix_fmt === "string" ? stream.pix_fmt : "",
    alphaModeTag: typeof stream.tags?.alpha_mode === "string" ? stream.tags.alpha_mode : "",
  };
}

// ── generic mode (design 08 §2b, ADR-057) ────────────────────────────────────
// Single-item downscale for player media renditions: arbitrary `targetWidth`,
// container kept from source (`.mp4` H.264 / `.webm` VP9 alpha-aware), output
// PUT S2S at an exact caller-supplied storage key (sibling key). Distinct from
// the book-master `transcodeDownscale` above (never touched by this section).

export type TranscodeContainer = "mp4" | "webm";

/** Derive the output container from a source URL's path extension. Returns
 *  null for anything other than `.mp4`/`.webm` (caller → 400 INVALID_INPUT) —
 *  generic mode only ever sees spread `videos[]` (mp4) or auto_pic (webm). */
export function detectContainer(sourceUrl: string): TranscodeContainer | null {
  let pathname: string;
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {
    pathname = sourceUrl;
  }
  const ext = path.extname(pathname).toLowerCase();
  if (ext === ".mp4") return "mp4";
  if (ext === ".webm") return "webm";
  return null;
}

/** `min(targetWidth, sourceWidth)` floored to an even number (ffmpeg `scale`
 *  needs even dims for 4:2:0 chroma subsampling) — the no-upscale bound
 *  (design 08 §2b: `source_w ≤ targetWidth` → keep source dims). A
 *  non-positive/unprobed `sourceWidth` skips the bound (targetWidth as-is;
 *  already validated even>0 at the request layer). */
export function computeEffectiveWidth(sourceWidth: number, targetWidth: number): number {
  const bounded = sourceWidth > 0 ? Math.min(targetWidth, sourceWidth) : targetWidth;
  return bounded % 2 === 0 ? bounded : bounded - 1;
}

export interface BuildSingleFfmpegArgsInput {
  sourcePath: string;
  effectiveWidth: number;
  container: TranscodeContainer;
  hasAlpha: boolean;
  /** Boot-selected encoder profile — used for the mp4 branch only. */
  profile: EncoderProfile;
  outPath: string;
}

/** Full ffmpeg argv for the generic single-output downscale (design 08 §2b).
 *  mp4 = boot-selected encoder profile (GPU-capable, retried CPU on hw-fail by
 *  the caller). webm = ALWAYS CPU `libvpx-vp9` regardless of `profile` — GPU
 *  encoders don't do VP9/alpha, so this branch never uses `profile`'s venc. */
export function buildSingleFfmpegArgs(input: BuildSingleFfmpegArgsInput): string[] {
  const { sourcePath, effectiveWidth, container, hasAlpha, profile, outPath } = input;

  if (container === "webm") {
    return [
      "-hide_banner", "-y",
      // Alpha source → force the libvpx-vp9 DECODER as an *input* option (must
      // precede -i). ffmpeg's native vp9 decoder does not decode the
      // BlockAdditional alpha side-data — without this override the alpha
      // plane silently drops even though `-pix_fmt yuva420p` is requested on
      // the OUTPUT below.
      ...(hasAlpha ? ["-c:v", "libvpx-vp9"] : []),
      "-i", sourcePath,
      "-vf", `scale=${effectiveWidth}:-2:flags=lanczos`,
      "-map", "0:v",
      "-map", "0:a?",
      "-c:v", "libvpx-vp9",
      "-b:v", "0",
      "-crf", String(TRANSCODE_CRF),
      "-pix_fmt", hasAlpha ? "yuva420p" : "yuv420p",
      "-c:a", "copy",
      outPath,
    ];
  }

  return [
    "-hide_banner", "-y",
    ...profile.hwaccelIn,
    "-i", sourcePath,
    "-vf", `${profile.scaleFilter}=${effectiveWidth}:-2${profile.scaleSuffix}`,
    "-map", "0:v",
    "-map", "0:a?",
    "-c:v", profile.venc,
    ...profile.encOpts,
    // -pix_fmt only for CPU (yuv420p); GPU frames stay hardware-side (see EncoderProfile.pixFmt).
    ...(profile.pixFmt ? ["-pix_fmt", profile.pixFmt] : []),
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
}

export interface GenericTranscodeInput {
  sourceUrl: string;
  targetWidth: number;
  outputKey: string;
}

export type GenericTranscodeParseResult =
  | { ok: true; input: GenericTranscodeInput }
  | { ok: false; message: string };

/** Validate + narrow a generic-mode `/transcode` body (design 08 §2b). Pure —
 *  no I/O — so field validation is unit-testable without a running server.
 *  Caller (server.ts) invokes this only after `detectTranscodeShape` picked
 *  "generic". */
export function parseGenericTranscodeInput(body: Record<string, unknown>): GenericTranscodeParseResult {
  if (typeof body.sourceFileName === "string" && body.sourceFileName.trim()) {
    return { ok: false, message: "generic transcode does not accept `sourceFileName` — use `sourceUrl`" };
  }
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  if (!sourceUrl) {
    return { ok: false, message: "`sourceUrl` is required for generic transcode" };
  }
  const targetWidth = body.targetWidth;
  if (typeof targetWidth !== "number" || !Number.isInteger(targetWidth) || targetWidth <= 0 || targetWidth % 2 !== 0) {
    return { ok: false, message: "`targetWidth` must be a positive even integer" };
  }
  const outputKey = typeof body.outputKey === "string" ? body.outputKey.trim() : "";
  if (!outputKey) {
    return { ok: false, message: "`outputKey` is required and must be a non-empty string" };
  }
  return { ok: true, input: { sourceUrl, targetWidth, outputKey } };
}

export type TranscodeShape = "book" | "generic" | "mixed";

/** Mode detect by body shape (design 08 §2b): `outputKey`/`targetWidth`
 *  present = generic; `targets` present = book. Both groups present →
 *  "mixed" (caller → 400 INVALID_INPUT — the two modes are mutually
 *  exclusive on this one endpoint). */
export function detectTranscodeShape(body: Record<string, unknown>): TranscodeShape {
  const hasGeneric = body.outputKey !== undefined || body.targetWidth !== undefined;
  const hasBook = body.targets !== undefined;
  if (hasGeneric && hasBook) return "mixed";
  return hasGeneric ? "generic" : "book";
}

export interface SingleTranscodeResult {
  outPath: string;
  container: TranscodeContainer;
  width: number;
  height: number;
  fileSizeBytes: number;
  durationInFrames: number;
  fps: number;
}

/**
 * Downscale ONE video item to `targetWidth` (generic mode, design 08 §2b).
 * Unlike `transcodeDownscale` (book master → N targets, single decode split),
 * this is a single-output pass: probe source (dims/fps/frames + alpha via
 * `pix_fmt`) → no-upscale bound → container-specific encode (mp4 = boot
 * profile, GPU-capable; webm = ALWAYS CPU `libvpx-vp9`, alpha-aware). A
 * runtime hw-encode failure on the mp4 branch is retried once with the CPU
 * profile (same resilience posture as `transcodeDownscale`, design §3.1).
 *
 * @param sourcePath  Absolute path to the already-fetched source (temp file).
 * @param targetWidth Caller-requested width (validated even>0 upstream).
 * @param container   `.mp4`/`.webm` per `detectContainer(sourceUrl)`.
 * @param profile     Boot-selected encoder profile (mp4 branch only).
 * @param outPath     Absolute local scratch path to write the single output.
 */
export async function transcodeSingle(
  sourcePath: string,
  targetWidth: number,
  container: TranscodeContainer,
  profile: EncoderProfile,
  outPath: string,
): Promise<SingleTranscodeResult> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const probe = await runFfprobe(sourcePath);
  // `pix_fmt` alone under-detects: ffmpeg's native vp9 decoder (used by
  // `runFfprobe` — no `-c:v` override) never surfaces alpha, so a real alpha
  // webm still probes `yuv420p`. The `alpha_mode` stream tag is the reliable
  // signal for that case (M1, ADR-057 review).
  const hasAlpha = probe.pixFmt.startsWith("yuva") || probe.alphaModeTag === "1";
  const effectiveWidth = computeEffectiveWidth(probe.width, targetWidth);

  let usedProfile = profile;
  const buildArgs = () =>
    buildSingleFfmpegArgs({ sourcePath, effectiveWidth, container, hasAlpha, profile: usedProfile, outPath });

  try {
    await runFfmpeg(buildArgs());
  } catch (err) {
    if (err instanceof TranscodeTimeoutError) throw err;
    // webm is already forced CPU by buildSingleFfmpegArgs — retry only helps mp4/GPU.
    if (container === "mp4" && profile.name !== "cpu") {
      console.warn(
        `[transcode-single] hw encode failed (encoder=${profile.name}) — retry cpu: ${String(err).slice(-300)}`
      );
      usedProfile = buildEncoderProfile("cpu");
      await runFfmpeg(buildArgs());
    } else {
      throw err;
    }
  }

  const stat = await fs.stat(outPath);
  const outProbe = await runFfprobe(outPath);

  return {
    outPath,
    container,
    width: outProbe.width || effectiveWidth,
    height: outProbe.height || 0,
    fileSizeBytes: stat.size,
    durationInFrames: probe.durationInFrames,
    fps: probe.fps,
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
        // single combined -show_entries: repeating the flag makes ffprobe honor
        // only the LAST occurrence, silently dropping the earlier sections.
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate,nb_frames,width,height,duration,pix_fmt:stream_tags=alpha_mode:format=duration",
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
