// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agents seeing images with their own model: native looks (`mode:native`)
 * return prepared image bytes, tool results carry them as image parts, the
 * live transcript keeps only the newest images, the journal never records
 * image bytes, `MARINA_AGENT_VISION` chooses the mode, and image generation is
 * offered by provider rather than by the agent's model.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import sharp from "sharp";
import { withoutImageBytes } from "../src/agent/durable-memory";
import { GameStateManager } from "../src/agent/game-state";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { createProfileToolset, type ToolContext } from "../src/agent/tools";
import { createMediaTools } from "../src/agent/tools/media";
import { execCommand, perceptionImages } from "../src/agent/tools/shared";
import {
  boundTranscriptImages,
  imagePlaceholder,
  transcriptImageLimit,
} from "../src/agent/transcript-hygiene";
import {
  agentAcceptsImageInput,
  agentVisionMode,
  agentVisionPolicy,
  modelAcceptsImageInput,
  setDefaultUpstreamDescriber,
} from "../src/agent/vision-input";
import { mediaGenerationAvailable } from "../src/engine/media/manager";
import {
  AGENT_VIEW_IMAGE_LIMITS,
  clearVisionCache,
  lookReply,
  parseLookArgs,
  resetVisionRateLimits,
  viewHeader,
} from "../src/engine/media/vision";
import { inferModelCapabilities } from "../src/net/model/model-discovery";
import type { MarinaClient } from "../src/sdk/client";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";

async function png(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 20, b: 20 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

function fakeContext(
  reply: (command: string) => Perception[],
  visionMode?: () => "native" | "describe",
): ToolContext & { commands: string[] } {
  const commands: string[] = [];
  const client = {
    isConnected: () => true,
    command: async (command: string) => {
      commands.push(command);
      return reply(command);
    },
  } as unknown as MarinaClient;
  return {
    client,
    gameState: new GameStateManager(),
    commands,
    ...(visionMode ? { visionMode } : {}),
  };
}

const IMG = { ref: "asset:a1", mime: "image/png", data: "iVBORw0KGgo=", width: 10, height: 8 };

describe("tool results carry native images", () => {
  it("turns a vision perception's images into image parts plus refs", async () => {
    const ctx = fakeContext(() => [
      {
        kind: "message",
        tag: "vision",
        timestamp: 1,
        data: { text: "Viewing square.png.", images: [IMG, { bogus: true }] },
      },
    ]);
    const result = await execCommand(ctx, "canvas look a1 mode:native");
    expect(result.content[0].text).toContain("Viewing square.png.");
    expect(result.content.slice(1)).toEqual([
      { type: "image", data: IMG.data, mimeType: "image/png" },
    ]);
    expect(result.details.images).toEqual([
      { ref: "asset:a1", width: 10, height: 8, mime: "image/png" },
    ]);
  });

  it("keeps text-only results unchanged and caps images per result", () => {
    const plain = perceptionImages([{ kind: "message", timestamp: 1, data: { text: "hi" } }]);
    expect(plain.parts).toEqual([]);
    const many = perceptionImages([
      { kind: "message", timestamp: 1, data: { text: "", images: Array(9).fill(IMG) } },
    ]);
    expect(many.parts).toHaveLength(4);
    const badMime = perceptionImages([
      { kind: "message", timestamp: 1, data: { images: [{ ...IMG, mime: "image/svg+xml" }] } },
    ]);
    expect(badMime.parts).toEqual([]);
  });

  it("marina_see asks for a native look only when the vision mode is native", async () => {
    const reply = () => [{ kind: "message", timestamp: 1, data: { text: "ok" } }] as Perception[];
    for (const [mode, expectNative] of [
      ["native", true],
      ["describe", false],
      [undefined, false],
    ] as const) {
      const ctx = fakeContext(reply, mode ? () => mode : undefined);
      const see = createMediaTools(ctx).find((t) => t.name === "marina_see")!;
      await see.execute("t1", { source: "asset:a1", question: "what colour" });
      await see.execute("t2", { source: "workspace:shot.png" });
      expect(ctx.commands[0]!.endsWith(" mode:native")).toBe(expectNative);
      expect(ctx.commands[1]!.includes('"mode":"native"')).toBe(expectNative);
    }
  });
});

describe("live transcript image bound", () => {
  const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
  const result = (n: number, ref: string): AgentMessage =>
    ({
      role: "toolResult",
      toolCallId: `c-${ref}`,
      toolName: "marina_see",
      content: [{ type: "text", text: `look ${ref}` }, ...Array(n).fill(image)],
      details: { images: Array(n).fill({ ref, width: 640, height: 480, mime: "image/png" }) },
      isError: false,
      timestamp: 1,
    }) as unknown as AgentMessage;

  it("keeps the newest N images and replaces older ones with a reopenable placeholder", () => {
    const messages = [result(1, "asset:old"), result(2, "asset:mid"), result(1, "asset:new")];
    const bounded = boundTranscriptImages(messages, 2);
    const blocks = (m: AgentMessage) => (m as unknown as { content: { type: string }[] }).content;
    expect(blocks(bounded[2]!).filter((b) => b.type === "image")).toHaveLength(1);
    expect(blocks(bounded[1]!).filter((b) => b.type === "image")).toHaveLength(1);
    expect(blocks(bounded[0]!).filter((b) => b.type === "image")).toHaveLength(0);
    const text = JSON.stringify(blocks(bounded[0]!));
    expect(text).toContain("asset:old 640x480");
    expect(text).toContain("marina_see asset:old");
    // The newest unchanged message keeps its identity.
    expect(bounded[2]).toBe(messages[2]);
  });

  it("returns the same array when within the bound", () => {
    const messages = [result(1, "asset:a"), result(1, "asset:b")];
    expect(boundTranscriptImages(messages, 4)).toBe(messages);
  });

  it("reads MARINA_AGENT_VISION_MAX_IMAGES with a floor of one", () => {
    expect(transcriptImageLimit({})).toBe(4);
    expect(transcriptImageLimit({ MARINA_AGENT_VISION_MAX_IMAGES: "2" })).toBe(2);
    expect(transcriptImageLimit({ MARINA_AGENT_VISION_MAX_IMAGES: "0" })).toBe(4);
    expect(transcriptImageLimit({ MARINA_AGENT_VISION_MAX_IMAGES: "junk" })).toBe(4);
    expect(imagePlaceholder()).toContain("marina_see image");
  });

  it("never journals image bytes", () => {
    const json = JSON.stringify([result(1, "asset:x")], withoutImageBytes);
    expect(json).not.toContain("AAAA");
    expect(json).toContain("[image image/png not recorded]");
  });
});

describe("MARINA_AGENT_VISION and image input", () => {
  afterEach(() => setDefaultUpstreamDescriber(undefined));

  it("parses the policy and picks native only for image-reading models under auto", () => {
    expect(agentVisionPolicy({})).toBe("auto");
    expect(agentVisionPolicy({ MARINA_AGENT_VISION: "NATIVE" })).toBe("native");
    expect(agentVisionPolicy({ MARINA_AGENT_VISION: "describe" })).toBe("describe");
    expect(agentVisionPolicy({ MARINA_AGENT_VISION: "bogus" })).toBe("auto");
    expect(agentVisionMode("auto", true)).toBe("native");
    expect(agentVisionMode("auto", false)).toBe("describe");
    expect(agentVisionMode("describe", true)).toBe("describe");
    expect(agentVisionMode("native", false)).toBe("native");
  });

  it("reads image input from the registry, the default upstream and explicit config", () => {
    expect(modelAcceptsImageInput("anthropic/claude-opus-5-5")).toBe(true);
    expect(modelAcceptsImageInput("openrouter/anthropic/claude-opus-5.5")).toBe(true);
    expect(modelAcceptsImageInput("llamacpp/some-local-model")).toBe(false);
    expect(modelAcceptsImageInput(undefined)).toBe(false);
    // marina/default follows its current upstream.
    expect(modelAcceptsImageInput("marina/default")).toBe(false);
    setDefaultUpstreamDescriber(() => "anthropic/claude-opus-5-5");
    expect(modelAcceptsImageInput("marina/default")).toBe(true);
    expect(modelAcceptsImageInput("marina/default@remote.example")).toBe(false);
    // A live model input list (hosted catalog refresh) counts.
    expect(modelAcceptsImageInput("nebius/some-vlm", ["text", "image"])).toBe(true);
    // Explicit configuration wins either way.
    expect(agentAcceptsImageInput({ text: true, imageInput: false }, "marina/default")).toBe(false);
    expect(agentAcceptsImageInput({ text: true, imageInput: true }, "llamacpp/x")).toBe(true);
  });
});

describe("generation is a provider capability", () => {
  const ctx = fakeContext(() => []);
  const memory = {} as PlatformMemoryBackend;
  const names = (tools: AgentTool[]) => tools.map((t) => t.name);
  const all = (opts: Parameters<typeof createProfileToolset>[4], supports = { text: true }) => {
    const set = createProfileToolset(ctx, memory, "full", supports, opts);
    return [...names(set.resident), ...names(set.deferred)];
  };

  it("offers generate tools to any model when a provider is configured", () => {
    expect(all(undefined)).not.toContain("marina_generate_image");
    expect(all({ mediaGeneration: { image: true } })).toContain("marina_generate_image");
    expect(all({ mediaGeneration: { image: true } })).not.toContain("marina_generate_video");
    expect(all({ mediaGeneration: { video: true } })).toContain("marina_generate_video");
    // The explicit configuration override still works.
    expect(all(undefined, { text: true, image: true } as never)).toContain("marina_generate_image");
  });

  it("keeps vision input apart from image generation in model capabilities", () => {
    const vision = inferModelCapabilities("openai/gpt-4o-vision-preview");
    expect(vision.imageInput).toBe(true);
    expect(vision.image).toBeUndefined();
    expect(inferModelCapabilities("openai/gpt-image-2").image).toBe(true);
  });

  it("detects configured image and video providers", () => {
    const none = { configured: true, hasKey: () => false, env: {} };
    expect(mediaGenerationAvailable(none)).toEqual({ image: false, video: false });
    expect(mediaGenerationAvailable({ ...none, hasKey: (p) => p === "openai" })).toEqual({
      image: true,
      video: false,
    });
    expect(mediaGenerationAvailable({ ...none, hasKey: (p) => p === "runway" }).video).toBe(true);
    expect(
      mediaGenerationAvailable({ ...none, env: { TOGETHER_IMAGE_BASE_URL: "http://x" } }).image,
    ).toBe(true);
    expect(mediaGenerationAvailable({ configured: false, hasKey: () => true, env: {} })).toEqual({
      image: false,
      video: false,
    });
  });
});

describe("native looks on the server", () => {
  let assets: string;
  let fixture: ReturnType<typeof createTestEngine>;
  let originalFetch: typeof fetch;
  let modelCalls: number;
  const who = { entityId: "e_ann" as EntityId, name: "Ann" };

  beforeEach(async () => {
    assets = mkdtempSync(join(tmpdir(), "vision-native-"));
    const storage = new LocalStorageProvider(assets);
    await storage.init();
    fixture = createTestEngine({ assetStorage: storage });
    clearVisionCache();
    resetVisionRateLimits();
    modelCalls = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      modelCalls++;
      return Response.json({ error: { message: "no model in this test" } }, { status: 500 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fixture.dispose();
    rmSync(assets, { recursive: true, force: true });
  });

  async function asset(id: string, bytes: Uint8Array, owner = "Ann"): Promise<void> {
    await fixture.engine.storage!.put(`${id}.png`, bytes, "image/png");
    fixture.db.createAsset({
      id,
      entityName: owner,
      filename: `${id}.png`,
      mimeType: "image/png",
      size: bytes.byteLength,
      storageKey: `${id}.png`,
      metadata: {},
    });
  }

  it("returns the image fitted to the model-input limits, with no model call", async () => {
    await asset("big", await png(3000, 1000));
    const reply = await lookReply(fixture.engine, who, ["asset:big", "what", "mode:native"]);
    expect(modelCalls).toBe(0);
    expect(reply.images).toHaveLength(1);
    const img = reply.images![0]!;
    expect(img.ref).toBe("asset:big");
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(AGENT_VIEW_IMAGE_LIMITS.maxSide!);
    expect(img.width / img.height).toBeCloseTo(3, 1);
    expect(reply.text).toContain("Question: what");
    expect(reply.text).toContain("Untrusted content");
    expect(reply.text).toContain(`asset:big ${img.width}x${img.height}`);
  });

  it("keeps describe as the default and refuses sources the requester may not read", async () => {
    await asset("small", await png(64, 64));
    const described = await lookReply(fixture.engine, who, ["asset:small"]);
    expect(described.images).toBeUndefined();
    // No model is configured here: the describe path labels it, never crashes.
    expect(described.text).toContain("[no vision]");

    fixture.db.createCanvas({
      id: "priv",
      name: "inbox:someone-else",
      scope: "entity",
      scopeId: "e_other",
      creatorName: "Other",
    });
    fixture.db.createNode({
      id: "pn",
      canvasId: "priv",
      type: "image",
      assetId: "small",
      creatorName: "Other",
    });
    const refused = await lookReply(fixture.engine, who, ["node:pn", "mode:native"]);
    expect(refused.images).toBeUndefined();
    expect(refused.text).toContain("not found");
  });

  it("parses mode and renders a header", () => {
    expect(parseLookArgs(["n1", "mode:native", "what"])).toEqual({
      ref: "n1",
      question: "what",
      mode: "native",
    });
    expect(parseLookArgs(["n1", "--mode=describe"])).toEqual({
      ref: "n1",
      question: "",
      mode: "describe",
    });
    const header = viewHeader("doc.pdf", [IMG, IMG], { kind: "pdf", text: "hello" });
    expect(header).toContain("(pdf)");
    expect(header).toContain("[image 2/2 asset:a1 10x8 image/png]");
    expect(header).toContain("Extracted text:\nhello");
  });
});
