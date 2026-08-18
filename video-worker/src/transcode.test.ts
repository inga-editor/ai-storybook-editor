// Unit tests for transcode pure helpers (no ffmpeg/ffprobe spawn).
//
// `@/remotion/composition-metadata` is mocked to the spec downscale dims so the
// test is isolated from the heavy shared-frontend import chain AND asserts the
// exact spec §1 dims (fhd 1440×1080, hd 960×720, sd 640×480).
import { describe, it, expect, vi } from "vitest";

vi.mock("@/remotion/composition-metadata", () => ({
  RESOLUTION_DIMS: {
    qhd: { width: 1920, height: 1440 },
    fhd: { width: 1440, height: 1080 },
    hd: { width: 960, height: 720 },
    sd: { width: 640, height: 480 },
  },
}));

import {
  outputFileName,
  buildFilterComplex,
  buildFfmpegArgs,
  parseFfprobe,
  detectContainer,
  computeEffectiveWidth,
  buildSingleFfmpegArgs,
  parseGenericTranscodeInput,
  detectTranscodeShape,
} from "./transcode.js";
import { buildEncoderProfile } from "./encoder-probe.js";

const CPU = buildEncoderProfile("cpu");

describe("outputFileName", () => {
  it("appends -{res} and strips .mp4", () => {
    expect(outputFileName("book-123-ab12cd34.mp4", "fhd")).toBe("book-123-ab12cd34-fhd.mp4");
    expect(outputFileName("book-123-ab12cd34.mp4", "sd")).toBe("book-123-ab12cd34-sd.mp4");
  });

  it("uses basename only (path-traversal-safe naming)", () => {
    expect(outputFileName("/abs/path/book-x.mp4", "hd")).toBe("book-x-hd.mp4");
  });

  it("is case-insensitive on the .mp4 suffix", () => {
    expect(outputFileName("BOOK.MP4", "fhd")).toBe("BOOK-fhd.mp4");
  });
});

describe("buildFilterComplex", () => {
  it("splits N branches and scales each to spec dims (cpu lanczos)", () => {
    const fc = buildFilterComplex(["fhd", "hd", "sd"], CPU);
    expect(fc).toContain("[0:v]split=3[v0][v1][v2]");
    expect(fc).toContain("[v0]scale=1440:1080:flags=lanczos[fhd]");
    expect(fc).toContain("[v1]scale=960:720:flags=lanczos[hd]");
    expect(fc).toContain("[v2]scale=640:480:flags=lanczos[sd]");
  });

  it("single target → split=1", () => {
    const fc = buildFilterComplex(["fhd"], CPU);
    expect(fc).toContain("split=1[v0]");
    expect(fc).toContain("[v0]scale=1440:1080:flags=lanczos[fhd]");
  });

  it("gpu profile uses scale_cuda with no lanczos suffix", () => {
    const fc = buildFilterComplex(["hd"], buildEncoderProfile("nvenc"));
    expect(fc).toContain("[v0]scale_cuda=960:720[hd]");
  });
});

describe("buildFfmpegArgs", () => {
  it("maps each output with audio copy + faststart + per-res out path", () => {
    const args = buildFfmpegArgs("/out/book-x.mp4", ["fhd", "sd"], CPU,
      (r) => `/out/book-x-${r}.mp4`);
    expect(args).toContain("-i");
    expect(args).toContain("/out/book-x.mp4");
    expect(args).toContain("-filter_complex");
    // per-output maps + codecs
    expect(args).toContain("[fhd]");
    expect(args).toContain("[sd]");
    expect(args.filter((a) => a === "0:a?").length).toBe(2);   // optional audio per output
    expect(args.filter((a) => a === "copy").length).toBe(2);   // -c:a copy per output
    expect(args).toContain("/out/book-x-fhd.mp4");
    expect(args).toContain("/out/book-x-sd.mp4");
    expect(args).toContain("+faststart");
  });

  it("prepends gpu hwaccel input args for a gpu profile", () => {
    const args = buildFfmpegArgs("/m.mp4", ["hd"], buildEncoderProfile("nvenc"),
      (r) => `/o-${r}.mp4`);
    const i = args.indexOf("-i");
    // hwaccel args appear before -i
    expect(args.slice(0, i)).toContain("cuda");
  });
});

describe("parseFfprobe", () => {
  it("parses fps from r_frame_rate and nb_frames", () => {
    const json = JSON.stringify({
      streams: [{ r_frame_rate: "30/1", nb_frames: "4830", width: 1920, height: 1440, duration: "161.0" }],
      format: { duration: "161.0" },
    });
    const p = parseFfprobe(json);
    expect(p.fps).toBe(30);
    expect(p.durationInFrames).toBe(4830);
    expect(p.width).toBe(1920);
    expect(p.height).toBe(1440);
  });

  it("falls back to duration*fps when nb_frames is N/A", () => {
    const json = JSON.stringify({
      streams: [{ r_frame_rate: "30/1", nb_frames: "N/A", width: 1440, height: 1080, duration: "10.0" }],
      format: { duration: "10.0" },
    });
    const p = parseFfprobe(json);
    expect(p.durationInFrames).toBe(300);
  });

  it("handles fractional frame rate (e.g. 30000/1001)", () => {
    const json = JSON.stringify({
      streams: [{ r_frame_rate: "30000/1001", duration: "10.0", width: 640, height: 480 }],
      format: {},
    });
    const p = parseFfprobe(json);
    expect(p.fps).toBe(30); // round(29.97)
  });

  it("defaults fps to 30 when rate is unparseable", () => {
    const json = JSON.stringify({ streams: [{ r_frame_rate: "0/0", duration: "5" }], format: {} });
    const p = parseFfprobe(json);
    expect(p.fps).toBe(30);
  });

  it("parses pix_fmt (alpha detection source)", () => {
    const json = JSON.stringify({
      streams: [{ r_frame_rate: "30/1", nb_frames: "10", width: 640, height: 480, pix_fmt: "yuva420p" }],
      format: {},
    });
    expect(parseFfprobe(json).pixFmt).toBe("yuva420p");
  });

  it("pixFmt defaults to empty string when absent", () => {
    const json = JSON.stringify({ streams: [{ r_frame_rate: "30/1", duration: "1" }], format: {} });
    expect(parseFfprobe(json).pixFmt).toBe("");
  });

  it("parses the alpha_mode stream tag (M1 — native vp9 decode under-detects alpha via pix_fmt alone)", () => {
    const json = JSON.stringify({
      streams: [{ r_frame_rate: "30/1", nb_frames: "10", width: 640, height: 480, pix_fmt: "yuv420p", tags: { alpha_mode: "1" } }],
      format: {},
    });
    const p = parseFfprobe(json);
    expect(p.alphaModeTag).toBe("1");
    expect(p.pixFmt).toBe("yuv420p"); // native decode still reports opaque pix_fmt
  });

  it("alphaModeTag defaults to empty string when tags/alpha_mode absent", () => {
    const json = JSON.stringify({ streams: [{ r_frame_rate: "30/1", duration: "1" }], format: {} });
    expect(parseFfprobe(json).alphaModeTag).toBe("");
  });
});

// ── generic mode (design 08 §2b, ADR-057) ────────────────────────────────────

describe("detectTranscodeShape", () => {
  it("targets[] present → book", () => {
    expect(detectTranscodeShape({ targets: ["fhd"] })).toBe("book");
  });

  it("outputKey/targetWidth present → generic", () => {
    expect(detectTranscodeShape({ outputKey: "a@b.mp4", targetWidth: 640 })).toBe("generic");
    expect(detectTranscodeShape({ targetWidth: 640 })).toBe("generic");
    expect(detectTranscodeShape({ outputKey: "a@b.mp4" })).toBe("generic");
  });

  it("neither present → book (default, existing body validation still applies)", () => {
    expect(detectTranscodeShape({})).toBe("book");
  });

  it("both groups present → mixed", () => {
    expect(detectTranscodeShape({ targets: ["fhd"], outputKey: "a@b.mp4" })).toBe("mixed");
    expect(detectTranscodeShape({ targets: ["fhd"], targetWidth: 640 })).toBe("mixed");
  });
});

describe("parseGenericTranscodeInput", () => {
  const VALID = { sourceUrl: "https://storage.example.com/files/x/uploads/videos/xyz.mp4", targetWidth: 640, outputKey: "uploads/videos/xyz.mp4@mobile.mp4" };

  it("accepts a well-formed body", () => {
    const r = parseGenericTranscodeInput(VALID);
    expect(r).toEqual({ ok: true, input: VALID });
  });

  it("rejects sourceFileName (generic mode must use sourceUrl)", () => {
    const r = parseGenericTranscodeInput({ ...VALID, sourceFileName: "book-1.mp4" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing sourceUrl", () => {
    const { sourceUrl: _drop, ...rest } = VALID;
    const r = parseGenericTranscodeInput(rest);
    expect(r.ok).toBe(false);
  });

  it("rejects odd targetWidth", () => {
    const r = parseGenericTranscodeInput({ ...VALID, targetWidth: 641 });
    expect(r.ok).toBe(false);
  });

  it("rejects targetWidth <= 0", () => {
    expect(parseGenericTranscodeInput({ ...VALID, targetWidth: 0 }).ok).toBe(false);
    expect(parseGenericTranscodeInput({ ...VALID, targetWidth: -640 }).ok).toBe(false);
  });

  it("rejects non-integer targetWidth", () => {
    expect(parseGenericTranscodeInput({ ...VALID, targetWidth: 640.5 }).ok).toBe(false);
  });

  it("rejects empty outputKey", () => {
    expect(parseGenericTranscodeInput({ ...VALID, outputKey: "" }).ok).toBe(false);
    expect(parseGenericTranscodeInput({ ...VALID, outputKey: "   " }).ok).toBe(false);
  });
});

describe("detectContainer", () => {
  it("mp4 source URL → mp4", () => {
    expect(detectContainer("https://storage.example.com/files/b/uploads/videos/xyz.mp4")).toBe("mp4");
  });

  it("webm source URL → webm", () => {
    expect(detectContainer("https://storage.example.com/files/b/uploads/videos/xyz.webm")).toBe("webm");
  });

  it("unsupported extension → null", () => {
    expect(detectContainer("https://storage.example.com/files/b/uploads/videos/xyz.mov")).toBeNull();
  });

  it("unparseable URL falls back to raw-string extname", () => {
    expect(detectContainer("not-a-url.webm")).toBe("webm");
  });
});

describe("computeEffectiveWidth", () => {
  it("no-upscale: source narrower than target → keeps source width", () => {
    expect(computeEffectiveWidth(500, 640)).toBe(500);
  });

  it("target narrower than source → uses target width", () => {
    expect(computeEffectiveWidth(1920, 640)).toBe(640);
  });

  it("floors an odd bound to even", () => {
    expect(computeEffectiveWidth(501, 640)).toBe(500);
  });

  it("unprobed source width (<=0) → keeps targetWidth", () => {
    expect(computeEffectiveWidth(0, 640)).toBe(640);
  });
});

describe("buildSingleFfmpegArgs", () => {
  it("mp4 (cpu profile): even-width lanczos scale + faststart + yuv420p", () => {
    const args = buildSingleFfmpegArgs({
      sourcePath: "/tmp/src.mp4", effectiveWidth: 640, container: "mp4", hasAlpha: false, profile: CPU, outPath: "/tmp/out.mp4",
    });
    expect(args).toContain("-vf");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=640:-2:flags=lanczos");
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(args).toContain("yuv420p");
    expect(args).toContain("/tmp/out.mp4");
  });

  it("webm alpha: ALWAYS libvpx-vp9 CPU + yuva420p, ignores a GPU profile", () => {
    const gpu = buildEncoderProfile("nvenc");
    const args = buildSingleFfmpegArgs({
      sourcePath: "/tmp/src.webm", effectiveWidth: 480, container: "webm", hasAlpha: true, profile: gpu, outPath: "/tmp/out.webm",
    });
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("yuva420p");
    expect(args).not.toContain("h264_nvenc");
    expect(args).not.toContain("scale_cuda");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=480:-2:flags=lanczos");
  });

  it("webm alpha: -c:v libvpx-vp9 appears as an INPUT option (before -i) so the decoder actually reads the alpha plane (M1)", () => {
    const args = buildSingleFfmpegArgs({
      sourcePath: "/tmp/src.webm", effectiveWidth: 480, container: "webm", hasAlpha: true, profile: CPU, outPath: "/tmp/out.webm",
    });
    const iIndex = args.indexOf("-i");
    const firstCodecIndex = args.indexOf("-c:v");
    expect(firstCodecIndex).toBeGreaterThanOrEqual(0);
    expect(firstCodecIndex).toBeLessThan(iIndex);
    expect(args[firstCodecIndex + 1]).toBe("libvpx-vp9");
    // still carries the OUTPUT encoder -c:v libvpx-vp9 after -i (2 occurrences total).
    expect(args.filter((a) => a === "-c:v").length).toBe(2);
  });

  it("webm without alpha → yuv420p (still forced CPU vp9 OUTPUT encoder), NO input decoder override (native decode kept)", () => {
    const args = buildSingleFfmpegArgs({
      sourcePath: "/tmp/src.webm", effectiveWidth: 480, container: "webm", hasAlpha: false, profile: CPU, outPath: "/tmp/out.webm",
    });
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("yuv420p");
    expect(args).not.toContain("yuva420p");
    // only ONE -c:v (the output encoder) — no input decoder override for non-alpha sources.
    expect(args.filter((a) => a === "-c:v").length).toBe(1);
    const iIndex = args.indexOf("-i");
    expect(iIndex).toBe(2); // "-hide_banner", "-y", "-i" — nothing prepended before -i
  });

  it("mp4 gpu profile: prepends hwaccel args, omits -pix_fmt", () => {
    const gpu = buildEncoderProfile("nvenc");
    const args = buildSingleFfmpegArgs({
      sourcePath: "/tmp/src.mp4", effectiveWidth: 960, container: "mp4", hasAlpha: false, profile: gpu, outPath: "/tmp/out.mp4",
    });
    const i = args.indexOf("-i");
    expect(args.slice(0, i)).toContain("cuda");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale_cuda=960:-2");
    expect(args).not.toContain("-pix_fmt");
  });

  it("audio is optional-mapped and copied (parity with book mode)", () => {
    const args = buildSingleFfmpegArgs({
      sourcePath: "/tmp/src.mp4", effectiveWidth: 640, container: "mp4", hasAlpha: false, profile: CPU, outPath: "/tmp/out.mp4",
    });
    expect(args).toContain("0:a?");
    expect(args).toContain("copy");
  });
});
