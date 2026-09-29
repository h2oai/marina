// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * MediaManager end to end against an in-memory store and a mocked network:
 * image jobs (moderation, success, provider failure, unsupported provider),
 * video jobs (immediate success, start failure, polled progress → success,
 * polled failure / cancel / missing key), plus the asset store/publish helpers
 * and the OpenAI and Runway providers they drive. No real network or DNS.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MediaManager } from "../src/engine/media/manager";
import { generateOpenAIImage, moderateOpenAIText } from "../src/engine/media/providers/openai";
import { pollRunwayVideoJob, startRunwayVideoJob } from "../src/engine/media/providers/runway";
import { publishGeneratedAsset, storeGeneratedAsset } from "../src/engine/media/publish";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import type { EngineEvent, EntityId } from "../src/types";

const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const ENV_KEYS = ["MARINA_DAILY_SPEND_CAP_USD", "MAX_IMAGE_JOBS_PER_DAY", "MAX_VIDEO_JOBS_PER_DAY"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetSpendLedgerForTests();
  __setDnsResolverForTest(async () => ["93.184.216.34"]);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  __setDnsResolverForTest(null);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSpendLedgerForTests();
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof fetch;
  return urls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

/** Capture setInterval callbacks so a poll tick can be driven by hand. */
function captureIntervals(): Array<() => Promise<void>> {
  const ticks: Array<() => Promise<void>> = [];
  globalThis.setInterval = ((fn: () => Promise<void>) => {
    ticks.push(fn);
    return ticks.length as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  return ticks;
}

interface Job {
  id: string;
  status: string;
  error?: string | null;
  assetId?: string | null;
  providerJobId?: string | null;
  costEstimate?: number | null;
  metadata?: unknown;
}

function fakeWorld(opts: { jobsToday?: number; noStorage?: boolean; noCanvas?: boolean } = {}) {
  const jobs = new Map<string, Job>();
  const assets = new Map<string, Record<string, unknown>>();
  const nodes: Array<Record<string, unknown>> = [];
  const canvases = new Map<string, { id: string }>([["c_given", { id: "c_given" }]]);
  const stored = new Map<string, Uint8Array>();
  const events: EngineEvent[] = [];
  const db = {
    countMediaJobsSince: () => opts.jobsToday ?? 0,
    createMediaJob: (row: Record<string, unknown>) =>
      jobs.set(String(row.id), { ...(row as unknown as Job), status: "pending" }),
    updateMediaJob: (id: string, patch: Partial<Job>) => {
      const job = jobs.get(id);
      if (job) jobs.set(id, { ...job, ...patch });
    },
    getMediaJob: (id: string) => jobs.get(id),
    getCanvas: (id: string) => canvases.get(id),
    ensureEntityCanvas: (entityId: string) => {
      const id = `c_${entityId}`;
      if (!canvases.has(id)) canvases.set(id, { id });
      return canvases.get(id)!;
    },
    createAsset: (row: Record<string, unknown>) =>
      assets.set(String(row.id), {
        ...row,
        mime_type: row.mimeType,
        storage_key: row.storageKey,
      }),
    getAsset: (id: string) => assets.get(id),
    getNodesByCanvas: () => nodes.map((n) => ({ y: n.y as number, height: 100 })),
    createNode: (row: Record<string, unknown>) => nodes.push(row),
  };
  const storage = {
    put: async (key: string, data: Uint8Array) => {
      stored.set(key, data);
    },
    resolve: (key: string) => `/assets/${key}`,
  };
  const engine = {
    db: opts.noCanvas ? undefined : db,
    storage: opts.noStorage ? undefined : storage,
    logEvent: (e: EngineEvent) => events.push(e),
  };
  return { db, engine, storage, jobs, assets, nodes, stored, events, canvases };
}

function makeManager(world: ReturnType<typeof fakeWorld>, keys: Record<string, string>) {
  return new MediaManager({
    engine: world.engine as never,
    db: world.db as never,
    storage: world.storage as never,
    resolveApiKey: (provider) => keys[provider],
    logEvent: (e) => world.events.push(e),
  });
}

const who = { entityId: "e_1" as EntityId, entityName: "Painter" };
const kinds = (events: EngineEvent[]) =>
  events.filter((e) => e.type === "feed_event").map((e) => (e as { kind: string }).kind);

describe("MediaManager image jobs", () => {
  it("moderates, generates, stores, publishes on the entity canvas and records spend", async () => {
    const urls = mockFetch((url) =>
      url.includes("moderations")
        ? json({ results: [{ flagged: false }] })
        : json({ data: [{ b64_json: PNG_B64 }] }),
    );
    const world = fakeWorld();
    const job = await makeManager(world, { openai: "sk" }).startJob({
      type: "image",
      ...who,
      prompt: "a lighthouse",
      model: "openai/gpt-image-2",
      width: 1024,
      height: 1024,
      style: "vivid",
    });
    expect(job.status).toBe("succeeded");
    expect(urls.some((u) => u.includes("moderations"))).toBe(true);
    expect(world.assets.size).toBe(1);
    expect(world.stored.size).toBe(1);
    expect(world.nodes).toHaveLength(1);
    expect(world.nodes[0]?.canvasId).toBe("c_e_1");
    expect(kinds(world.events)).toEqual(["media_pending", "image_generated", "media_complete"]);
    expect(world.events.some((e) => e.type === "canvas_publish")).toBe(true);
    expect(spentTodayUsd()).toBeCloseTo(0.042, 3);
  });

  it("publishes to a named canvas when it exists", async () => {
    mockFetch(() => json({ data: [{ b64_json: PNG_B64 }] }));
    const world = fakeWorld();
    // No openai key → moderation skipped; stability needs its own key.
    const m = makeManager(world, { openai: "", google: "g" });
    mockFetch(() =>
      json({ predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: "image/png" }] }),
    );
    const job = await m.startJob({
      type: "image",
      ...who,
      prompt: "p",
      model: "google/imagen-4",
      canvasId: "c_given",
    });
    expect(job.status).toBe("succeeded");
    expect(world.nodes[0]?.canvasId).toBe("c_given");
  });

  it("a moderation flag blocks the job without calling the image API", async () => {
    const urls = mockFetch(() =>
      json({ results: [{ flagged: true, categories: { violence: true, spam: false } }] }),
    );
    const world = fakeWorld();
    const job = await makeManager(world, { openai: "sk" }).startJob({
      type: "image",
      ...who,
      prompt: "bad",
      model: "openai/gpt-image-2",
    });
    expect(job.status).toBe("blocked");
    expect(job.error).toBe("Flagged categories: violence");
    expect(urls).toHaveLength(1);
    expect(kinds(world.events)).toContain("media_blocked");
  });

  it("a provider failure marks the job failed without throwing", async () => {
    mockFetch((url) =>
      url.includes("moderations")
        ? new Response("down", { status: 503 })
        : new Response("nope", { status: 500 }),
    );
    const world = fakeWorld();
    const job = await makeManager(world, { openai: "sk" }).startJob({
      type: "image",
      ...who,
      prompt: "p",
      model: "openai/dall-e-3",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("500");
    expect(kinds(world.events)).toContain("media_failed");
    expect(spentTodayUsd()).toBe(0);
  });

  it("an unsupported provider fails the job and rethrows", async () => {
    const world = fakeWorld();
    await expect(
      makeManager(world, {}).startJob({ type: "image", ...who, prompt: "p", model: "nobody/x" }),
    ).rejects.toThrow(/not yet supported for image generation/);
    const [job] = [...world.jobs.values()];
    expect(job?.status).toBe("failed");
    expect(kinds(world.events)).toEqual(["media_pending", "media_failed"]);
  });

  it("refuses a cloud provider with no key before creating a job", async () => {
    const world = fakeWorld();
    await expect(
      makeManager(world, {}).startJob({ type: "image", ...who, prompt: "p", model: "openai/x" }),
    ).rejects.toThrow(/No API key configured for provider "openai"/);
    expect(world.jobs.size).toBe(0);
  });

  it("MAX_IMAGE_JOBS_PER_DAY=0 lifts the cap", async () => {
    process.env.MAX_IMAGE_JOBS_PER_DAY = "0";
    mockFetch(() => new Response("x", { status: 500 }));
    const world = fakeWorld({ jobsToday: 10_000 });
    const job = await makeManager(world, { stability: "k" }).startJob({
      type: "image",
      ...who,
      prompt: "p",
      model: "stability/core",
    });
    expect(job.status).toBe("failed");
  });

  it("estimates cost per provider (recorded on the job row)", async () => {
    mockFetch(() => new Response("x", { status: 500 }));
    const world = fakeWorld();
    const m = makeManager(world, {
      stability: "k",
      google: "k",
      flux: "k",
      runway: "k",
      luma: "k",
    });
    const cases: Array<[Parameters<MediaManager["startJob"]>[0], number]> = [
      [{ type: "image", ...who, prompt: "p", model: "stability/core" }, 0.04],
      [{ type: "image", ...who, prompt: "p", model: "flux/flux-pro" }, 0.05],
      [{ type: "video", ...who, prompt: "p", model: "runway/gen4", duration: 10 }, 0.15],
      [{ type: "video", ...who, prompt: "p", model: "luma/ray-2", duration: 5 }, 1.75],
      [{ type: "video", ...who, prompt: "p", model: "google/veo-3", duration: 5 }, 2],
      [{ type: "image", ...who, prompt: "p", model: "flux/x", costHint: 0.5 }, 0.5],
    ];
    for (const [params, expected] of cases) {
      await m.startJob(params).catch(() => undefined);
      const rows = [...world.jobs.values()];
      expect(rows.at(-1)?.costEstimate).toBeCloseTo(expected, 3);
    }
  });
});

describe("MediaManager video jobs", () => {
  it("requires a key for any video provider and rejects unknown providers", async () => {
    const world = fakeWorld();
    await expect(
      makeManager(world, {}).startJob({ type: "video", ...who, prompt: "p", model: "runway/g" }),
    ).rejects.toThrow(/No API key/);
    await expect(
      makeManager(world, { nobody: "k" }).startJob({
        type: "video",
        ...who,
        prompt: "p",
        model: "nobody/v",
      }),
    ).rejects.toThrow(/not yet supported for video generation/);
  });

  it("a start that succeeds immediately completes the job", async () => {
    mockFetch((url) =>
      url.includes("generations")
        ? json({
            id: "rw1",
            status: "SUCCEEDED",
            outputs: [{ id: "o", url: "https://cdn.example/v.mp4" }],
          })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
    );
    const world = fakeWorld();
    const job = await makeManager(world, { runway: "k" }).startJob({
      type: "video",
      ...who,
      prompt: "waves",
      model: "runway/gen4",
      aspectRatio: "16:9",
    });
    expect(job.status).toBe("succeeded");
    expect(world.nodes[0]?.type).toBe("video");
    expect(kinds(world.events)).toEqual(["media_pending", "video_generated", "media_complete"]);
  });

  it("a failed start marks the job failed", async () => {
    mockFetch(() => json({ error: { message: "quota" } }, 402));
    const world = fakeWorld();
    const job = await makeManager(world, { runway: "k" }).startJob({
      type: "video",
      ...who,
      prompt: "p",
      model: "runway/gen4",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toBe("quota");
  });

  it("polls a running job: progress, then success", async () => {
    const ticks = captureIntervals();
    let poll = 0;
    mockFetch((url) => {
      if (url.endsWith("/generations")) return json({ id: "rw2", status: "QUEUED" });
      if (url.includes("/generations/rw2")) {
        poll += 1;
        return poll === 1
          ? json({ id: "rw2", status: "RUNNING", progress: 0.5 })
          : json({
              id: "rw2",
              status: "SUCCEEDED",
              outputs: [
                {
                  id: "o",
                  url: "https://cdn.example/f.mp4",
                  mime_type: "video/mp4",
                  file_name: "f.mp4",
                },
              ],
            });
      }
      return new Response(new Uint8Array([9, 9]));
    });
    const world = fakeWorld();
    const m = makeManager(world, { runway: "k" });
    const job = await m.startJob({ type: "video", ...who, prompt: "p", model: "runway/gen4" });
    expect(job.status).toBe("running");
    expect(world.jobs.get(job.id)?.providerJobId).toBe("rw2");
    expect(ticks).toHaveLength(1);
    await ticks[0]!();
    expect(world.events.some((e) => (e as { summary?: string }).summary?.includes("(50%)"))).toBe(
      true,
    );
    await ticks[0]!();
    expect(m.getJob(job.id)?.status).toBe("succeeded");
    expect(world.assets.get(String(world.jobs.get(job.id)?.assetId))?.filename).toBe("f.mp4");
    m.stop();
  });

  it("a polled failure, a cancel and a lost key each fail the job", async () => {
    for (const [status, keyLost, expected] of [
      ["FAILED", false, "boom"],
      ["CANCELED", false, "Runway job was canceled."],
      ["RUNNING", true, "Missing provider key during polling."],
    ] as const) {
      const ticks = captureIntervals();
      mockFetch((url) =>
        url.endsWith("/generations")
          ? json({ id: "rw3", status: "RUNNING" })
          : json({ id: "rw3", status, error: { message: "boom" } }),
      );
      const world = fakeWorld();
      const keys: Record<string, string> = { runway: "k" };
      const m = makeManager(world, keys);
      const job = await m.startJob({ type: "video", ...who, prompt: "p", model: "runway/gen4" });
      if (keyLost) delete keys.runway;
      await ticks[0]!();
      expect(m.getJob(job.id)?.status).toBe("failed");
      expect(m.getJob(job.id)?.error).toBe(expected);
    }
  });

  it("a running start with no provider job id stays running without a poll", async () => {
    const ticks = captureIntervals();
    mockFetch(() => json({ status: "RUNNING" }));
    const world = fakeWorld();
    const job = await makeManager(world, { runway: "k" }).startJob({
      type: "video",
      ...who,
      prompt: "p",
      model: "runway/gen4",
    });
    expect(job.status).toBe("running");
    expect(ticks).toHaveLength(0);
  });
});

describe("storeGeneratedAsset / publishGeneratedAsset", () => {
  it("refuses without a database or storage", async () => {
    const base = {
      entityName: "P",
      mimeType: "image/png",
      data: new Uint8Array(1),
      prompt: "p",
      model: "m",
    };
    await expect(
      storeGeneratedAsset({ ...base, engine: fakeWorld({ noCanvas: true }).engine as never }),
    ).rejects.toThrow(/Database not configured/);
    await expect(
      storeGeneratedAsset({ ...base, engine: fakeWorld({ noStorage: true }).engine as never }),
    ).rejects.toThrow(/Storage not configured/);
    expect(() =>
      publishGeneratedAsset({
        engine: fakeWorld({ noCanvas: true }).engine as never,
        entityId: "e_1" as EntityId,
        entityName: "P",
        assetId: "a",
        nodeType: "image",
        prompt: "p",
        model: "m",
      }),
    ).toThrow(/Database not configured/);
  });

  it("infers a filename/extension from the MIME type and stacks nodes below existing ones", async () => {
    const world = fakeWorld();
    const engine = world.engine as never;
    const common = { engine, entityName: "P", data: new Uint8Array(2), prompt: "p", model: "m" };
    const img = await storeGeneratedAsset({ ...common, mimeType: "image/png", id: "a1" });
    expect(img).toEqual({ id: "a1", filename: "a1.png", storageKey: "a1.png" });
    const vid = await storeGeneratedAsset({
      ...common,
      mimeType: "video/webm",
      id: "a2",
      filename: "  ",
    });
    expect(vid.filename).toBe("a2.mp4");
    const other = await storeGeneratedAsset({
      ...common,
      mimeType: "application/x",
      id: "a3",
      filename: "x.gif",
    });
    expect(other.storageKey).toBe("a3.gif");

    const pub = { engine, entityId: "e_1" as EntityId, entityName: "P", prompt: "p", model: "m" };
    const first = publishGeneratedAsset({
      ...pub,
      assetId: "a1",
      nodeType: "image",
      canvasId: "missing",
    });
    expect(first.canvasId).toBe("c_e_1");
    publishGeneratedAsset({ ...pub, assetId: "a2", nodeType: "video" });
    expect(world.nodes.map((n) => n.y)).toEqual([20, 140]);
    expect(world.nodes[0]?.data).toMatchObject({ url: "/assets/a1.png", author: "P" });
    expect(() => publishGeneratedAsset({ ...pub, assetId: "nope", nodeType: "image" })).toThrow(
      /not found/,
    );
    const feed = world.events.filter((e) => e.type === "feed_event") as Array<{ kind: string }>;
    expect(feed.map((e) => e.kind)).toEqual(["image_generated", "video_generated"]);
  });
});

describe("OpenAI image provider", () => {
  it("clamps size, sends the bare model and decodes b64", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return json({ data: [{ b64_json: PNG_B64 }] });
    });
    const res = await generateOpenAIImage({
      apiKey: "k",
      prompt: "p",
      model: "openai/gpt-image-2",
      width: 5000,
      height: 10,
    });
    expect(res.status).toBe("succeeded");
    expect(res.asset?.mimeType).toBe("image/png");
    expect(body).toMatchObject({
      model: "gpt-image-2",
      size: "2048x256",
      response_format: "b64_json",
    });
  });

  it("reports missing data, HTTP errors and thrown errors", async () => {
    mockFetch(() => json({ data: [] }));
    expect((await generateOpenAIImage({ apiKey: "k", prompt: "p", model: "m" })).error).toBe(
      "No image data returned.",
    );
    mockFetch(() => new Response("bad key", { status: 401 }));
    expect((await generateOpenAIImage({ apiKey: "k", prompt: "p", model: "m" })).error).toContain(
      "401 bad key",
    );
    mockFetch(() => {
      throw new Error("offline");
    });
    expect((await generateOpenAIImage({ apiKey: "k", prompt: "p", model: "m" })).error).toBe(
      "offline",
    );
  });

  it("moderation: clean, flagged without categories, HTTP error and thrown error", async () => {
    mockFetch(() => json({ results: [{ flagged: false }] }));
    expect(await moderateOpenAIText({ apiKey: "k", prompt: "p" })).toEqual({ blocked: false });
    mockFetch(() => json({ results: [{ flagged: true }] }));
    expect(await moderateOpenAIText({ apiKey: "k", prompt: "p" })).toEqual({
      blocked: true,
      reason: undefined,
    });
    mockFetch(() => new Response("x", { status: 500 }));
    expect(await moderateOpenAIText({ apiKey: "k", prompt: "p" })).toBeNull();
    mockFetch(() => {
      throw new Error("offline");
    });
    expect(await moderateOpenAIText({ apiKey: "k", prompt: "p" })).toBeNull();
  });
});

describe("Runway video provider", () => {
  it("start: running, success without an asset, and thrown errors", async () => {
    mockFetch(() => json({ id: "r", status: "RUNNING", progress: 0.1 }));
    expect(await startRunwayVideoJob({ apiKey: "k", model: "gen4", prompt: "p" })).toEqual({
      status: "running",
      providerJobId: "r",
      progress: 0.1,
    });
    mockFetch(() => json({ id: "r", status: "SUCCEEDED", outputs: [{ id: "o" }] }));
    expect((await startRunwayVideoJob({ apiKey: "k", model: "gen4", prompt: "p" })).error).toBe(
      "Runway returned success without asset.",
    );
    mockFetch(() => json({}, 500));
    expect((await startRunwayVideoJob({ apiKey: "k", model: "gen4", prompt: "p" })).error).toBe(
      "Runway start failed (500)",
    );
    mockFetch(() => {
      throw new Error("offline");
    });
    expect((await startRunwayVideoJob({ apiKey: "k", model: "gen4", prompt: "p" })).error).toBe(
      "offline",
    );
  });

  it("poll: queued, failed default message, HTTP error, asset fetch failure, thrown", async () => {
    mockFetch(() => json({ id: "r", status: "QUEUED" }));
    expect(await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).toEqual({
      status: "running",
      progress: 0,
    });
    mockFetch(() => json({ id: "r", status: "FAILED" }));
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).error).toBe(
      "Runway reported failure.",
    );
    mockFetch(() => json({ error: { message: "gone" } }, 404));
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).error).toBe("gone");
    mockFetch((url) =>
      url.includes("/generations/")
        ? json({
            id: "r",
            status: "SUCCEEDED",
            outputs: [{ id: "o", url: "https://cdn.example/x" }],
          })
        : new Response("no", { status: 404 }),
    );
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).error).toBe(
      "Runway returned success without asset.",
    );
    mockFetch(() => {
      throw new Error("offline");
    });
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).error).toBe("offline");
  });
});
