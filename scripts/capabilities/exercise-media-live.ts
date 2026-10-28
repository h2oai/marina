// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareVisual } from "../../src/engine/media/vision";
import type { ExerciseContext } from "./exercise";

export async function exerciseMediaLive(ctx: ExerciseContext) {
  const sharp = (await import("sharp")).default;
  const upload = async (bytes: Uint8Array, mime: string, ext: string) => {
    const name = `${randomUUID()}.${ext}`;
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type: mime }));
    const response = await ctx.request("/api/assets", { method: "POST", body: form });
    assert.equal(response.status, 201, await response.text());
    const row = ctx.db.query("SELECT * FROM assets WHERE filename=?").get(name) as {
      id: string;
      sha256: string;
    };
    assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
    return row.id;
  };
  const fixtures = [
    {
      svg: '<svg width="600" height="400"><rect width="600" height="400" fill="white"/><circle cx="110" cy="100" r="70" fill="red"/><rect x="400" y="240" width="120" height="120" fill="blue"/><text x="170" y="210" font-size="58" fill="black">LARCH 62</text></svg>',
      checks: [/red/i, /circle/i, /blue/i, /square/i, /LARCH/i, /62/],
    },
    {
      svg: '<svg width="600" height="400"><rect width="600" height="400" fill="white"/><polygon points="80,30 20,160 140,160" fill="orange"/><circle cx="460" cy="290" r="65" fill="green"/><text x="170" y="205" font-size="60" fill="black">MICA 47</text></svg>',
      checks: [/orange/i, /triangle/i, /green/i, /circle/i, /MICA/i, /47/],
    },
  ];
  await ctx.command("owner", "canvas create qa-discrimination Visual qualification");
  for (const [i, fixture] of fixtures.entries()) {
    const bytes = await sharp(Buffer.from(fixture.svg)).png().toBuffer();
    writeFileSync(join(ctx.directory, `visual-fixture-${i}.png`), bytes);
    const id = await upload(bytes, "image/png", "png");
    if (!ctx.live) {
      ctx.record({
        id: `visual:${i}`,
        status: "blocked",
        detail: "Uploaded real fixture; image understanding needs a provider.",
      });
      continue;
    }
    await ctx.scenario(`visual:${i}`, async () => {
      const question =
        "Describe all shapes, colors, their relative positions, and the exact printed text.";
      const output = await ctx.command("owner", `image describe ${id} ${question}`);
      for (const expected of fixture.checks) assert.match(output, expected);
      await ctx.command("owner", `canvas publish image ${id} qa-discrimination`);
      const node = ctx.db
        .query("SELECT id FROM canvas_nodes WHERE data LIKE ? ORDER BY created_at DESC LIMIT 1")
        .get(`%${id}%`) as { id: string };
      assert(node);
      const look = await ctx.command("owner", `canvas look ${node.id} ${question}`);
      for (const expected of fixture.checks) assert.match(look, expected);
      const derived = ctx.db
        .query("SELECT * FROM canvas_nodes WHERE type='text' AND data LIKE ?")
        .all(`%${node.id}%`);
      assert(derived.length, "Description must link the source node");
      return JSON.stringify({
        id,
        node: node.id,
        output,
        look,
        derived,
        scope: "Two independently graded images; prompt/filenames disclose none of their contents.",
      });
    });
  }
  const path = join(ctx.directory, "discrimination-video.mp4");
  const ff = Bun.spawnSync([
    "ffmpeg",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x240:d=2:r=30",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x240:d=2:r=30",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:d=2:r=30",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]",
    "-map",
    "[out]",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  assert.equal(ff.exitCode, 0, ff.stderr.toString());
  const video = readFileSync(path);
  await ctx.scenario("video:decoded-frames", async () => {
    const prepared = await prepareVisual({
      data: video,
      mime: "video/mp4",
      label: "anonymous clip",
    });
    assert(prepared.images.length >= 3, JSON.stringify(prepared.notes));
    const colors = [];
    for (const [i, frame] of prepared.images.entries()) {
      const bytes = Buffer.from(frame.slice(frame.indexOf(",") + 1), "base64");
      writeFileSync(join(ctx.directory, `decoded-frame-${i}.png`), bytes);
      const stats = await sharp(bytes).stats();
      colors.push(stats.channels.slice(0, 3).map((c) => c.mean));
    }
    assert(colors.some(([r, g, b]) => r! > g! * 2 && r! > b! * 2));
    assert(colors.some(([r, g, b]) => g! > r! * 2 && g! > b! * 2));
    assert(colors.some(([r, g, b]) => b! > r! * 2 && b! > g! * 2));
    return JSON.stringify({
      frames: prepared.images.length,
      notes: prepared.notes,
      colors,
      scope: "Production decoder, real H.264 fixture, independently checked pixel colors.",
    });
  });
  const videoId = await upload(video, "video/mp4", "mp4");
  if (!ctx.live) return;
  await ctx.scenario("video:understanding", async () => {
    const output = await ctx.command(
      "owner",
      `video describe ${videoId} List the distinct colors visible in the sampled frames.`,
    );
    for (const color of [/red/i, /green/i, /blue/i]) assert.match(output, color);
    return JSON.stringify({ videoId, output });
  });
  await ctx.scenario("audio:speech-transcript", async () => {
    const text = "The lantern is green. The parcel number is seven hundred and twenty nine.";
    const output = await ctx.command(
      "owner",
      `audio speak model:openai/gpt-4o-mini-tts voice:alloy format:wav -- ${text}`,
    );
    const row = ctx.db
      .query("SELECT * FROM assets WHERE mime_type LIKE 'audio/%' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string; storage_key: string; metadata: string } | null;
    assert(row, output);
    const data = readFileSync(join(ctx.directory, "assets", row.storage_key));
    assert.equal(data.subarray(0, 4).toString(), "RIFF");
    const transcript = await ctx.command(
      "owner",
      `audio transcribe ${row.id} model:openai/whisper-1 language:en`,
    );
    assert.match(transcript, /lantern is green/i);
    assert.match(transcript, /729|seven hundred (?:and )?twenty.nine/i);
    const stored = ctx.db.query("SELECT metadata FROM assets WHERE id=?").get(row.id) as {
      metadata: string;
    };
    const parsed = JSON.parse(stored.metadata).transcript;
    assert(parsed?.segments?.length, "Timed transcript segments required");
    assert(
      parsed.segments.every((s: { start: number; end: number }) => s.start >= 0 && s.end > s.start),
    );
    return JSON.stringify({
      output,
      transcript,
      asset: row.id,
      bytes: data.length,
      stored: parsed,
      scope:
        "Configured OpenAI speech/transcription routes, separately identified from text and vision models.",
    });
  });
  await ctx.scenario("image:generated", async () => {
    const output = await ctx.command(
      "owner",
      "image generate A white background with exactly one orange triangle in the center, no text. model:openai/gpt-image-1-mini width:1024 height:1024",
    );
    const job = ctx.db
      .query("SELECT * FROM media_jobs WHERE type='image' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string; status: string; asset_id: string; error: string } | null;
    assert(job, output);
    assert.equal(job.status, "succeeded", JSON.stringify(job));
    const asset = ctx.db.query("SELECT storage_key FROM assets WHERE id=?").get(job.asset_id) as {
      storage_key: string;
    };
    const bytes = readFileSync(join(ctx.directory, "assets", asset.storage_key));
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 1024);
    const described = await ctx.command(
      "owner",
      `image describe ${job.asset_id} Describe the central shape and background.`,
    );
    assert.match(described, /orange/i);
    assert.match(described, /triangle/i);
    assert.match(described, /white/i);
    return JSON.stringify({ job, output, described, metadata });
  });
  const videoGeneration = await ctx.command(
    "owner",
    "video generate A blue circle moves left to right. model:runway/gen4.5 duration:5",
  );
  ctx.record({
    id: "video:provider-prerequisite",
    status: /[Nn]o.*key|[Mm]issing.*key|not configured/.test(videoGeneration)
      ? "blocked"
      : "observed",
    detail: videoGeneration,
  });
}
