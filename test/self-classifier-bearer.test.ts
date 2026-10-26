// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Classifiers on this Marina's own `/v1` (the `marina-self` decision backend,
 * the lesson judge's fallback, classifier engines) read their bearer on every
 * ask. Before the server marks itself serving, `selfModelToken` returns the
 * local profile's key; the server treats that key as an outside caller, so in
 * the default `agents` endpoint mode `marina/default` with a response format
 * is refused (400) and then not found (404) — no upstream call, no lifecycle
 * event. A provider that kept the first bearer it saw stayed on that key for
 * the life of the process, and every lesson judgement failed as "decision
 * backend unavailable". The server also marks itself serving before anything
 * can ask a model (`src/main.ts`).
 *
 * The upstream is mocked; the `/v1` hop runs in-process through
 * `handleModelApi`. No network call is made.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerFromConfig } from "../src/decisions/config";
import { resetClassifierCapabilitiesForTests } from "../src/decisions/providers";
import type { DecisionProvider } from "../src/decisions/types";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { LESSON_JUDGE_QUESTIONS } from "../src/learning/outcomes";
import { lessonJudgeFromEnv } from "../src/learning/service";
import { handleModelApi } from "../src/net/model/model-api";
import { setEndpointConfig } from "../src/net/model/model-endpoint";
import { markServingProcess, resetServingProcessForTests } from "../src/net/model/self-model-token";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

const ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_LOCAL_API_KEY",
  "MARINA_DECISIONS",
  "MARINA_DECISION_ENGINE",
  "DB_PATH",
] as const;

const SELF = "http://localhost:3300/v1";
const LOCAL_KEY = `mk_local_${"a".repeat(32)}`;
const NOULS = Object.fromEntries(
  Object.keys(LESSON_JUDGE_QUESTIONS).map((id) => [id, { noul: 0.9 }]),
);

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
/** Upstream (Anthropic) request bodies. */
let upstream: Record<string, unknown>[];
/** Status of every `/v1` reply, in order. */
let selfStatuses: number[];
/** The Anthropic message content blocks the mocked upstream answers with. */
let blocks: () => unknown[];

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  setTrustProfile("local");
  resetServingProcessForTests();
  resetClassifierCapabilitiesForTests();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  dir = mkdtempSync(join(tmpdir(), "self-classifier-bearer-"));
  const dbPath = join(dir, "w.db");
  // The local profile's key on disk, as a server that booted before left it.
  writeFileSync(`${dbPath}.local-api-key`, `${LOCAL_KEY}\n`);
  process.env.DB_PATH = dbPath;
  db = new MarinaDB(dbPath);
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  // The fresh-install endpoint mode: outside callers are routed to agents.
  setEndpointConfig(db, {
    mode: "agents",
    fallback: true,
    passthruModel: "anthropic/claude-opus-5-5",
  });
  upstream = [];
  selfStatuses = [];
  blocks = () => [{ type: "text", text: JSON.stringify({ answers: NOULS }) }];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "localhost") {
      const resp = await handleModelApi(url, req.method, req, engine);
      selfStatuses.push(resp?.status ?? 0);
      return resp ?? new Response("no route", { status: 404 });
    }
    expect(url.host).toBe("api.anthropic.com");
    upstream.push((await req.json()) as Record<string, unknown>);
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: blocks(),
      stop_reason: "end_turn",
      usage: { input_tokens: 2000, output_tokens: 80 },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetServingProcessForTests();
  resetTrustProfileForTests();
  resetClassifierCapabilitiesForTests();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  engine.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = (p: DecisionProvider) =>
  p.ask({
    state: { outcome: { result: "success" }, lesson: "rule: check the cap first" },
    questions: LESSON_JUDGE_QUESTIONS,
  });

/** The `marina-self` backend exactly as `MARINA_DECISIONS=auto` builds it. */
const selfBackend = () =>
  providerFromConfig({
    kind: "marina-self",
    model: "marina/default",
    baseUrl: SELF,
    timeoutMs: 15_000,
    method: "auto",
  });

describe("a classifier on the server's own /v1 follows the server's bearer", () => {
  it("first asked before the server serves: the local key is refused as an outside caller", async () => {
    // The server accepts the local key once it has booted.
    process.env.MARINA_LOCAL_API_KEY = LOCAL_KEY;
    await expect(ask(selfBackend())).rejects.toThrow(/decision backend 404/);
    // Refused at the agents route: 400 response_format, then 404 marina/default.
    expect(selfStatuses).toEqual([400, 404]);
    expect(upstream).toHaveLength(0);
  });

  it("the marina-self backend answers once the server serves, though its first ask came before", async () => {
    process.env.MARINA_LOCAL_API_KEY = LOCAL_KEY;
    const judge = selfBackend();
    await expect(ask(judge)).rejects.toThrow(/decision backend 404/);
    markServingProcess();
    const result = await ask(judge);
    expect(result.provider).toBe("marina-self");
    for (const id of Object.keys(LESSON_JUDGE_QUESTIONS))
      expect(result.answers[id]).toEqual({ type: "noul", noul: 0.9 });
    expect(upstream.length).toBeGreaterThan(0);
  });

  it("the lesson judge's own fallback classifier does the same", async () => {
    process.env.MARINA_DECISIONS = "off";
    process.env.MARINA_LOCAL_API_KEY = LOCAL_KEY;
    const judge = lessonJudgeFromEnv(process.env, { baseUrl: SELF });
    expect(judge.kind).toBe("marina-classifier");
    await expect(ask(judge)).rejects.toThrow(/decision backend 404/);
    markServingProcess();
    const result = await ask(judge);
    expect(result.answers.grounded).toEqual({ type: "noul", noul: 0.9 });
    expect(upstream).toHaveLength(1);
  });
});

describe("the classifier reads the answer text whatever reasoning comes first", () => {
  it("a Claude reply with a thinking block before the text is answered", async () => {
    markServingProcess();
    blocks = () => [
      { type: "thinking", thinking: "Weigh the evidence.", signature: "sig" },
      { type: "text", text: JSON.stringify({ answers: NOULS }) },
    ];
    const result = await ask(selfBackend());
    expect(result.answers.general).toEqual({ type: "noul", noul: 0.9 });
    // No thinking was asked for: the classifier sends no reasoning directive.
    for (const body of upstream) expect(body.thinking).toBeUndefined();
  });
});

describe("the server marks itself serving before anything can ask a model", () => {
  it("markServingProcess runs before the lesson loop is armed and agents respawn", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
    const marked = main.indexOf("\nmarkServingProcess();");
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(main.indexOf("\nenableOutcomeLearning(db);"));
    expect(marked).toBeLessThan(main.indexOf("await engine.initAgents("));
    expect(main.indexOf("\nmarkServingProcess();", marked + 1)).toBe(-1);
  });
});
