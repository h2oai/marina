// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { pollVeoVideoJob, startVeoVideoJob } from "../src/engine/media/providers/veo";
import {
  getVideoProvider,
  knownVideoProviders,
} from "../src/engine/media/providers/video-registry";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response): {
  calls: () => number;
} {
  let count = 0;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    count += 1;
    return Promise.resolve(handler(String(url), init));
  }) as unknown as typeof fetch;
  return { calls: () => count };
}

describe("video-registry", () => {
  it("resolves runway + google (Veo) + luma, nothing else", () => {
    expect(knownVideoProviders().sort()).toEqual(["google", "luma", "runway"]);
    expect(typeof getVideoProvider("runway")?.start).toBe("function");
    expect(typeof getVideoProvider("google")?.poll).toBe("function");
    expect(typeof getVideoProvider("luma")?.start).toBe("function");
    expect(getVideoProvider("pika")).toBeUndefined();
  });
});

describe("Veo start", () => {
  it("submits predictLongRunning with the bare model and returns the operation id", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return Response.json({ name: "models/veo-3.0/operations/abc123" });
    });
    const res = await startVeoVideoJob({
      apiKey: "AIza",
      model: "google/veo-3.0-generate-preview",
      prompt: "a drone shot",
      aspectRatio: "9:16",
    });
    expect(capturedUrl).toContain("/models/veo-3.0-generate-preview:predictLongRunning");
    expect(res.status).toBe("running");
    expect(res.providerJobId).toBe("models/veo-3.0/operations/abc123");
  });

  it("surfaces a start error", async () => {
    mockFetch(() => Response.json({ error: { message: "quota" } }, { status: 429 }));
    const res = await startVeoVideoJob({ apiKey: "k", model: "google/veo-3", prompt: "x" });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("quota");
  });
});

describe("Veo poll", () => {
  it("reports running until the operation is done", async () => {
    mockFetch(() => Response.json({ done: false }));
    const res = await pollVeoVideoJob({ apiKey: "k", providerJobId: "models/x/operations/1" });
    expect(res.status).toBe("running");
  });

  it("downloads the video via its uri when done", async () => {
    const cap = mockFetch((url) => {
      if (url.includes("/operations/")) {
        return Response.json({
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: "https://files.example/v/abc" } }],
            },
          },
        });
      }
      // download
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    });
    const res = await pollVeoVideoJob({ apiKey: "k", providerJobId: "models/x/operations/1" });
    expect(cap.calls()).toBe(2); // poll + download
    expect(res.status).toBe("succeeded");
    expect(res.asset?.mimeType).toBe("video/mp4");
    expect(res.asset?.data.byteLength).toBe(3);
  });

  it("decodes inline base64 video bytes when present", async () => {
    mockFetch(() =>
      Response.json({
        done: true,
        response: {
          generatedVideos: [{ bytesBase64Encoded: Buffer.from("mp4").toString("base64") }],
        },
      }),
    );
    const res = await pollVeoVideoJob({ apiKey: "k", providerJobId: "models/x/operations/1" });
    expect(res.status).toBe("succeeded");
    expect(Buffer.from(res.asset!.data).toString()).toBe("mp4");
  });

  it("fails when done but no video is present", async () => {
    mockFetch(() => Response.json({ done: true, response: {} }));
    const res = await pollVeoVideoJob({ apiKey: "k", providerJobId: "models/x/operations/1" });
    expect(res.status).toBe("failed");
  });
});

import { pollLumaVideoJob, startLumaVideoJob } from "../src/engine/media/providers/luma";

describe("Luma video", () => {
  it("creates a generation and returns its id", async () => {
    let capturedUrl = "";
    let body: Record<string, unknown> = {};
    mockFetch((url, init) => {
      capturedUrl = url;
      body = JSON.parse(String(init?.body));
      return Response.json({ id: "gen_123", state: "queued" });
    });
    const res = await startLumaVideoJob({
      apiKey: "luma-key",
      model: "luma/ray-2",
      prompt: "ocean waves",
      aspectRatio: "9:16",
    });
    expect(capturedUrl).toBe("https://api.lumalabs.ai/dream-machine/v1/generations");
    expect(body.model).toBe("ray-2");
    expect(body.aspect_ratio).toBe("9:16");
    expect(res.status).toBe("running");
    expect(res.providerJobId).toBe("gen_123");
  });

  it("polls until completed, then downloads the video", async () => {
    const cap = mockFetch((url) => {
      if (url.endsWith("/generations/gen_123")) {
        return Response.json({ state: "completed", assets: { video: "https://cdn.luma/v.mp4" } });
      }
      return new Response(new Uint8Array([7, 7]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    });
    const res = await pollLumaVideoJob({ apiKey: "k", providerJobId: "gen_123" });
    expect(cap.calls()).toBe(2);
    expect(res.status).toBe("succeeded");
    expect(res.asset?.data.byteLength).toBe(2);
  });

  it("reports running while dreaming and fails on failure", async () => {
    mockFetch(() => Response.json({ state: "dreaming" }));
    expect((await pollLumaVideoJob({ apiKey: "k", providerJobId: "x" })).status).toBe("running");
    mockFetch(() => Response.json({ state: "failed", failure_reason: "nsfw" }));
    const failed = await pollLumaVideoJob({ apiKey: "k", providerJobId: "x" });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("nsfw");
  });
});
