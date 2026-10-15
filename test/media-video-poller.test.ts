// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable video jobs: a started job is polled from the database by the
 * `media-video-poll` tick job — the only polling path — so a restart resumes
 * it, a job past MARINA_VIDEO_JOB_TIMEOUT_MIN fails with a reason, transient
 * provider errors keep it running, and its spend is recorded exactly once even
 * when two passes observe the same finished task. Real in-memory MarinaDB,
 * mocked Runway HTTP; no real network or DNS.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Logger } from "../src/engine/logger";
import {
  DEFAULT_VIDEO_JOB_TIMEOUT_MIN,
  MediaManager,
  videoJobTimeoutMs,
} from "../src/engine/media/manager";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import {
  MEDIA_VIDEO_POLL_MS,
  mediaVideoPollPhase,
  mediaVideoPollTicks,
  registerTickJobs,
  type TickJobHost,
} from "../src/engine/tick-jobs";
import { TickScheduler } from "../src/engine/tick-scheduler";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent, EntityId } from "../src/types";

const realFetch = globalThis.fetch;
const ENV_KEYS = [
  "MARINA_DAILY_SPEND_CAP_USD",
  "MAX_VIDEO_JOBS_PER_DAY",
  "MARINA_VIDEO_JOB_TIMEOUT_MIN",
];
let saved: Record<string, string | undefined>;
let db: MarinaDB;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetSpendLedgerForTests();
  __setDnsResolverForTest(async () => ["93.184.216.34"]);
  db = new MarinaDB(":memory:");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __setDnsResolverForTest(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSpendLedgerForTests();
  db.close();
});

const TASK = "11111111-1111-4111-8111-111111111111";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler): Array<{ path: string; init?: RequestInit }> {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ path: new URL(url).pathname, init });
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One "process": a manager over the shared DB with its own engine shell and storage. */
function process_(events: EngineEvent[] = []) {
  const blobs = new Map<string, { data: Uint8Array; mime: string }>();
  const storage = {
    put: async (key: string, data: Uint8Array, mime: string) => {
      blobs.set(key, { data, mime });
    },
    get: async (key: string) => blobs.get(key) ?? null,
    resolve: (key: string) => `/assets/${key}`,
  };
  const engine = {
    db,
    storage,
    entities: { get: () => undefined },
    logEvent: (e: EngineEvent) => events.push(e),
  };
  const manager = new MediaManager({
    engine: engine as never,
    db,
    storage: storage as never,
    resolveApiKey: (provider) => (provider === "runway" ? "key_test" : undefined),
    logEvent: (e) => events.push(e),
  });
  return { manager, events, blobs, engine };
}

const who = { entityId: "e_1" as EntityId, entityName: "Director" };

async function startRunwayJob(manager: MediaManager): Promise<string> {
  mockFetch(() => json({ id: TASK, estimatedCost: { credits: 60 } }));
  const job = await manager.startJob({
    type: "video",
    ...who,
    prompt: "a slow dolly over misty mountains",
    model: "runway/gen4.5",
    duration: 5,
  });
  expect(job.status).toBe("running");
  expect(job.provider_job_id).toBe(TASK);
  return job.id;
}

function succeededTask(credits = 60): Handler {
  return (url) =>
    url.includes("/v1/tasks/")
      ? json({
          id: TASK,
          status: "SUCCEEDED",
          createdAt: "2026-10-15T00:00:00.000Z",
          output: ["https://dnznrvs05pmza.cloudfront.net/out.mp4"],
          cost: { credits },
        })
      : new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "content-type": "video/mp4" } });
}

describe("durable video polling", () => {
  it("a restarted process resumes a running job from the database and completes it", async () => {
    const first = process_();
    const jobId = await startRunwayJob(first.manager);
    first.manager.stop(); // the first process goes away; the row stays `running`

    const events: EngineEvent[] = [];
    const second = process_(events);
    const calls = mockFetch((url) =>
      url.includes("/v1/tasks/")
        ? json({ id: TASK, status: "RUNNING", progress: 0.5, createdAt: "x" })
        : new Response("unexpected", { status: 500 }),
    );
    expect(await second.manager.pollRunningVideoJobs()).toEqual({
      polled: 1,
      succeeded: 0,
      failed: 0,
      timedOut: 0,
    });
    expect(calls.map((c) => c.path)).toEqual([`/v1/tasks/${TASK}`]);
    expect(new Headers(calls[0]?.init?.headers).get("x-runway-version")).toBe("2024-11-06");
    expect(JSON.parse(db.getMediaJob(jobId)!.metadata!).progress).toBe(0.5);
    expect(events.some((e) => (e as { summary?: string }).summary?.includes("(50%)"))).toBe(true);

    mockFetch(succeededTask());
    expect((await second.manager.pollRunningVideoJobs()).succeeded).toBe(1);
    const done = db.getMediaJob(jobId)!;
    expect(done.status).toBe("succeeded");
    expect(done.asset_id).toBeTruthy();
    expect(db.getAsset(done.asset_id!)?.mime_type).toBe("video/mp4");
    // Runway's reported charge (60 credits at $0.01) is what is recorded.
    expect(spentTodayUsd()).toBeCloseTo(0.6, 4);
    expect(db.listMediaJobsByStatus({ status: "running", type: "video" })).toHaveLength(0);

    // Nothing left to poll: no request, no second charge.
    const after = mockFetch(succeededTask());
    expect((await second.manager.pollRunningVideoJobs()).polled).toBe(0);
    expect(after).toHaveLength(0);
    expect(spentTodayUsd()).toBeCloseTo(0.6, 4);
  });

  it("records spend once when two passes observe the same finished task", async () => {
    const a = process_();
    const b = process_();
    const jobId = await startRunwayJob(a.manager);
    mockFetch(succeededTask());
    const [pa, pb] = await Promise.all([
      a.manager.pollRunningVideoJobs(),
      b.manager.pollRunningVideoJobs(),
    ]);
    expect(pa.succeeded + pb.succeeded).toBe(1);
    expect(spentTodayUsd()).toBeCloseTo(0.6, 4);
    expect(db.getMediaJob(jobId)?.status).toBe("succeeded");
    const canvas = db.ensureEntityCanvas(who.entityId, who.entityName, who.entityName);
    expect(db.getNodesByCanvas(canvas.id).filter((n) => n.type === "video")).toHaveLength(1);
  });

  it("falls back to the job's estimate when the provider reports no cost", async () => {
    const p = process_();
    const jobId = await startRunwayJob(p.manager);
    expect(db.getMediaJob(jobId)?.cost_estimate).toBeCloseTo(0.6, 4); // gen4.5: 12 credits/s × 5 s
    mockFetch((url) =>
      url.includes("/v1/tasks/")
        ? json({ id: TASK, status: "SUCCEEDED", output: ["https://cdn.example/v.mp4"] })
        : new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } }),
    );
    await p.manager.pollRunningVideoJobs();
    expect(spentTodayUsd()).toBeCloseTo(0.6, 4);
  });

  it("fails a job past its deadline with a reason, without polling the provider", async () => {
    process.env.MARINA_VIDEO_JOB_TIMEOUT_MIN = "10";
    const p = process_();
    const jobId = await startRunwayJob(p.manager);
    const calls = mockFetch(succeededTask());
    const pass = await p.manager.pollRunningVideoJobs(Date.now() + 11 * 60_000);
    expect(pass.timedOut).toBe(1);
    expect(calls).toHaveLength(0);
    const row = db.getMediaJob(jobId)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("timed out");
    expect(row.error).toContain("10 min");
    expect(row.error).toContain(TASK);
    expect(spentTodayUsd()).toBe(0);
    expect(p.events.some((e) => (e as { kind?: string }).kind === "media_failed")).toBe(true);
  });

  it("keeps a job running through transient errors, and fails it on a terminal one", async () => {
    const p = process_();
    const jobId = await startRunwayJob(p.manager);
    mockFetch(() => {
      throw new Error("ECONNRESET");
    });
    await p.manager.pollRunningVideoJobs();
    let row = db.getMediaJob(jobId)!;
    expect(row.status).toBe("running");
    expect(JSON.parse(row.metadata!).lastPollError).toBe("ECONNRESET");

    mockFetch(() => json({ id: TASK, status: "FAILED", failure: "Content moderated" }));
    await p.manager.pollRunningVideoJobs();
    row = db.getMediaJob(jobId)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Content moderated");
    expect(spentTodayUsd()).toBe(0);
  });

  it("a stopped manager starts no pass", async () => {
    const p = process_();
    await startRunwayJob(p.manager);
    p.manager.stop();
    const calls = mockFetch(succeededTask());
    expect((await p.manager.pollRunningVideoJobs()).polled).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("the timeout setting: positive minutes, else the default (never unbounded)", () => {
    expect(videoJobTimeoutMs({})).toBe(DEFAULT_VIDEO_JOB_TIMEOUT_MIN * 60_000);
    expect(videoJobTimeoutMs({ MARINA_VIDEO_JOB_TIMEOUT_MIN: "45" })).toBe(45 * 60_000);
    for (const junk of ["0", "-5", "soon", ""]) {
      expect(videoJobTimeoutMs({ MARINA_VIDEO_JOB_TIMEOUT_MIN: junk })).toBe(30 * 60_000);
    }
  });
});

describe("reference images", () => {
  it("a stored asset id is inlined as a data URI and sent to Runway's image_to_video", async () => {
    const p = process_();
    const key = "ref.png";
    await p.engine.storage.put(key, PNG, "image/png");
    db.createAsset({
      id: "asset_ref",
      entityName: who.entityName,
      filename: "ref.png",
      mimeType: "image/png",
      size: PNG.byteLength,
      storageKey: key,
      metadata: {},
    });
    const calls = mockFetch(() => json({ id: TASK, estimatedCost: { credits: 60 } }));
    const job = await p.manager.startJob({
      type: "video",
      ...who,
      prompt: "animate this",
      model: "runway/gen4.5",
      referenceImage: "asset_ref",
    });
    expect(job.status).toBe("running");
    expect(calls[0]?.path).toBe("/v1/image_to_video");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.promptImage).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    // The row keeps the reference as given, never the inlined bytes.
    expect(JSON.parse(db.getMediaJob(job.id)!.options).referenceImage).toBe("asset_ref");
  });

  it("an unknown asset fails the job before any provider call", async () => {
    const p = process_();
    const calls = mockFetch(() => json({ id: TASK }));
    await expect(
      p.manager.startJob({
        type: "video",
        ...who,
        prompt: "p",
        model: "runway/gen4.5",
        referenceImage: "asset_missing",
      }),
    ).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(0);
  });
});

describe("media-video-poll tick job", () => {
  it("is registered at ~5 s on a phase of its own and drives the manager's pass", async () => {
    expect(mediaVideoPollTicks(1000)).toBe(MEDIA_VIDEO_POLL_MS / 1000);
    expect(mediaVideoPollPhase(5)).toBe(4);
    expect(mediaVideoPollTicks(60_000)).toBe(2);
    expect(mediaVideoPollPhase(2)).toBe(1);

    let passes = 0;
    const scheduler = new TickScheduler(new Logger({ level: "error" }));
    const host = {
      logger: new Logger({ level: "error" }),
      config: { tickInterval: 1000 },
      mediaManager: {
        pollRunningVideoJobs: async () => {
          passes += 1;
          return { polled: 0, succeeded: 0, failed: 0, timedOut: 0 };
        },
      },
    } as unknown as TickJobHost;
    registerTickJobs(host, scheduler);
    const job = scheduler.describe().find((j) => j.name === "media-video-poll");
    expect(job).toMatchObject({ every: 5, phase: 4 });
    for (const tick of [4, 9, 10]) {
      scheduler.runDue(tick);
      await scheduler.drain();
    }
    expect(passes).toBe(2);
    // An in-flight pass is never overlapped by the next due tick.
    let release: () => void = () => {};
    (host.mediaManager as { pollRunningVideoJobs: () => Promise<unknown> }).pollRunningVideoJobs =
      () => {
        passes += 1;
        return new Promise<void>((r) => {
          release = r;
        });
      };
    scheduler.runDue(14);
    scheduler.runDue(19);
    release();
    await scheduler.drain();
    expect(passes).toBe(3);
  });
});
