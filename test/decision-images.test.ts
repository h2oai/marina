// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness decisions over images: image parts in the decision state (prepared
 * before they leave Marina, refused with a reason otherwise), the `box`
 * question end to end, `/v1/decisions` sizing, image references in
 * `decision check|choose` under the caller's ACL, and MARINA_MEDIA_VERIFY.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAnswers, toWireAnswers } from "../src/decisions/answers";
import { combineAnswers, unsureAnswers } from "../src/decisions/combine";
import { decisionConfigFromEnv } from "../src/decisions/config";
import {
  CONFORMANCE_IMAGE_PNG,
  IMAGE_CONFORMANCE_REQUESTS,
  runConformance,
  wireViolations,
} from "../src/decisions/conformance";
import { gateToolCall } from "../src/decisions/gate";
import {
  classifierReadsImages,
  dataUrlDecodedBytes,
  decisionMaxImages,
  jevVersion,
  modelAnswersBox,
  prepareStateImages,
  splitStateImages,
  stateTextBytes,
} from "../src/decisions/images";
import { decideMediaVerify, readLocation } from "../src/decisions/policy";
import { chatClassifierProvider, decisionsApiProvider } from "../src/decisions/providers";
import { box, locate, parseQuestions } from "../src/decisions/questions";
import {
  DecisionError,
  type DecisionImagePart,
  type DecisionProvider,
  type DecisionRequest,
} from "../src/decisions/types";
import { checkDraft } from "../src/decisions/verify";
import { decisionCommand, extractImageRefs } from "../src/engine/commands/decision";
import {
  loadDecisionImage,
  mediaVerifyMode,
  REGENERATION_OF,
  startMediaVerify,
  verifyGeneratedImage,
} from "../src/engine/media/image-decisions";
import { probeImage, setImageBackendForTests } from "../src/engine/media/image-ops";
import { handleDecisions } from "../src/net/api/decisions-api";
import type { MediaJobRow } from "../src/persistence/database";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EngineEvent, Entity, EntityId, RoomContext } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

const PNG_BYTES = new Uint8Array(Buffer.from(CONFORMANCE_IMAGE_PNG.split(",")[1]!, "base64"));
const image = (url = CONFORMANCE_IMAGE_PNG): DecisionImagePart => ({
  type: "image_url",
  image_url: { url },
});

async function encoded(
  format: "png" | "webp" | "jpeg",
  width: number,
  height: number,
): Promise<string> {
  const sharp = (await import("sharp")).default;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#3a6"/></svg>`,
  );
  const buf = await sharp(svg)[format]().toBuffer();
  return `data:image/${format};base64,${buf.toString("base64")}`;
}

const decodeUrl = (url: string) =>
  new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));

type Captured = { url: string; body: Record<string, unknown> };
function fakeFetch(reply: (body: Record<string, unknown>) => unknown, sink: Captured[]) {
  return async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sink.push({ url, body });
    return Response.json(reply(body));
  };
}

afterEach(() => setImageBackendForTests());

// ─── box: types, normalization, wire, combine, policy ───────────────────────

describe("box questions", () => {
  const questions = parseQuestions({
    where: { type: "box", instructions: "The red circle." },
  });

  it("parses, and normalizes the Jev answer shape (clamp, order, confidence)", () => {
    expect(questions.where).toEqual(box("The red circle."));
    const answers = normalizeAnswers(questions, {
      where: {
        type: "box",
        box: { top: 0.41, bottom: 0.08, left: -0.2, right: 1.3 },
        confidence: 0.97,
      },
    });
    expect(answers.where).toEqual({
      type: "box",
      box: { top: 0.08, bottom: 0.41, left: 0, right: 1 },
      confidence: 0.97,
    });
  });

  it("refuses a box answer with a missing edge", () => {
    expect(() => normalizeAnswers(questions, { where: { box: { top: 0.1, left: 0.2 } } })).toThrow(
      DecisionError,
    );
  });

  it("serves the TypeSafe-complete wire shape and passes conformance checks", () => {
    const wire = toWireAnswers(questions, {
      where: { type: "box", box: { top: 0.1, bottom: 0.4, left: 0.6, right: 0.9 } },
    });
    expect(wire.where).toEqual({
      type: "box",
      box: { top: 0.1, bottom: 0.4, left: 0.6, right: 0.9 },
      confidence: 0.5,
    });
    expect(wireViolations(questions, wire)).toEqual([]);
    expect(
      wireViolations(questions, {
        where: { type: "box", box: { top: 0.5, bottom: 0.1, left: 0, right: 1 }, confidence: 1 },
      }),
    ).toEqual(["where: box edges are out of order"]);
  });

  it("combines boxes by confidence-weighted mean and flags an unsure one", () => {
    const combined = combineAnswers(questions, [
      {
        where: { type: "box", box: { top: 0, bottom: 0.4, left: 0.6, right: 1 }, confidence: 0.9 },
      },
      {
        where: {
          type: "box",
          box: { top: 0.2, bottom: 0.6, left: 0.4, right: 0.8 },
          confidence: 0.1,
        },
      },
    ]);
    const b = combined.where;
    expect(b?.type).toBe("box");
    if (b?.type === "box") {
      expect(b.box.top).toBeCloseTo(0.02, 5);
      expect(b.box.right).toBeCloseTo(0.98, 5);
      expect(b.confidence).toBeCloseTo(0.5, 5);
    }
    expect(
      unsureAnswers(questions, {
        where: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.3 },
      }),
    ).toEqual(["where"]);
  });

  it("locate() pairs the box with its presence noul; readLocation trusts the box only when present", () => {
    const q = locate("logo", "the company logo");
    expect(Object.keys(q).sort()).toEqual(["logo", "logo_present"]);
    expect(q.logo?.type).toBe("box");
    expect(q.logo_present?.type).toBe("noul");
    const b = { top: 0.1, bottom: 0.3, left: 0.2, right: 0.5 };
    expect(
      readLocation(
        {
          logo: { type: "box", box: b, confidence: 0.8 },
          logo_present: { type: "noul", noul: 0.9 },
        },
        "logo",
      ),
    ).toEqual({ found: true, box: b, presence: 0.9, confidence: 0.8 });
    expect(
      readLocation(
        { logo: { type: "box", box: b }, logo_present: { type: "noul", noul: 0.2 } },
        "logo",
      ),
    ).toEqual({ found: false, presence: 0.2 });
    // No usable answer ⇒ not found (a box alone is never evidence).
    expect(readLocation({ logo: { type: "box", box: b } }, "logo")).toEqual({ found: false });
    expect(readLocation(undefined, "logo")).toEqual({ found: false });
  });

  it("knows which Jev answers boxes", () => {
    expect(jevVersion("typesafe/jev-1.13")).toEqual([1, 13]);
    expect(jevVersion("~typesafe/jev-latest")).toBe("latest");
    expect(jevVersion("openjev-local")).toBeUndefined();
    expect(modelAnswersBox("typesafe/jev-1.13")).toBe(false);
    expect(modelAnswersBox("typesafe/jev-1.14")).toBe(true);
    expect(modelAnswersBox("jev-latest")).toBe(true);
    expect(modelAnswersBox("openjev-local")).toBe(true);
  });
});

// ─── image preparation ──────────────────────────────────────────────────────

describe("image parts in the state", () => {
  it("returns a text-only state unchanged (same object)", async () => {
    const state = { tool: "rm", args: ["-rf"] };
    const out = await prepareStateImages(state);
    expect(out.state).toBe(state);
    expect(out.images).toBe(0);
  });

  it("passes an in-spec PNG through untouched and drops `detail`", async () => {
    const out = await prepareStateImages([
      "caption",
      { type: "image_url", image_url: { url: CONFORMANCE_IMAGE_PNG, detail: "high" } },
    ]);
    expect(out.images).toBe(1);
    expect(out.state).toEqual(["caption", image()]);
  });

  it("re-encodes WebP (Jev takes PNG/JPEG only) and scales a too-small image up", async () => {
    const webp = await encoded("webp", 400, 400);
    const small = await encoded("png", 100, 100);
    const out = await prepareStateImages([image(webp), { nested: [image(small)] }]);
    const [first, second] = out.state as [DecisionImagePart, { nested: [DecisionImagePart] }];
    expect(first.image_url.url).toMatch(/^data:image\/(png|jpeg);base64,/);
    const scaled = probeImage(decodeUrl(second.nested[0].image_url.url));
    expect(Math.min(scaled!.width, scaled!.height)).toBeGreaterThanOrEqual(256);
    expect(scaled!.width * scaled!.height).toBeGreaterThanOrEqual(78_400);
  });

  it("refuses with a reason: remote URL, malformed data, too many, unpreparable without sharp", async () => {
    const refusal = async (state: unknown, opts = {}) => {
      try {
        await prepareStateImages(state, opts);
        return undefined;
      } catch (err) {
        expect(err).toBeInstanceOf(DecisionError);
        expect((err as DecisionError).code).toBe("unsupported_input");
        return (err as Error).message;
      }
    };
    expect(await refusal([image("https://example.com/a.png")])).toContain("remote URLs");
    expect(await refusal([image("data:image/png;base64,AAAA")])).toContain("not a recognised");
    expect(await refusal([image("not-a-url")])).toContain("base64 data URL");
    expect(await refusal([image(), image(), image()], { maxImages: 2 })).toContain("limit of 2");
    setImageBackendForTests(async () => undefined);
    expect(await refusal([image(await encoded("png", 100, 100))])).toContain("sharp");
  });

  it("splits images out of the text for classifiers and sizes the text without them", () => {
    const state = ["Look:", image(), { note: "x" }];
    const split = splitStateImages(state);
    expect(split.text).toEqual(["Look:", "[image 1]", { note: "x" }]);
    expect(split.images).toEqual([CONFORMANCE_IMAGE_PNG]);
    expect(stateTextBytes(state)).toBeLessThan(100);
    expect(dataUrlDecodedBytes(CONFORMANCE_IMAGE_PNG)).toBe(PNG_BYTES.byteLength);
    expect(decisionMaxImages({})).toBe(8);
    expect(decisionMaxImages({ MARINA_DECISION_MAX_IMAGES: "3" })).toBe(3);
    expect(decisionMaxImages({ MARINA_DECISION_MAX_IMAGES: "999" })).toBe(32);
    expect(decisionMaxImages({ MARINA_DECISION_MAX_IMAGES: "junk" })).toBe(8);
  });
});

// ─── backends ───────────────────────────────────────────────────────────────

describe("decisions-api backend with images and boxes", () => {
  const reply = (body: Record<string, unknown>) => ({
    model: `${body.model}-dated`,
    answers: Object.fromEntries(
      Object.entries(body.questions as Record<string, { type: string }>).map(([id, q]) => [
        id,
        q.type === "box"
          ? {
              type: "box",
              box: { top: 0.08, bottom: 0.41, left: 0.59, right: 0.91 },
              confidence: 0.97,
            }
          : { type: "noul", noul: 0.95 },
      ]),
    ),
    usage: { input_tokens: 1039, output_tokens: 36, cost: 0.00004 },
  });

  it("sends prepared image parts in `state` and reads a box answer", async () => {
    const sent: Captured[] = [];
    const p = decisionsApiProvider({
      baseUrl: "https://openrouter.ai/api/alpha",
      model: "typesafe/jev-1.14",
      timeoutMs: 5_000,
      fetch: fakeFetch(reply, sent),
    });
    const webp = await encoded("webp", 300, 300);
    const result = await p.ask({
      state: ["caption", image(webp)],
      questions: locate("c", "a circle"),
    });
    const body = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    const parts = body.state as [string, DecisionImagePart];
    expect(parts[0]).toBe("caption");
    expect(parts[1].image_url.url).toMatch(/^data:image\/(png|jpeg);base64,/);
    expect(result.answers.c).toEqual({
      type: "box",
      box: { top: 0.08, bottom: 0.41, left: 0.59, right: 0.91 },
      confidence: 0.97,
    });
    expect(result.costUsd).toBe(0.00004);
  });

  it("TypeSafe's own path passes parts through too", async () => {
    const sent: Captured[] = [];
    const p = decisionsApiProvider({
      baseUrl: "https://api.typesafe.ai",
      path: "/v1/systemone",
      model: "jev-latest",
      timeoutMs: 5_000,
      fetch: fakeFetch(reply, sent),
    });
    await p.ask({ state: [image()], questions: { d: { type: "noul", instructions: "Red?" } } });
    expect(sent[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent[0]!.body.state).toEqual([image()]);
  });

  it("a box on a pinned Jev 1.13 is refused before any call; the unpinned default moves to 1.14", async () => {
    const sent: Captured[] = [];
    const pinned = decisionsApiProvider({
      baseUrl: "https://openrouter.ai/api/alpha",
      model: "typesafe/jev-1.13",
      timeoutMs: 5_000,
      fetch: fakeFetch(reply, sent),
    });
    const err = await pinned
      .ask({ state: [image()], questions: { where: box("The circle.") } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect((err as DecisionError).code).toBe("unsupported_input");
    expect((err as Error).message).toContain("1.14");
    expect(sent).toHaveLength(0);
    // Images alone are fine on 1.13 (verified live).
    await pinned.ask({
      state: [image()],
      questions: { d: { type: "noul", instructions: "Red?" } },
    });
    expect(sent[0]!.body.model).toBe("typesafe/jev-1.13");

    const config = decisionConfigFromEnv({ MARINA_DECISIONS: "jev", OPENROUTER_API_KEY: "k" })!;
    expect(config.boxModel).toBe("typesafe/jev-1.14");
    const auto = decisionsApiProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      boxModel: config.boxModel!,
      timeoutMs: 5_000,
      fetch: fakeFetch(reply, sent),
    });
    const r = await auto.ask({ state: [image()], questions: { where: box("The circle.") } });
    expect(sent.at(-1)!.body.model).toBe("typesafe/jev-1.14");
    expect(r.model).toBe("typesafe/jev-1.14-dated");
  });

  it("passes the image conformance requests with a conformant backend", async () => {
    const p = decisionsApiProvider({
      baseUrl: "https://openrouter.ai/api/alpha",
      model: "typesafe/jev-1.14",
      timeoutMs: 5_000,
      fetch: fakeFetch(reply, []),
    });
    expect(IMAGE_CONFORMANCE_REQUESTS.map((r) => r.name)).toEqual(["image-noul", "image-box"]);
    const res = await runConformance(p, { images: true });
    expect(res.total).toBe(6);
    // The stub answers every non-box question as a noul, so only the four
    // text requests' choice/score questions fail; both image requests pass.
    const failed = res.failures.map((f) => f.name);
    expect(failed).not.toContain("image-noul");
    expect(failed).not.toContain("image-box");
  });
});

describe("chat-classifier backend with images", () => {
  const chatReply = (content: string) => () => ({
    model: "google/gemini-3.1-pro-preview",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 900, completion_tokens: 20, cost: 0.001 },
  });

  it("sends image_url content parts after the prompt to a vision model", async () => {
    const sent: Captured[] = [];
    const p = chatClassifierProvider({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-3.1-pro-preview",
      timeoutMs: 5_000,
      fetch: fakeFetch(
        chatReply(
          '{"answers":{"d":{"noul":0.9},"c":{"box":{"top":0.1,"bottom":0.4,"left":0.6,"right":0.9},"confidence":0.8}}}',
        ),
        sent,
      ),
    });
    const r = await p.ask({
      state: ["An image:", image()],
      questions: { d: { type: "noul", instructions: "Red circle?" }, c: box("The red circle.") },
    });
    const user = (sent[0]!.body.messages as { role: string; content: unknown }[])[1]!;
    const content = user.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("[image 1]");
    expect(content[0]!.text).not.toContain("base64");
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: CONFORMANCE_IMAGE_PNG } });
    expect(r.answers.c).toEqual({
      type: "box",
      box: { top: 0.1, bottom: 0.4, left: 0.6, right: 0.9 },
      confidence: 0.8,
    });
  });

  it("keeps a text-only request a plain string (unchanged)", async () => {
    const sent: Captured[] = [];
    const p = chatClassifierProvider({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-3.1-pro-preview",
      timeoutMs: 5_000,
      fetch: fakeFetch(chatReply('{"answers":{"d":{"noul":0.2}}}'), sent),
    });
    await p.ask({ state: "text", questions: { d: { type: "noul", instructions: "?" } } });
    const user = (sent[0]!.body.messages as { content: unknown }[])[1]!;
    expect(typeof user.content).toBe("string");
  });

  it("refuses images to a model not known to read them — no call is made", async () => {
    const sent: Captured[] = [];
    for (const [baseUrl, model] of [
      ["https://openrouter.ai/api/v1", "deepseek/deepseek-chat"],
      ["http://localhost:8080/v1", "local-model"],
    ] as const) {
      const p = chatClassifierProvider({
        baseUrl,
        model,
        timeoutMs: 5_000,
        fetch: fakeFetch(chatReply("{}"), sent),
      });
      const err = await p
        .ask({ state: [image()], questions: { d: { type: "noul", instructions: "?" } } })
        .catch((e) => e);
      expect((err as DecisionError).code).toBe("unsupported_input");
      expect((err as Error).message).toContain("not known to read images");
    }
    expect(sent).toHaveLength(0);
  });

  it("knows vision models from the catalog, including marina/default", () => {
    expect(
      classifierReadsImages("google/gemini-3.1-pro-preview", "https://openrouter.ai/api/v1"),
    ).toBe(true);
    expect(
      classifierReadsImages("openrouter/anthropic/claude-sonnet-5", "http://localhost:3300/v1"),
    ).toBe(true);
    expect(classifierReadsImages("anthropic/claude-sonnet-5", "http://localhost:3300/v1")).toBe(
      true,
    );
    expect(classifierReadsImages("deepseek/deepseek-chat", "https://openrouter.ai/api/v1")).toBe(
      false,
    );
    expect(
      classifierReadsImages("marina/default", "http://localhost:3300/v1", {
        ANTHROPIC_API_KEY: "k",
      }),
    ).toBe(true);
    expect(classifierReadsImages("marina/default", "http://localhost:3300/v1", {})).toBe(false);
  });

  it("an image refusal follows each policy's outage rule: the gate blocks, the verifier accepts", async () => {
    const refusing: DecisionProvider = {
      kind: "chat-classifier",
      model: "text-only",
      calibrated: false,
      async ask() {
        throw new DecisionError("not known to read images", "unsupported_input", 400);
      },
    };
    const gate = await gateToolCall(refusing, "delete_file", { path: "/x" });
    expect(gate.action).toBe("block");
    const check = await checkDraft(refusing, "draft", [], "request", [image()]);
    expect(check.action).toBe("accept");
    expect(check.error).toContain("images");
  });
});

// ─── /v1/decisions ──────────────────────────────────────────────────────────

describe("/v1/decisions with images", () => {
  const keys = [
    "MARINA_DECISIONS",
    "MARINA_DECISION_MODEL",
    "MARINA_DECISION_BASE_URL",
    "MARINA_DECISION_MAX_IMAGES",
  ];
  let saved: Record<string, string | undefined> = {};
  let server: ReturnType<typeof Bun.serve>;
  const received: Record<string, unknown>[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        received.push(body);
        return Response.json({
          answers: { d: { type: "noul", noul: 0.9 } },
          usage: { cost: 0.00004 },
        });
      },
    });
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "openjev-local";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${server.port}`;
  });
  afterEach(() => {
    server.stop(true);
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleDecisions(
      new Request("http://marina.test/v1/decisions", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  const q = { d: { type: "noul", instructions: "Red?" } };

  it("accepts image parts; the 64 KB text cap does not count image bytes", async () => {
    // Hundreds of KB of image data with little text is accepted…
    const sharp = (await import("sharp")).default;
    const noise = Buffer.from(
      Array.from({ length: 400 * 400 * 3 }, () => (Math.random() * 256) | 0),
    );
    const png = await sharp(noise, { raw: { width: 400, height: 400, channels: 3 } })
      .png()
      .toBuffer();
    const big = `data:image/png;base64,${png.toString("base64")}`;
    expect(big.length).toBeGreaterThan(64 * 1024);
    const res = await post({ state: ["caption", image(big)], questions: q });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answers: unknown }).answers).toEqual({
      d: { type: "noul", noul: 0.9 },
    });
    const sentState = received.at(-1)!.state as [string, DecisionImagePart];
    expect(sentState[1].image_url.url.startsWith("data:image/")).toBe(true);
    // …while 64 KB of text is still refused.
    const text = await post({ state: ["x".repeat(70 * 1024), image()], questions: q });
    expect(text.status).toBe(400);
  });

  it("caps image count and refuses remote URLs before any backend call", async () => {
    process.env.MARINA_DECISION_MAX_IMAGES = "2";
    const before = received.length;
    const many = await post({ state: [image(), image(), image()], questions: q });
    expect(many.status).toBe(400);
    const manyBody = (await many.json()) as { error: { code: string; message: string } };
    expect(manyBody.error.code).toBe("unsupported_parameter");
    expect(manyBody.error.message).toContain("limit is 2");
    const remote = await post({ state: [image("https://example.com/a.png")], questions: q });
    expect(remote.status).toBe(400);
    expect(((await remote.json()) as { error: { message: string } }).error.message).toContain(
      "remote URLs",
    );
    expect(received.length).toBe(before);
  });

  it("an image that cannot be prepared is a 400 unsupported_parameter, never a silent drop", async () => {
    const res = await post({ state: [image("data:image/png;base64,AAAAAAAA")], questions: q });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "unsupported_parameter",
    );
  });

  it("refuses a body over 32 MiB by its declared length", async () => {
    const res = await post(
      { state: "x", questions: q },
      { "content-length": String(40 * 1024 * 1024) },
    );
    expect(res.status).toBe(413);
  });

  it("serves box answers in the wire shape (TypeSafe path too)", async () => {
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          answers: {
            where: {
              type: "box",
              box: { top: 0.1, bottom: 0.4, left: 0.6, right: 0.9 },
              confidence: 0.9,
            },
          },
        }),
    });
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${server.port}`;
    const res = await handleDecisions(
      new Request("http://marina.test/v1/systemone", {
        method: "POST",
        body: JSON.stringify({
          state: [image()],
          questions: { where: { type: "box", instructions: "The circle." } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answers: unknown }).answers).toEqual({
      where: {
        type: "box",
        box: { top: 0.1, bottom: 0.4, left: 0.6, right: 0.9 },
        confidence: 0.9,
      },
    });
  });
});

// ─── agent-facing references and ACL ────────────────────────────────────────

describe("decision check|choose image references", () => {
  it("extracts image refs and leaves text without refs exactly as written", () => {
    expect(extractImageRefs("image:asset:a1 Is it red? | yes")).toEqual({
      text: "Is it red? | yes",
      refs: ["asset:a1"],
    });
    expect(extractImageRefs("q --image node:n1 | a | b image=asset:x")).toEqual({
      text: "q | a | b",
      refs: ["node:n1", "asset:x"],
    });
    expect(extractImageRefs("keep  double  spaces | image of a cat")).toEqual({
      text: "keep  double  spaces | image of a cat",
      refs: [],
    });
  });

  const me = { id: "e_ann", name: "Ann", properties: {} } as unknown as Entity;
  const input = (line: string) => {
    const tokens = line.split(/\s+/).slice(1);
    return { entity: "e_ann" as EntityId, tokens, args: tokens.join(" "), raw: line } as never;
  };

  it("attaches loaded images to the judged state; a ref the caller cannot read stops the call", async () => {
    const asked: DecisionRequest[] = [];
    const provider: DecisionProvider = {
      kind: "stub",
      model: "stub",
      async ask(req) {
        asked.push(req);
        return {
          answers: { pick: { type: "choice", choice: "o1", confidence: 0.9 } },
          model: "stub",
          provider: "stub",
          latencyMs: 1,
        };
      },
    };
    const out: string[] = [];
    const ctx = {
      send: (_: string, t: string) => out.push(stripAnsi(t)),
    } as unknown as RoomContext;
    const cmd = decisionCommand({
      getEntity: () => me,
      provider: () => provider,
      loadImage: async (_entity, ref) => {
        if (ref === "asset:private") throw new Error('Asset "private" not found.');
        return image();
      },
    });
    await cmd.handler(ctx, input("decision choose image:asset:a1 Which is red? | left | right"));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.state).toEqual([{}, image()]);
    expect(out.join("\n")).toContain("Pick: left");

    out.length = 0;
    await cmd.handler(ctx, input("decision choose image:asset:private Which? | a | b"));
    expect(asked).toHaveLength(1);
    expect(out.join("\n")).toContain("not found");

    const noLoader = decisionCommand({ getEntity: () => me, provider: () => provider });
    out.length = 0;
    await noLoader.handler(ctx, input("decision check image:asset:a1 looks fine"));
    expect(out.join("\n")).toContain("asset storage");
    expect(asked).toHaveLength(1);
  });

  describe("loadDecisionImage — the caller's own read access", () => {
    let assets: string;
    let fixture: ReturnType<typeof createTestEngine>;
    beforeEach(async () => {
      assets = mkdtempSync(join(tmpdir(), "decision-image-assets-"));
      const storage = new LocalStorageProvider(assets);
      await storage.init();
      fixture = createTestEngine({ assetStorage: storage });
      await fixture.engine.storage!.put("pub.png", PNG_BYTES, "image/png");
      await fixture.engine.storage!.put("priv.png", PNG_BYTES, "image/png");
      fixture.db.createAsset({
        id: "pub",
        entityName: "Ann",
        filename: "pub.png",
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
        storageKey: "pub.png",
        metadata: {},
      });
      // Staged from someone else's model request: private to its owner.
      fixture.db.createAsset({
        id: "priv",
        entityName: "Bob",
        filename: "priv.png",
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
        storageKey: "priv.png",
        metadata: { origin: "request", owner: "e_bob" },
      });
    });
    afterEach(async () => {
      await fixture.dispose();
      rmSync(assets, { recursive: true, force: true });
    });

    it("loads a readable asset and refuses one the caller may not read, the owner reads its own", async () => {
      const part = await loadDecisionImage(fixture.engine, "e_ann" as EntityId, "asset:pub");
      expect(part).toEqual(image());
      await expect(
        loadDecisionImage(fixture.engine, "e_ann" as EntityId, "asset:priv"),
      ).rejects.toThrow("not found");
      const own = await loadDecisionImage(fixture.engine, "e_bob" as EntityId, "asset:priv");
      expect(own.image_url.url).toBe(CONFORMANCE_IMAGE_PNG);
      await expect(
        loadDecisionImage(fixture.engine, "e_ann" as EntityId, "https://example.com/a.png"),
      ).rejects.toThrow("asset:<id> or node:<id>");
    });
  });
});

// ─── MARINA_MEDIA_VERIFY ────────────────────────────────────────────────────

describe("MARINA_MEDIA_VERIFY", () => {
  function host(depicts: number | "down", opts: { env?: NodeJS.ProcessEnv } = {}) {
    const metadata = new Map<string, Record<string, unknown> | null>();
    const events: EngineEvent[] = [];
    const asked: DecisionRequest[] = [];
    const regenerations: Record<string, unknown>[] = [];
    const provider: DecisionProvider = {
      kind: "decisions-api",
      model: "typesafe/jev-1.14",
      calibrated: true,
      async ask(req) {
        asked.push(req);
        if (depicts === "down") throw new DecisionError("timed out", "timeout", 504);
        return {
          answers: {
            depicts: { type: "noul", noul: depicts },
            quality: { type: "score", score: 1.9, confidence: 0.9 },
          },
          model: "typesafe/jev-1.14",
          provider: "decisions-api",
          latencyMs: 150,
          costUsd: 0.00004,
        };
      },
    };
    return {
      metadata,
      events,
      asked,
      regenerations,
      host: {
        db: {
          getMediaJob: (id: string) =>
            ({
              id,
              metadata: metadata.get(id) ? JSON.stringify(metadata.get(id)) : null,
            }) as MediaJobRow,
          updateMediaJob: (id: string, patch: { metadata: Record<string, unknown> | null }) => {
            metadata.set(id, patch.metadata);
          },
        },
        logEvent: (e: EngineEvent) => events.push(e),
        regenerate: async (m: Record<string, unknown>) => {
          regenerations.push(m);
        },
        provider: () => provider,
        env: opts.env ?? {},
      },
    };
  }
  const generated = (metadata?: Record<string, unknown>) => ({
    jobId: "job1",
    entityName: "Ann",
    prompt: "a red circle on white",
    data: PNG_BYTES,
    ...(metadata ? { metadata } : {}),
  });

  it("is off by default: no call, no record, no event", async () => {
    expect(mediaVerifyMode({})).toBe("off");
    expect(mediaVerifyMode({ MARINA_MEDIA_VERIFY: "junk" })).toBe("off");
    const h = host(0.1);
    expect(await verifyGeneratedImage(h.host, generated())).toBeUndefined();
    expect(h.asked).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.metadata.size).toBe(0);
  });

  it("observe records numbers and a label on the job and as an agent_decision event, never regenerates", async () => {
    const h = host(0.1, { env: { MARINA_MEDIA_VERIFY: "observe" } });
    const out = await verifyGeneratedImage(h.host, generated());
    expect(out).toMatchObject({
      label: "mismatch",
      regenerated: false,
      signals: { depicts: 0.1, quality: 1.9 },
    });
    expect(h.asked[0]!.state).toEqual([
      "An image generated for the request below.",
      { type: "image_url", image_url: { url: CONFORMANCE_IMAGE_PNG } },
    ]);
    expect(h.regenerations).toHaveLength(0);
    const verify = h.metadata.get("job1")!.mediaVerify as Record<string, unknown>;
    expect(verify).toMatchObject({
      mode: "observe",
      label: "mismatch",
      signals: { depicts: 0.1, quality: 1.9 },
    });
    expect(JSON.stringify(h.metadata.get("job1"))).not.toContain("red circle");
    const event = h.events[0] as Extract<EngineEvent, { type: "agent_decision" }>;
    expect(event).toMatchObject({
      type: "agent_decision",
      stage: "media_verify",
      subject: "media:job1",
      verdict: "mismatch",
      signals: { depicts: 0.1, quality: 1.9 },
      costUsd: 0.00004,
    });
    expect(JSON.stringify(event)).not.toContain("red circle");
  });

  it("on regenerates a mismatch at most once, never a regeneration, never a match", async () => {
    const env = { MARINA_MEDIA_VERIFY: "on" };
    const miss = host(0.1, { env });
    expect((await verifyGeneratedImage(miss.host, generated()))?.regenerated).toBe(true);
    expect(miss.regenerations).toEqual([{ [REGENERATION_OF]: "job1" }]);
    expect((miss.metadata.get("job1")!.mediaVerify as Record<string, unknown>).regenerated).toBe(
      true,
    );

    const second = host(0.1, { env });
    const again = await verifyGeneratedImage(second.host, generated({ [REGENERATION_OF]: "job0" }));
    expect(again?.label).toBe("mismatch");
    expect(again?.regenerated).toBe(false);
    expect(second.regenerations).toHaveLength(0);

    const hit = host(0.9, { env });
    expect((await verifyGeneratedImage(hit.host, generated()))?.label).toBe("match");
    expect(hit.regenerations).toHaveLength(0);
  });

  it("an outage is unjudged and never regenerates (the verifier accepts)", async () => {
    const h = host("down", { env: { MARINA_MEDIA_VERIFY: "on" } });
    const out = await verifyGeneratedImage(h.host, generated());
    expect(out).toMatchObject({ label: "unjudged", regenerated: false });
    expect(out?.error).toContain("timed out");
    expect(h.regenerations).toHaveLength(0);
    expect(decideMediaVerify(undefined, true).label).toBe("unjudged");
    // One cut at 0.5 for an uncalibrated judge; 0.35 for a calibrated one.
    const a = { depicts: { type: "noul" as const, noul: 0.4 } };
    expect(decideMediaVerify(a, true).label).toBe("match");
    expect(decideMediaVerify(a, false).label).toBe("mismatch");
  });

  it("does nothing without a decision backend", async () => {
    const h = host(0.1, { env: { MARINA_MEDIA_VERIFY: "on" } });
    const out = await verifyGeneratedImage({ ...h.host, provider: () => undefined }, generated());
    expect(out).toBeUndefined();
    expect(h.events).toHaveLength(0);
  });

  it("the manager hook starts nothing when off and tracks the detached check otherwise", async () => {
    const tracked: Promise<unknown>[] = [];
    const engine = {
      trackBackground: <T>(p: Promise<T>) => {
        tracked.push(p);
        return p;
      },
    };
    const off = host(0.1);
    startMediaVerify(engine, off.host, generated());
    expect(tracked).toHaveLength(0);
    expect(off.asked).toHaveLength(0);
    const on = host(0.9, { env: { MARINA_MEDIA_VERIFY: "observe" } });
    startMediaVerify(engine, on.host, generated());
    expect(tracked).toHaveLength(1);
    await tracked[0];
    expect(on.events).toHaveLength(1);
    // A host without background tracking (a test double) still runs it.
    const bare = host(0.9, { env: { MARINA_MEDIA_VERIFY: "observe" } });
    startMediaVerify(undefined, bare.host, generated());
    await Bun.sleep(10);
    expect(bare.asked).toHaveLength(1);
  });
});
