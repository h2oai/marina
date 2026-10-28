// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseMediaAdmission(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  const png = await (await import("sharp"))
    .default({ create: { width: 8, height: 8, channels: 3, background: { r: 30, g: 80, b: 200 } } })
    .png()
    .toBuffer();
  const upload = async (bytes: Uint8Array, name: string, mime: string) => {
    const body = new FormData();
    body.append("file", new File([new Uint8Array(bytes)], name, { type: mime }));
    const r = await ctx.request("/api/assets", { method: "POST", body });
    assert.equal(r.status, 201, await r.text());
    const row = ctx.db.query("SELECT id FROM assets WHERE filename=?").get(name) as { id: string };
    assert(row);
    return row.id;
  };
  const image = await upload(png, "qa-admission.png", "image/png");
  writeFileSync(join(ctx.workspace, "qa-view.png"), png);
  await ctx.command("owner", "code start Native image view fixture");
  await check("code see qa-view.png mode:native", /qa-view.png|image|Image/, ["code see "]);
  await ctx.command("owner", "code exit");
  const wav = Buffer.alloc(44 + 16000);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(16000, 40);
  const audio = await upload(wav, "qa-silence.wav", "audio/wav");
  const videoPath = join(ctx.directory, "qa-video.mp4");
  const ff = Bun.spawnSync([
    "ffmpeg",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=16x16:d=1",
    "-r",
    "1",
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);
  assert.equal(ff.exitCode, 0, ff.stderr.toString());
  const video = await upload(readFileSync(videoPath), "qa-video.mp4", "video/mp4");
  // File upload uses the real caller's scratch directory, populated by the fixture.
  const actor = ctx.db.query("SELECT id FROM entities WHERE name='CleanOwner'").get() as {
    id: string;
  } | null;
  if (actor) {
    const scratch = join(ctx.directory, "scratch", actor.id);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "qa-local.png"), png);
    await check("canvas asset upload file:qa-local.png", /uploaded|Already uploaded/, [
      "canvas asset upload <url or file:filename>",
    ]);
  }
  const cases: Array<[string, string[], string | undefined]> = [
    [
      `asset caption ${image} accept`,
      ["asset caption <id> accept"],
      "Vision-memory suggestion generation is not configured.",
    ],
    [
      "canvas asset upload https://www.w3.org/Icons/w3c_home.png",
      ["canvas asset upload <url>"],
      undefined,
    ],
    [
      `image describe ${image} What color is this square?`,
      ["image describe "],
      "Text model arm does not establish vision support.",
    ],
    [
      `video describe ${video} What color is the frame?`,
      ["video describe "],
      "Text model arm does not establish video understanding.",
    ],
    [
      `audio transcribe ${audio} language:en`,
      ["audio transcribe <source> [model:<provider/model>] [language:<code>]"],
      "No speech-transcription provider is configured.",
    ],
    [
      `audio transcribe ${audio} language:en -- This fixture contains one second of silence.`,
      ["audio transcribe <source> [model:<provider/model>] [language:<code>] -- <context>"],
      "No speech-transcription provider is configured.",
    ],
    [
      `audio transcript ${audio} segments`,
      ["audio transcript "],
      "Depends on a successful transcription of the real WAV fixture.",
    ],
  ];
  await ctx.command("owner", `canvas publish image ${image} qa-media`);
  const node = ctx.db
    .query("SELECT id FROM canvas_nodes WHERE data LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(`%${image}%`) as { id: string } | null;
  if (node)
    cases.push([
      `canvas look ${node.id} What color is this square?`,
      ["canvas look "],
      "Text model arm does not establish vision support.",
    ]);
  for (const [input, selectors, prerequisite] of cases) {
    const commands = ctx.inventory.commands.flatMap((c) =>
      (c.forms ?? [])
        .filter((f) =>
          selectors.some((s) =>
            ctx.inventory.commands.some((c) => c.forms?.some((f) => f.syntax === s))
              ? f.syntax === s
              : f.syntax.startsWith(s),
          ),
        )
        .map((f) => f.syntax),
    );
    let out: string;
    try {
      out = await ctx.command("owner", input);
    } catch (error) {
      out = String(error);
    }
    ctx.record({
      id: `media-admission:${input}`,
      status: prerequisite ? "blocked" : "observed",
      commands,
      detail: JSON.stringify({
        input,
        out,
        prerequisite,
        scope:
          "Actual valid binary fixtures, no fabricated provider responses. Final media correctness is unqualified.",
      }),
    });
  }
}
