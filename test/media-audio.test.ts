// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio end to end on an isolated engine with real asset storage and a mocked
 * provider network: `audio transcribe` (transcript stored on the asset per
 * the memory-over-media contract, only by someone who may change it), `audio
 * transcript`, `audio speak` (a generated audio asset with provenance and a
 * canvas node), per-entity caps, the daily spend cap, spend recorded once,
 * the ffmpeg path (video audio track, long audio cut into pieces with merged
 * timestamps; skipped when ffmpeg is missing) and the OpenAI-compatible
 * `/v1/audio/transcriptions` and `/v1/audio/speech` endpoints (auth, caller
 * identity, multipart parsing, caps, unsupported parameters).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestAsset } from "../src/engine/media/asset-library";
import { prepareAudioPieces } from "../src/engine/media/audio";
import {
  speechPriceUsd,
  transcriptionPriceUsd,
} from "../src/engine/media/providers/audio-registry";
import { hasTool, runTool } from "../src/engine/media/vision";
import { recordSpend, resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import { handleModelApi } from "../src/net/model/model-api";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import type { AssetRow } from "../src/persistence/db-assets";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection, stripAnsi } from "./helpers";

const ENV = [
  "MARINA_ASSET_DERIVATIVES",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MAX_TRANSCRIPTION_JOBS_PER_DAY",
  "MAX_SPEECH_JOBS_PER_DAY",
  "MARINA_AUDIO_MAX_BYTES",
  "MARINA_AUDIO_CHUNK_SECONDS",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_TRANSCRIBE_MODEL",
  "MARINA_SPEECH_MODEL",
];
const realFetch = globalThis.fetch;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
const FFMPEG = hasTool("ffmpeg") && hasTool("ffprobe");

interface Call {
  path: string;
  form?: FormData;
  body?: Record<string, unknown>;
}

describe("audio — commands, storage, spend and the /v1/audio endpoints", () => {
  let saved: Record<string, string | undefined>;
  let dir: string;
  let fixture: ReturnType<typeof createTestEngine>;
  let calls: Call[];
  let transcribeReply: (call: Call, index: number) => Record<string, unknown>;
  type Who = { id: EntityId; token: string; conn: MockConnection; name: string };
  let owner: Who;
  let stranger: Who;

  function enter(name: string, rank: number): Who {
    const conn = new MockConnection(`c-${name}`);
    conn.peerIp = "203.0.113.9";
    fixture.engine.addConnection(conn);
    const login = fixture.engine.login(conn.id, name);
    if (!("token" in login)) throw new Error(`login failed: ${login.error}`);
    fixture.engine.entities.get(login.entityId)!.properties.rank = rank;
    return { id: login.entityId, token: login.token, conn, name };
  }

  async function run(who: Who, raw: string): Promise<string> {
    const before = who.conn.messages.length;
    await fixture.engine.processCommand(who.id, raw);
    return stripAnsi(who.conn.allText().slice(before).join("\n"));
  }

  const ingest = async (who: Who, data: Uint8Array, filename: string, mime: string) =>
    (
      await ingestAsset(fixture.engine, {
        owner: who.name,
        filename,
        mime,
        data,
        origin: "upload",
        actor: who.id,
      })
    ).asset;

  const meta = (id: string) =>
    JSON.parse((fixture.db.getAsset(id) as AssetRow).metadata) as Record<string, unknown>;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.MARINA_ASSET_DERIVATIVES = "off";
    resetSpendLedgerForTests();
    __setDnsResolverForTest(async () => ["93.184.216.34"]);
    dir = mkdtempSync(join(tmpdir(), "audio-test-"));
    const storage = new LocalStorageProvider(dir);
    await storage.init();
    fixture = createTestEngine({ assetStorage: storage });
    // The provider key, without touching the real environment.
    (
      fixture.engine.mediaManager as unknown as { resolveApiKey: (p: string) => string | undefined }
    ).resolveApiKey = (p) => (p === "openai" ? "sk-test" : undefined);
    calls = [];
    transcribeReply = () => ({
      text: "The harbour light turns green.",
      languages: [{ code: "en" }],
      usage: { type: "duration", seconds: 5 },
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      if (path.endsWith("/audio/transcriptions")) {
        const call = { path, form: init?.body as FormData };
        calls.push(call);
        return Response.json(transcribeReply(call, calls.length - 1));
      }
      if (path.endsWith("/audio/speech")) {
        calls.push({ path, body: JSON.parse(String(init?.body)) });
        return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;
    owner = enter("Owner", 1);
    stranger = enter("Stranger", 4);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    __setDnsResolverForTest(null);
    await fixture.dispose();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSpendLedgerForTests();
  });

  it("transcribes an owned asset, stores metadata.transcript per contract, charges once", async () => {
    const asset = await ingest(owner, MP3, "memo.mp3", "audio/mpeg");
    const reply = await run(owner, `audio transcribe ${asset.id} language:en -- Harbour names`);
    expect(reply).toContain("The harbour light turns green.");
    expect(reply).toContain(`Saved on asset ${asset.id}`);
    expect(calls).toHaveLength(1);
    const form = calls[0]!.form!;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.getAll("languages[]")).toEqual(["en"]);
    expect(form.get("prompt")).toBe("Harbour names");
    expect((form.get("file") as File).type).toBe("audio/mpeg");

    const transcript = meta(asset.id).transcript as Record<string, unknown>;
    expect(transcript).toMatchObject({
      text: "The harbour light turns green.",
      language: "en",
      model: "openai/gpt-transcribe",
    });
    expect(typeof transcript.createdAt).toBe("number");
    expect(spentTodayUsd()).toBeCloseTo(transcriptionPriceUsd("openai/gpt-transcribe", 5)!, 8);
    const jobs = fixture.db.listMediaJobs({ entityName: "Owner" });
    expect(jobs.map((j) => [j.type, j.status, j.asset_id])).toEqual([
      ["transcription", "succeeded", asset.id],
    ]);
    // The job records what was transcribed, never the transcript.
    expect(JSON.stringify(jobs[0])).not.toContain("harbour light");

    expect(await run(owner, `audio transcript ${asset.id}`)).toContain(
      "The harbour light turns green.",
    );
    expect(await run(owner, `asset show ${asset.id}`)).toContain("transcript 30 chars");
  });

  it("lets a reader transcribe someone else's asset without changing it", async () => {
    const asset = await ingest(owner, MP3, "memo.mp3", "audio/mpeg");
    const reply = await run(stranger, `audio transcribe ${asset.id}`);
    expect(reply).toContain("The harbour light turns green.");
    expect(reply).toContain("Not saved");
    expect(meta(asset.id).transcript).toBeUndefined();
  });

  it("refuses non-audio sources, past the entity cap, and past the daily spend cap — before any call", async () => {
    const text = await ingest(owner, new TextEncoder().encode("hello"), "a.txt", "text/plain");
    expect(await run(owner, `audio transcribe ${text.id}`)).toContain("not audio or video");

    const asset = await ingest(owner, MP3, "memo.mp3", "audio/mpeg");
    process.env.MAX_TRANSCRIPTION_JOBS_PER_DAY = "1";
    expect(await run(owner, `audio transcribe ${asset.id}`)).toContain("Transcript");
    expect(await run(owner, `audio transcribe ${asset.id}`)).toContain(
      "MAX_TRANSCRIPTION_JOBS_PER_DAY",
    );
    expect(calls).toHaveLength(1);

    delete process.env.MAX_TRANSCRIPTION_JOBS_PER_DAY;
    process.env.MARINA_DAILY_SPEND_CAP_USD = "0.01";
    recordSpend("media", 0.02);
    expect(await run(owner, `audio transcribe ${asset.id}`)).toContain("Transcription refused");
    expect(await run(owner, "audio speak -- hello")).toContain("Speech refused");
    expect(calls).toHaveLength(1);
  });

  it("speaks to a generated audio asset with provenance and an audio canvas node; charges once", async () => {
    const reply = await run(owner, "audio speak voice:cedar format:wav -- Hello   harbour");
    expect(reply).toContain("Speech ready: asset:");
    expect(calls[0]!.body).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Hello harbour",
      voice: "cedar",
      response_format: "wav",
    });
    const assetId = /asset:([0-9a-f-]+)/.exec(reply)![1]!;
    const asset = fixture.db.getAsset(assetId)!;
    expect(asset.origin).toBe("generated");
    expect(asset.mime_type).toBe("audio/wav");
    expect(asset.entity_name).toBe("Owner");
    expect(JSON.parse(asset.provenance)).toMatchObject({
      prompt: "Hello harbour",
      model: "openai/gpt-4o-mini-tts",
      provider: "openai",
    });
    const canvas = fixture.db.ensureEntityCanvas(owner.id, "Owner", "Owner");
    const nodes = fixture.db.getNodesByCanvas(canvas.id).filter((n) => n.asset_id === assetId);
    expect(nodes.map((n) => n.type)).toEqual(["audio"]);
    expect(spentTodayUsd()).toBeCloseTo(speechPriceUsd("openai/gpt-4o-mini-tts", 13, 13 / 15)!, 8);
    const [job] = fixture.db.listMediaJobs({ entityName: "Owner" });
    expect([job!.type, job!.status, job!.asset_id]).toEqual(["speech", "succeeded", assetId]);
    expect(job!.prompt).not.toContain("harbour");

    expect(await run(owner, "audio speak format:pcm -- hi")).toContain("format must be one of");
    expect(await run(owner, `audio speak -- ${"x".repeat(4100)}`)).toContain("limit is 4096");
  });

  it.skipIf(!FFMPEG)("transcribes a video from its audio track (ffmpeg)", async () => {
    const work = mkdtempSync(join(tmpdir(), "audio-ff-"));
    try {
      const out = join(work, "clip.mp4");
      const made = await runTool([
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=2",
        "-shortest",
        "-c:v",
        "mpeg4",
        "-c:a",
        "aac",
        out,
      ]);
      expect(made.ok).toBe(true);
      const video = await ingest(owner, new Uint8Array(readFileSync(out)), "clip.mp4", "video/mp4");
      const reply = await run(owner, `audio transcribe ${video.id}`);
      expect(reply).toContain("The harbour light turns green.");
      const file = calls[0]!.form!.get("file") as File;
      expect(file.type).toBe("audio/wav");
      expect(file.name).toBe("audio.wav");
      expect((meta(video.id).transcript as { text: string }).text).toContain("harbour");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!FFMPEG)("cuts long audio into pieces and merges their timestamps", async () => {
    const work = mkdtempSync(join(tmpdir(), "audio-ff-"));
    try {
      const out = join(work, "long.wav");
      const made = await runTool([
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=70:sample_rate=8000",
        "-ac",
        "1",
        out,
      ]);
      expect(made.ok).toBe(true);
      const data = new Uint8Array(readFileSync(out));
      process.env.MARINA_AUDIO_CHUNK_SECONDS = "30";
      const prepared = await prepareAudioPieces(data, "audio/wav", {
        provider: "openai",
        maxUploadBytes: 25 * 1024 * 1024,
      });
      expect(prepared.pieces.map((p) => p.offset)).toEqual([0, 30, 60]);
      expect(prepared.pieces.every((p) => p.mime === "audio/wav")).toBe(true);

      transcribeReply = (_call, i) => ({
        text: `part ${i}`,
        segments: [{ id: 0, start: 1, end: 2, text: `part ${i}` }],
        duration: i === 2 ? 10 : 30,
      });
      const asset = await ingest(owner, data, "long.wav", "audio/wav");
      const reply = await run(owner, `audio transcribe ${asset.id} model:openai/whisper-1`);
      expect(reply).toContain("3 pieces");
      const t = meta(asset.id).transcript as {
        text: string;
        segments: { start: number; end: number }[];
      };
      expect(t.text).toBe("part 0\npart 1\npart 2");
      expect(t.segments.map((s) => s.start)).toEqual([1, 31, 61]);
      // 70 s of whisper-1, recorded once.
      expect(spentTodayUsd()).toBeCloseTo(transcriptionPriceUsd("openai/whisper-1", 70)!, 6);
      expect(await run(owner, `audio transcript ${asset.id} segments`)).toContain(
        "[1:01–1:02] part 2",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  describe("/v1/audio endpoints", () => {
    const call = (path: string, init: RequestInit) => {
      const url = new URL(`http://localhost:3300${path}`);
      const req = new Request(url.toString(), { method: "POST", ...init });
      return handleModelApi(url, "POST", req, fixture.engine);
    };
    const upload = (
      fields: Record<string, string | string[]>,
      file = MP3,
      auth = "Bearer sk-bound",
    ) => {
      const form = new FormData();
      form.append(
        "file",
        new File([file as Uint8Array<ArrayBuffer>], "memo.mp3", { type: "audio/mpeg" }),
      );
      for (const [k, v] of Object.entries(fields))
        for (const one of [v].flat()) form.append(k, one);
      return call("/v1/audio/transcriptions", { body: form, headers: { Authorization: auth } });
    };

    beforeEach(() => {
      process.env.MODEL_API_KEYS = "sk-bound:Owner";
    });

    it("requires model-API auth", async () => {
      const res = await upload({ model: "gpt-transcribe" }, MP3, "Bearer wrong");
      expect(res!.status).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it("transcribes a multipart upload as the bound caller (json and text)", async () => {
      const res = await upload({ model: "gpt-transcribe", "languages[]": ["en", "fr"] });
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({
        text: "The harbour light turns green.",
        languages: [{ code: "en" }],
        usage: { type: "duration", seconds: 5 },
      });
      expect(res!.headers.get("x-marina-media-job")).toBeTruthy();
      expect(calls[0]!.form!.getAll("languages[]")).toEqual(["en", "fr"]);
      const [job] = fixture.db.listMediaJobs({ entityName: "Owner" });
      expect(job!.type).toBe("transcription");

      const text = await upload({ model: "gpt-transcribe", response_format: "text" });
      expect(text!.headers.get("content-type")).toContain("text/plain");
      expect(await text!.text()).toBe("The harbour light turns green.");
    });

    it("serves srt from segments and refuses it without them", async () => {
      const none = await upload({ model: "gpt-transcribe", response_format: "srt" });
      expect(none!.status).toBe(400);
      transcribeReply = () => ({
        text: "hi there",
        segments: [{ start: 0, end: 1.25, text: "hi there" }],
      });
      const srt = await upload({ model: "whisper-1", response_format: "srt" });
      expect(await srt!.text()).toBe("1\n00:00:00,000 --> 00:00:01,250\nhi there\n");
    });

    it("refuses parameters it cannot honor, unknown bare models and oversize uploads", async () => {
      const body = async (r: Response | undefined) =>
        ((await r!.json()) as { error: { code: string; param: string | null } }).error;
      const inc = await upload({ model: "gpt-transcribe", "include[]": "logprobs" });
      expect(inc!.status).toBe(400);
      expect(await body(inc)).toMatchObject({ code: "unsupported_parameter", param: "include[]" });
      const words = await upload({ model: "whisper-1", "timestamp_granularities[]": "word" });
      expect((await body(words)).code).toBe("unsupported_parameter");
      const stream = await upload({ model: "gpt-transcribe", stream: "true" });
      expect((await body(stream)).code).toBe("unsupported_parameter");
      const unknown = await upload({ model: "kokoro" });
      expect(unknown!.status).toBe(404);
      expect((await body(unknown)).code).toBe("model_not_found");
      process.env.MARINA_AUDIO_MAX_BYTES = "4";
      const big = await upload({ model: "gpt-transcribe" });
      expect(big!.status).toBe(413);
      expect((await body(big)).code).toBe("payload_too_large");
      expect(calls).toHaveLength(0);
    });

    it("speaks OpenAI-compatibly and returns the audio bytes; refuses unsupported fields", async () => {
      const speak = (payload: Record<string, unknown>) =>
        call("/v1/audio/speech", {
          body: JSON.stringify(payload),
          headers: { Authorization: "Bearer sk-bound", "Content-Type": "application/json" },
        });
      const res = await speak({
        model: "gpt-4o-mini-tts",
        input: "hi",
        voice: "marin",
        response_format: "mp3",
        stream_format: "audio",
      });
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-type")).toBe("audio/mpeg");
      expect(new Uint8Array(await res!.arrayBuffer())).toEqual(MP3);
      expect(Number(res!.headers.get("x-marina-cost-usd"))).toBeGreaterThan(0);
      const [job] = fixture.db.listMediaJobs({ entityName: "Owner" });
      expect([job!.type, job!.status, job!.asset_id]).toEqual(["speech", "succeeded", null]);

      const sse = await speak({ model: "gpt-4o-mini-tts", input: "hi", stream_format: "sse" });
      expect(((await sse!.json()) as { error: { code: string } }).error.code).toBe(
        "unsupported_parameter",
      );
      const extra = await speak({ model: "gpt-4o-mini-tts", input: "hi", seed: 3 });
      expect(((await extra!.json()) as { error: { param: string } }).error.param).toBe("seed");
      const legacy = await speak({ model: "tts-1", input: "hi", voice: "marin" });
      expect(legacy!.status).toBe(400);
      expect(calls.filter((c) => c.path.endsWith("/speech"))).toHaveLength(1);
    });
  });
});
