// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/patterns/run` (`src/net/api/patterns-api.ts`) and the free-text
 * protocols behind it (`src/orchestration/text-patterns.ts`): validation,
 * the crew-only refusal, the daily cap, a debate judged end to end through
 * the model proxy, budget stops, and every protocol's stage sequence.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { Engine } from "../src/engine/engine";
import { SpendGuard } from "../src/engine/spend-guard";
import { recordSpend } from "../src/engine/spend-ledger";
import { handleModelApi } from "../src/net/model/model-api";
import {
  CREW_ONLY_PATTERNS,
  type PatternRunResult,
  parseReview,
  runTextPattern,
  TEXT_PATTERNS,
  TEXT_PICK_SYSTEM,
  type TextComplete,
  type TextPattern,
} from "../src/orchestration/text-patterns";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { ORCHESTRATION_PATTERNS } from "../src/world/templates/orchestration";
import { MockConnection, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

// ─── Pure protocols ─────────────────────────────────────────────────────────

interface Call {
  model: string;
  system: string;
  user: string;
}

/** A fake model: picks `pick`, reviews with `review`, otherwise answers `<model>#<n>`. */
function fakeModel(
  o: {
    pick?: number;
    review?: string;
    costUsd?: number;
    fail?: (c: Call, n: number) => boolean;
  } = {},
) {
  const calls: Call[] = [];
  const complete: TextComplete = async (model, system, user) => {
    const c = { model, system, user };
    calls.push(c);
    const n = calls.length;
    if (o.fail?.(c, n)) throw new Error(`upstream 500: down (${model})`);
    const costUsd = o.costUsd ?? 0.001;
    if (system === TEXT_PICK_SYSTEM)
      return { text: `{"pick":${o.pick ?? 1},"reason":"most complete"}`, costUsd };
    if (system.includes("You review a DRAFT"))
      return { text: o.review ?? '{"verdict":"approve","issues":""}', costUsd };
    return { text: `${model}#${n}`, costUsd };
  };
  return { calls, complete };
}

const M = ["m/a", "m/b", "m/c"];
const run = (
  pattern: TextPattern,
  f: ReturnType<typeof fakeModel>,
  members = M,
  budget = new SpendGuard({ label: "pattern budget", daily: false }),
  signal?: AbortSignal,
): Promise<PatternRunResult> =>
  runTextPattern(pattern, "Name the capital of France.", members, {
    complete: f.complete,
    checker: "m/judge",
    budget,
    ...(signal ? { signal } : {}),
  });
const stages = (r: PatternRunResult) => r.trace.steps.map((s) => s.stage);

describe("the protocols stay pure", () => {
  it("text-patterns imports no network or engine module at runtime", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/orchestration/text-patterns.ts"),
      "utf8",
    );
    const runtimeImports = [...source.matchAll(/^import (?!type )[^;]*?from "([^"]+)";/gms)].map(
      (m) => m[1],
    );
    expect(runtimeImports.filter((p) => p?.includes("/net/") || p?.endsWith("/engine"))).toEqual(
      [],
    );
  });
});

describe("the pattern catalogue split", () => {
  it("every catalogue pattern is either runnable here or crew-only, never both", () => {
    for (const p of ORCHESTRATION_PATTERNS) {
      const text = (TEXT_PATTERNS as readonly string[]).includes(p);
      expect(text !== p in CREW_ONLY_PATTERNS, p).toBe(true);
    }
    // `ensemble` is the passthru formation's name (src/net/model-api/ensemble.ts), not a catalogue entry.
    const outside = TEXT_PATTERNS.filter(
      (p) => !(ORCHESTRATION_PATTERNS as readonly string[]).includes(p),
    );
    expect(outside).toEqual(["ensemble"]);
  });

  it("reads a review verdict only when it is approve or revise", () => {
    expect(parseReview('{"verdict":"revise","issues":" fix x "}')).toEqual({
      verdict: "revise",
      issues: "fix x",
    });
    expect(parseReview('{"verdict":"maybe"}')).toBeUndefined();
    expect(parseReview("looks fine")).toBeUndefined();
  });
});

describe("runTextPattern", () => {
  it("ensemble: parallel drafts, the checker picks one", async () => {
    const f = fakeModel({ pick: 2 });
    const r = await run("ensemble", f);
    expect(r.success).toBe(true);
    expect(stages(r)).toEqual(["draft:draft-1", "draft:draft-2", "draft:draft-3", "pick"]);
    expect(r.message).toBe("m/b#2");
    expect(r.trace.steps.at(-1)?.text).toBe("picked draft-2: most complete");
    expect(r.trace.costUsd).toBeCloseTo(0.004, 8);
    expect(r.trace.fallback).toBeUndefined();
  });

  it("debate: two advocates open, rebut each other, the judge picks", async () => {
    const f = fakeModel({ pick: 2 });
    const r = await run("debate", f);
    expect(stages(r)).toEqual([
      "opening:advocate-1",
      "opening:advocate-2",
      "rebuttal:advocate-1",
      "rebuttal:advocate-2",
      "judge",
    ]);
    // Only the first two members argue; each rebuttal sees the opponent's opening.
    expect(f.calls.some((c) => c.model === "m/c")).toBe(false);
    expect(f.calls[2]!.user).toContain("YOUR OPPONENT'S OPENING:\nm/b#2");
    expect(r.message).toBe("m/b#4");
  });

  it("delphi: drafts, an anonymised summary, one revision each, a pick", async () => {
    const f = fakeModel({ pick: 3 });
    const r = await run("delphi", f);
    expect(stages(r)).toEqual([
      "round-1:round-1-1",
      "round-1:round-1-2",
      "round-1:round-1-3",
      "summary",
      "round-2:round-1-1",
      "round-2:round-1-2",
      "round-2:round-1-3",
      "pick",
    ]);
    const summary = f.calls[3]!;
    expect(summary.model).toBe("m/judge");
    expect(summary.user).not.toContain("round-1-");
    expect(f.calls[4]!.user).toContain("PANEL SUMMARY:\nm/judge#4");
    expect(r.message).toBe("m/c#7");
  });

  it("tournament: a bracket of pairwise picks with a bye", async () => {
    const f = fakeModel({ pick: 2 });
    const r = await run("tournament", f);
    expect(stages(r)).toEqual([
      "draft:draft-1",
      "draft:draft-2",
      "draft:draft-3",
      "round-1:draft-1-vs-draft-2",
      "round-1:draft-3",
      "round-2:draft-2-vs-draft-3",
    ]);
    expect(r.trace.steps[4]).toMatchObject({ status: "skipped", text: "bye" });
    expect(r.message).toBe("m/c#3");
  });

  it("verification: draft, review, one revision when asked", async () => {
    const revise = fakeModel({ review: '{"verdict":"revise","issues":"cite a source"}' });
    const r = await run("verification", revise);
    expect(stages(r)).toEqual(["draft", "review", "revise"]);
    expect(revise.calls[2]!.user).toContain("REVIEWER'S ISSUES:\ncite a source");
    expect(r.message).toBe("m/a#3");
    const approve = await run("verification", fakeModel());
    expect(stages(approve)).toEqual(["draft", "review"]);
    expect(approve.message).toBe("m/a#1");
  });

  it("deliberation: propose, see anonymised peers, revise, pick", async () => {
    const f = fakeModel({ pick: 1 });
    const r = await run("deliberation", f);
    expect(stages(r)).toEqual([
      "propose:propose-1",
      "propose:propose-2",
      "propose:propose-3",
      "revise:propose-1",
      "revise:propose-2",
      "revise:propose-3",
      "pick",
    ]);
    const first = f.calls[3]!.user;
    expect(first).toContain("YOUR PROPOSAL:\nm/a#1");
    expect(first).toContain("PROPOSAL:\nm/b#2");
    expect(first).toContain("PROPOSAL:\nm/c#3");
    expect(r.message).toBe("m/a#4");
  });

  it("chorus: propose, critique one peer in a ring, revise, pick", async () => {
    const f = fakeModel({ pick: 2 });
    const r = await run("chorus", f);
    expect(stages(r)).toEqual([
      "propose:propose-1",
      "propose:propose-2",
      "propose:propose-3",
      "critique:propose-1",
      "critique:propose-2",
      "critique:propose-3",
      "revise:propose-1",
      "revise:propose-2",
      "revise:propose-3",
      "pick",
    ]);
    // Proposal 1 is critiqued by member 2, proposal 3 by member 1.
    expect(r.trace.steps[3]!.member).toBe("m/b");
    expect(r.trace.steps[5]!.member).toBe("m/a");
    expect(f.calls[6]!.user).toContain("PEER CRITIQUE:\nm/b#4");
    expect(r.message).toBe("m/b#8");
  });

  it("pipeline: each member refines the handoff; a failed stage passes it on", async () => {
    const f = fakeModel({ fail: (c) => c.model === "m/c" });
    const r = await run("pipeline", f);
    expect(stages(r)).toEqual(["stage-1", "stage-2", "stage-3"]);
    expect(f.calls[1]!.user).toContain("PREVIOUS STAGE'S HANDOFF:\nm/a#1");
    expect(r.trace.steps[2]!.status).toBe("failed");
    expect(r.success).toBe(true);
    expect(r.message).toBe("m/b#2");
    const ok = await run("pipeline", fakeModel());
    expect(ok.message).toBe("m/c#3");
  });

  it("a budget stop returns the best answer so far with success:false", async () => {
    const f = fakeModel({ costUsd: 0.01 });
    const budget = new SpendGuard({ label: "pattern budget", budgetUsd: 0.015, daily: false });
    const r = await run("ensemble", f, M.slice(0, 2), budget);
    expect(r.success).toBe(false);
    expect(r.message).toBe("m/a#1");
    expect(r.trace.fallback).toStartWith("budget: pattern budget $0.01");
    expect(f.calls.some((c) => c.system === TEXT_PICK_SYSTEM)).toBe(false);
  });

  it("an unreadable pick fails open to the first answer", async () => {
    const f = fakeModel({ pick: 9 });
    const r = await run("ensemble", f);
    expect(r.success).toBe(true);
    expect(r.message).toBe("m/a#1");
    expect(r.trace.steps.at(-1)?.status).toBe("failed");
  });

  it("no answer at all, or an aborted run, is success:false with a reason", async () => {
    const none = await run("ensemble", fakeModel({ fail: () => true }));
    expect(none).toMatchObject({ success: false, message: "" });
    expect(none.trace.fallback).toBe("no member produced an answer");
    const aborted = await run(
      "debate",
      fakeModel(),
      M,
      new SpendGuard({ label: "pattern budget", daily: false }),
      AbortSignal.abort(),
    );
    expect(aborted.success).toBe(false);
    expect(aborted.trace.fallback).toBe("aborted: the caller went away");
    expect(aborted.trace.steps).toEqual([]);
  });
});

// ─── The route ──────────────────────────────────────────────────────────────

const A = "openrouter/openai/gpt-6.1-sol";
const B = "openrouter/anthropic/claude-opus-5.5";

describe("POST /v1/patterns/run", () => {
  let state: DisposableStack;
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let upstream: Array<{ model: string; system: string; user: string }>;
  let judgeReply: string;
  let callCost: number;

  beforeEach(() => {
    state = scopeProcessState({
      env: {
        ...Object.fromEntries(modelSourceEnvKeys().map((k) => [k, undefined])),
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        MODEL_API_KEYS: undefined,
        MARINA_VERIFY_CHECKER_MODEL: undefined,
        MARINA_ENSEMBLE_SIZE: undefined,
        MARINA_DAILY_SPEND_CAP_USD: undefined,
        MARINA_OPEN_API: "true",
        OPENROUTER_API_KEY: "test-openrouter-key",
      },
    });
    upstream = [];
    judgeReply = '{"pick":2,"reason":"rebuts the other"}';
    callCost = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const msgs = (body.messages ?? []) as { role: string; content: unknown }[];
      const of = (role: string) =>
        msgs
          .filter((m) => m.role === role)
          .map((m) => String(m.content))
          .join("\n");
      const system = of("system");
      upstream.push({ model: String(body.model), system, user: of("user") });
      const content = system.includes("You choose the best of several CANDIDATE")
        ? judgeReply
        : system.includes("Rebut the opponent")
          ? `final answer from ${body.model}`
          : `opening from ${body.model}`;
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          ...(callCost ? { cost: callCost } : {}),
        },
      });
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "patterns-run-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    engine.addConnection(new MockConnection("c1"));
    engine.spawnEntity("c1", "Agent1");
  });

  afterEach(async () => {
    await engine.shutdown();
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(dir, { recursive: true, force: true });
    state.dispose();
  });

  async function post(body: unknown) {
    const url = new URL("http://localhost:3300/v1/patterns/run");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await handleModelApi(url, "POST", req, engine))!;
  }

  type ErrorBody = { error: { code: string; param?: string; message: string } };

  it("refuses an unknown pattern, listing the supported ones", async () => {
    const resp = await post({ pattern: "conga", task: "x" });
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as ErrorBody;
    expect(j.error.param).toBe("pattern");
    for (const p of TEXT_PATTERNS) expect(j.error.message).toContain(p);
    expect(upstream).toHaveLength(0);
  });

  it("refuses a crew-only pattern with unsupported_parameter and a marina:<crew> pointer", async () => {
    const resp = await post({ pattern: "foundry", task: "Build a site." });
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as ErrorBody;
    expect(j.error.code).toBe("unsupported_parameter");
    expect(j.error.param).toBe("pattern");
    expect(j.error.message).toContain("persistent crew");
    expect(j.error.message).toContain("marina:<crew>");
    expect(upstream).toHaveLength(0);
  });

  it("refuses a marina member, a bad task and a bad budget", async () => {
    const recursive = await post({
      pattern: "debate",
      task: "x",
      members: [A, "marina/ensemble:a,b"],
    });
    expect(recursive.status).toBe(400);
    expect(((await recursive.json()) as ErrorBody).error).toMatchObject({
      code: "unsupported_parameter",
      param: "members",
    });
    expect((await post({ pattern: "debate", task: "" })).status).toBe(400);
    expect((await post({ pattern: "debate", task: "x".repeat(16_001) })).status).toBe(400);
    expect((await post({ pattern: "debate", task: "x", members: [A] })).status).toBe(400);
    expect((await post({ pattern: "debate", task: "x", budgetUsd: 0 })).status).toBe(400);
    expect((await post({ pattern: "debate", task: "x", members: [A, "nope"] })).status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it("answers 429 spend_cap_reached when the daily cap is spent", async () => {
    process.env.MARINA_DAILY_SPEND_CAP_USD = "0.000001";
    recordSpend("model_api", 1);
    const resp = await post({ pattern: "ensemble", task: "x" });
    expect(resp.status).toBe(429);
    expect(((await resp.json()) as ErrorBody).error.code).toBe("spend_cap_reached");
    expect(upstream).toHaveLength(0);
  });

  it("runs a debate whose judge picks a draft", async () => {
    const resp = await post({ pattern: "debate", task: "Is P = NP?", members: [A, B] });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as PatternRunResult;
    expect(j.success).toBe(true);
    expect(j.pattern).toBe("debate");
    expect(j.message).toBe("final answer from anthropic/claude-opus-5.5");
    expect(j.trace.steps.map((s) => [s.stage, s.status])).toEqual([
      ["opening:advocate-1", "ok"],
      ["opening:advocate-2", "ok"],
      ["rebuttal:advocate-1", "ok"],
      ["rebuttal:advocate-2", "ok"],
      ["judge", "ok"],
    ]);
    expect(j.trace.steps.at(-1)?.text).toBe("picked advocate-2: rebuts the other");
    // The judge is the verify checker resolution: the first member checks.
    expect(upstream.at(-1)?.model).toBe("openai/gpt-6.1-sol");
    expect(upstream[2]!.user).toContain("opening from anthropic/claude-opus-5.5");
  });

  it("legacy names normalise and default members are the available model", async () => {
    const resp = await post({ pattern: "NSED", task: "Plan a picnic." });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as PatternRunResult;
    expect(j.pattern).toBe("deliberation");
    expect(j.success).toBe(true);
    // 3 proposals + 3 revisions on the one available model; identical finals need no pick.
    expect(upstream).toHaveLength(6);
    expect(j.trace.steps.at(-1)).toMatchObject({ stage: "pick", status: "skipped" });
    expect(new Set(upstream.map((u) => u.model)).size).toBe(1);
  });

  it("a budget stop returns the best so far with success:false and trace.fallback", async () => {
    callCost = 0.01;
    const resp = await post({ pattern: "ensemble", task: "x", members: [A, B], budgetUsd: 0.015 });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as PatternRunResult;
    expect(j.success).toBe(false);
    expect(j.message).toBe("opening from openai/gpt-6.1-sol");
    expect(j.trace.fallback).toContain("pattern budget");
    expect(j.trace.costUsd).toBeCloseTo(0.02, 6);
    expect(upstream).toHaveLength(2);
  });
});
