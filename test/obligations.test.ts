// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The obligations ledger: extraction → mechanical tracking → a trailing
 * reminder after the cache breakpoints → one nudge per obligation at a final
 * reply, never rewriting the model's output; opt-in on the passthru (model
 * prefix or header) and byte-identical without it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { Engine } from "../src/engine/engine";
import { appendTrailingNote, buildAnthropicRequest } from "../src/net/anthropic-tools";
import { handleModelApi } from "../src/net/model-api";
import { stripOptInPrefixes } from "../src/net/model-api/chat-completions";
import {
  conversationKey,
  conversationKeys,
  readConversation,
  resetObligationsForTests,
} from "../src/net/model-api/obligations";
import { withTrailingNote } from "../src/net/model-api/upstream";
import { AgentObligations } from "../src/obligations/agent";
import {
  checkFinalReply,
  EXTRACT_SYSTEM,
  extractionInput,
  parseExtraction,
  resolveMatch,
} from "../src/obligations/extract";
import { recoveredObligationOutcome } from "../src/obligations/learn";
import {
  applyExtraction,
  idTokens,
  LedgerStore,
  looksLikeError,
  matchCall,
  newLedger,
  nudgeNote,
  openObligations,
  readOnlyByName,
  reminderBlock,
} from "../src/obligations/ledger";
import { obligationsMode, parseObligationsMode } from "../src/obligations/mode";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const writes = (name: string) => !readOnlyByName(name);

describe("ledger (pure)", () => {
  it("adds extracted obligations, keeps only offered tools, de-duplicates, cancels", () => {
    const l = newLedger("k", 0);
    const tools = new Set(["cancel_order", "refund"]);
    const added = applyExtraction(
      l,
      1,
      {
        add: [
          { what: "Cancel order W123", target: "W123", tools: ["cancel_order", "made_up"] },
          { what: "  " },
        ],
        cancel: [],
      },
      tools,
      0,
    );
    expect(added).toEqual(["o1"]);
    expect(l.obligations[0]!.tools).toEqual(["cancel_order"]);
    applyExtraction(
      l,
      2,
      { add: [{ what: "cancel order w123", target: "W123" }], cancel: [] },
      tools,
      0,
    );
    expect(l.obligations.length).toBe(1);
    applyExtraction(l, 3, { add: [], cancel: ["o1"] }, tools, 0);
    expect(l.obligations[0]!.status).toBe("declined");
    expect(l.obligations[0]!.by).toBe("user");
  });

  it("settles on a named successful write call whose arguments share the target id", () => {
    const l = newLedger("k", 0);
    applyExtraction(
      l,
      1,
      {
        add: [
          { what: "Cancel order W1001", target: "W1001", tools: ["cancel_order"] },
          { what: "Cancel order W2002", target: "W2002", tools: ["cancel_order"] },
        ],
        cancel: [],
      },
      new Set(["cancel_order"]),
      0,
    );
    // Failed and read-only calls settle nothing.
    expect(
      matchCall(
        l,
        { name: "cancel_order", args: { order_id: "W2002" }, turn: 1, ok: false },
        writes,
      ).satisfied,
    ).toEqual([]);
    expect(
      matchCall(l, { name: "get_order", args: { order_id: "W2002" }, turn: 1, ok: true }, writes)
        .satisfied,
    ).toEqual([]);
    const m = matchCall(
      l,
      { name: "cancel_order", args: { order_id: "W2002" }, turn: 1, ok: true },
      writes,
    );
    expect(m.satisfied).toEqual(["o2"]);
    expect(openObligations(l).map((o) => o.id)).toEqual(["o1"]);
    // A call made before the obligation's request never settles it.
    applyExtraction(
      l,
      3,
      { add: [{ what: "Refund R555", target: "R555", tools: ["refund"] }], cancel: [] },
      new Set(["refund"]),
      0,
    );
    expect(
      matchCall(l, { name: "refund", args: { id: "R555" }, turn: 2, ok: true }, writes).satisfied,
    ).toEqual([]);
  });

  it("leaves equally plausible candidates ambiguous, and a transfer settles everything", () => {
    const l = newLedger("k", 0);
    applyExtraction(
      l,
      1,
      {
        add: [
          { what: "Update the address", tools: ["update_profile"] },
          { what: "Update the phone", tools: ["update_profile"] },
        ],
        cancel: [],
      },
      new Set(["update_profile"]),
      0,
    );
    const m = matchCall(l, { name: "update_profile", args: { x: 1 }, turn: 1, ok: true }, writes);
    expect(m.satisfied).toEqual([]);
    expect(m.ambiguous).toEqual(["o1", "o2"]);
    const t = matchCall(
      l,
      { name: "transfer_to_human_agents", args: {}, turn: 1, ok: true },
      writes,
    );
    expect(t.satisfied).toEqual(["o1", "o2"]);
    expect(
      l.obligations.every((o) => o.status === "declined" && o.by?.startsWith("transfer:")),
    ).toBe(true);
  });

  it("renders a bounded reminder and a nudge that quotes the draft", () => {
    const l = newLedger("k", 0);
    expect(reminderBlock(l)).toBeUndefined();
    applyExtraction(
      l,
      1,
      { add: [{ what: "Close card 4417", target: "4417", constraints: "today" }], cancel: [] },
      new Set(),
      0,
    );
    const r = reminderBlock(l)!;
    expect(r).toContain("[Marina obligations");
    expect(r).toContain("o1: Close card 4417 (target: 4417; today)");
    expect(r).toContain("still ask for any confirmation the rules require");
    const n = nudgeNote("All set, goodbye!", openObligations(l));
    expect(n).toContain("«All set, goodbye!»");
    expect(n).toContain("send your drafted reply unchanged");
  });

  it("detects error results and id-like tokens", () => {
    expect(looksLikeError("Error: order not found")).toBe(true);
    expect(looksLikeError('{"error":"x"}')).toBe(true);
    expect(looksLikeError('{"status":"ok"}')).toBe(false);
    expect([...idTokens({ a: "#W123 and 7", b: 4417, c: [12] })].sort()).toEqual(["4417", "w123"]);
    expect(readOnlyByName("get_user_details")).toBe(true);
    expect(readOnlyByName("marina_look")).toBe(true);
    expect(readOnlyByName("cancel_pending_order")).toBe(false);
  });

  it("carries a conversation's state from its deepest known ancestor key as a copy", () => {
    const s = new LedgerStore(1000, 100);
    const shared = newLedger("k0", 0);
    shared.userTurns = 1;
    s.put(shared);
    expect(s.resolve(["k0"], 1)).toBe(shared);
    expect(s.resolve(["x", "y"], 1)).toBeUndefined();
    // Two conversations that shared k0 continue on k1a and k1b, each from a copy.
    const a = s.resolve(["k0", "k1a"], 1)!;
    const b = s.resolve(["k0", "k1b"], 1)!;
    expect(a.key).toBe("k1a");
    expect(b.key).toBe("k1b");
    expect(a.userTurns).toBe(1);
    a.userTurns = 5;
    expect(b.userTurns).toBe(1);
    expect(s.get("k0", 1)!.userTurns).toBe(1);
    expect(s.resolve(["k0", "k1a"], 1)).toBe(a);
    // A skipped checkpoint resolves through the deepest ancestor present.
    expect(s.resolve(["k0", "k1a", "k2", "k3"], 1)!.userTurns).toBe(5);
  });

  it("keeps ledgers in a bounded, expiring store", () => {
    const s = new LedgerStore(1000, 2);
    s.put(newLedger("a", 0));
    s.put(newLedger("b", 0));
    s.put(newLedger("c", 0));
    expect(s.get("a", 10)).toBeUndefined();
    expect(s.get("c", 10)?.key).toBe("c");
    expect(s.get("c", 5000)).toBeUndefined();
  });
});

describe("model calls (extraction, matching, final check)", () => {
  it("parses extraction leniently and shows only write tools", () => {
    expect(parseExtraction("no json")).toBeUndefined();
    const e = parseExtraction(
      'sure:\n```json\n{"add":[{"request":2,"what":"Refund","tools":["refund",3]}],"cancel":["o1","x"]}\n```',
    )!;
    expect(e.add).toEqual([{ what: "Refund", turn: 2, tools: ["refund"] }]);
    expect(e.cancel).toEqual(["o1"]);
    const input = extractionInput({
      tools: [
        { name: "refund", description: "Refund an order", write: true },
        { name: "get_order", write: false },
      ],
      open: [],
      requests: [{ turn: 1, text: "Please refund W1", before: "How can I help?" }],
    });
    expect(input).toContain("- refund: Refund an order");
    expect(input).not.toContain("get_order");
    expect(input).toContain("NEW REQUEST 1:\nPlease refund W1");
    expect(EXTRACT_SYSTEM).toContain("JSON only");
  });

  it("classifies a final reply with a decision provider or the chat model; failure is undefined", async () => {
    const l = newLedger("k", 0);
    applyExtraction(
      l,
      1,
      { add: [{ what: "Refund W1" }, { what: "Close card" }], cancel: [] },
      new Set(),
      0,
    );
    const open = openObligations(l);
    const viaChat = await checkFinalReply(
      { open, draft: "Done!", recentCalls: [] },
      { complete: async () => '{"o1":"owed","o2":"waiting","o3":"owed"}' },
    );
    expect(viaChat).toEqual({ o1: "owed", o2: "waiting" });
    const viaProvider = await checkFinalReply(
      { open, draft: "Done!", recentCalls: [] },
      {
        provider: {
          kind: "test",
          model: "t",
          ask: async (req) => ({
            answers: Object.fromEntries(
              Object.keys(req.questions).map((k) => [
                k,
                { type: "choice" as const, choice: k === "o1" ? "declined" : "done" },
              ]),
            ),
            model: "t",
            provider: "test",
            latencyMs: 1,
          }),
        },
      },
    );
    expect(viaProvider).toEqual({ o1: "declined", o2: "done" });
    expect(
      await checkFinalReply(
        { open, draft: "x", recentCalls: [] },
        {
          complete: async () => {
            throw new Error("down");
          },
        },
      ),
    ).toBeUndefined();
    const pick = await resolveMatch({ name: "update_profile", args: {}, turn: 1, ok: true }, open, {
      complete: async () => '{"match":"o2"}',
    });
    expect(pick).toBe("o2");
  });

  it("writes a general recovered-obligation outcome with the case kept private", () => {
    const l = newLedger("k", 0);
    applyExtraction(l, 1, { add: [{ what: "Close card 4417" }], cancel: [] }, new Set(), 0);
    const o = recoveredObligationOutcome({
      surface: "passthru",
      owed: openObligations(l),
      tool: "close_card",
      now: 0,
    });
    expect(o.source).toBe("obligations:passthru");
    expect(o.attempted).not.toContain("4417");
    expect(o.detail).not.toContain("4417");
    expect(o.privateContext).toContain("4417");
  });
});

describe("trailing note placement", () => {
  it("appends after the cache breakpoints on the Anthropic route", () => {
    const body = {
      model: "claude-fable-5-1",
      messages: [
        { role: "system", content: "S".repeat(4000) },
        { role: "user", content: "U".repeat(4000) },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "R".repeat(4000) },
      ],
    };
    const out = buildAnthropicRequest(body, "claude-fable-5-1", false, {
      autoCache: true,
      trailingNote: "NOTE",
    }) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const last = out.messages[out.messages.length - 1]!;
    expect(last.role).toBe("user");
    const blocks = last.content;
    expect(blocks[blocks.length - 1]).toEqual({ type: "text", text: "NOTE" });
    // The rolling breakpoint sits on the tool result before the note.
    expect(blocks[blocks.length - 2]!.cache_control).toEqual({ type: "ephemeral" });
    // Without the note the request is otherwise identical.
    const plain = buildAnthropicRequest(body, "claude-fable-5-1", false, { autoCache: true }) as {
      messages: Array<{ content: unknown[] }>;
    };
    const lastPlain = plain.messages[plain.messages.length - 1]!.content;
    expect(blocks.slice(0, -1)).toEqual(lastPlain as Array<Record<string, unknown>>);
    expect(appendTrailingNote([{ role: "assistant", content: "hi" }], "N")).toEqual([
      { role: "assistant", content: "hi" },
      { role: "user", content: [{ type: "text", text: "N" }] },
    ]);
  });

  it("appends to the last user message or adds one on the OpenAI shape", () => {
    const b = { messages: [{ role: "user", content: "hello" }] };
    expect(withTrailingNote(b, undefined)).toBe(b);
    expect(withTrailingNote(b, "N").messages).toEqual([{ role: "user", content: "hello\n\nN" }]);
    const t = { messages: [{ role: "tool", tool_call_id: "x", content: "r" }] };
    expect((withTrailingNote(t, "N").messages as unknown[]).at(-1)).toEqual({
      role: "user",
      content: "N",
    });
    expect(b.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("opt-in parsing", () => {
  it("strips opt-in prefixes in any order and reads the modes", () => {
    expect(stripOptInPrefixes("marina/lessons:marina/obligations:openai/x")).toBe("openai/x");
    expect(
      stripOptInPrefixes("marina/obligations:marina/lessons:openai/x", "marina/lessons:"),
    ).toBe("marina/lessons:openai/x");
    expect(stripOptInPrefixes("openai/x", "marina/lessons:")).toBe("openai/x");
    expect(parseObligationsMode("observe")).toBe("observe");
    expect(parseObligationsMode("junk")).toBeUndefined();
    expect(obligationsMode({})).toBe("off");
    expect(obligationsMode({ MARINA_OBLIGATIONS: "on" })).toBe("on");
  });

  it("keys a conversation by a chain over its history (or the session header) and reads calls with results", () => {
    const msgs = [
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
    ];
    const r = new Request("http://x/v1/chat/completions");
    const k1 = conversationKeys(r, msgs as never);
    const longer = conversationKeys(r, [
      ...msgs,
      { role: "assistant", content: "ok" },
      { role: "user", content: "more" },
    ] as never);
    // The longer history extends the same chain: its shallower keys are the shorter one's.
    expect(longer.slice(0, k1.length)).toEqual(k1);
    expect(longer.length).toBeGreaterThan(k1.length);
    expect(conversationKey(r, msgs as never)).toBe(k1[k1.length - 1]!);
    // The declared tools are part of the key.
    expect(conversationKeys(r, msgs as never, undefined, [{ type: "function" }])[0]).not.toBe(
      k1[0],
    );
    // Between checkpoints the key holds still (9 → 11 non-system messages stay on checkpoint 8).
    const many = (n: number) =>
      [
        { role: "system", content: "rules" },
        ...Array.from({ length: n }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: `m${i}`,
        })),
      ] as never;
    expect(conversationKey(r, many(9))).toBe(conversationKey(r, many(11)));
    expect(conversationKey(r, many(12))).not.toBe(conversationKey(r, many(11)));
    const withSession = new Request("http://x", { headers: { "x-marina-session": "abc" } });
    expect(conversationKeys(withSession, msgs as never)).toEqual([
      expect.stringContaining("s:abc"),
    ]);
    const conv = readConversation([
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Cancel W1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "cancel", arguments: '{"id":"W1"}' } },
          { id: "b", type: "function", function: { name: "never_answered", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "Error: nope" },
    ] as never);
    expect(conv.requests).toEqual([{ turn: 1, text: "Cancel W1", before: "Hello" }]);
    expect(conv.calls).toEqual([{ name: "cancel", args: { id: "W1" }, turn: 1, ok: false }]);
  });
});

describe("agent loop ledger", () => {
  it("is inert when off, tracks in observe, and nudges once when on", async () => {
    let mode: "off" | "observe" | "on" = "off";
    let calls = 0;
    const a = new AgentObligations({
      mode: () => mode,
      complete: async () => {
        calls++;
        return '{"add":[{"what":"Close card 4417","target":"4417","tools":["marina_command"]}],"cancel":[]}';
      },
    });
    a.noteRequest("please close card 4417");
    await a.refresh([{ name: "marina_command", write: true }]);
    expect(calls).toBe(0);
    mode = "observe";
    a.noteRequest("please close card 4417");
    await a.refresh([{ name: "marina_command", write: true }]);
    expect(calls).toBe(1);
    expect(a.section()).toBeUndefined();
    expect(a.nudge()).toBeUndefined();
    mode = "on";
    expect(a.section()).toContain("o1: Close card 4417");
    expect(a.nudge()).toContain("Close card 4417");
    expect(a.nudge()).toBeUndefined();
    a.observeToolResult("marina_command", { command: "card close 4417" }, true, () => true);
    expect(a.section()).toBeUndefined();
    expect(a.summary().satisfied).toBe(1);
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
let extraction: string;
let verdicts: string;
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

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  resetObligationsForTests();
  seen = [];
  extraction =
    '{"add":[{"request":1,"what":"Close card 4417","target":"4417","tools":["close_card"]}],"cancel":[]}';
  verdicts = '{"o1":"owed"}';
  replies = [{ role: "assistant", content: "Anything else?" }];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const system = systemText(body);
    let kind = "main";
    let message: Record<string, unknown>;
    if (system.startsWith("You keep the ledger")) {
      kind = "extract";
      message = { role: "assistant", content: extraction };
    } else if (system.startsWith("An assistant is about to send a reply")) {
      kind = "check";
      message = { role: "assistant", content: verdicts };
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
  dir = mkdtempSync(join(tmpdir(), "obligations-"));
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

const lastUserText = (body: Record<string, unknown>) => {
  const msgs = body.messages as { role: string; content: unknown }[];
  const last = msgs[msgs.length - 1]!;
  return { role: last.role, text: String(last.content) };
};

describe("POST /v1/chat/completions with the obligations ledger", () => {
  it("never mixes two conversations with the same opening once they diverge", async () => {
    const model = `marina/obligations:${MODEL}`;
    const counters = (r: Response) => r.headers.get("x-marina-obligations") ?? "";
    // Both start identically: one shared ledger (indistinguishable so far), one obligation.
    expect(counters(await post({ model, messages: opening, tools: TOOLS }))).toContain("open=1");
    expect(counters(await post({ model, messages: opening, tools: TOOLS }))).toContain("open=1");
    extraction = '{"add":[],"cancel":[]}';
    const closeCall = (id: string, name: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: '{"card_id":"4417"}' } }],
    });
    // A confirms and closes the card: its obligation is satisfied.
    const a = [
      ...opening,
      { role: "assistant", content: "Confirm closing card 4417?" },
      { role: "user", content: "Yes." },
      closeCall("t1", "close_card"),
      { role: "tool", tool_call_id: "t1", content: '{"status":"closed"}' },
    ];
    expect(counters(await post({ model, messages: a, tools: TOOLS }))).toContain("satisfied=1");
    // B diverged after the opening and only looked the card up: A's settlement is not B's.
    const b = [
      ...opening,
      { role: "assistant", content: "Which card do you mean?" },
      { role: "user", content: "The one ending 4417, but wait, let me think." },
      closeCall("t2", "get_card"),
      { role: "tool", tool_call_id: "t2", content: '{"card":"4417","status":"active"}' },
    ];
    const bResp = counters(await post({ model, messages: b, tools: TOOLS }));
    expect(bResp).toContain("open=1");
    expect(bResp).toContain("satisfied=0");
    // A keeps its own state.
    const aMore = [
      ...a,
      { role: "assistant", content: "Done." },
      { role: "user", content: "Thanks." },
    ];
    expect(counters(await post({ model, messages: aMore, tools: TOOLS }))).toContain("satisfied=1");
  });

  it("is byte-identical without the opt-in", async () => {
    const req = { model: MODEL, messages: opening, tools: TOOLS };
    const resp = await post(req);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-marina-obligations")).toBeNull();
    expect(seen.map((s) => s.kind)).toEqual(["main"]);
    expect(seen[0]!.body.messages).toEqual(opening);
  });

  it("extracts, appends the open obligations after the conversation, and strips the prefix", async () => {
    const resp = await post({
      model: `marina/obligations:${MODEL}`,
      messages: opening,
      tools: TOOLS,
    });
    expect(seen.map((s) => s.kind).slice(0, 2)).toEqual(["extract", "main"]);
    const main = seen[1]!.body;
    expect(main.model).toBe("openai/gpt-6.1-sol");
    const last = lastUserText(main);
    expect(last.role).toBe("user");
    expect(last.text.startsWith("Please close my card 4417.\n\n[Marina obligations")).toBe(true);
    expect(last.text).toContain("o1: Close card 4417");
    // The prefix (system + earlier messages) is untouched.
    expect((main.messages as unknown[]).slice(0, 2)).toEqual(opening.slice(0, 2));
    expect(resp.headers.get("x-marina-obligations")).toContain("open=1");
  });

  it("settles on a matching successful call; a final reply then needs no check", async () => {
    await post({ model: `marina/obligations:${MODEL}`, messages: opening, tools: TOOLS });
    seen = [];
    const later = [
      ...opening,
      { role: "assistant", content: "Confirm closing card 4417?" },
      { role: "user", content: "Yes." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "close_card", arguments: '{"card_id":"4417"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: '{"status":"closed"}' },
    ];
    extraction = '{"add":[],"cancel":[]}';
    const resp = await post({
      model: `marina/obligations:${MODEL}`,
      messages: later,
      tools: TOOLS,
    });
    expect(seen.map((s) => s.kind)).toEqual(["extract", "main"]);
    // No open obligation: no note on the tool-result tail.
    expect(lastUserText(seen[1]!.body).role).toBe("tool");
    expect(resp.headers.get("x-marina-obligations")).toContain("satisfied=1");
    expect(resp.headers.get("x-marina-obligations")).toContain("check=none-open");
  });

  it("nudges a final reply that leaves an obligation owed, once, and returns the model's second reply", async () => {
    replies = [
      { role: "assistant", content: "All done, goodbye!" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t9",
            type: "function",
            function: { name: "close_card", arguments: '{"card_id":"4417"}' },
          },
        ],
      },
    ];
    const resp = await post({
      model: `marina/obligations:${MODEL}`,
      messages: opening,
      tools: TOOLS,
    });
    expect(seen.map((s) => s.kind)).toEqual(["extract", "main", "check", "main"]);
    const nudge = lastUserText(seen[3]!.body).text;
    expect(nudge).toContain("«All done, goodbye!»");
    expect(nudge).toContain("o1: Close card 4417");
    expect(resp.headers.get("x-marina-obligations")).toContain("check=nudged-acted");
    const j = (await resp.json()) as {
      choices: { message: { tool_calls?: { function: { name: string } }[] } }[];
    };
    expect(j.choices[0]!.message.tool_calls?.[0]?.function.name).toBe("close_card");
    // At most once per obligation: the next final reply is returned as drafted.
    seen = [];
    replies = [{ role: "assistant", content: "Goodbye!" }];
    const again = await post({
      model: `marina/obligations:${MODEL}`,
      messages: [
        ...opening,
        { role: "assistant", content: "Anything else?" },
        { role: "user", content: "No." },
      ],
      tools: TOOLS,
    });
    expect(seen.map((s) => s.kind)).toEqual(["extract", "main"]);
    expect(again.headers.get("x-marina-obligations")).toContain("check=none-open");
  });

  it("leaves a reply that waits on the user alone", async () => {
    verdicts = '{"o1":"waiting"}';
    replies = [{ role: "assistant", content: "Do you confirm closing card 4417?" }];
    const resp = await post({
      model: `marina/obligations:${MODEL}`,
      messages: opening,
      tools: TOOLS,
    });
    expect(seen.map((s) => s.kind)).toEqual(["extract", "main", "check"]);
    expect(resp.headers.get("x-marina-obligations")).toContain("check=handled");
    const j = (await resp.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]!.message.content).toBe("Do you confirm closing card 4417?");
  });

  it("observes without showing anything (header opt-in), combinable with lessons", async () => {
    const resp = await post(
      { model: `marina/lessons:${MODEL}`, messages: opening, tools: TOOLS },
      { "x-marina-obligations": "observe" },
    );
    expect(seen.map((s) => s.kind)).toEqual(["extract", "main"]);
    expect(lastUserText(seen[1]!.body).text).toBe("Please close my card 4417.");
    expect(resp.headers.get("x-marina-obligations")).toContain("observe;open=1");
    expect(resp.headers.get("x-marina-lessons")).not.toBeNull();
  });

  it("skips a request without tools, and fails open when extraction fails", async () => {
    const none = await post({ model: `marina/obligations:${MODEL}`, messages: opening });
    expect(none.headers.get("x-marina-obligations")).toBe("on;skipped=no-tools");
    expect(seen.map((s) => s.kind)).toEqual(["main"]);
    resetObligationsForTests();
    seen = [];
    extraction = "not json";
    const resp = await post({
      model: `marina/obligations:${MODEL}`,
      messages: opening,
      tools: TOOLS,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-marina-obligations")).toContain("extract=failed");
    expect(lastUserText(seen[1]!.body).text).toBe("Please close my card 4417.");
  });
});
