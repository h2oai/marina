// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina/verify:` with the Arbiter (`MARINA_VERIFY_ARBITER` /
 * `x-marina-arbiter`): a checker's flag on a FINAL answer is a dissent the
 * Arbiter adjudicates from the tool results, instead of a free revision.
 * Off is unchanged; observe only reports; on keeps the draft unless the
 * overrule clears the bar. Upstream mocked.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationFromLabel } from "../benchmarks/modes/passthrough";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model/model-api";
import {
  arbiterItemFor,
  finalAnswerDraft,
  toolResultSources,
  verifyArbiterMode,
} from "../src/net/model-api/verify";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const ENV = [
  ...modelSourceEnvKeys(),
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_VERIFY_CHECKER_MODEL",
  "MARINA_VERIFY_ROUNDS",
  "MARINA_VERIFY_ARBITER",
  "MARINA_ARBITER_CAP",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let calls: Array<{ kind: string; tail: string }>;
let arbiterReply: Record<string, unknown>;

const TOOL_RESULT = JSON.stringify([
  { docid: "d1", url: "https://www.reuters.com/a", text: "The final score was 3-1 to Brazil." },
  { docid: "d2", url: "https://apnews.com/b", text: "Brazil beat Spain 3-1 on Sunday." },
]);

const OVERRULE = {
  verdict: "overrule",
  answer: "Brazil",
  items: [
    {
      item: "Brazil",
      citations: [
        { source: "https://www.reuters.com/a", quote: "The final score was 3-1 to Brazil." },
        { source: "https://apnews.com/b", quote: "Brazil beat Spain 3-1 on Sunday." },
      ],
    },
  ],
  source_quality: 0.9,
  reasoning_quality: 0.8,
  confidence: 0.85,
  reason: "Two wire reports.",
};

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  calls = [];
  arbiterReply = OVERRULE;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const msgs = (body.messages ?? []) as { role: string; content: unknown }[];
    const text = (c: unknown) =>
      Array.isArray(c) ? (c as { text?: string }[]).map((p) => p.text ?? "").join("") : String(c);
    const system = msgs
      .filter((m) => m.role === "system")
      .map((m) => text(m.content))
      .join("\n");
    const tail = text(msgs.at(-1)?.content ?? "");
    const kind = system.includes("You are the Arbiter")
      ? "arbiter"
      : system.includes("You review an assistant's DRAFT")
        ? "checker"
        : tail.includes("A reviewer checked your draft")
          ? "revision"
          : "proposer";
    calls.push({ kind, tail });
    const content =
      kind === "arbiter"
        ? JSON.stringify(arbiterReply)
        : kind === "checker"
          ? '{"verdict":"revise","issues":"The answer looks wrong; double-check the winner."}'
          : kind === "revision"
            ? "Brazil"
            : "Spain";
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "arbiter-verify-"));
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

async function post(headers: Record<string, string> = {}) {
  const url = new URL("http://localhost:3300/v1/chat/completions");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: "marina/verify:openrouter/openai/gpt-6.1-sol",
      messages: [
        { role: "system", content: "Answer with the team name only." },
        { role: "user", content: "Who won the final?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "search", arguments: '{"q":"final"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: TOOL_RESULT },
      ],
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
    }),
  });
  const resp = (await handleModelApi(url, "POST", req, engine))!;
  const j = (await resp.json()) as { choices: { message: { content: string } }[] };
  return { resp, content: j.choices[0]!.message.content };
}

describe("marina/verify with the Arbiter", () => {
  it("off (default): the checker's flag leads to a free revision, as before", async () => {
    const { resp, content } = await post();
    expect(resp.headers.get("x-marina-verify")).toBe("revised");
    expect(resp.headers.get("x-marina-arbiter")).toBeNull();
    expect(content).toBe("Brazil");
    expect(calls.map((c) => c.kind)).toEqual(["proposer", "checker", "revision"]);
  });

  it("observe: the Arbiter's verdict is reported and nothing else changes", async () => {
    const { resp, content } = await post({ "x-marina-arbiter": "observe" });
    expect(resp.headers.get("x-marina-arbiter")).toBe("adjudicated:overrule");
    expect(resp.headers.get("x-marina-verify")).toBe("revised");
    expect(content).toBe("Brazil");
    expect(calls.map((c) => c.kind)).toEqual(["proposer", "checker", "arbiter", "revision"]);
  });

  it("on: a flag the Arbiter cannot back with two domains keeps the draft", async () => {
    arbiterReply = {
      ...OVERRULE,
      items: [{ item: "Brazil", citations: [OVERRULE.items[0]!.citations[0]] }],
    };
    process.env.MARINA_VERIFY_ARBITER = "on";
    const { resp, content } = await post();
    expect(resp.headers.get("x-marina-verify")).toBe("arbiter-kept");
    expect(resp.headers.get("x-marina-arbiter")).toBe("adjudicated:keep");
    expect(content).toBe("Spain");
    expect(calls.map((c) => c.kind)).toEqual(["proposer", "checker", "arbiter"]);
    expect(verificationFromLabel("arbiter-kept")).toBe("passed");
  });

  it("on: an overrule past the bar is passed to the revision", async () => {
    const { resp, content } = await post({ "x-marina-arbiter": "on" });
    expect(resp.headers.get("x-marina-verify")).toBe("arbiter-overruled");
    expect(resp.headers.get("x-marina-arbiter")).toBe("adjudicated:overrule:applied");
    expect(content).toBe("Brazil");
    expect(calls.at(-1)?.tail).toContain("the answer should be: Brazil");
  });

  it("the header overrides the env; helpers read the tool results", () => {
    expect(verifyArbiterMode({ MARINA_VERIFY_ARBITER: "on" }, "off")).toBe("off");
    expect(verifyArbiterMode({ MARINA_VERIFY_ARBITER: "observe" }, null)).toBe("observe");
    expect(verifyArbiterMode({})).toBe("off");
    expect(finalAnswerDraft({ role: "assistant", content: "Spain" })).toBe(true);
    expect(
      finalAnswerDraft({
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "x" } }],
      }),
    ).toBe(false);
    expect(toolResultSources(TOOL_RESULT)).toEqual([
      "https://www.reuters.com/a",
      "https://apnews.com/b",
      "d1",
      "d2",
    ]);
    const item = arbiterItemFor(
      [
        { role: "user", content: "Who won?" },
        { role: "tool", content: TOOL_RESULT },
      ],
      { role: "assistant", content: "Spain" },
      "wrong winner",
    );
    expect(item.question).toBe("Who won?");
    expect(item.runs).toEqual([{ answer: "Spain", label: "proposer" }]);
    expect(item.evidence).toBe(TOOL_RESULT);
  });
});
