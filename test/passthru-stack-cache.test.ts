// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt caching under the passthru instrument stack. An OpenAI-compatible
 * upstream's automatic cache reuses a WHOLE earlier prompt, so each turn's
 * upstream request must start with the previous turn's request byte for byte —
 * the per-request trailing note included (`sticky-notes.ts`). Also: the
 * caller's `prompt_cache_key` reaches the upstream on /v1/responses, side calls
 * (judges, the checker) never carry it, and the verify checker skips drafts
 * that are only read-only lookups (`MARINA_VERIFY_REVIEW`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model/model-api";
import { resetObligationsForTests } from "../src/net/model-api/obligations";
import {
  noteScopeFor,
  planStickyNotes,
  resetStickyNotesForTests,
} from "../src/net/model-api/sticky-notes";
import { withTrailingNote } from "../src/net/model-api/upstream";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

type Body = Record<string, unknown>;

const ENV = [
  ...modelSourceEnvKeys(),
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DECISIONS",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_PASSTHRU_STACK",
  "MARINA_PASSTHRU_STICKY_NOTES",
  "MARINA_VERIFY_REVIEW",
  "MARINA_PROFILE",
  "MARINA_LESSONS_FROM_WORK",
  "MARINA_ANTHROPIC_AUTO_CACHE",
] as const;

const MAIN = "MAIN";
let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let calls: { url: string; kind: string; body: Body }[];
let script: Body[][];
let turn: number;

/** The side call a request is, by its system text, or MAIN for the conversation itself. */
function kindOf(body: Body): string {
  if (Array.isArray(body.tools) && body.tools.length > 0) return MAIN;
  const items = (body.input ?? body.messages) as Body[];
  const first = String(items?.[0]?.content ?? "");
  if (first.startsWith("You keep the ledger")) return "extract";
  if (first.startsWith("You review an assistant's DRAFT")) return "checker";
  if (first.startsWith("An assistant is about to run")) return "argcheck";
  if (first.startsWith("You decide whether a task warrants")) return "select";
  if (first.startsWith("An assistant is about to send a reply")) return "final-check";
  return "other";
}

/** One extraction that opens an obligation, so the reminder note rides every turn. */
const EXTRACTION =
  '{"add":[{"request":1,"what":"Email every attendee","target":"","tools":["send_email"]}],"cancel":[]}';

function stubFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : {};
    const kind = kindOf(body);
    calls.push({ url, kind, body });
    const text = kind === "extract" ? EXTRACTION : '{"add":[],"cancel":[]}';
    const output: Body[] =
      kind === MAIN
        ? [
            { type: "reasoning", id: `rs_${turn}`, encrypted_content: `enc${turn}`, summary: [] },
            ...(script[Math.min(turn++, script.length - 1)] ?? []),
          ]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
    if (url.includes("/responses")) {
      return Response.json({
        id: `resp_${calls.length}`,
        object: "response",
        status: "completed",
        created_at: 1,
        output,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      });
    }
    // An OpenAI-compatible chat upstream (OpenRouter).
    const call = output.find((o) => o.type === "function_call");
    const message = call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.call_id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        }
      : { role: "assistant", content: kind === MAIN ? "Done." : text };
    return Response.json({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.OPENAI_API_KEY = "sk-upstream";
  process.env.OPENROUTER_API_KEY = "sk-openrouter";
  process.env.MODEL_API_KEYS = "sk-client:Agent1";
  process.env.MARINA_DECISIONS = "off";
  resetObligationsForTests();
  resetStickyNotesForTests();
  calls = [];
  turn = 0;
  script = [
    [{ type: "function_call", call_id: "c1", name: "list_meetings", arguments: "{}" }],
    [{ type: "function_call", call_id: "c2", name: "list_meetings", arguments: '{"day":1}' }],
    [{ type: "function_call", call_id: "c3", name: "send_email", arguments: '{"to":"a@b.c"}' }],
    [{ type: "function_call", call_id: "c4", name: "send_email", arguments: '{"to":"d@e.f"}' }],
    [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }],
  ];
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
  dir = mkdtempSync(join(tmpdir(), "stack-cache-"));
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

async function post(path: string, body: unknown, stack = "full") {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-client",
      "x-marina-stack": stack,
    },
    body: JSON.stringify(body),
  });
  return (await handleModelApi(url, "POST", req, engine))!;
}

const INSTRUCTIONS = "You are an automation agent. Follow the user's request exactly.";
const TASK = "Send follow-up emails to everyone in yesterday's zoom meetings.";
const RESPONSES_TOOLS = [
  {
    type: "function",
    name: "list_meetings",
    description: "List zoom meetings",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "send_email",
    description: "Send an email",
    parameters: { type: "object", properties: { to: { type: "string" } } },
  },
];
const CHAT_TOOLS = RESPONSES_TOOLS.map(({ type, ...fn }) => ({ type, function: fn }));

/** A chat-completions tool loop: the client resends its whole history each turn. */
async function chatLoop(model: string, stack = "full"): Promise<number[]> {
  const messages: Body[] = [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: TASK },
  ];
  const perTurn: number[] = [];
  for (let t = 0; t < script.length; t++) {
    const before = calls.length;
    const r = await post(
      "/v1/chat/completions",
      { model, messages, tools: CHAT_TOOLS, reasoning_effort: "medium" },
      stack,
    );
    expect(r.status).toBe(200);
    perTurn.push(calls.length - before);
    const msg = ((await r.json()) as { choices: { message: Body }[] }).choices[0]!.message;
    messages.push(msg);
    const toolCalls = (msg.tool_calls ?? []) as { id: string }[];
    if (toolCalls.length === 0) break;
    for (const c of toolCalls)
      messages.push({ role: "tool", tool_call_id: c.id, content: `{"ok":${t}}` });
  }
  return perTurn;
}

/** A Responses tool loop: the client resends its whole input each turn. */
async function responsesLoop(extra: Body = {}): Promise<void> {
  const input: Body[] = [{ role: "user", content: TASK }];
  for (let t = 0; t < script.length; t++) {
    const r = await post("/v1/responses", {
      model: "openai/gpt-6.1-sol",
      instructions: INSTRUCTIONS,
      tools: RESPONSES_TOOLS,
      input,
      ...extra,
    });
    expect(r.status).toBe(200);
    const out = ((await r.json()) as { output?: Body[] }).output ?? [];
    const call = out.find((o) => o.type === "function_call");
    if (!call) break;
    input.push(
      { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.call_id, output: `{"ok":${t}}` },
    );
  }
}

/** The conversation's upstream prompt items, in order, as compared bytes. */
function promptItems(body: Body): string[] {
  return ((body.input ?? body.messages) as unknown[]).map((item) => JSON.stringify(item));
}

/** Everything but the prompt items (tools, model, effort, cache key …). */
function settings(body: Body): string {
  const { input: _i, messages: _m, ...rest } = body;
  return JSON.stringify(rest);
}

/** Each main call's upstream request starts with the previous one, byte for byte. */
function expectAppendOnly(): void {
  const mains = calls.filter((c) => c.kind === MAIN).map((c) => c.body);
  expect(mains.length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < mains.length; i++) {
    const prev = promptItems(mains[i - 1]!);
    const next = promptItems(mains[i]!);
    expect(settings(mains[i]!)).toBe(settings(mains[i - 1]!));
    expect(next.slice(0, prev.length)).toEqual(prev);
    expect(next.length).toBeGreaterThan(prev.length);
  }
  // The test is only meaningful when Marina did add a note to the conversation.
  const last = promptItems(mains[mains.length - 1]!).join("\n");
  expect(last).toContain("[Marina obligations");
}

describe("upstream prefix under the full stack", () => {
  it("chat completions → OpenAI Responses upstream: every turn extends the last", async () => {
    await chatLoop("openai/gpt-6.1-sol");
    expect(calls.every((c) => c.url.endsWith("/v1/responses"))).toBe(true);
    expectAppendOnly();
  });

  it("chat completions → OpenAI-compatible chat upstream: every turn extends the last", async () => {
    await chatLoop("openrouter/openai/gpt-6.1-sol");
    expect(calls.every((c) => c.url.includes("openrouter"))).toBe(true);
    expectAppendOnly();
  });

  it("/v1/responses: every turn extends the last and the caller's cache key is forwarded", async () => {
    await responsesLoop({ prompt_cache_key: "task-7", store: false });
    expectAppendOnly();
    for (const c of calls) {
      // The conversation carries the key; side calls (other prefixes) never do.
      expect(c.body.prompt_cache_key).toBe(c.kind === MAIN ? "task-7" : undefined);
    }
  });

  it("a fresh trailing note every turn (sticky notes off) breaks the prefix", async () => {
    process.env.MARINA_PASSTHRU_STICKY_NOTES = "off";
    await chatLoop("openai/gpt-6.1-sol");
    const mains = calls.filter((c) => c.kind === MAIN).map((c) => promptItems(c.body));
    const broken = mains.slice(1).some((next, i) => {
      const prev = mains[i]!;
      return JSON.stringify(next.slice(0, prev.length)) !== JSON.stringify(prev);
    });
    expect(broken).toBe(true);
  });

  it("stack none sends the client's history untouched", async () => {
    await chatLoop("openai/gpt-6.1-sol", "none");
    expect(calls.map((c) => c.kind)).toEqual(Array(script.length).fill(MAIN));
    for (const c of calls) expect(promptItems(c.body).join("\n")).not.toContain("[Marina");
  });
});

describe("side calls per turn under the full stack", () => {
  it("the checker skips drafts of read-only lookups and reviews the rest", async () => {
    const perTurn = await chatLoop("openai/gpt-6.1-sol");
    // turn 1: extraction + main; lookups: main only; writes: main + checker
    // (+ the argument check's judge, + the review selection once); final: main + checker.
    expect(perTurn[0]).toBe(2);
    expect(perTurn[1]).toBe(1);
    expect(calls.filter((c) => c.kind === "checker").length).toBe(3);
    expect(calls.filter((c) => c.kind === "extract").length).toBe(1);
  });

  it("MARINA_VERIFY_REVIEW=all reviews every draft", async () => {
    process.env.MARINA_VERIFY_REVIEW = "all";
    await chatLoop("openai/gpt-6.1-sol");
    expect(calls.filter((c) => c.kind === "checker").length).toBe(
      calls.filter((c) => c.kind === MAIN).length,
    );
  });
});

describe("sticky notes (unit)", () => {
  const m = (role: string, content: string) => ({ role, content });

  it("re-inserts a note where it was sent, with the same bytes", () => {
    const h1 = [m("system", "s"), m("user", "task")];
    const first = planStickyNotes(h1, "NOTE-1", "scope-a");
    first.commit();
    const sent1 = withTrailingNote({ messages: first.messages }, first.note).messages as unknown[];
    const h2 = [...h1, m("assistant", "a"), m("tool", "r")];
    const second = planStickyNotes(h2, "NOTE-2", "scope-a");
    second.commit();
    const sent2 = withTrailingNote({ messages: second.messages }, second.note)
      .messages as unknown[];
    expect(sent2.slice(0, sent1.length)).toEqual(sent1);
    expect(sent2[sent2.length - 1]).toEqual(m("user", "NOTE-2"));
  });

  it("never hands one caller's note to another", () => {
    const h1 = [m("user", "task")];
    planStickyNotes(h1, "PRIVATE", "scope-a").commit();
    const other = planStickyNotes(
      [...h1, m("assistant", "a"), m("user", "b")],
      undefined,
      "scope-b",
    );
    expect(JSON.stringify(other.messages)).not.toContain("PRIVATE");
  });

  it("replaces the note at the final position (a nudge or a retry of the same history)", () => {
    const h = [m("user", "task"), m("assistant", "a"), m("tool", "r")];
    planStickyNotes(h, "REMINDER", "s").commit();
    const nudge = planStickyNotes(h, "REMINDER + NUDGE", "s");
    expect(nudge.messages).toEqual(h);
    expect(nudge.note).toBe("REMINDER + NUDGE");
    nudge.commit();
    const next = planStickyNotes([...h, m("assistant", "b"), m("tool", "r2")], undefined, "s");
    expect(JSON.stringify(next.messages)).toContain("REMINDER + NUDGE");
    expect(next.messages.filter((x) => JSON.stringify(x).includes("REMINDER")).length).toBe(1);
  });

  it("does not repeat a note identical to the latest one in the history", () => {
    const h = [m("user", "task"), m("assistant", "a"), m("tool", "r")];
    planStickyNotes(h, "SAME", "s").commit();
    const again = planStickyNotes([...h, m("assistant", "b"), m("tool", "r2")], "SAME", "s");
    expect(again.note).toBeUndefined();
  });

  it("scopes by credential and by the mapped name", () => {
    const req = (agent?: string) => ({
      headers: new Headers(agent ? { "X-Marina-Agent": agent } : {}),
    });
    const auth = { internal: false, openMode: false, matchedKey: "k1", canNameMap: true };
    expect(noteScopeFor(req("a"), auth)).not.toBe(noteScopeFor(req("b"), auth));
    expect(noteScopeFor(req(), auth)).not.toBe(noteScopeFor(req(), { ...auth, matchedKey: "k2" }));
    expect(noteScopeFor(req(), auth)).not.toContain("k1");
  });
});
