// video-worker/src/paths.ts
// Resolved filesystem anchors shared across worker modules. The worker lives at
// ai-storybook-editor/video-worker/src/ → frontend src is two levels up.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** ai-storybook-editor/src — root the Remotion bundle resolves `@/` against. */
export const FRONTEND_SRC = path.resolve(here, "../../src");

/** Remotion entry registering the composition tree. */
export const REMOTION_ENTRY = path.join(FRONTEND_SRC, "remotion", "index.ts");

/** Output dir for rendered MP4s (served statically by the worker at /files). */
export const OUT_DIR = path.resolve(here, "../out");

/** Resolution-tier subdirectory under OUT_DIR (storage classification): book
 *  artifacts are filed per quality tier — qhd master in `out/qhd`, downscale
 *  outputs in `out/{fhd,hd,sd}`. Served at `/files/{tier}/{file}`. Keeps the
 *  durable book MP4s sorted by tier instead of one flat directory. */
export function tierOutDir(tier: string): string {
  return path.join(OUT_DIR, tier);
}

/** Tier holding the QHD master (render-book output + transcode source). */
export const MASTER_TIER = "qhd";

// ── Storage-service cutover (design 06 §6.1, 02 §2b/§2c; ADR-054) ─────────────
// Book-video finals stream PUT to the self-hosted storage-service and are served
// publicly by its nginx. OUT_DIR becomes scratch/cache (qhd master = transcode
// cache pruned by MAX_KEEP_MASTERS; downscale outputs pruned after PUT).

/** Storage-service base URL (loopback S2S target). Unset → local-fallback posture
 *  (relative `/files/{tier}` publicUrl, no storageKey) for dev/demo. */
export const STORAGE_SERVICE_URL = (process.env.STORAGE_SERVICE_URL ?? "").trim();

/** S2S API key (`X-API-Key`) for storage-service writes. Never logged. */
export const STORAGE_SERVICE_API_KEY = process.env.STORAGE_SERVICE_API_KEY ?? "";

/** Storage bucket book videos are filed under. */
export const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "storybook-assets";

/** LRU cap for the `out/qhd` master cache (transcode source). Newest N kept by mtime. */
export const MAX_KEEP_MASTERS = Number(process.env.MAX_KEEP_MASTERS ?? 3);

/** Worker port — server bind. Override via env (PORT). The ThorVG WASM is no longer
 *  served by the worker (render adapter resolves it as a bundled `?url` asset), so the
 *  port no longer doubles as a WASM origin. */
export const WORKER_PORT = Number(process.env.PORT ?? 4000);

/** Optional shared secret protecting /render* routes (POST only).
 *  Unset → bypass (dev loopback). Set → require X-Worker-Token header match. */
export const VIDEO_WORKER_TOKEN = process.env.VIDEO_WORKER_TOKEN ?? "";

/** Max bytes to fetch for BGM audio (SSRF + OOM guard). Default: 20 MB. */
export const BGM_MAX_BYTES = Number(process.env.BGM_MAX_BYTES ?? 20 * 1024 * 1024);

// ── Transcode (POST /transcode — design service/video-worker/08 §7) ──────────

/** Hardware-encode selection for /transcode (design 08 §3.1):
 *  `auto` (default, probe nvenc→qsv→cpu) | `nvenc` | `qsv` | `cpu` (force).
 *  Force-GPU that fails the boot probe → warn + fall back to CPU (never crash). */
export const TRANSCODE_HWACCEL = (process.env.TRANSCODE_HWACCEL ?? "auto").toLowerCase();

/** CPU libx264 quality (x264 CRF). Lower = higher quality / larger file. */
export const TRANSCODE_CRF = Number(process.env.TRANSCODE_CRF ?? 20);

/** GPU constant-quality (`-cq` nvenc / `-global_quality` qsv). Slightly higher
 *  than CRF since GPU encoders give lower quality at the same setting. */
export const TRANSCODE_CQ = Number(process.env.TRANSCODE_CQ ?? 23);

/** CPU libx264 preset (speed↔compression). */
export const TRANSCODE_PRESET = process.env.TRANSCODE_PRESET ?? "medium";

/** ffmpeg wall-clock cap for one /transcode call → 504 TRANSCODE_TIMEOUT. */
export const TRANSCODE_TIMEOUT_MS = Number(process.env.TRANSCODE_TIMEOUT_MS ?? 600000);

/** Max bytes to fetch for the `sourceUrl` fallback (SSRF + OOM guard). Default: 2 GB. */
export const TRANSCODE_SRC_MAX_BYTES = Number(
  process.env.TRANSCODE_SRC_MAX_BYTES ?? 2 * 1024 * 1024 * 1024
);
