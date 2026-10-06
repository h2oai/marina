// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The argument check before writes: a mechanical pass over ids, amounts, dates
 * and options; one judgement for a flagged call; one nudge per call signature;
 * fail open on a judge outage; never a rewritten argument. Opt-in on the
 * passthru (model prefix or header, combinable with obligations) and in agent
 * loops (`MARINA_ARGCHECK`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tau2AgentModel } from "../benchmarks/repro/setups";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { ARGCHECK_SUPPORTED_MIN, decideArgcheck } from "../src/decisions/policy";
import type { DecisionProvider } from "../src/decisions/types";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model-api";
import {
  argcheckRequestMode,
  conversationEvidence,
  resetArgcheckForTests,
} from "../src/net/model-api/argcheck";
import { stripOptInPrefixes } from "../src/net/model-api/chat-completions";
import { resetObligationsForTests } from "../src/net/model-api/obligations";
import {
  ARGCHECK_JUDGE_SYSTEM,
  argValues,
  callSignature,
  checkCall,
  datesIn,
  EvidenceIndex,
  type EvidenceText,
  judgeState,
  mechanicalCheck,
  newArgcheckMemo,
  numbersIn,
} from "../src/obligations/argcheck";
import { AgentArgcheck, transcriptEvidence } from "../src/obligations/argcheck-agent";
import { argcheckMode, argcheckModel } from "../src/obligations/mode";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const convo: EvidenceText[] = [
  { channel: "system", text: "Bank policy: a replacement card costs $25. Confirm before writes." },
  { channel: "user", text: "Move $1,250.50 from checking ACC-7781 to savings on May 3, 2026." },
  { channel: "tool", text: '{"accounts":[{"id":"ACC-7781","type":"checking"},{"id":"ACC-9002"}]}' },
  { channel: "assistant", text: "I can send it to ACC-5555, is that right?" },
];

describe("values and evidence (pure)", () => {
  it("collects ids, amounts, dates and short options; skips free text, booleans, small ints", () => {
    const v = argValues({
      from: "ACC-7781",
      amount: 1250.5,
      fee: "$25",
      date: "2026-05-03",
      kind: "savings",
      count: 2,
      urgent: true,
      reason: "the customer asked for it on the phone today",
      note: "x1234",
      label: "card ending 4821 please",
      items: [{ sku: "SKU-12" }],
    });
    expect(v).toEqual([
      { path: "from", value: "acc-7781", kind: "id" },
      { path: "amount", value: "1250.5", kind: "number" },
      { path: "fee", value: "25", kind: "number" },
      { path: "date", value: "2026-05-03", kind: "date" },
      { path: "kind", value: "savings", kind: "option" },
      { path: "label", value: "4821", kind: "id" },
      { path: "items[0].sku", value: "sku-12", kind: "id" },
    ]);
  });

  it("walks a dispatcher tool's nested JSON arguments", () => {
    expect(
      argValues({
        agent_tool_name: "apply_credit",
        arguments: '{"user_id":"u_8812","amount":42.5}',
      }),
    ).toEqual([
      { path: "agent_tool_name", value: "apply_credit", kind: "option" },
      { path: "arguments.user_id", value: "u_8812", kind: "id" },
      { path: "arguments.amount", value: "42.5", kind: "number" },
    ]);
  });

  it("normalises numbers and dates across spellings", () => {
    expect([...numbersIn("pay $1,250.50 or 99")].sort()).toEqual(["1250.5", "99"]);
    expect([...datesIn("on May 3, 2026, 4 Sept 2026, 2026-01-09 and 12/31/2026")].sort()).toEqual([
      "2026-01-09",
      "2026-05-03",
      "2026-09-04",
      "2026-12-31",
    ]);
    expect(datesIn("the mayor 3, 2026 plan").size).toBe(0);
  });

  it("grades support: user/tool text is strong, the assistant's or the policy's own is weak", () => {
    const e = new EvidenceIndex(convo);
    const { findings, flagged } = mechanicalCheck(
      { from: "ACC-7781", to: "ACC-5555", amount: "1250.50", date: "2026-05-03", fee: 25 },
      e,
    );
    expect(findings.map((f) => [f.path, f.support])).toEqual([
      ["from", "strong"],
      ["to", "weak"],
      ["amount", "strong"],
      ["date", "strong"],
      ["fee", "weak"],
    ]);
    expect(flagged.map((f) => f.path)).toEqual(["to", "fee"]);
    // A value glued inside another token is not found.
    expect(mechanicalCheck({ id: "778" }, e).flagged[0]!.support).toBe("none");
  });

  it("signs a call by name and canonical arguments", () => {
    expect(callSignature("t", { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      callSignature("t", '{"b":[1,{"d":3,"c":2}],"a":1}'),
    );
    expect(callSignature("t", { a: 1 })).not.toBe(callSignature("t", { a: 2 }));
  });

  it("reads the modes and the judge model", () => {
    expect(argcheckMode({})).toBe("off");
    expect(argcheckMode({ MARINA_ARGCHECK: "observe" })).toBe("observe");
    expect(argcheckMode({ MARINA_ARGCHECK: "on" })).toBe("on");
    expect(argcheckModel({ MARINA_OBLIGATIONS_MODEL: "a" })).toBe("a");
    expect(argcheckModel({ MARINA_OBLIGATIONS_MODEL: "a", MARINA_ARGCHECK_MODEL: "b" })).toBe("b");
  });

  it("decides with one cut and fails open with a label", () => {
    expect(decideArgcheck(undefined).label).toBe("unjudged");
    expect(decideArgcheck(undefined).action).toBe("allow");
    const n = (p: number) => ({ supported: { type: "noul" as const, noul: p } });
    expect(decideArgcheck(n(ARGCHECK_SUPPORTED_MIN - 0.01)).action).toBe("nudge");
    expect(decideArgcheck(n(ARGCHECK_SUPPORTED_MIN)).action).toBe("allow");
  });
});

describe("checkCall", () => {
  const e = new EvidenceIndex(convo);
  const judgeReplies = (reply: string | Error) => {
    const calls: string[] = [];
    const complete = async (system: string, user: string) => {
      expect(system).toBe(ARGCHECK_JUDGE_SYSTEM);
      calls.push(user);
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return { calls, complete };
  };

  it("passes a mechanically supported call with no model call", async () => {
    const j = judgeReplies('{"supported": false}');
    const memo = newArgcheckMemo("k", 0);
    const out = await checkCall(
      { name: "transfer", args: { from: "ACC-7781", amount: 1250.5 } },
      e,
      { memo, mode: "on", judge: { complete: j.complete } },
    );
    expect(out.label).toBe("supported");
    expect(j.calls.length).toBe(0);
    expect(out.nudge).toBeUndefined();
  });

  it("nudges an unsupported call once per signature; the same call again runs", async () => {
    const j = judgeReplies('{"supported": false}');
    const memo = newArgcheckMemo("k", 0);
    const call = { name: "transfer", args: { from: "ACC-7781", to: "ACC-5555", amount: 1300 } };
    const first = await checkCall(call, e, { memo, mode: "on", judge: { complete: j.complete } });
    expect(first.label).toBe("unsupported");
    expect(first.nudge).toContain("Before transfer runs");
    expect(first.nudge).toContain("to = acc-5555");
    expect(first.nudge).toContain("amount = 1300: not found");
    // The nudge never proposes a value of its own.
    expect(first.nudge).not.toContain("1250");
    expect(j.calls.length).toBe(1);
    expect(j.calls[0]).toContain("VALUES TO CHECK");
    const again = await checkCall(call, e, { memo, mode: "on", judge: { complete: j.complete } });
    expect(again.label).toBe("repeat");
    expect(again.nudge).toBeUndefined();
    expect(j.calls.length).toBe(1);
    expect(memo.nudges).toBe(1);
  });

  it("allows a flagged call the judge supports; observe labels without a nudge", async () => {
    const yes = judgeReplies('{"supported": true}');
    const memo = newArgcheckMemo("k", 0);
    const fee = { name: "order_card", args: { fee: 25 } };
    expect(
      (await checkCall(fee, e, { memo, mode: "on", judge: { complete: yes.complete } })).label,
    ).toBe("judged-supported");
    const no = judgeReplies('{"supported": false}');
    const observed = await checkCall({ name: "transfer", args: { amount: 999 } }, e, {
      memo,
      mode: "observe",
      judge: { complete: no.complete },
    });
    expect(observed.label).toBe("unsupported");
    expect(observed.nudge).toBeUndefined();
    expect(memo.nudged).toEqual([]);
  });

  it("fails open on a judge outage or an unparseable answer", async () => {
    const memo = newArgcheckMemo("k", 0);
    for (const reply of [new Error("down"), "maybe?"]) {
      const j = judgeReplies(reply);
      const out = await checkCall({ name: "transfer", args: { amount: 999 } }, e, {
        memo,
        mode: "on",
        judge: { complete: j.complete },
      });
      expect(out.label).toBe("unjudged");
      expect(out.nudge).toBeUndefined();
    }
    expect(memo.unjudged).toBe(2);
  });

  it("asks the decision layer a noul question when one is configured", async () => {
    const asked: unknown[] = [];
    const provider: DecisionProvider = {
      kind: "test",
      model: "jev-test",
      ask: async (req) => {
        asked.push(req);
        return {
          answers: { supported: { type: "noul", noul: 0.1 } },
          model: "jev-test",
          provider: "test",
          latencyMs: 1,
          costUsd: 0.0001,
        };
      },
    };
    const memo = newArgcheckMemo("k", 0);
    const out = await checkCall({ name: "transfer", args: { amount: 999 } }, e, {
      memo,
      mode: "on",
      judge: { provider, complete: async () => '{"supported": true}' },
      stated: ["- move money (target: ACC-7781) [$1,250.50]"],
    });
    expect(out.label).toBe("unsupported");
    expect(out.judgement).toMatchObject({ supported: 0.1, model: "jev-test", costUsd: 0.0001 });
    const req = asked[0] as { state: string; questions: Record<string, { type: string }> };
    expect(req.questions.supported!.type).toBe("noul");
    expect(req.state).toContain("STATED REQUESTS");
    // Provider outage: fail open.
    const down: DecisionProvider = {
      ...provider,
      ask: async () => {
        throw new Error("outage");
      },
    };
    const failed = await checkCall({ name: "transfer", args: { amount: 998 } }, e, {
      memo,
      mode: "on",
      judge: { provider: down },
    });
    expect(failed.label).toBe("unjudged");
  });

  it("bounds what the judge sees", () => {
    const long = new EvidenceIndex([
      ...Array.from({ length: 20 }, (_, i) => ({
        channel: "user" as const,
        text: `msg ${i} ${"x".repeat(2000)}`,
      })),
    ]);
    const s = judgeState({ name: "t", args: { a: "1".repeat(5000) }, flagged: [], evidence: long });
    expect(s.length).toBeLessThan(12_000);
    expect(s).toContain("msg 19");
    expect(s).not.toContain("msg 13 ");
  });
});

describe("agent loop", () => {
  const transcript = [
    { role: "system", content: "Policy." },
    { role: "user", content: [{ type: "text", text: "Close card 4417 please." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking it up." },
        { type: "toolCall", id: "t", name: "close_card", arguments: { card: "9999" } },
      ],
    },
    { role: "toolResult", content: [{ type: "text", text: '{"cards":["4417"]}' }] },
  ];

  it("never reads tool-call arguments as evidence", () => {
    const ev = transcriptEvidence(transcript);
    expect(ev.map((x) => x.channel)).toEqual(["system", "user", "assistant", "tool"]);
    expect(ev.some((x) => x.text.includes("9999"))).toBe(false);
  });

  it("is inert when off, logs in observe, refuses once when on", async () => {
    let mode: "off" | "observe" | "on" = "off";
    let judged = 0;
    const a = new AgentArgcheck({
      complete: async () => {
        judged++;
        return '{"supported": false}';
      },
      mode: () => mode,
    });
    expect(await a.check("close_card", { card: "9999" }, transcript)).toEqual({});
    mode = "observe";
    const observed = await a.check("close_card", { card: "9999" }, transcript);
    expect(observed.outcome?.label).toBe("unsupported");
    expect(observed.refusal).toBeUndefined();
    mode = "on";
    const refused = await a.check("close_card", { card: "9999" }, transcript);
    expect(refused.refusal).toContain("card = 9999");
    expect((await a.check("close_card", { card: "9999" }, transcript)).refusal).toBeUndefined();
    expect((await a.check("close_card", { card: "4417" }, transcript)).outcome?.label).toBe(
      "supported",
    );
    expect(judged).toBe(2);
    expect(a.summary()).toMatchObject({ nudges: 1, unsupported: 2 });
  });
});

// ─── The passthru surface ────────────────────────────────────────────────────

const ENV = [
  ...modelSourceEnvKeys(),
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_OBLIGATIONS_MODEL",
  "MARINA_ARGCHECK_MODEL",
  "MARINA_DECISIONS",
  "MARINA_DECISION_ENGINE",
  "MARINA_ANTHROPIC_AUTO_CACHE",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let seen: { kind: string; body: Record<string, unknown> }[];
let judgeReply: string;
let failJudge: boolean;
/** The main model's replies, in order (the last one repeats). */
let replies: Record<string, unknown>[];

const MODEL = "openrouter/openai/gpt-6.1-sol";
const TOOLS = [
  { type: "function", function: { name: "get_card", parameters: { type: "object" } } },
  { type: "function", function: { name: "close_card", parameters: { type: "object" } } },
];

function systemText(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as { role: string; content: unknown }[];
  return msgs
    .filter((m) => m.role === "system")
    .map((m) => String(m.content))
    .join("\n");
}

const closeCall = (card: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: `t${card}`,
      type: "function",
      function: { name: "close_card", arguments: `{"card_id":"${card}"}` },
    },
  ],
});

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  resetObligationsForTests();
  resetArgcheckForTests();
  seen = [];
  judgeReply = '{"supported": false}';
  failJudge = false;
  replies = [closeCall("4471")];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const system = systemText(body);
    let kind = "main";
    let message: Record<string, unknown>;
    if (system.startsWith("An assistant is about to run a state-changing tool call")) {
      kind = "judge";
      if (failJudge) {
        seen.push({ kind, body });
        return new Response("upstream down", { status: 503 });
      }
      message = { role: "assistant", content: judgeReply };
    } else if (system.startsWith("You keep the ledger")) {
      kind = "extract";
      message = {
        role: "assistant",
        content:
          '{"add":[{"request":1,"what":"Close card 4417","target":"4417","tools":["close_card"]}],"cancel":[]}',
      };
    } else {
      const mains = seen.filter((s) => s.kind === "main").length;
      message = replies[Math.min(mains, replies.length - 1)]!;
    }
    seen.push({ kind, body });
    return Response.json({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "argcheck-"));
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

async function post(body: unknown, headers: Record<string, string> = {}) {
  const url = new URL("http://localhost:3300/v1/chat/completions");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return (await handleModelApi(url, "POST", req, engine))!;
}

const opening = [
  { role: "system", content: "You are a bank agent. Confirm before closing cards." },
  { role: "assistant", content: "Hi! How can I help?" },
  { role: "user", content: "Please close my card 4417." },
];

const lastText = (body: Record<string, unknown>) => {
  const msgs = body.messages as { role: string; content: unknown }[];
  return String(msgs[msgs.length - 1]!.content);
};

const firstCall = async (resp: Response) => {
  const j = (await resp.json()) as {
    choices: { message: { tool_calls?: { function: { arguments: string } }[] } }[];
  };
  return j.choices[0]!.message.tool_calls?.[0]?.function.arguments;
};

describe("POST /v1/chat/completions with the argument check", () => {
  it("parses the opt-in and is byte-identical without it", async () => {
    const req = (h: Record<string, string>) =>
      new Request("http://x/v1/chat/completions", { method: "POST", headers: h });
    expect(argcheckRequestMode(req({}), `marina/argcheck:${MODEL}`)).toBe("on");
    expect(argcheckRequestMode(req({ "x-marina-argcheck": "observe" }), MODEL)).toBe("observe");
    expect(
      argcheckRequestMode(req({ "x-marina-argcheck": "off" }), `marina/argcheck:${MODEL}`),
    ).toBe(undefined);
    expect(stripOptInPrefixes(`marina/obligations:marina/argcheck:marina/lessons:${MODEL}`)).toBe(
      MODEL,
    );
    expect(conversationEvidence([closeCall("1") as never]).map((e) => e.text)).toEqual([""]);
    const resp = await post({ model: MODEL, messages: opening, tools: TOOLS });
    expect(resp.headers.get("x-marina-argcheck")).toBeNull();
    expect(seen.map((s) => s.kind)).toEqual(["main"]);
    expect(seen[0]!.body.messages).toEqual(opening);
  });

  it("passes a supported write with no judge call", async () => {
    replies = [closeCall("4417")];
    const resp = await post({ model: `marina/argcheck:${MODEL}`, messages: opening, tools: TOOLS });
    expect(seen.map((s) => s.kind)).toEqual(["main"]);
    expect(seen[0]!.body.model).toBe("openai/gpt-6.1-sol");
    expect(resp.headers.get("x-marina-argcheck")).toBe(
      "on;writes=1;checked=1;flagged=0;nudges=0;check=supported",
    );
    expect(await firstCall(resp)).toBe('{"card_id":"4417"}');
  });

  it("nudges an unsupported write once and returns the model's second reply", async () => {
    replies = [closeCall("4471"), closeCall("4417")];
    const resp = await post({ model: `marina/argcheck:${MODEL}`, messages: opening, tools: TOOLS });
    expect(seen.map((s) => s.kind)).toEqual(["main", "judge", "main"]);
    const note = lastText(seen[2]!.body);
    expect(note).toContain("[Marina argument check");
    expect(note).toContain("card_id = 4471: not found");
    expect(seen[2]!.body.messages).toEqual([
      ...opening.slice(0, 2),
      { role: "user", content: expect.stringContaining("Please close my card 4417.") },
    ]);
    expect(resp.headers.get("x-marina-argcheck")).toContain("check=nudged-changed");
    expect(await firstCall(resp)).toBe('{"card_id":"4417"}');
  });

  it("never nudges the same call twice: the model's choice stands", async () => {
    replies = [closeCall("4471")];
    const first = await post({
      model: `marina/argcheck:${MODEL}`,
      messages: opening,
      tools: TOOLS,
    });
    expect(first.headers.get("x-marina-argcheck")).toContain("check=nudged-kept");
    expect(await firstCall(first)).toBe('{"card_id":"4471"}');
    seen = [];
    const second = await post({
      model: `marina/argcheck:${MODEL}`,
      messages: opening,
      tools: TOOLS,
    });
    expect(seen.map((s) => s.kind)).toEqual(["main"]);
    expect(second.headers.get("x-marina-argcheck")).toContain("check=repeat");
  });

  it("observes without a retry (header opt-in)", async () => {
    const resp = await post(
      { model: MODEL, messages: opening, tools: TOOLS },
      { "x-marina-argcheck": "observe" },
    );
    expect(seen.map((s) => s.kind)).toEqual(["main", "judge"]);
    expect(resp.headers.get("x-marina-argcheck")).toContain("observe;");
    expect(resp.headers.get("x-marina-argcheck")).toContain("check=unsupported");
    expect(await firstCall(resp)).toBe('{"card_id":"4471"}');
  });

  it("fails open with a label when the judge is down", async () => {
    failJudge = true;
    const resp = await post({ model: `marina/argcheck:${MODEL}`, messages: opening, tools: TOOLS });
    expect(resp.status).toBe(200);
    expect(seen.map((s) => s.kind)).toEqual(["main", "judge"]);
    expect(resp.headers.get("x-marina-argcheck")).toContain("check=unjudged");
    expect(await firstCall(resp)).toBe('{"card_id":"4471"}');
  });

  it("leaves replies without a write alone", async () => {
    replies = [{ role: "assistant", content: "Which card?" }];
    const resp = await post({ model: `marina/argcheck:${MODEL}`, messages: opening, tools: TOOLS });
    expect(resp.headers.get("x-marina-argcheck")).toContain("check=no-write");
    replies = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "g", type: "function", function: { name: "get_card", arguments: '{"id":"1"}' } },
        ],
      },
    ];
    seen = [];
    const read = await post({ model: `marina/argcheck:${MODEL}`, messages: opening, tools: TOOLS });
    expect(seen.map((s) => s.kind)).toEqual(["main"]);
    expect(read.headers.get("x-marina-argcheck")).toContain("check=no-write");
  });

  it("combines with the obligations ledger: both run, the judge sees the stated requests", async () => {
    replies = [closeCall("4471"), closeCall("4417")];
    const resp = await post({
      model: `marina/obligations:marina/argcheck:${MODEL}`,
      messages: opening,
      tools: TOOLS,
    });
    expect(seen.map((s) => s.kind)).toEqual(["extract", "main", "judge", "main"]);
    expect(seen[1]!.body.model).toBe("openai/gpt-6.1-sol");
    expect(lastText(seen[2]!.body)).toContain("STATED REQUESTS:\n- Close card 4417 (target: 4417)");
    const retryNote = lastText(seen[3]!.body);
    expect(retryNote).toContain("[Marina obligations");
    expect(retryNote).toContain("[Marina argument check");
    expect(resp.headers.get("x-marina-obligations")).toContain("check=tool-call");
    expect(resp.headers.get("x-marina-argcheck")).toContain("check=nudged-changed");
  });
});

describe("repro kit arms", () => {
  it("maps the argcheck arms to combined model prefixes", () => {
    const m = { answer: "anthropic/claude-fable-5-1", checker: "anthropic/claude-fable-5-1" };
    expect(tau2AgentModel("argcheck", m)).toBe("marina/argcheck:anthropic/claude-fable-5-1");
    expect(tau2AgentModel("obligations+argcheck", m)).toBe(
      "marina/obligations:marina/argcheck:anthropic/claude-fable-5-1",
    );
    expect(tau2AgentModel("obligations", m)).toBe("marina/obligations:anthropic/claude-fable-5-1");
  });
});
