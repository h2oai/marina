// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * MediaManager end to end against an in-memory store and a mocked network:
 * image jobs (moderation, success, provider failure, unsupported provider),
 * video job starts (left running for the durable poller — see
 * media-video-poller.test.ts — start failure, no task id), plus the asset
 * store/publish helpers and the OpenAI and Runway providers they drive
 * (request shapes per the providers' current APIs). No real network or DNS.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MediaManager } from "../src/engine/media/manager";
import {
  flexibleImageSize,
  generateOpenAIImage,
  moderateOpenAIText,
  openAIImageModelKind,
  openAIImageSize,
} from "../src/engine/media/providers/openai";
import {
  buildRunwayStartRequest,
  pollRunwayVideoJob,
  RUNWAY_API_VERSION,
  runwayCostEstimate,
  runwayModelId,
  startRunwayVideoJob,
} from "../src/engine/media/providers/runway";
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
    transitionMediaJob: (id: string, from: string, patch: Partial<Job>) => {
      const job = jobs.get(id);
      if (!job || job.status !== from) return false;
      jobs.set(id, { ...job, ...patch });
      return true;
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
      model: "openai/gpt-image-1.5",
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
      [{ type: "video", ...who, prompt: "p", model: "runway/gen4.5", duration: 10 }, 1.2],
      [{ type: "video", ...who, prompt: "p", model: "runway/gen4_turbo", duration: 5 }, 0.25],
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

  it("a started job is left running with its task id — no in-memory timer", async () => {
    const intervals: unknown[] = [];
    globalThis.setInterval = ((fn: unknown) => {
      intervals.push(fn);
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    mockFetch(() => json({ id: "rw2", estimatedCost: { credits: 60 } }));
    const world = fakeWorld();
    const job = await makeManager(world, { runway: "k" }).startJob({
      type: "video",
      ...who,
      prompt: "p",
      model: "runway/gen4.5",
    });
    expect(job.status).toBe("running");
    expect(world.jobs.get(job.id)?.providerJobId).toBe("rw2");
    expect(intervals).toHaveLength(0);
    expect(kinds(world.events)).toEqual(["media_pending", "media_rendering"]);
  });

  it("a failed start marks the job failed", async () => {
    mockFetch(() => json({ error: "quota" }, 402));
    const world = fakeWorld();
    const job = await makeManager(world, { runway: "k" }).startJob({
      type: "video",
      ...who,
      prompt: "p",
      model: "runway/gen4.5",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toBe("quota");
    expect(spentTodayUsd()).toBe(0);
  });

  it("a start with no task id fails instead of hanging in running", async () => {
    mockFetch(() => json({}));
    const world = fakeWorld();
    const job = await makeManager(world, { runway: "k" }).startJob({
      type: "video",
      ...who,
      prompt: "p",
      model: "runway/gen4.5",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toBe("Runway did not return a task id.");
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

  it("stores the provider-reported MIME only through the upload allowlist + magic bytes", async () => {
    const world = fakeWorld();
    const engine = world.engine as never;
    const common = { engine, entityName: "P", prompt: "p", model: "m" };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    await storeGeneratedAsset({ ...common, data: png, mimeType: "image/png", id: "g1" });
    await storeGeneratedAsset({ ...common, data: html, mimeType: "text/html", id: "g2" });
    await storeGeneratedAsset({ ...common, data: html, mimeType: "image/png", id: "g3" });
    await storeGeneratedAsset({ ...common, data: png, mimeType: "image/webp", id: "g4" });
    expect(world.assets.get("g1")?.mime_type).toBe("image/png");
    expect(world.assets.get("g2")?.mime_type).toBe("application/octet-stream");
    expect(world.assets.get("g3")?.mime_type).toBe("application/octet-stream");
    expect(world.assets.get("g4")?.mime_type).toBe("image/png");
  });
});

describe("OpenAI image provider", () => {
  it("gpt-image-2: sends only model/prompt/size, maps size into the flexible space, folds style into the prompt", async () => {
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
      style: "synthwave",
    });
    expect(res.status).toBe("succeeded");
    expect(res.asset?.mimeType).toBe("image/png");
    expect(Object.keys(body).sort()).toEqual(["model", "prompt", "size"]);
    expect(body).toMatchObject({ model: "gpt-image-2", prompt: "p\n\nStyle: synthwave" });
    // 3:1 is the widest aspect; the pixel floor is 655,360.
    expect(body.size).toBe("1440x480");
  });

  it("gpt-image-1.x snaps to its three fixed sizes; no dimensions means no size", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    mockFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ data: [{ b64_json: PNG_B64 }] });
    });
    await generateOpenAIImage({
      apiKey: "k",
      prompt: "p",
      model: "openai/gpt-image-1.5",
      width: 1920,
      height: 1080,
    });
    await generateOpenAIImage({ apiKey: "k", prompt: "p", model: "openai/gpt-image-1-mini" });
    expect(bodies[0]?.size).toBe("1536x1024");
    expect(bodies[1]).toEqual({ model: "gpt-image-1-mini", prompt: "p" });
    for (const b of bodies) {
      expect(b.response_format).toBeUndefined();
      expect(b.style).toBeUndefined();
    }
  });

  it("dall-e is refused locally as retired, with no request", async () => {
    const urls = mockFetch(() => json({}));
    const res = await generateOpenAIImage({ apiKey: "k", prompt: "p", model: "openai/dall-e-3" });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("retired");
    expect(urls).toHaveLength(0);
  });

  it("size mapping", () => {
    expect(openAIImageModelKind("gpt-image-2-2026-04-21")).toBe("flexible");
    expect(openAIImageModelKind("gpt-image-2.5-flare")).toBe("flexible");
    expect(openAIImageModelKind("gpt-image-1")).toBe("fixed");
    expect(openAIImageModelKind("chatgpt-image-latest")).toBe("fixed");
    expect(openAIImageSize("gpt-image-2", 1024, 1024)).toBe("1024x1024");
    expect(openAIImageSize("gpt-image-2", 1536, 1024)).toBe("1536x1024");
    expect(openAIImageSize("gpt-image-2", 1080, 1920)).toBe("1088x1920");
    expect(openAIImageSize("gpt-image-2", 256, 256)).toBe("816x816");
    expect(openAIImageSize("gpt-image-2", 8000, 8000)).toBe("2880x2880");
    expect(openAIImageSize("gpt-image-2", 512)).toBe("816x816");
    expect(openAIImageSize("gpt-image-1", 600, 1000)).toBe("1024x1536");
    for (const [w, h] of [
      [1, 9999],
      [3333, 1111],
      [4096, 2304],
      [700, 700],
      [17, 31],
    ] as const) {
      const [sw, sh] = flexibleImageSize(w, h).split("x").map(Number) as [number, number];
      expect(sw % 16).toBe(0);
      expect(sh % 16).toBe(0);
      expect(Math.max(sw, sh)).toBeLessThanOrEqual(3840);
      expect(Math.max(sw, sh) / Math.min(sw, sh)).toBeLessThanOrEqual(3);
      expect(sw * sh).toBeGreaterThanOrEqual(655_360);
      expect(sw * sh).toBeLessThanOrEqual(8_294_400);
    }
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
  it("text to video: POST /v1/text_to_video with the version header and a bare model", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    mockFetch((url, init) => {
      seen = { url, init };
      return json({ id: "11111111-1111-4111-8111-111111111111", estimatedCost: { credits: 60 } });
    });
    const res = await startRunwayVideoJob({
      apiKey: "key_x",
      model: "runway/gen4.5",
      prompt: "waves",
      duration: 12,
      fps: 30,
      aspectRatio: "9:16",
    });
    expect(res).toEqual({
      status: "running",
      providerJobId: "11111111-1111-4111-8111-111111111111",
      progress: 0,
    });
    const headers = new Headers(seen?.init?.headers);
    expect(seen?.init?.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/v1/text_to_video");
    expect(headers.get("host")).toBe("api.dev.runwayml.com");
    expect(headers.get("x-runway-version")).toBe(RUNWAY_API_VERSION);
    expect(headers.get("authorization")).toBe("Bearer key_x");
    // Duration clamps to gen4.5's 2–10 s; no fps parameter exists.
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      model: "gen4.5",
      promptText: "waves",
      ratio: "720:1280",
      duration: 10,
    });
  });

  it("image to video: a reference goes to /v1/image_to_video as promptImage", async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    mockFetch((url, init) => {
      bodies.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) });
      return json({ id: "t", estimatedCost: { credits: 25 } });
    });
    const dataUri = `data:image/png;base64,${PNG_B64}`;
    await startRunwayVideoJob({
      apiKey: "k",
      model: "runway/gen4_turbo",
      prompt: "pan",
      referenceImage: dataUri,
      aspectRatio: "1:1",
    });
    expect(bodies[0]).toEqual({
      path: "/v1/image_to_video",
      body: {
        model: "gen4_turbo",
        promptText: "pan",
        ratio: "960:960",
        duration: 5,
        promptImage: dataUri,
      },
    });
  });

  it("refuses requests the API cannot take, without a request", async () => {
    const urls = mockFetch(() => json({}));
    expect(
      (await startRunwayVideoJob({ apiKey: "k", model: "runway/gen4_turbo", prompt: "p" })).error,
    ).toContain("image-to-video only");
    expect(
      (
        await startRunwayVideoJob({
          apiKey: "k",
          model: "runway/gen4.5",
          prompt: "p",
          referenceImage: "asset-123",
        })
      ).error,
    ).toContain("https URL or an image data URI");
    expect(urls).toHaveLength(0);
    expect(buildRunwayStartRequest({ apiKey: "k", model: "runway", prompt: "p" })).toEqual({
      path: "/text_to_video",
      body: { model: "gen4.5", promptText: "p", ratio: "1280:720", duration: 5 },
    });
    expect(runwayModelId("runway/veo3.1")).toBe("veo3.1");
    expect(runwayCostEstimate("runway/gen4.5", undefined)).toBeCloseTo(0.6, 3);
  });

  it("start errors: Runway's error string, issues, and thrown errors", async () => {
    mockFetch(() => json({ error: "Invalid input", issues: [{ path: ["ratio"] }] }, 400));
    expect(
      (await startRunwayVideoJob({ apiKey: "k", model: "gen4.5", prompt: "p" })).error,
    ).toContain("Invalid input");
    mockFetch(() => new Response("oops", { status: 500 }));
    expect((await startRunwayVideoJob({ apiKey: "k", model: "gen4.5", prompt: "p" })).error).toBe(
      "Runway start failed (500)",
    );
    mockFetch(() => {
      throw new Error("offline");
    });
    expect((await startRunwayVideoJob({ apiKey: "k", model: "gen4.5", prompt: "p" })).error).toBe(
      "offline",
    );
  });

  it("poll: GET /v1/tasks/{id}; pending/throttled/running stay running", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    mockFetch((url, init) => {
      seen = { url, init };
      return json({ id: "t1", status: "THROTTLED", createdAt: "x", estimatedCost: { credits: 1 } });
    });
    expect(await pollRunwayVideoJob({ apiKey: "k", providerJobId: "t1" })).toEqual({
      status: "running",
      progress: 0,
    });
    expect(new URL(seen!.url).pathname).toBe("/v1/tasks/t1");
    expect(new Headers(seen?.init?.headers).get("x-runway-version")).toBe(RUNWAY_API_VERSION);
    mockFetch(() => json({ id: "t1", status: "RUNNING", progress: 0.4 }));
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "t1" })).progress).toBe(0.4);
  });

  it("poll: success downloads output[0] and reports the credit cost in USD", async () => {
    mockFetch((url) =>
      url.includes("/tasks/")
        ? json({
            id: "t1",
            status: "SUCCEEDED",
            output: ["https://dnznrvs05pmza.cloudfront.net/v.mp4?sig=1"],
            cost: { credits: 60 },
          })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
    );
    const res = await pollRunwayVideoJob({ apiKey: "k", providerJobId: "t1" });
    expect(res.status).toBe("succeeded");
    expect(res.costUsd).toBeCloseTo(0.6, 4);
    expect(res.asset?.data.byteLength).toBe(3);
  });

  it("poll: terminal failures fail; transient ones stay running and retryable", async () => {
    mockFetch(() => json({ id: "r", status: "FAILED", failure: "bad", failureCode: "SAFETY" }));
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).error).toBe(
      "bad (SAFETY)",
    );
    mockFetch(() => json({ id: "r", status: "CANCELLED", cost: { credits: 0 } }));
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).error).toBe(
      "Runway task was cancelled.",
    );
    mockFetch(() => json({ error: "not found" }, 404));
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).status).toBe("failed");
    mockFetch(() => json({ error: "slow down" }, 429));
    expect(await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).toEqual({
      status: "running",
      retryable: true,
      error: "slow down",
    });
    mockFetch((url) =>
      url.includes("/tasks/")
        ? json({ id: "r", status: "SUCCEEDED", output: ["https://cdn.example/x"] })
        : new Response("no", { status: 403 }),
    );
    expect((await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).retryable).toBe(true);
    mockFetch(() => {
      throw new Error("offline");
    });
    expect(await pollRunwayVideoJob({ apiKey: "k", providerJobId: "r" })).toEqual({
      status: "running",
      retryable: true,
      error: "offline",
    });
  });
});
