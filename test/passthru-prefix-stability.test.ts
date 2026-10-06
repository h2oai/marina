// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt-cache stability of the passthru's per-request injections. Memory
 * context and opt-in lessons are volatile (relevance-gated, re-chosen as notes
 * and lessons accrue), so they ride as ONE trailing note after the cache
 * breakpoints. Across the turns of one conversation, everything the upstream
 * cached on the previous turn — tools, system prompt, every earlier message —
 * is re-sent byte-identical, whatever was injected; and lessons are chosen
 * from the conversation's opening request, so the set changes only when the
 * lesson pool does. Covered on the Anthropic route (native `cache_control`)
 * and on OpenRouter `anthropic/*` (markers on OpenAI content parts).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import { type Lesson, memoryLessonSink } from "../src/learning/outcomes";
import { disableOutcomeLearning, enableOutcomeLearning } from "../src/learning/service";
import { handleModelApi } from "../src/net/model-api";
import { lessonQuery } from "../src/net/model-api/passthru";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { INJECTION_MARKER } from "../src/net/passthru-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture } from "./fixtures/unified-memory-fixture";
import { makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const ENV = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_ANTHROPIC_AUTO_CACHE",
  "MARINA_PROFILE",
  "MARINA_LESSONS",
] as const;

const QUESTION = `what is the ${FIXTURE_QUERY}?`;
const AUTH = { Authorization: "Bearer sk-ada" };
/** Long enough that the rolling message breakpoint is placed (≥ 1024 est. tokens). */
const SYSTEM = `You are terse. ${"Follow the deployment runbook exactly. ".repeat(160)}`;
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_port",
      description: "Look up a deployment port",
      parameters: { type: "object", properties: { service: { type: "string" } } },
    },
  },
];

const lesson = (id: string, text: string): Lesson => ({
  id,
  domain: "tools",
  text,
  kind: "failure",
  trust: "trusted",
  resolvedAt: "2026-09-01T00:00:00.000Z",
  source: "test:prefix",
});

type Msg = Record<string, unknown>;

/** Turn 1, then the tool round trip, then a new user turn on another topic. */
function conversation(): Msg[][] {
  const turn1: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: QUESTION },
  ];
  const turn2: Msg[] = [
    ...turn1,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_port", arguments: '{"service":"amber"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "port 7419" },
  ];
  const turn3: Msg[] = [
    ...turn2,
    { role: "assistant", content: "Port 7419." },
    { role: "user", content: "And what weather forecast is due for the city tomorrow?" },
  ];
  return [turn1, turn2, turn3];
}

/** `value` with every `cache_control` removed (markers move turn to turn by design). */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (k !== "cache_control") out[k] = unmarked(v);
  return out;
}

/** Messages in one comparable shape: string content becomes one text block. */
function normalized(messages: unknown): Msg[] {
  return (unmarked(messages) as Msg[]).map((m) =>
    typeof m.content === "string" ? { ...m, content: [{ type: "text", text: m.content }] } : m,
  );
}

type Part = { type?: string; text?: string; cache_control?: unknown };

/** The trailing note of a forwarded request, and its messages without it. */
function splitNote(messages: Msg[]): { note: string; rest: Msg[]; marked: boolean } {
  const rest = normalized(messages);
  const raw = messages.at(-1)!.content as Part[] | string;
  const last = rest.at(-1)!;
  const parts = last.content as Part[];
  const note = parts.at(-1)?.text ?? "";
  expect(note).toStartWith(INJECTION_MARKER);
  const marked = Array.isArray(raw) && raw.at(-1)?.cache_control !== undefined;
  const kept = parts.slice(0, -1);
  if (kept.length) rest[rest.length - 1] = { ...last, content: kept };
  else rest.pop();
  return { note, rest, marked };
}

for (const route of ["anthropic", "openrouter"] as const) {
  describe(`passthru prefix stability across turns (${route})`, () => {
    let processState: DisposableStack | undefined;
    let saved: Map<string, string | undefined>;
    let originalFetch: typeof fetch;
    let dir: string;
    let db: MarinaDB;
    let engine: Engine;
    let upstream: Record<string, unknown>[];

    beforeEach(async () => {
      using pending = scopeProcessState();
      saved = new Map(ENV.map((k) => [k, process.env[k]]));
      for (const k of ENV) delete process.env[k];
      if (route === "anthropic") process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      else process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.MARINA_ANTHROPIC_AUTO_CACHE = "true";
      process.env.MODEL_API_KEYS = "sk-ada:Ada";
      resetTrustProfileForTests();
      originalFetch = globalThis.fetch;
      upstream = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const body = (await new Request(input, init).json()) as Record<string, unknown>;
        upstream.push(body);
        return route === "anthropic"
          ? Response.json({
              id: "msg_up",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 2 },
            })
          : Response.json({
              id: "chatcmpl-up",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            });
      }) as typeof fetch;
      dir = mkdtempSync(join(tmpdir(), "prefix-stability-"));
      db = new MarinaDB(join(dir, "w.db"));
      engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
      engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
      setEndpointConfig(db, {
        mode: "passthru",
        passthruModel:
          route === "anthropic"
            ? "anthropic/claude-sonnet-5"
            : "openrouter/anthropic/claude-sonnet-5",
      });
      const fx = await seedUnifiedFixture(engine, db);
      engine.entities.get(fx.ownerEntityId)!.properties.passthruContext = true;
      processState = pending.move();
    });

    afterEach(() => {
      using _state = processState;
      processState = undefined;
      disableOutcomeLearning(db);
      globalThis.fetch = originalFetch;
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      engine.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    async function post(messages: Msg[], headers: Record<string, string> = {}) {
      const url = new URL("http://localhost:3300/v1/chat/completions");
      const req = new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH, ...headers },
        body: JSON.stringify({ model: "marina", messages, tools: TOOLS }),
      });
      const resp = await handleModelApi(url, "POST", req, engine);
      expect(resp?.status).toBe(200);
      return resp!;
    }

    /** What the upstream cached: tools + system (Anthropic) and the messages. */
    const prefixOf = (body: Record<string, unknown>) => ({
      tools: body.tools,
      system: body.system,
    });

    it("re-sends the previous turn byte-identical while memory and lessons change", async () => {
      const sink = memoryLessonSink([
        lesson("L1", "check the Amber deployment port in the runbook before answering"),
        lesson("W1", "weather forecast questions for a city need the city's tomorrow date"),
      ]);
      enableOutcomeLearning(db, { sink, writer: null, judge: null, env: {} });
      const turns = conversation();
      const headers = { "x-marina-lessons": "on" };
      const served: (string | null)[] = [];
      for (const [i, turn] of turns.entries()) {
        // The pool changes between turns 2 and 3.
        if (i === 2) await sink.write(lesson("L2", "confirm which Amber deployment port is live"));
        served.push((await post(turn, headers)).headers.get("x-marina-lessons"));
      }
      expect(upstream).toHaveLength(3);

      // Lessons: chosen from the opening request on every turn (the weather
      // lesson matching turn 3's new message is never served); re-chosen when
      // the pool changed.
      expect(served[0]).toContain("L1");
      expect(served[1]).toBe(served[0]);
      expect(served[2]).toContain("L2");
      for (const s of served) expect(s).not.toContain("W1");

      const split = upstream.map((b) => splitNote(b.messages as Msg[]));
      for (const s of split) {
        expect(s.note).toContain("LESSONS (from past outcomes");
        // The note is never under a cache breakpoint.
        expect(s.marked).toBe(false);
      }
      // A breakpoint does sit on the conversation before the note.
      expect(JSON.stringify(upstream[1]!.messages)).toContain("cache_control");

      for (let i = 1; i < upstream.length; i++) {
        const before = upstream[i - 1]!;
        const after = upstream[i]!;
        // Tools and system prompt (markers included) are byte-identical.
        expect(JSON.stringify(prefixOf(after))).toBe(JSON.stringify(prefixOf(before)));
        // Every message the previous turn sent (without its note) is re-sent unchanged.
        const prev = split[i - 1]!.rest;
        expect(normalized(after.messages).slice(0, prev.length)).toEqual(prev);
      }
      // The system prompt never carries the injected context.
      for (const body of upstream) {
        expect(JSON.stringify(body.system ?? "")).not.toContain(INJECTION_MARKER);
        const systemMessages = (body.messages as Msg[]).filter((m) => m.role === "system");
        expect(JSON.stringify(systemMessages)).not.toContain(INJECTION_MARKER);
      }
    });

    it("an opted-out request carries no note and the same prefix as an injected one", async () => {
      const [turn1] = conversation();
      await post(turn1!);
      await post(turn1!, { "X-Marina-Context": "off" });
      const [injected, plain] = upstream;
      expect(JSON.stringify(prefixOf(injected!))).toBe(JSON.stringify(prefixOf(plain!)));
      expect(JSON.stringify(plain!.messages)).not.toContain(INJECTION_MARKER);
      // Without its note, the injected request's conversation is the plain one.
      expect(splitNote(injected!.messages as Msg[]).rest).toEqual(normalized(plain!.messages));
    });
  });
}

describe("passthru with nothing opted in", () => {
  let processState: DisposableStack | undefined;
  let saved: Map<string, string | undefined>;
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let upstream: Record<string, unknown>[];

  beforeEach(() => {
    using pending = scopeProcessState();
    saved = new Map(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MODEL_API_KEYS = "sk-plain";
    resetTrustProfileForTests();
    originalFetch = globalThis.fetch;
    upstream = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      upstream.push((await new Request(input, init).json()) as Record<string, unknown>);
      return Response.json({
        id: "chatcmpl-up",
        object: "chat.completion",
        created: 1,
        model: "gpt-6.1-sol",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      });
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "prefix-plain-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-6.1-sol" });
    processState = pending.move();
  });

  afterEach(() => {
    using _state = processState;
    processState = undefined;
    disableOutcomeLearning(db);
    globalThis.fetch = originalFetch;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    engine.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards every turn byte-identical to the client's body, even with lessons in the pool", async () => {
    const sink = memoryLessonSink([lesson("L1", "check the Amber deployment port first")]);
    enableOutcomeLearning(db, { sink, writer: null, judge: null, env: {} });
    for (const turn of conversation()) {
      const body = { model: "marina", messages: turn, tools: TOOLS };
      const url = new URL("http://localhost:3300/v1/chat/completions");
      const req = new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-plain" },
        body: JSON.stringify(body),
      });
      const resp = await handleModelApi(url, "POST", req, engine);
      expect(resp?.status).toBe(200);
      expect(resp!.headers.get("x-marina-lessons")).toBeNull();
      expect(JSON.stringify(upstream.at(-1))).toBe(
        JSON.stringify({ ...body, model: "gpt-6.1-sol" }),
      );
    }
  });
});

describe("lessonQuery", () => {
  it("is the conversation's opening user request, whatever came after", () => {
    const [turn1, , turn3] = conversation();
    expect(lessonQuery(turn1!)).toBe(QUESTION);
    expect(lessonQuery(turn3!)).toBe(QUESTION);
    expect(lessonQuery([{ role: "user", content: [{ type: "text", text: "  hi  " }] }])).toBe("hi");
    expect(lessonQuery([{ role: "system", content: "s" }])).toBe("");
  });
});
