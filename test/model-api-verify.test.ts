// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina/verify:<proposer>[+<checker>]` — the verification formation as a
 * model id: proposer draft → checker review → at most one bounded revision,
 * tool calls included, failing open to the draft.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { memoryLessonSink } from "../src/learning/outcomes";
import { disableOutcomeLearning, enableOutcomeLearning } from "../src/learning/service";
import { handleModelApi } from "../src/net/model-api";
import {
  guardRevision,
  isReadOnlyToolCall,
  parseVerdict,
  parseVerifyModel,
  renderReview,
  revisionNote,
  type Verdict,
  verifyRounds,
} from "../src/net/model-api/verify";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

describe("verify model ids", () => {
  it("parses proposer and checker; the checker defaults to the env, else the proposer", () => {
    expect(parseVerifyModel("openrouter/openai/gpt-6.1-sol")).toBeUndefined();
    expect(parseVerifyModel("marina/verify:")).toBeUndefined();
    expect(parseVerifyModel("marina/verify:openrouter/a/b", {})).toEqual({
      proposer: "openrouter/a/b",
      checker: "openrouter/a/b",
    });
    expect(
      parseVerifyModel("marina/verify:openrouter/a/b", { MARINA_VERIFY_CHECKER_MODEL: "x/y" }),
    ).toEqual({ proposer: "openrouter/a/b", checker: "x/y" });
    expect(parseVerifyModel("marina/verify:openrouter/a/b+openrouter/c/d", {})).toEqual({
      proposer: "openrouter/a/b",
      checker: "openrouter/c/d",
    });
  });

  it("clamps the revision rounds", () => {
    expect(verifyRounds({})).toBe(1);
    expect(verifyRounds({ MARINA_VERIFY_ROUNDS: "0" })).toBe(0);
    expect(verifyRounds({ MARINA_VERIFY_ROUNDS: "9" })).toBe(3);
    expect(verifyRounds({ MARINA_VERIFY_ROUNDS: "junk" })).toBe(1);
  });
});

describe("verdicts and rendering", () => {
  it("parses revise only with concrete issues; everything else approves (fail open)", () => {
    expect(parseVerdict('{"verdict":"revise","issues":"confirm first"}')).toEqual({
      verdict: "revise",
      issues: "confirm first",
    });
    expect(parseVerdict('```json\n{"verdict":"approve","issues":""}\n```').verdict).toBe("approve");
    expect(parseVerdict('{"verdict":"revise","issues":""}').verdict).toBe("approve");
    expect(parseVerdict("no json here").verdict).toBe("approve");
    expect(parseVerdict("{broken").verdict).toBe("approve");
  });

  it("shows the checker the rules, tools, conversation and the draft's tool calls", () => {
    const text = renderReview(
      [
        { role: "system", content: "Never cancel without explicit confirmation." },
        { role: "user", content: "Cancel order 7." },
        { role: "tool", name: "get_order", content: '{"id":7,"status":"pending"}' },
      ],
      [{ type: "function", function: { name: "cancel_order", description: "Cancel an order" } }],
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "cancel_order", arguments: '{"id":7}' } }],
      },
    );
    expect(text).toContain("Never cancel without explicit confirmation.");
    expect(text).toContain("- cancel_order: Cancel an order");
    expect(text).toContain("TOOL RESULT (get_order)");
    expect(text).toContain('CALL cancel_order({"id":7})');
    expect(revisionNote({ role: "assistant", content: "Done." }, "ask first")).toContain(
      "Reviewer: ask first",
    );
  });
});

const ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_VERIFY_CHECKER_MODEL",
  "MARINA_VERIFY_ROUNDS",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let calls: { model: unknown; system: string }[];
let checkerReply: string;
/** When set, the proposer's draft message (else a cancel_order tool call). */
let proposerMessage: Record<string, unknown> | undefined;

const toolCall = (name: string, args: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }],
});

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  calls = [];
  checkerReply = '{"verdict":"approve","issues":""}';
  proposerMessage = undefined;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const msgs = (body.messages ?? []) as { role: string; content: string }[];
    const system = msgs
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    calls.push({ model: body.model, system });
    const isChecker = system.includes("You review an assistant's DRAFT");
    const isRevision = system.includes("A reviewer checked your draft");
    const message = isChecker
      ? { role: "assistant", content: checkerReply }
      : isRevision
        ? { role: "assistant", content: "Please confirm you want order 7 cancelled." }
        : (proposerMessage ?? toolCall("cancel_order", '{"id":7}'));
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
  dir = mkdtempSync(join(tmpdir(), "verify-route-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  engine.addConnection(new MockConnection("c1"));
  engine.spawnEntity("c1", "Agent1");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  engine.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(body: unknown) {
  const url = new URL("http://localhost:3300/v1/chat/completions");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await handleModelApi(url, "POST", req, engine);
}

const request = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [
    { role: "system", content: "Never cancel without explicit confirmation." },
    { role: "user", content: "Cancel order 7." },
  ],
  tools: [{ type: "function", function: { name: "cancel_order", parameters: { type: "object" } } }],
  ...extra,
});

describe("POST /v1/chat/completions with marina/verify", () => {
  it("returns the approved draft (a tool call) after one review", async () => {
    const resp = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol"));
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get("x-marina-verify")).toBe("approved");
    const j = (await resp!.json()) as {
      model: string;
      choices: { message: { tool_calls?: unknown[] } }[];
      usage: { total_tokens: number };
    };
    expect(j.model).toBe("marina/verify:openrouter/openai/gpt-6.1-sol");
    expect(j.choices[0]!.message.tool_calls?.length).toBe(1);
    expect(j.usage.total_tokens).toBe(24); // proposer + checker
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-6.1-sol", "openai/gpt-6.1-sol"]);
  });

  it("revises once when the checker flags the draft, using the checker model given", async () => {
    checkerReply = JSON.stringify({
      verdict: "revise",
      issues: "Ask for explicit confirmation first.",
      conflict: {
        kind: "policy",
        quote: "Never cancel without explicit confirmation.",
        call: "cancel_order",
      },
    });
    const resp = await post(
      request("marina/verify:openrouter/openai/gpt-6.1-sol+openrouter/anthropic/claude-opus-5.5"),
    );
    expect(resp?.headers.get("x-marina-verify")).toBe("revised");
    const j = (await resp!.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]!.message.content).toContain("confirm");
    expect(calls.map((c) => c.model)).toEqual([
      "openai/gpt-6.1-sol",
      "anthropic/claude-opus-5.5",
      "openai/gpt-6.1-sol",
    ]);
    expect(calls[2]!.system).toContain("Ask for explicit confirmation first.");
  });

  it("holds the drafted write action when the checker cites no concrete conflict", async () => {
    checkerReply = '{"verdict":"revise","issues":"Ask for explicit confirmation first."}';
    const resp = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol"));
    expect(resp?.headers.get("x-marina-verify")).toBe("held-write");
    const j = (await resp!.json()) as {
      choices: { message: { tool_calls?: { function: { name: string } }[] } }[];
    };
    expect(j.choices[0]!.message.tool_calls?.[0]?.function.name).toBe("cancel_order");
    expect(calls.length).toBe(3); // proposer, checker, revision (discarded)
  });

  it("injects recalled lessons for the proposer and the checker, and names them", async () => {
    const sink = memoryLessonSink([
      {
        id: "L1",
        domain: "tools",
        text: "confirm before you cancel an order",
        kind: "failure",
        trust: "trusted",
        resolvedAt: "2026-09-01T00:00:00.000Z",
        source: "tau2:retail",
      },
    ]);
    enableOutcomeLearning(db, { sink, writer: null, judge: null, env: {} });
    try {
      const resp = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol"));
      expect(resp?.headers.get("x-marina-lessons")).toBe("L1");
      expect(calls[0]!.system).toContain("LESSONS (from past outcomes");
      expect(calls[0]!.system).toContain("confirm before you cancel an order");
    } finally {
      disableOutcomeLearning(db);
    }
    const plain = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol"));
    expect(plain?.headers.get("x-marina-lessons")).toBe("0");
  });

  it("repairs a final message that carries its tool call as text, labelled", async () => {
    proposerMessage = {
      role: "assistant",
      // A fenced JSON call (`<tool_call>` tags are already normalized upstream).
      content: 'Cancelling now.\n```json\n{"name": "cancel_order", "arguments": {"id": 7}}\n```',
    };
    const resp = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol"));
    expect(resp?.headers.get("x-marina-repair")).toBe("repaired:parse");
    const j = (await resp!.json()) as {
      choices: {
        finish_reason: string;
        message: {
          content: unknown;
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
      }[];
    };
    expect(j.choices[0]!.finish_reason).toBe("tool_calls");
    expect(j.choices[0]!.message.content).toBeNull();
    expect(j.choices[0]!.message.tool_calls?.[0]?.function).toEqual({
      name: "cancel_order",
      arguments: '{"id":7}',
    });
    expect(calls.length).toBe(2); // proposer + checker; the parse needed no shot
  });

  it("leaves output raw with MARINA_OUTPUT_REPAIR=off and never repairs plain prose", async () => {
    proposerMessage = {
      role: "assistant",
      content: '{"name": "cancel_order", "arguments": {"id": 7}}',
    };
    process.env.MARINA_OUTPUT_REPAIR = "off";
    try {
      const off = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol"));
      expect(off?.headers.get("x-marina-repair")).toBeNull();
    } finally {
      delete process.env.MARINA_OUTPUT_REPAIR;
    }
    proposerMessage = { role: "assistant", content: "Which order do you mean?" };
    const prose = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol"));
    expect(prose?.headers.get("x-marina-repair")).toBeNull();
  });

  it("refuses streaming and unreachable models explicitly", async () => {
    const s = await post(request("marina/verify:openrouter/openai/gpt-6.1-sol", { stream: true }));
    expect(s?.status).toBe(400);
    const u = await post(request("marina/verify:anthropic/claude-opus-5.5"));
    expect(u?.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe("write-action guard", () => {
  const tools = [
    { type: "function", function: { name: "get_order_details" } },
    { type: "function", function: { name: "modify_pending_order_items" } },
    { type: "function", function: { name: "lookup_rates" }, annotations: { readOnlyHint: false } },
  ];
  const messages = [
    {
      role: "system",
      content: "Exchange or modify items only to an available item of the same product.",
    },
    { role: "user", content: "Swap item 1008292230 in order #W2378156 for the blue one." },
    {
      role: "tool",
      name: "get_order_details",
      content:
        '{"order_id":"#W2378156","items":[{"item_id":"1008292230"}],"available":["4602305039","9690244451"],"payment":"gift_card_9450778"}',
    },
  ];
  const call = (name: string, args: unknown) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }],
  });
  const modify = (newItem: string, payment = "gift_card_9450778") =>
    call("modify_pending_order_items", {
      order_id: "#W2378156",
      item_ids: ["1008292230"],
      new_item_ids: [newItem],
      payment_method_id: payment,
    });
  const draft = modify("4602305039");
  const revise = (conflict?: Verdict["conflict"]): Verdict => ({
    verdict: "revise",
    issues: "Use the blue variant.",
    ...(conflict ? { conflict } : {}),
  });
  const cited = {
    kind: "tool_result" as const,
    quote: '"available":["4602305039","9690244451"]',
    call: "modify_pending_order_items",
    field: "new_item_ids[0]",
  };

  it("classifies read-only calls by declared hint first, then by name", () => {
    expect(isReadOnlyToolCall("get_order_details", tools)).toBe(true);
    expect(isReadOnlyToolCall("modify_pending_order_items", tools)).toBe(false);
    expect(isReadOnlyToolCall("lookup_rates", tools)).toBe(false); // declared not read-only
    expect(isReadOnlyToolCall("cancel_pending_order", undefined)).toBe(false);
  });

  it("keeps a write call when the critique is vague (no cited conflict)", () => {
    const revised = modify("9690244451");
    expect(guardRevision({ messages, tools, draft, revised, verdict: revise() }).accept).toBe(
      false,
    );
  });

  it("lets only the cited argument change when the conflict is grounded", () => {
    expect(
      guardRevision({
        messages,
        tools,
        draft,
        revised: modify("9690244451"),
        verdict: revise(cited),
      }).accept,
    ).toBe(true);
    const alsoPayment = modify("9690244451", "gift_card_0000001");
    expect(
      guardRevision({ messages, tools, draft, revised: alsoPayment, verdict: revise(cited) })
        .accept,
    ).toBe(false);
  });

  it("rejects an invented id and a quote that is not in the conversation", () => {
    expect(
      guardRevision({
        messages,
        tools,
        draft,
        revised: modify("5555555555"),
        verdict: revise(cited),
      }).accept,
    ).toBe(false);
    const ungrounded = { ...cited, quote: "Always prefer the blue variant of any item." };
    expect(
      guardRevision({
        messages,
        tools,
        draft,
        revised: modify("9690244451"),
        verdict: revise(ungrounded),
      }).accept,
    ).toBe(false);
  });

  it("revises text and read-only calls freely; a cited rule may defer a write", () => {
    const lookup = call("get_order_details", { order_id: "#W2378156" });
    const textOnly = { role: "assistant", content: "Let me check the order first." };
    expect(
      guardRevision({ messages, tools, draft: lookup, revised: textOnly, verdict: revise() })
        .accept,
    ).toBe(true);
    const deferred = { role: "assistant", content: "Shall I swap it for 9690244451? (yes/no)" };
    expect(
      guardRevision({ messages, tools, draft, revised: deferred, verdict: revise() }).accept,
    ).toBe(false);
    const rule = {
      kind: "policy" as const,
      quote: "only to an available item of the same product",
      call: "modify_pending_order_items",
    };
    expect(
      guardRevision({ messages, tools, draft, revised: deferred, verdict: revise(rule) }).accept,
    ).toBe(true);
  });

  it("parses a cited conflict from the checker's verdict", () => {
    const v = parseVerdict(
      JSON.stringify({ verdict: "revise", issues: "wrong item", conflict: { ...cited } }),
    );
    expect(v.conflict).toEqual(cited);
    expect(revisionNote(draft, "wrong item", v.conflict)).toContain("argument new_item_ids[0]");
  });
});
