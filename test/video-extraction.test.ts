// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareVisual } from "../src/engine/media/vision";

it.skipIf(!Bun.which("ffmpeg"))(
  "samples decoded frames with current FFmpeg output synchronization",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-video-extraction-"));
    try {
      const path = join(dir, "clip.mp4");
      const made = Bun.spawnSync([
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x64:d=2:r=30",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      expect(made.exitCode, made.stderr.toString()).toBe(0);
      const visual = await prepareVisual({
        data: readFileSync(path),
        mime: "video/mp4",
        label: "clip",
      });
      expect(visual.images.length, visual.notes.join(" ")).toBeGreaterThan(0);
      const sharp = (await import("sharp")).default;
      const stats = await sharp(Buffer.from(visual.images[0]!.split(",")[1]!, "base64")).stats();
      expect(stats.channels[0]!.mean).toBeGreaterThan(200);
      expect(stats.channels[1]!.mean).toBeLessThan(20);
      expect(stats.channels[2]!.mean).toBeLessThan(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
