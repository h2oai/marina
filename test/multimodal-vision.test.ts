// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeing images, documents and video on the canvas: loading untrusted bytes,
 * preparing model inputs, the vision-model fallthrough, canvas write-back
 * (`derived_from`), request images staged on the canvas for crews, and the
 * `marina/verify` checker receiving the conversation's images.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter } from "../src/auth/rate-limiter";
import {
  classifyVisual,
  clearVisionCache,
  decodeDataUrl,
  lookAndReply,
  parseLookArgs,
  prepareVisual,
  REQUEST_IMAGE_ORIGIN,
  requestInboxName,
  resetVisionRateLimits,
  runTool,
  sniffRaster,
  stageRequestImages,
  visionModelCandidates,
  visionRequest,
} from "../src/engine/media/vision";
import { handleModelApi } from "../src/net/model-api";
import { reviewContent } from "../src/net/model-api/verify";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

describe("vision helpers", () => {
  it("parses a source, a question and a model modifier", () => {
    expect(parseLookArgs([])).toHaveProperty("error");
    expect(parseLookArgs(["n1", "what", "model:openrouter/a/b", "is", "this"])).toEqual({
      ref: "n1",
      question: "what is this",
      model: "openrouter/a/b",
    });
    expect(parseLookArgs(["n1", "--model=x/y"])).toEqual({ ref: "n1", question: "", model: "x/y" });
  });

  it("classifies by content first; a declared image MIME is not trusted", () => {
    expect(sniffRaster(PNG)).toBe("image/png");
    expect(classifyVisual(PNG, "application/octet-stream")).toBe("image");
    expect(classifyVisual(new TextEncoder().encode("%PDF-1.7"), "")).toBe("pdf");
    expect(classifyVisual(new Uint8Array([1, 2, 3]), "image/png")).toBeNull();
    expect(classifyVisual(new Uint8Array([1, 2, 3]), "video/mp4")).toBe("video");
    expect(classifyVisual(new TextEncoder().encode("hi"), "text/plain")).toBe("text");
  });

  it("tries the agent's own model, then MARINA_VISION_MODEL; an explicit model alone", () => {
    expect(visionModelCandidates(undefined, undefined, {})).toEqual(["marina"]);
    expect(visionModelCandidates(undefined, "a/b", { MARINA_VISION_MODEL: "v/m" })).toEqual([
      "a/b",
      "v/m",
    ]);
    expect(visionModelCandidates(undefined, "v/m", { MARINA_VISION_MODEL: "v/m" })).toEqual([
      "v/m",
    ]);
    expect(visionModelCandidates("x/y", "a/b", { MARINA_VISION_MODEL: "v/m" })).toEqual(["x/y"]);
  });

  it("prepares images as data URLs, text as text, and refuses SVG", async () => {
    const img = await prepareVisual({ data: PNG, mime: "image/png", label: "p" });
    expect(img.kind).toBe("image");
    expect(img.images[0]).toStartWith("data:image/png;base64,");
    const txt = await prepareVisual({
      data: new TextEncoder().encode("hello"),
      mime: "text/plain",
      label: "t",
    });
    expect(txt.text).toBe("hello");
    const svg = await prepareVisual({
      data: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      mime: "image/svg+xml",
      label: "s",
    });
    expect(svg.images).toEqual([]);
    expect(svg.notes.join(" ").toLowerCase()).toContain("svg");
  });

  it("sends the question, extracted text and images as one user message", () => {
    const body = visionRequest(
      "m",
      "what?",
      { kind: "pdf", images: ["data:image/png;base64,AA"], text: "page text", notes: [] },
      "doc.pdf",
    ) as { model: string; messages: { role: string; content: unknown }[] };
    expect(body.model).toBe("m");
    const user = body.messages[1]!.content as Record<string, unknown>[];
    expect(user[0]!.text).toContain("Question: what?");
    expect(user[0]!.text).toContain("page text");
    expect(user[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AA" } });
  });

  it("decodes only base64 data URLs", () => {
    expect(decodeDataUrl(PNG_URL)?.data).toEqual(PNG);
    expect(decodeDataUrl("data:text/plain,hi")).toBeUndefined();
    expect(decodeDataUrl("https://x/y.png")).toBeUndefined();
  });
});

describe("external tools run off the event loop", () => {
  it("times out a slow tool asynchronously while timers keep firing", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    const r = await runTool(["sleep", "5"], { timeoutMs: 300 });
    clearInterval(timer);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
    // A synchronous spawn would have held the loop for the whole run.
    expect(ticks).toBeGreaterThan(3);
  });

  it("caps a tool's stdout and kills it past the cap", async () => {
    const r = await runTool(["yes"], { maxStdoutBytes: 4096, timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.stdout.length).toBeLessThanOrEqual(4096);
  });

  it("stops a tool when the caller aborts", async () => {
    const ac = new AbortController();
    const pending = runTool(["sleep", "5"], { signal: ac.signal, timeoutMs: 10_000 });
    setTimeout(() => ac.abort(), 50);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBeUndefined();
  });

  it("returns the output of a tool that succeeds", async () => {
    const r = await runTool(["echo", "hello"]);
    expect(r).toEqual({ ok: true, stdout: "hello\n" });
  });
});

describe("marina/verify checker sees images", () => {
  it("keeps text-only reviews a string and appends the most recent four images", () => {
    expect(reviewContent("R", [{ role: "user", content: "hi" }])).toBe("R");
    const img = (n: number) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${n}` },
    });
    const content = reviewContent("R", [
      { role: "user", content: [{ type: "text", text: "look" }, img(1), img(2), img(3)] },
      { role: "assistant", content: "ok" },
      { role: "tool", content: [img(4), img(5)] },
    ]) as Record<string, unknown>[];
    expect(Array.isArray(content)).toBe(true);
    expect(String(content[0]!.text)).toContain("last 4 of 5 images");
    expect(content.slice(1)).toEqual([img(2), img(3), img(4), img(5)]);
  });
});

describe("canvas look and request staging", () => {
  let assets: string;
  let fixture: ReturnType<typeof createTestEngine>;
  let originalFetch: typeof fetch;
  let saved: Record<string, string | undefined>;
  let sent: { model: string; content: unknown }[];
  let canSee: (model: string) => boolean;

  beforeEach(async () => {
    assets = mkdtempSync(join(tmpdir(), "vision-assets-"));
    const storage = new LocalStorageProvider(assets);
    await storage.init();
    fixture = createTestEngine({ assetStorage: storage });
    // The fixture mocks OpenRouter's wire format; local provider keys must not
    // make the default `marina` route select a different provider.
    fixture.db.setSetting("default_model", "openrouter/vision/model");
    clearVisionCache();
    saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      MARINA_VISION_MODEL: process.env.MARINA_VISION_MODEL,
      MARINA_DAILY_SPEND_CAP_USD: process.env.MARINA_DAILY_SPEND_CAP_USD,
    };
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.MARINA_VISION_MODEL;
    delete process.env.MARINA_DAILY_SPEND_CAP_USD;
    sent = [];
    canSee = () => true;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const model = String(body.model);
      sent.push({ model, content: body.messages?.[1]?.content });
      if (!canSee(model)) {
        return Response.json(
          { error: { message: "model does not support images" } },
          { status: 400 },
        );
      }
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "A red square." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fixture.dispose();
    rmSync(assets, { recursive: true, force: true });
  });

  async function imageNode(): Promise<{ canvasId: string; nodeId: string }> {
    const { db, engine } = fixture;
    await engine.storage!.put("a1.png", PNG, "image/png");
    db.createAsset({
      id: "a1",
      entityName: "Ann",
      filename: "square.png",
      mimeType: "image/png",
      size: PNG.byteLength,
      storageKey: "a1.png",
      metadata: {},
    });
    db.createCanvas({ id: "cv1", name: "board", creatorName: "Ann" });
    db.createNode({ id: "n1", canvasId: "cv1", type: "image", assetId: "a1", creatorName: "Ann" });
    return { canvasId: "cv1", nodeId: "n1" };
  }

  it("describes a canvas image, writes the answer back linked derived_from, and caches", async () => {
    const { canvasId } = await imageNode();
    const who = { entityId: "e_ann" as EntityId, name: "Ann" };
    const reply = await lookAndReply(fixture.engine, who, ["n1", "what", "colour?"]);
    expect(reply).toContain("A red square.");
    expect(sent).toHaveLength(1);
    const parts = sent[0]!.content as { type: string; image_url?: { url: string } }[];
    expect(parts.some((p) => p.type === "image_url" && p.image_url!.url === PNG_URL)).toBe(true);

    const written = fixture.db.getNodesByCanvas(canvasId).filter((n) => n.id !== "n1");
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.data).text).toBe("A red square.");
    const edges = fixture.db.getCanvasEdges(canvasId);
    expect(
      edges.some(
        (e) =>
          e.source_id === written[0]!.id &&
          e.target_id === "n1" &&
          e.relationship === "derived_from",
      ),
    ).toBe(true);

    const again = await lookAndReply(fixture.engine, who, ["n1", "what", "colour?"]);
    expect(again).toContain("(cached)");
    expect(sent).toHaveLength(1);
  });

  it("falls through from a model that cannot see to MARINA_VISION_MODEL, then labels", async () => {
    await imageNode();
    process.env.MARINA_VISION_MODEL = "openrouter/vision/model";
    canSee = (m) => m.endsWith("vision/model");
    const who = { entityId: "e_ann" as EntityId, name: "Ann" };
    const ok = await lookAndReply(fixture.engine, who, ["n1", "model:openrouter/blind/model"]);
    expect(ok).toContain("[no vision]");
    const via = await lookAndReply(fixture.engine, who, ["asset:a1"]);
    expect(via).toContain("A red square.");
    expect(via).toContain("model: openrouter/vision/model");
  });

  it("refuses a missing source and an image that fails the magic-byte check", async () => {
    const who = { entityId: "e_ann" as EntityId, name: "Ann" };
    expect(await lookAndReply(fixture.engine, who, ["nope"])).toContain("not found");
    await fixture.engine.storage!.put("bad.png", new Uint8Array([1, 2, 3]), "image/png");
    fixture.db.createAsset({
      id: "bad",
      entityName: "Ann",
      filename: "bad.png",
      mimeType: "image/png",
      size: 3,
      storageKey: "bad.png",
      metadata: {},
    });
    const reply = await lookAndReply(fixture.engine, who, ["asset:bad"]);
    expect(reply).toContain("Unsupported content");
    expect(sent).toHaveLength(0);
  });

  it("stages request images on the caller's private inbox and names each node", async () => {
    const principal = { ownerId: "model-key-abc", name: "model-key-abc" };
    const lines = await stageRequestImages(
      fixture.engine,
      [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: PNG_URL } },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
      principal,
    );
    expect(lines).toHaveLength(3);
    const nodeId = /canvas node ([0-9a-f-]+)/.exec(lines[0]!)?.[1];
    expect(nodeId).toBeTruthy();
    const canvas = fixture.db.getCanvasByName("inbox:model-key-abc");
    // Private to its owner (dashboard/WS gate), attributed to the caller.
    expect(canvas?.scope).toBe("entity");
    expect(canvas?.scope_id).toBe("model-key-abc");
    expect(canvas?.creator_name).toBe("model-key-abc");
    const node = fixture.db.getNode(nodeId!);
    expect(node?.type).toBe("image");
    expect(node?.creator_name).toBe("model-key-abc");
    expect(JSON.parse(node!.data).origin).toBe(REQUEST_IMAGE_ORIGIN);
    const asset = fixture.db.getAsset(node!.asset_id!);
    expect(asset?.entity_name).toBe("model-key-abc");
    expect(JSON.parse(asset!.metadata).origin).toBe(REQUEST_IMAGE_ORIGIN);
    expect(lines[1]).toContain("not staged");
    expect(lines[2]).toContain("canvas look https://example.com/a.png");
    expect(sent).toHaveLength(0);
  });

  it("names the inbox from the principal only, sanitised", () => {
    expect(requestInboxName("e_42")).toBe("inbox:e_42");
    expect(requestInboxName("a b/../c:d")).toBe("inbox:a-b-..-c-d");
    expect(requestInboxName("x".repeat(200))).toHaveLength("inbox:".length + 80);
  });

  it("stores nothing for a caller without an identity, and labels it", async () => {
    const lines = await stageRequestImages(
      fixture.engine,
      [{ type: "image_url", image_url: { url: PNG_URL } }],
      undefined,
    );
    expect(lines).toEqual(["[image 1: not staged — this caller has no identity to own it]"]);
    expect(fixture.db.listAssets()).toHaveLength(0);
  });

  it("caps the bytes one request may stage in total", async () => {
    const saved = process.env.MARINA_VISION_MAX_BYTES;
    process.env.MARINA_VISION_MAX_BYTES = String(PNG.byteLength + 4);
    try {
      const img = { type: "image_url", image_url: { url: PNG_URL } };
      const lines = await stageRequestImages(fixture.engine, [img, img], {
        ownerId: "o",
        name: "o",
      });
      expect(lines[0]).toContain("canvas node");
      expect(lines[1]).toContain("in total — not staged");
    } finally {
      if (saved === undefined) delete process.env.MARINA_VISION_MAX_BYTES;
      else process.env.MARINA_VISION_MAX_BYTES = saved;
    }
  });

  it("rate limits each entity's looks", async () => {
    await imageNode();
    const bypass = RateLimiter.bypass;
    RateLimiter.bypass = false;
    resetVisionRateLimits();
    try {
      const who = { entityId: "e_rl" as EntityId, name: "Rl" };
      const replies: string[] = [];
      for (let i = 0; i < 7; i++) replies.push(await lookAndReply(fixture.engine, who, ["n1"]));
      expect(replies.slice(0, 6).every((r) => !r.includes("rate limit"))).toBe(true);
      expect(replies[6]).toContain("Vision rate limit reached");
      // Another entity has its own budget.
      const other = await lookAndReply(fixture.engine, { ...who, entityId: "e_x" as EntityId }, [
        "n1",
      ]);
      expect(other).not.toContain("rate limit");
    } finally {
      RateLimiter.bypass = bypass;
      resetVisionRateLimits();
    }
  });

  describe("agents-mode model API", () => {
    let savedKeys: string | undefined;
    let requests: string[];

    beforeEach(() => {
      savedKeys = process.env.MODEL_API_KEYS;
      process.env.MODEL_API_KEYS = "sk-test-staging";
      requests = [];
      const { engine } = fixture;
      const conn = new MockConnection("c-crew");
      engine.addConnection(conn);
      const crew = engine.spawnEntity("c-crew", "Crew1")!.id;
      engine.processCommand(crew, "channel join model");
      const cm = engine.channelManager!;
      cm.onMessage((channelId, senderId, _name, content) => {
        if (senderId !== "__model_api__") return;
        const parsed = JSON.parse(content) as { type?: string; id?: string; content?: string };
        if (parsed.type !== "model_request" || (parsed as { reminder?: boolean }).reminder) return;
        requests.push(String(parsed.content));
        cm.send(
          channelId,
          crew,
          "Crew1",
          JSON.stringify({ type: "model_response", id: parsed.id, content: "seen" }),
        );
      });
    });

    afterEach(() => {
      if (savedKeys === undefined) delete process.env.MODEL_API_KEYS;
      else process.env.MODEL_API_KEYS = savedKeys;
    });

    async function post(path: string, body: unknown) {
      const url = new URL(`http://localhost:3300${path}`);
      const req = new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test-staging" },
        body: JSON.stringify(body),
      });
      return await handleModelApi(url, "POST", req, fixture.engine);
    }

    function stagedCanvas(text: string) {
      const nodeId = /canvas node ([0-9a-f-]+)/.exec(text)?.[1];
      expect(nodeId).toBeTruthy();
      const node = fixture.db.getNode(nodeId!);
      return fixture.db.getCanvas(node!.canvas_id);
    }

    it("chat completions stage onto the key's private inbox, never a model-named canvas", async () => {
      const resp = await post("/v1/chat/completions", {
        model: "marina",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is it?" },
              { type: "image_url", image_url: { url: PNG_URL } },
            ],
          },
        ],
      });
      expect(resp?.status).toBe(200);
      expect(requests).toHaveLength(1);
      const canvas = stagedCanvas(requests[0]!);
      expect(canvas?.scope).toBe("entity");
      expect(canvas?.name).toMatch(/^inbox:model-key-[0-9a-f]{16}$/);
      expect(fixture.db.getCanvasByName("inbox:marina")).toBeUndefined();
    });

    it("/v1/responses carries images to the agents instead of dropping them", async () => {
      const resp = await post("/v1/responses", {
        model: "marina",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "what is it?" },
              { type: "input_image", image_url: PNG_URL },
            ],
          },
        ],
      });
      expect(resp?.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("what is it?");
      expect(requests[0]).toContain("canvas look");
      const canvas = stagedCanvas(requests[0]!);
      expect(canvas?.scope).toBe("entity");
      expect(canvas?.name).toMatch(/^inbox:model-key-/);
    });
  });
});
