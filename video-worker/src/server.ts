// video-worker/src/server.ts
// Render server exposing POST /render (1-spread) and POST /render-book (full-book).
// Output written locally and served via /files (static). Renders run one at a time
// (CPU/RAM bound); a small in-flight guard rejects concurrent requests (429 BUSY)
// rather than risk OOM. Dev-only: bound to localhost, permissive CORS.
//
// Security split (design 02 §6):
//   GET  /files/*       — public read-only (spread previews only; book finals move to storage-service)
//   POST /render*       — token-protected (VIDEO_WORKER_TOKEN, env-gated)
//   GET  /health        — public (liveness probe)
//
// Storage posture (design 06 §6.1, 02 §2b/§2c; ADR-054): when STORAGE_SERVICE_URL
// is set and the request carries bookId, /render-book + /transcode finals stream
// PUT to the storage-service (served publicly by its nginx) and OUT_DIR is
// scratch/cache — qhd master kept as an LRU transcode cache (MAX_KEEP_MASTERS),
// downscale outputs pruned after PUT. Unset → legacy local /files fallback (dev/demo).
//
// Prune policy:
//   /render 1-spread     → prune spread-* only, keep 10 most-recent
//   /render-book (qhd)   → keep newest MAX_KEEP_MASTERS masters (transcode cache)

import os from "node:os";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import {
  OUT_DIR,
  WORKER_PORT,
  VIDEO_WORKER_TOKEN,
  TRANSCODE_SRC_MAX_BYTES,
  tierOutDir,
  MASTER_TIER,
  MAX_KEEP_MASTERS,
} from "./paths.js";
import {
  isStorageConfigured,
  putBookArtifact,
  putObjectAtKey,
  uploadTranscodeOutputs,
  StorageUploadError,
} from "./storage-upload.js";
import {
  renderSpread,
  warmup,
  SUPPORTED_LANGUAGES,
  type RenderInput,
  type RenderLanguage,
} from "./render.js";
import { renderBook, type BookRenderInput } from "./render-book.js";
import { classifyRenderError, classifyTranscodeError, ERROR_STATUS } from "./errors.js";
import {
  transcodeDownscale,
  transcodeSingle,
  detectTranscodeShape,
  parseGenericTranscodeInput,
  detectContainer,
  TRANSCODE_TARGETS,
  type TranscodeTarget,
} from "./transcode.js";
import { probeEncoder, getEncoderProfile } from "./encoder-probe.js";
import { assertSsrfSafe } from "./ssrf-guard.js";
import type { BgmInput } from "./mux-bgm.js";

/** Narrow an arbitrary body value to a supported language, defaulting to en_US. */
function coerceLanguage(value: unknown): RenderLanguage {
  return SUPPORTED_LANGUAGES.includes(value as RenderLanguage)
    ? (value as RenderLanguage)
    : "en_US";
}

/** Parse an optional `bookId` from the body: trimmed non-empty string with no
 *  path-separator characters (it becomes a storage key segment). Returns null
 *  when absent (legacy fallback). Returns { error } when present but malformed. */
function parseBookId(value: unknown): { bookId: string | null; error?: string } {
  if (value == null || value === "") return { bookId: null };
  if (typeof value !== "string") return { bookId: null, error: "`bookId` must be a string" };
  const trimmed = value.trim();
  if (!trimmed) return { bookId: null };
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return { bookId: null, error: "`bookId` must not contain path separators" };
  }
  return { bookId: trimmed };
}

const PORT = WORKER_PORT;
const MAX_KEEP_SPREAD_FILES = 10;

const app = express();
app.use(express.json({ limit: "30mb" }));

// ── Dev CORS (demo runs on a different Vite port) ────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Worker-Token");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Static file serving (public — book artifacts must be internet-reachable) ─
app.use("/files", express.static(OUT_DIR));

// NOTE: the worker no longer serves the ThorVG WASM. The render adapter resolves it as a
// bundled `?url` asset (src/remotion/lottie/thorvg-lottie-player.tsx + webpack-override.ts),
// so the headless Chromium fetches it from the Remotion bundle origin — origin-independent,
// nothing to host here. Only `/files` (MP4) + `/health` are exposed publicly.

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ── Token middleware for POST /render* routes ────────────────────────────────
// VIDEO_WORKER_TOKEN unset → bypass (dev loopback). Set → require X-Worker-Token match.
function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!VIDEO_WORKER_TOKEN) {
    // Dev loopback: no token configured — bypass.
    next();
    return;
  }
  const provided = req.headers["x-worker-token"];
  if (provided !== VIDEO_WORKER_TOKEN) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "Missing or invalid X-Worker-Token" });
    return;
  }
  next();
}

// ── Shared in-flight guard ────────────────────────────────────────────────────
// Both /render and /render-book share this flag (1 render slot, CPU/RAM bound).
let rendering = false;

// ── POST /render — 1-spread render ───────────────────────────────────────────
app.post("/render", requireToken, async (req: Request, res: Response) => {
  const { spread, language, dimension, bleedMm } = req.body ?? {};
  if (!spread || typeof spread !== "object") {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "`spread` object required" });
    return;
  }
  if (rendering) {
    res.status(429).json({ ok: false, code: "BUSY", message: "another render in progress" });
    return;
  }

  const input: RenderInput = {
    spread,
    language: coerceLanguage(language),
    // Forward book sizing → composition derives the design-canvas width (font parity).
    // Absent (demo) → composition 800×600 fallback.
    ...(Number.isFinite(dimension) ? { dimension } : {}),
    ...(Number.isFinite(bleedMm) && bleedMm > 0 ? { bleedMm } : {}),
  };
  const fileName = `spread-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
  rendering = true;
  const start = Date.now();
  console.log(`[render] start ${fileName} lang=${input.language}`);

  try {
    const result = await renderSpread(input, fileName);
    await pruneSpreadFiles();
    const elapsedMs = Date.now() - start;
    console.log(`[render] done ${fileName} frames=${result.durationInFrames} ${elapsedMs}ms`);
    res.json({
      ok: true,
      url: `/files/${fileName}`,
      fileName,
      width: result.width,
      height: result.height,
      fps: result.fps,
      durationInFrames: result.durationInFrames,
      elapsedMs,
    });
  } catch (err) {
    const c = classifyRenderError(err);
    console.error(`[render] failed ${fileName} code=${c.code}: ${c.message}`);
    res.status(c.status).json({ ok: false, code: c.code, message: c.message });
  } finally {
    rendering = false;
  }
});

// ── POST /render-book — full-book chunked render ──────────────────────────────
app.post("/render-book", requireToken, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const {
    illustration,
    edition,
    language,
    startSpreadId,
    bgm,
    dimension,
    bleedMm,
    transitionSfxUrl,
  } = body;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!illustration || typeof illustration !== "object") {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "`illustration` object required" });
    return;
  }
  const { bookId, error: bookIdError } = parseBookId(body.bookId);
  if (bookIdError) {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: bookIdError });
    return;
  }
  if (edition !== "classic" && edition !== "dynamic") {
    res.status(400).json({
      ok: false,
      code: "INVALID_INPUT",
      message: `\`edition\` must be "classic" or "dynamic" (got: ${String(edition)})`,
    });
    return;
  }
  if (rendering) {
    res.status(429).json({ ok: false, code: "BUSY", message: "another render in progress" });
    return;
  }

  // Extract spreads/sections from illustration object
  const illus = illustration as Record<string, unknown>;
  const spreads = Array.isArray(illus.spreads) ? illus.spreads : [];
  const sections = Array.isArray(illus.sections) ? illus.sections : [];

  if (spreads.length === 0) {
    res.status(422).json({ ok: false, code: "EMPTY_SEQUENCE", message: "illustration.spreads is empty" });
    return;
  }

  // Validate and sanitize bgm (optional)
  let bgmInput: BgmInput | null = null;
  if (bgm && typeof bgm === "object") {
    const bgmObj = bgm as Record<string, unknown>;
    if (typeof bgmObj.url === "string" && bgmObj.url) {
      bgmInput = {
        url: bgmObj.url,
        volume: typeof bgmObj.volume === "number" ? Math.max(0, Math.min(2, bgmObj.volume)) : 1.0,
      };
    }
  }

  const fileName = `book-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
  rendering = true;
  const start = Date.now();
  console.log(`[render-book] start ${fileName} edition=${edition} spreads=${spreads.length}${bgmInput ? " bgm=yes" : ""}`);

  const input: BookRenderInput = {
    spreads,
    sections,
    edition,
    language: coerceLanguage(language),
    startSpreadId: typeof startSpreadId === "string" ? startSpreadId : undefined,
    bgm: bgmInput,
    // Book sizing → composition derives the design-canvas width (font/border parity).
    // Job 07 always supplies these; absent → composition 800×600 fallback.
    ...(Number.isFinite(dimension) ? { dimension } : {}),
    ...(Number.isFinite(bleedMm) && bleedMm > 0 ? { bleedMm } : {}),
    // Page-turn SFX (book.sound.transition_id resolved upstream). Only forward non-empty strings.
    ...(typeof transitionSfxUrl === "string" && transitionSfxUrl ? { transitionSfxUrl } : {}),
  };

  try {
    const result = await renderBook(input, fileName);
    const elapsedMs = Date.now() - start;
    console.log(`[render-book] done ${fileName} frames=${result.durationInFrames} spreads=${result.spreadsRendered} ${elapsedMs}ms`);

    // Storage-service cutover: PUT the qhd master when configured + bookId present;
    // else legacy local /files fallback (byte-identical response for dev/demo).
    // out/qhd is a scratch/cache — pruned to MAX_KEEP_MASTERS in BOTH branches.
    let publicUrl = result.publicUrl;
    let storageKey: string | undefined;
    if (isStorageConfigured() && bookId) {
      try {
        const put = await putBookArtifact({
          tier: MASTER_TIER,
          bookId,
          fileName: result.fileName,
          filePath: result.outputLocation,
        });
        publicUrl = put.url;
        storageKey = put.storageKey;
      } catch (uploadErr) {
        // Explicit branch — do NOT run classifyRenderError; storage PUT is durable-artifact
        // critical. Local master stays (cache/debug), counted by pruneMasters next run.
        if (uploadErr instanceof StorageUploadError) {
          console.error(`[render-book] upload failed ${fileName}: ${uploadErr.message}`);
          await pruneMasters();
          res.status(502).json({ ok: false, code: uploadErr.code, message: uploadErr.message });
          return;
        }
        throw uploadErr;
      }
    }
    await pruneMasters();

    res.json({
      ok: true,
      publicUrl,
      ...(storageKey ? { storageKey } : {}),
      fileName: result.fileName,
      width: result.width,
      height: result.height,
      fps: result.fps,
      durationInFrames: result.durationInFrames,
      spreadsRendered: result.spreadsRendered,
      truncatedByCycle: result.truncatedByCycle,
      truncatedByCap: result.truncatedByCap,
      warnings: result.warnings,
      elapsedMs,
    });
  } catch (err) {
    // Check for known domain errors thrown by renderBook — use ERROR_STATUS map (DRY).
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "EMPTY_SEQUENCE" || msg === "BOOK_TOO_LARGE") {
      const code = msg as "EMPTY_SEQUENCE" | "BOOK_TOO_LARGE";
      const status = ERROR_STATUS[code];
      res.status(status).json({ ok: false, code, message: err instanceof Error ? err.message : msg });
    } else {
      const c = classifyRenderError(err);
      console.error(`[render-book] failed ${fileName} code=${c.code}: ${c.message}`);
      res.status(c.status).json({ ok: false, code: c.code, message: c.message });
    }
  } finally {
    rendering = false;
  }
});

// ── POST /transcode — downscale QHD master → fhd/hd/sd (design 08) ────────────
// REV (design 08 §2b, ADR-057): the SAME endpoint also serves a generic
// single-item mode — mode detect by body shape BEFORE any book-mode
// validation/guard runs (mixing both field groups is a hard 400).
app.post("/transcode", requireToken, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const shape = detectTranscodeShape(body);
  if (shape === "mixed") {
    res.status(400).json({
      ok: false, code: "INVALID_INPUT",
      message: "cannot mix `targets` (book mode) with `outputKey`/`targetWidth` (generic mode)",
    });
    return;
  }
  if (shape === "generic") {
    await handleGenericTranscode(body, res);
    return;
  }

  const sourceFileNameRaw = typeof body.sourceFileName === "string" ? body.sourceFileName.trim() : "";
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  const targetsRaw = Array.isArray(body.targets) ? body.targets : null;
  const { bookId, error: bookIdError } = parseBookId(body.bookId);
  if (bookIdError) {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: bookIdError });
    return;
  }

  // ── Validate targets (non-empty, subset {fhd,hd,sd}, dedup, reject qhd) ────
  if (!targetsRaw || targetsRaw.length === 0) {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "`targets` non-empty array required" });
    return;
  }
  const seen = new Set<string>();
  const targets: TranscodeTarget[] = [];
  for (const t of targetsRaw) {
    if (typeof t !== "string" || !TRANSCODE_TARGETS.includes(t as TranscodeTarget)) {
      res.status(400).json({
        ok: false, code: "INVALID_INPUT",
        message: `\`targets\` must be a subset of [${TRANSCODE_TARGETS.join(",")}] (got: ${String(t)})`,
      });
      return;
    }
    if (!seen.has(t)) {
      seen.add(t);
      targets.push(t as TranscodeTarget);
    }
  }
  if (!sourceFileNameRaw && !sourceUrl) {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "one of `sourceFileName` or `sourceUrl` required" });
    return;
  }
  // Path-traversal guard: sourceFileName must be a bare basename.
  if (sourceFileNameRaw && (sourceFileNameRaw.includes("/") || sourceFileNameRaw.includes("\\") || sourceFileNameRaw.includes(".."))) {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "`sourceFileName` must be a basename (no path separators)" });
    return;
  }

  if (rendering) {
    res.status(429).json({ ok: false, code: "BUSY", message: "another render in progress" });
    return;
  }
  rendering = true;
  const start = Date.now();

  // Resolve the master: local OUT_DIR file (primary) or SSRF-guarded fetch (fallback).
  let masterPath = "";
  let tempPath: string | null = null;
  // Output naming base: prefer sourceFileName, else derive from the URL path.
  let baseName = sourceFileNameRaw;

  try {
    if (sourceFileNameRaw) {
      // The QHD master is filed under out/qhd (render-book output tier).
      const localPath = path.join(tierOutDir(MASTER_TIER), path.basename(sourceFileNameRaw));
      const exists = await fs.access(localPath).then(() => true).catch(() => false);
      if (exists) {
        masterPath = localPath;
      } else if (!sourceUrl) {
        res.status(404).json({ ok: false, code: "SOURCE_NOT_FOUND", message: "source file not found in OUT_DIR" });
        return;
      }
    }
    if (!masterPath) {
      // sourceUrl fallback (future split-worker). SSRF-guarded + size-capped.
      if (!sourceUrl) {
        res.status(404).json({ ok: false, code: "SOURCE_NOT_FOUND", message: "source file not found in OUT_DIR" });
        return;
      }
      try {
        tempPath = await fetchMasterToTemp(sourceUrl);
        masterPath = tempPath;
        if (!baseName) baseName = path.basename(new URL(sourceUrl).pathname) || `master-${randomUUID().slice(0, 8)}.mp4`;
      } catch (err) {
        console.error(`[transcode] source fetch failed: ${String(err).slice(0, 200)}`);
        res.status(502).json({ ok: false, code: "SOURCE_FETCH_FAILED", message: "failed to fetch sourceUrl" });
        return;
      }
    }

    const profile = getEncoderProfile();
    console.log(`[transcode] start base=${baseName} targets=[${targets.join(",")}] encoder=${profile.name}`);

    const result = await transcodeDownscale(masterPath, baseName, targets, profile);
    const elapsedMs = Date.now() - start;
    console.log(
      `[transcode] done encoder=${profile.name} ${elapsedMs}ms ` +
      `perRes=[${result.outputs.map((o) => `${o.resolution}:${o.fileSizeBytes}`).join(",")}]`
    );

    // Storage-service cutover (design 08 §2): PUT each output when configured +
    // bookId; else legacy relative-url fallback. All-or-nothing — any output PUT
    // failure after retries → 502 for the whole call. Already-PUT outputs stay on
    // storage as harmless orphans (idempotent {base}-{res}.mp4 names re-PUT with
    // upsert on a retried job). Local out/{res} copies unlinked after each PUT.
    let outputs = result.outputs;
    if (isStorageConfigured() && bookId) {
      try {
        outputs = await uploadTranscodeOutputs(bookId, result.outputs);
      } catch (uploadErr) {
        if (uploadErr instanceof StorageUploadError) {
          console.error(`[transcode] upload failed: ${uploadErr.message}`);
          res.status(502).json({ ok: false, code: uploadErr.code, message: uploadErr.message });
          return;
        }
        throw uploadErr;
      }
    }

    res.json({
      ok: true,
      outputs,
      fps: result.fps,
      durationInFrames: result.durationInFrames,
      elapsedMs,
    });
  } catch (err) {
    const c = classifyTranscodeError(err);
    console.error(`[transcode] failed code=${c.code}: ${c.message.slice(0, 200)}`);
    res.status(c.status).json({ ok: false, code: c.code, message: c.message });
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
    rendering = false;
  }
});

/** Fetch `sourceUrl` (SSRF-guarded, size-capped) to a temp file. Throws on any
 *  failure (caller maps to 502 SOURCE_FETCH_FAILED). `ext` names the temp file
 *  (cosmetic/debug only — ffmpeg demuxes by content, not extension). */
async function fetchMasterToTemp(sourceUrl: string, ext = "mp4"): Promise<string> {
  await assertSsrfSafe(sourceUrl);
  const resp = await fetch(sourceUrl);
  if (!resp.ok || !resp.body) {
    throw new Error(`fetch returned ${resp.status}`);
  }
  const cl = Number(resp.headers.get("content-length") ?? 0);
  if (cl && cl > TRANSCODE_SRC_MAX_BYTES) {
    throw new Error(`source exceeds cap (${cl} > ${TRANSCODE_SRC_MAX_BYTES})`);
  }
  const tmp = path.join(os.tmpdir(), `transcode-src-${randomUUID().slice(0, 8)}.${ext}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > TRANSCODE_SRC_MAX_BYTES) {
    throw new Error(`source exceeds cap (${buf.byteLength} > ${TRANSCODE_SRC_MAX_BYTES})`);
  }
  await fs.writeFile(tmp, buf);
  return tmp;
}

// ── POST /transcode generic mode — single-item downscale (design 08 §2b) ─────
// Always sourceUrl (no scratch-cache path — the item isn't a QHD master),
// container kept from source, output PUT S2S at the EXACT caller-supplied
// `outputKey` (ADR-057 sibling key). Shares the `rendering` in-flight slot.
async function handleGenericTranscode(body: Record<string, unknown>, res: Response): Promise<void> {
  const parsed = parseGenericTranscodeInput(body);
  if (!parsed.ok) {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: parsed.message });
    return;
  }
  const { sourceUrl, targetWidth, outputKey } = parsed.input;

  const container = detectContainer(sourceUrl);
  if (!container) {
    res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "`sourceUrl` must end in .mp4 or .webm" });
    return;
  }
  if (!isStorageConfigured()) {
    res.status(400).json({
      ok: false, code: "INVALID_INPUT",
      message: "generic transcode requires storage-service to be configured (STORAGE_SERVICE_URL)",
    });
    return;
  }
  if (rendering) {
    res.status(429).json({ ok: false, code: "BUSY", message: "another render in progress" });
    return;
  }
  rendering = true;
  const start = Date.now();

  let tempSrcPath: string | null = null;
  let tempOutPath: string | null = null;
  try {
    try {
      tempSrcPath = await fetchMasterToTemp(sourceUrl, container);
    } catch (err) {
      console.error(`[transcode] generic source fetch failed: ${String(err).slice(0, 200)}`);
      res.status(502).json({ ok: false, code: "SOURCE_FETCH_FAILED", message: "failed to fetch sourceUrl" });
      return;
    }

    const profile = getEncoderProfile();
    tempOutPath = path.join(os.tmpdir(), `transcode-out-${randomUUID().slice(0, 8)}.${container}`);
    console.log(`[transcode] generic start container=${container} targetWidth=${targetWidth} encoder=${profile.name}`);

    const result = await transcodeSingle(tempSrcPath, targetWidth, container, profile, tempOutPath);
    console.log(
      `[transcode] generic transcoded container=${container} ${Date.now() - start}ms ` +
      `size=${result.fileSizeBytes} dims=${result.width}x${result.height}`
    );

    let put;
    try {
      put = await putObjectAtKey({
        key: outputKey,
        filePath: tempOutPath,
        contentType: container === "webm" ? "video/webm" : "video/mp4",
      });
    } catch (uploadErr) {
      if (uploadErr instanceof StorageUploadError) {
        console.error(`[transcode] generic upload failed: ${uploadErr.message}`);
        res.status(502).json({ ok: false, code: uploadErr.code, message: uploadErr.message });
        return;
      }
      throw uploadErr;
    }

    const elapsedMs = Date.now() - start;
    console.log(`[transcode] generic done ${elapsedMs}ms`);
    res.json({
      ok: true,
      output: {
        url: put.url,
        storageKey: put.storageKey,
        width: result.width,
        height: result.height,
        fileSizeBytes: result.fileSizeBytes,
        durationInFrames: result.durationInFrames,
      },
      fps: result.fps,
      elapsedMs,
    });
  } catch (err) {
    const c = classifyTranscodeError(err);
    console.error(`[transcode] generic failed code=${c.code}: ${c.message.slice(0, 200)}`);
    res.status(c.status).json({ ok: false, code: c.code, message: c.message });
  } finally {
    if (tempSrcPath) await fs.unlink(tempSrcPath).catch(() => undefined);
    if (tempOutPath) await fs.unlink(tempOutPath).catch(() => undefined);
    rendering = false;
  }
}

// ── Prune helpers ─────────────────────────────────────────────────────────────

/** Keep only the most-recent MAX_KEEP_SPREAD_FILES spread-* MP4s (ephemeral preview). */
async function pruneSpreadFiles(): Promise<void> {
  try {
    const entries = await fs.readdir(OUT_DIR);
    // Only prune `spread-` prefixed files; book- files live in out/qhd (see pruneMasters).
    const spreadMp4s = entries.filter((f) => f.startsWith("spread-") && f.endsWith(".mp4")).sort();
    const excess = spreadMp4s.slice(0, Math.max(0, spreadMp4s.length - MAX_KEEP_SPREAD_FILES));
    await Promise.all(excess.map((f) => fs.unlink(path.join(OUT_DIR, f)).catch(() => undefined)));
  } catch {
    /* best-effort cleanup */
  }
}

/** Keep only the newest MAX_KEEP_MASTERS `book-*.mp4` masters in out/qhd (the
 *  master is a transcode cache once the durable copy lives on storage-service).
 *  Safe against a concurrent transcode read: prune only runs while the single
 *  shared `rendering` slot is held (transcode holds the same slot) → no reader. */
async function pruneMasters(): Promise<void> {
  try {
    const dir = tierOutDir(MASTER_TIER);
    const entries = await fs.readdir(dir);
    const masters = entries.filter((f) => f.startsWith("book-") && f.endsWith(".mp4"));
    if (masters.length <= MAX_KEEP_MASTERS) return;
    const withMtime = await Promise.all(
      masters.map(async (f) => {
        const p = path.join(dir, f);
        const st = await fs.stat(p).catch(() => null);
        return { p, mtime: st ? st.mtimeMs : 0 };
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime); // newest first
    const excess = withMtime.slice(MAX_KEEP_MASTERS);
    await Promise.all(excess.map((e) => fs.unlink(e.p).catch(() => undefined)));
    if (excess.length) console.log(`[render-book] pruned ${excess.length} old master(s), kept ${MAX_KEEP_MASTERS}`);
  } catch {
    /* best-effort cleanup */
  }
}

async function main() {
  console.log("[server] warming up (browser + bundle)...");
  await warmup();
  // Probe the transcode encoder once (nvenc→qsv→cpu) and cache (design 08 §3.1).
  await probeEncoder();
  // Bind loopback only — enforces the dev-only posture (no auth, wildcard CORS).
  app.listen(PORT, "127.0.0.1", () => console.log(`[server] ready on http://localhost:${PORT}`));
}

void main();
