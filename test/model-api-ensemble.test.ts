// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ensemble formation on one passthru turn, tools included
 * (`src/net/model-api/ensemble.ts`): N drafts, one checker pick of a WHOLE
 * draft, fail open to the agreeing group, usage and cost summed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model-api";
import {
  ensembleSize,
  majorityWriteGroup,
  parseEnsembleModels,
  parsePick,
  writeSignature,
} from "../src/net/model-api/ensemble";
import { parseStackHeader, resolvePassthruStack } from "../src/net/model-api/stack";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const TOOLS = [
  { type: "function", function: { name: "cancel_order", parameters: { type: "object" } } },
  {
    type: "function",
    function: {
      name: "get_order",
      description: "Look up an order",
      parameters: { type: "object" },
    },
  },
];

const call = (name: string, args: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }],
});

describe("ensemble parsing and picking", () => {
  it("parses a listed panel of 2–5 ids and clamps the size", () => {
    expect(parseEnsembleModels("openrouter/a/b")).toBeUndefined();
    expect(parseEnsembleModels("marina/ensemble:a/b, c/d")).toEqual(["a/b", "c/d"]);
    expect(parseEnsembleModels("marina/ensemble:a/b")).toHaveProperty("error");
    expect(parseEnsembleModels("marina/ensemble:a,b,c,d,e,f")).toHaveProperty("error");
    expect(ensembleSize({})).toBe(3);
    expect(ensembleSize({ MARINA_ENSEMBLE_SIZE: "9" })).toBe(5);
    expect(ensembleSize({ MARINA_ENSEMBLE_SIZE: "1" })).toBe(2);
    expect(ensembleSize({ MARINA_ENSEMBLE_SIZE: "junk" })).toBe(3);
  });

  it("reads a pick in range only", () => {
    expect(parsePick('{"pick":2,"reason":"grounded id"}', 3)).toEqual({
      index: 1,
      reason: "grounded id",
    });
    expect(parsePick('```json\n{"pick":"3"}\n```', 3)?.index).toBe(2);
    expect(parsePick('{"pick":4}', 3)).toBeUndefined();
    expect(parsePick("draft two", 3)).toBeUndefined();
  });

  it("compares state-changing calls only, with arguments canonicalized", () => {
    const a = call("cancel_order", '{"id":7,"reason":"x"}');
    const b = call("cancel_order", '{"reason":"x","id":7}');
    const c = call("cancel_order", '{"id":8}');
    expect(writeSignature(a, TOOLS)).toBe(writeSignature(b, TOOLS));
    expect(writeSignature(call("get_order", '{"id":7}'), TOOLS)).toBe("");
    expect(majorityWriteGroup([a, c, b], TOOLS)).toEqual([0, 2]);
    expect(majorityWriteGroup([a, c], TOOLS)).toEqual([]);
    // Agreement on making NO write is not agreement on a write.
    const look = call("get_order", '{"id":7}');
    expect(majorityWriteGroup([look, look, a], TOOLS)).toEqual([]);
  });

  it("is opt-in by name: never part of `full`", () => {
    expect(parseStackHeader("ensemble")).toEqual({
      kind: "list",
      members: new Set(["ensemble"]),
    });
    const full = resolvePassthruStack(
      { headers: new Headers({ "x-marina-stack": "full" }) },
      undefined,
      false,
      () => false,
    );
    expect("members" in full && full.members.has("ensemble")).toBe(false);
  });
});

const ENV = [
  ...modelSourceEnvKeys(),
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_VERIFY_CHECKER_MODEL",
  "MARINA_ENSEMBLE_SIZE",
  "MARINA_PASSTHRU_STACK",
  "MARINA_OUTPUT_REPAIR",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let calls: { model: unknown; checker: boolean; reviewer: boolean; user: string }[];
/** The k-th proposer draft (0-based, in call order). */
let drafts: Array<Record<string, unknown>>;
let checkerReply: string;
let checkerStatus: number | undefined;
/** The verify checker's reply (`marina/verify`'s review of the picked draft). */
let reviewReply: string;

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.MARINA_OUTPUT_REPAIR = "off";
  calls = [];
  drafts = [];
  checkerReply = '{"pick":1,"reason":"first"}';
  checkerStatus = undefined;
  reviewReply = '{"verdict":"approve","issues":""}';
  let proposer = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const msgs = (body.messages ?? []) as { role: string; content: unknown }[];
    const system = msgs
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    const user = msgs
      .filter((m) => m.role === "user")
      .map((m) => String(m.content))
      .join("\n");
    const checker = system.includes("You choose the best of several DRAFT");
    const reviewer = system.includes("You review an assistant's DRAFT");
    calls.push({ model: body.model, checker, reviewer, user });
    if (checker && checkerStatus)
      return Response.json({ error: { message: "down" } }, { status: checkerStatus });
    const message = checker
      ? { role: "assistant", content: checkerReply }
      : reviewer
        ? { role: "assistant", content: reviewReply }
        : (drafts[proposer++] ?? call("cancel_order", '{"id":7}'));
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        { index: 0, message, finish_reason: message.content === null ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "ensemble-route-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  engine.addConnection(new MockConnection("c1"));
  engine.spawnEntity("c1", "Agent1");
});

afterEach(async () => {
  await engine.shutdown();
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return await handleModelApi(url, "POST", req, engine);
}

const MODEL = "openrouter/openai/gpt-6.1-sol";
const request = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [
    { role: "system", content: "Cancel only the order the user names." },
    { role: "user", content: "Cancel order 7." },
  ],
  tools: TOOLS,
  ...extra,
});
const STACK = { "x-marina-stack": "ensemble" };

type Completion = {
  model: string;
  usage: { total_tokens: number };
  choices: { message: { tool_calls?: { function: { arguments: string } }[] } }[];
};

describe("POST /v1/chat/completions with the ensemble", () => {
  it("unanimous drafts need no checker; usage is summed", async () => {
    const resp = await post("/v1/chat/completions", request(MODEL), STACK);
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-ensemble")).toBe("picked=1/3; drafts=3/3; unanimous");
    expect(resp?.headers.get("x-marina-stack")).toBe("ensemble; source=header");
    const j = (await resp!.json()) as Completion;
    expect(j.usage.total_tokens).toBe(36);
    expect(calls.filter((c) => c.checker)).toHaveLength(0);
    expect(calls.map((c) => c.model)).toEqual(Array(3).fill("openai/gpt-6.1-sol"));
  });

  it("disagreeing writes go to the checker, which picks ONE whole draft", async () => {
    drafts = [
      call("cancel_order", '{"id":7}'),
      call("cancel_order", '{"id":8}'),
      call("cancel_order", '{"id":7}'),
    ];
    checkerReply = '{"pick":3,"reason":"id 7 is the one the user named"}';
    const resp = await post("/v1/chat/completions", request(MODEL), STACK);
    expect(resp?.headers.get("x-marina-ensemble")).toBe("picked=3/3; drafts=3/3; picked");
    const j = (await resp!.json()) as Completion;
    expect(j.choices[0]!.message.tool_calls?.[0]?.function.arguments).toBe('{"id":7}');
    expect(j.usage.total_tokens).toBe(48); // 3 drafts + the checker
    const checker = calls.find((c) => c.checker)!;
    expect(checker.user).toContain("DRAFT 2:");
    expect(checker.user).toContain("(Drafts 1, 3 make the same state-changing calls.)");
  });

  it("a checker outage fails open to the agreeing group", async () => {
    drafts = [
      call("cancel_order", '{"id":8}'),
      call("cancel_order", '{"id":7}'),
      call("cancel_order", '{"id":7}'),
    ];
    checkerStatus = 500;
    const resp = await post("/v1/chat/completions", request(MODEL), STACK);
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-ensemble")).toBe(
      "picked=2/3; drafts=3/3; checker-unavailable",
    );
    const j = (await resp!.json()) as Completion;
    expect(j.choices[0]!.message.tool_calls?.[0]?.function.arguments).toBe('{"id":7}');
  });

  it("a listed panel drafts once per id and reports the asked id", async () => {
    drafts = [call("get_order", '{"id":7}'), call("cancel_order", '{"id":7}')];
    checkerReply = '{"pick":1,"reason":"look first"}';
    const model = `marina/ensemble:${MODEL},openrouter/anthropic/claude-opus-5.5`;
    const resp = await post("/v1/chat/completions", request(model));
    expect(resp?.headers.get("x-marina-ensemble")).toBe("picked=1/2; drafts=2/2; picked");
    const j = (await resp!.json()) as Completion;
    expect(j.model).toBe(model);
    expect(calls.filter((c) => !c.checker).map((c) => c.model)).toEqual([
      "openai/gpt-6.1-sol",
      "anthropic/claude-opus-5.5",
    ]);
  });

  it("re-emits the picked tool call as SSE for a streaming request", async () => {
    const resp = await post("/v1/chat/completions", request(MODEL, { stream: true }), STACK);
    expect(resp?.headers.get("content-type")).toContain("text/event-stream");
    expect(resp?.headers.get("x-marina-ensemble")).toContain("unanimous");
    const text = await resp!.text();
    expect(text).toContain('"tool_calls":[{"index":0');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("the argument check reads the picked draft", async () => {
    const resp = await post("/v1/chat/completions", request(MODEL), {
      "x-marina-stack": "ensemble,argcheck",
    });
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-stack")).toBe("argcheck,ensemble; source=header");
    expect(resp?.headers.get("x-marina-argcheck")).toBeTruthy();
    expect(resp?.headers.get("x-marina-ensemble")).toContain("unanimous");
  });

  it("refuses what it cannot honour", async () => {
    const n = await post("/v1/chat/completions", request(MODEL, { n: 2 }), STACK);
    expect(n?.status).toBe(400);
    const one = await post("/v1/chat/completions", request(`marina/ensemble:${MODEL}`));
    expect(one?.status).toBe(400);
    const unknown = await post(
      "/v1/chat/completions",
      request(`marina/ensemble:${MODEL},not-a-provider-model`),
    );
    expect(unknown?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

const say = (content: string) => ({ role: "assistant", content });

describe("the ensemble with verify", () => {
  it("verify reviews the picked draft; both headers and both members are reported", async () => {
    drafts = [
      call("cancel_order", '{"id":8}'),
      call("cancel_order", '{"id":9}'),
      call("cancel_order", '{"id":7,"note":"the named order"}'),
    ];
    checkerReply = '{"pick":3,"reason":"id 7 is the one the user named"}';
    const resp = await post("/v1/chat/completions", request(MODEL), {
      "x-marina-stack": "ensemble,verify",
    });
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-stack")).toBe("lessons,verify,ensemble; source=header");
    expect(resp?.headers.get("x-marina-ensemble")).toBe("picked=3/3; drafts=3/3; picked");
    expect(resp?.headers.get("x-marina-verify")).toBe("approved");
    const j = (await resp!.json()) as Completion;
    expect(j.choices[0]!.message.tool_calls?.[0]?.function.arguments).toContain("the named order");
    expect(j.usage.total_tokens).toBe(60); // 3 drafts + the pick + the review
    // Order: drafts, then the pick, then verify's review of the PICKED draft only.
    expect(calls.map((c) => (c.checker ? "pick" : c.reviewer ? "review" : "draft"))).toEqual([
      "draft",
      "draft",
      "draft",
      "pick",
      "review",
    ]);
    const review = calls.find((c) => c.reviewer)!;
    expect(review.user).toContain("the named order");
    expect(review.user).not.toContain('"id":8');
    expect(review.user).not.toContain('"id":9');
  });

  it("a flagged pick is revised by ITS proposer in one call, not a second ensemble", async () => {
    drafts = [say("Order 8 is cancelled."), say("I will cancel order 7."), say("Cancelling 7.")];
    checkerReply = '{"pick":2,"reason":"names the right order"}';
    reviewReply = '{"verdict":"revise","issues":"Call cancel_order for order 7 instead."}';
    const model = `marina/ensemble:${MODEL},openrouter/anthropic/claude-opus-5.5`;
    const resp = await post("/v1/chat/completions", request(model), { "x-marina-stack": "verify" });
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-verify")).toBe("revised");
    expect(resp?.headers.get("x-marina-ensemble")).toBe("picked=2/2; drafts=2/2; picked");
    expect(resp?.headers.get("x-marina-stack")).toBe("lessons,verify,ensemble; source=header");
    const j = (await resp!.json()) as {
      model: string;
      choices: { message: { content?: string } }[];
    };
    expect(j.model).toBe(model);
    expect(j.choices[0]!.message.content).toBe("Cancelling 7.");
    // Two drafts, then ONE revision by the picked draft's proposer.
    expect(calls.filter((c) => !c.checker && !c.reviewer).map((c) => c.model)).toEqual([
      "openai/gpt-6.1-sol",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-opus-5.5",
    ]);
    expect(calls.filter((c) => c.checker)).toHaveLength(1);
  });

  it("a pick outage is still labelled checker-unavailable, and verify still reviews", async () => {
    drafts = [
      call("cancel_order", '{"id":8}'),
      call("cancel_order", '{"id":7}'),
      call("cancel_order", '{"id":7}'),
    ];
    checkerStatus = 500;
    const resp = await post("/v1/chat/completions", request(`marina/verify:${MODEL}`), STACK);
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-ensemble")).toBe(
      "picked=2/3; drafts=3/3; checker-unavailable",
    );
    expect(resp?.headers.get("x-marina-verify")).toBe("approved");
    const review = calls.find((c) => c.reviewer)!;
    expect(review.user).not.toContain('"id":8');
  });

  it("the obligations ledger and the argument check still wrap the formation", async () => {
    const resp = await post("/v1/chat/completions", request(MODEL), {
      "x-marina-stack": "ensemble,verify,obligations,argcheck",
    });
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-stack")).toBe(
      "lessons,obligations,argcheck,verify,ensemble; source=header",
    );
    expect(resp?.headers.get("x-marina-argcheck")).toBeTruthy();
    expect(resp?.headers.get("x-marina-verify")).toBeTruthy();
    expect(resp?.headers.get("x-marina-ensemble")).toContain("unanimous");
  });

  it("streaming keeps verify's refusal; under `full` verify is skipped and the pick streams", async () => {
    const listed = await post("/v1/chat/completions", request(MODEL, { stream: true }), {
      "x-marina-stack": "ensemble,verify",
    });
    expect(listed?.status).toBe(400);
    expect(calls).toHaveLength(0);
    const full = await post(
      "/v1/chat/completions",
      request(`marina/ensemble:${MODEL},${MODEL}`, { stream: true }),
      { "x-marina-stack": "full" },
    );
    expect(full?.headers.get("content-type")).toContain("text/event-stream");
    expect(full?.headers.get("x-marina-stack")).toContain("ensemble");
    expect(full?.headers.get("x-marina-stack")).toContain("skipped=verify(");
    expect(full?.headers.get("x-marina-verify")).toBeNull();
  });

  it("a listed panel keeps its reachability rule under verify", async () => {
    const resp = await post(
      "/v1/chat/completions",
      request(`marina/ensemble:${MODEL},not-a-provider-model`),
      { "x-marina-stack": "verify" },
    );
    expect(resp?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /v1/responses with the ensemble", () => {
  it("runs the same formation and returns the picked call as a Responses record", async () => {
    const resp = await post("/v1/responses", {
      model: `marina/ensemble:${MODEL},${MODEL}`,
      input: "Cancel order 7.",
      tools: [{ type: "function", name: "cancel_order", parameters: { type: "object" } }],
    });
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-ensemble")).toBe("picked=1/2; drafts=2/2; unanimous");
    const text = JSON.stringify(await resp!.json());
    expect(text).toContain("function_call");
    expect(text).toContain("cancel_order");
  });
});
