// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lessons from work (src/learning/work.ts): Marina's own non-benchmark tool
 * work → aggregated patterns → ONE judged lesson each through `recordOutcome`.
 * Covers every source's general fields, the leak guard, owner vs shared
 * scope, measurement exclusion, aggregation floors and caps, the spend stop,
 * no model ⇒ no write, off/observe/on, the read-only backfill scan, and recall
 * of owner `tools` lessons on passthru and through the `lessons` command.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider, DecisionRequest } from "../src/decisions/types";
import { lessonsCommand } from "../src/engine/commands/lessons";
import { type Lesson, memoryLessonSink } from "../src/learning/outcomes";
import {
  canHoldOwnLessons,
  lessonRecallSinkFor,
  lessonSinkFor,
  ownerLessonSink,
  recallForWork,
  recallLessons,
} from "../src/learning/service";
import { classifyToolError, softFailureClass } from "../src/learning/tool-errors";
import {
  flushWorkLessons,
  generalToolName,
  learnPatterns,
  lessonsFromWorkMode,
  noteWork,
  observeWorkEvent,
  outcomeFromPattern,
  pendingWorkPatterns,
  resetWorkLearner,
  type ScopeReader,
  WorkAggregator,
  WorkEventTracker,
  type WorkPattern,
  type WorkSignal,
  workScopeFor,
} from "../src/learning/work";
import { scanWorkHistory } from "../src/learning/work-backfill";
import { PASSTHRU_LESSON_DOMAINS } from "../src/net/model-api/chat-completions";
import {
  conversationRecoveries,
  notePassthruRecoveries,
  passthruLearnOwner,
  resetPassthruLearnForTests,
  toolMessageFailure,
} from "../src/net/model-api/learn";
import type { PassthruAuthResult } from "../src/net/model-api/shared";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent, EntityId, RoomContext } from "../src/types";
import { scopeProcessState } from "./process-state";

const ON = { MARINA_LESSONS_FROM_WORK: "on" } as NodeJS.ProcessEnv;
const OBSERVE = { MARINA_LESSONS_FROM_WORK: "observe" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

const dirs: string[] = [];
function freshDb(): MarinaDB {
  const dir = mkdtempSync(join(tmpdir(), "lessons-work-"));
  dirs.push(dir);
  return new MarinaDB(join(dir, "m.db"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetPassthruLearnForTests();
});

/** A judge answering every noul question 0.9 (calibrated), recording requests. */
function judge(opts: { fail?: boolean } = {}): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    kind: "test",
    model: "test/jev",
    calibrated: true,
    requests,
    async ask(request) {
      requests.push(request);
      if (opts.fail) throw new Error("no model reachable");
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: 0.9 }]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      } as never;
    },
  };
}

const SHARED = { kind: "shared" } as const;

/** The producer-domain lessons a sink holds (a shared trusted method lesson is also mirrored to meta). */
const tools = (sink: { all(): Lesson[] }) => sink.all().filter((l) => l.domain !== "meta");
const signal = (over: Partial<WorkSignal> = {}): WorkSignal => ({
  source: "tool-recovery",
  tool: "marina_command",
  errorClass: "not-found",
  succeeded: true,
  scope: SHARED,
  at: Date.parse("2026-10-01T00:00:00Z"),
  ...over,
});

const pattern = (over: Partial<WorkPattern> = {}): WorkPattern => ({
  source: "tool-recovery",
  tool: "marina_command",
  errorClass: "not-found",
  succeeded: true,
  scope: SHARED,
  count: 3,
  firstAt: Date.parse("2026-10-01T00:00:00Z"),
  lastAt: Date.parse("2026-10-01T01:00:00Z"),
  refs: ["trace:agent-trace-1"],
  samples: [],
  ...over,
});

/** A scope reader over a small principal table. */
function reader(
  principals: Array<{ id: string; type: string; name: string; owner?: string }>,
  users: string[],
): ScopeReader {
  const rows = principals.map((p) => ({
    principal_id: p.id,
    principal_type: p.type,
    display_name: p.name,
    owner_principal_id: p.owner ?? null,
    status: "active",
  }));
  return {
    getPrincipal: (type, name) =>
      rows.find((r) => r.principal_type === type && r.display_name === name),
    listPrincipals: () => rows,
    getUserByName: (name) => (users.includes(name) ? { id: `u_${name}` } : undefined),
  };
}

describe("mechanical classification", () => {
  it("labels failures by class and never returns text", () => {
    expect(classifyToolError("Error: note #42 not found")).toBe("not-found");
    expect(classifyToolError("Usage: task approve <id> <claimant>")).toBe("invalid-args");
    expect(classifyToolError("Unknown command: frobnicate")).toBe("unknown-command");
    expect(classifyToolError("Run tool budget reached; this tool did not execute.")).toBe("budget");
    expect(classifyToolError("HTTP 429 rate limited")).toBe("rate-limit");
    expect(classifyToolError({ content: [{ text: "permission denied" }] })).toBe("permission");
    expect(classifyToolError("weird")).toBe("other");
  });

  it("finds soft failures only at a leading marker", () => {
    expect(softFailureClass("Unknown command: zap. Type help.")).toBe("unknown-command");
    expect(softFailureClass("Usage: note <text>")).toBe("invalid-args");
    expect(softFailureClass("Saved note #3. Nothing was not found here.")).toBeUndefined();
  });

  it("keeps tool names general (no arguments, no paths)", () => {
    expect(generalToolName("/usr/bin/rm -rf /tmp/x")).toBe("rm");
    expect(generalToolName("marina_command")).toBe("marina_command");
  });
});

describe("scope: owner by default, shared only for world agents", () => {
  const r = reader(
    [
      { id: "p_world", type: "agent", name: "Builder" },
      { id: "p_sys", type: "system", name: "system" },
      { id: "p_room", type: "agent", name: "Guide", owner: "p_sys" },
      { id: "p_jeff", type: "human", name: "jeff" },
      { id: "p_helper", type: "agent", name: "Helper", owner: "p_jeff" },
      { id: "p_sub", type: "agent", name: "Sub", owner: "p_helper" },
      { id: "p_crit", type: "agent", name: "Critic" },
      { id: "p_eval", type: "agent", name: "Evaluator", owner: "p_crit" },
    ],
    ["jeff", "Builder"],
  );

  it("resolves world, room, person, owned and sub-owned agents", () => {
    expect(workScopeFor(r, "Builder")).toEqual({ kind: "shared" });
    expect(workScopeFor(r, "Guide")).toEqual({ kind: "shared" });
    expect(workScopeFor(r, "Evaluator")).toEqual({ kind: "shared" });
    expect(workScopeFor(r, "Helper")).toEqual({ kind: "owner", owner: "jeff" });
    expect(workScopeFor(r, "Sub")).toEqual({ kind: "owner", owner: "jeff" });
    expect(workScopeFor(r, "jeff")).toEqual({ kind: "owner", owner: "jeff" });
    expect(workScopeFor(r, "nobody")).toBeUndefined();
  });

  it("works over a real database: an agent spawned by a person is that person's work", () => {
    const db = freshDb();
    try {
      db.createUser({ id: "u_jeff", name: "jeff" });
      db.saveAgentConfig({ name: "Helper", model: "m", spawnedBy: "jeff" });
      db.saveAgentConfig({ name: "Roamer", model: "m", spawnedBy: "system" });
      expect(workScopeFor(db, "Helper")).toEqual({ kind: "owner", owner: "jeff" });
      expect(workScopeFor(db, "Roamer")).toEqual({ kind: "shared" });
      expect(canHoldOwnLessons(db, "jeff")).toBe(true);
      expect(canHoldOwnLessons(db, "marina:lessons")).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("event tracker: every agent-loop source", () => {
  const collect = (opts: { unscoped?: boolean } = {}) => {
    const out: WorkSignal[] = [];
    const t = new WorkEventTracker(
      () => (opts.unscoped ? undefined : SHARED),
      (s) => out.push(s),
    );
    return { out, t };
  };
  const result = (
    over: Partial<Extract<EngineEvent, { type: "agent_tool_result" }>> = {},
  ): EngineEvent =>
    ({
      type: "agent_tool_result",
      name: "Builder",
      toolName: "marina_command",
      runId: "agent-run-1",
      traceId: "agent-trace-1",
      origin: "autonomous",
      isError: false,
      timestamp: 1_000,
      ...over,
    }) as EngineEvent;

  it("an error then a success of the same tool is a recovery (across runs, in the window)", () => {
    const { out, t } = collect();
    t.onEvent(result({ isError: true, errorClass: "not-found" }));
    t.onEvent(result({ runId: "agent-run-2", timestamp: 60_000 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "tool-recovery",
      tool: "marina_command",
      errorClass: "not-found",
      succeeded: true,
    });
    // General fields only: no result text rides on the signal.
    expect(JSON.stringify(out[0])).not.toContain("privateText");
  });

  it("three failures in a row are one repeat-failure; a budget block is its own source", () => {
    const { out, t } = collect();
    for (let i = 0; i < 4; i++) t.onEvent(result({ isError: true, errorClass: "invalid-args" }));
    t.onEvent(result({ isError: true, errorClass: "budget" }));
    expect(out.map((s) => s.source)).toEqual(["tool-repeat-failure", "tool-budget"]);
  });

  it("a failure outside the window is not a recovery", () => {
    const { out, t } = collect();
    t.onEvent(result({ isError: true, errorClass: "timeout" }));
    t.onEvent(result({ timestamp: 1_000 + 16 * 60_000 }));
    expect(out).toHaveLength(0);
  });

  it("request-driven turns (incl. measurement runs) never teach", () => {
    const { out, t } = collect();
    t.onEvent(result({ isError: true, origin: "request", traceId: "req-1" }));
    t.onEvent(result({ origin: "request", traceId: "req-1" }));
    expect(out).toHaveLength(0);
  });

  it("gate holds (one per ask), argcheck flags, verifier bounces and task verdicts", () => {
    const { out, t } = collect();
    const decision = (over: Record<string, unknown>) =>
      ({
        type: "agent_decision",
        name: "Builder",
        timestamp: 5,
        ...over,
      }) as unknown as EngineEvent;
    t.onEvent(decision({ stage: "gate", verdict: "allow", subject: "memory", signals: {} }));
    t.onEvent(
      decision({
        stage: "gate",
        verdict: "ask",
        subject: "marina_command",
        reason: "Held (unauthorized 0.79)",
        signals: { unauthorized: 0.79, destructive: 0.1 },
      }),
    );
    t.onEvent(
      decision({
        stage: "gate",
        verdict: "ask",
        subject: "marina_command",
        reason: "challenge ch_1 opened",
        signals: {},
      }),
    );
    t.onEvent(decision({ stage: "argcheck", verdict: "nudge", subject: "cancel_order" }));
    t.onEvent(decision({ stage: "verify", verdict: "retry", subject: "task #7" }));
    t.onEvent(decision({ stage: "verify", verdict: "accept", subject: "task #8" }));
    t.onEvent({
      type: "task_rejected",
      entity: "e_c" as EntityId,
      taskId: 9,
      claimantName: "Builder",
      timestamp: 6,
    });
    t.onEvent({ type: "task_approved", entity: "e_c" as EntityId, taskId: 10, timestamp: 7 });
    expect(out.map((s) => `${s.source}:${s.errorClass}`)).toEqual([
      "gate-hold:ask:unauthorized",
      "argcheck-correction:unsupported-value",
      "task-bounce:bounce",
      "task-verdict:rejected",
    ]);
    expect(out[2]!.ref).toBe("task:7");
  });

  it("an actor with no resolvable scope is never learned from", () => {
    const { out, t } = collect({ unscoped: true });
    t.onEvent(result({ isError: true }));
    t.onEvent(result({}));
    expect(out).toHaveLength(0);
  });
});

describe("outcomes: general fields only, leak guard unchanged", () => {
  it("one outcome per pattern with a general rule; case text only as privateContext", () => {
    const o = outcomeFromPattern(
      pattern({ samples: ["customer 88123 order ORD-5531 not found in store Austin-3"] }),
    );
    expect(o.domain).toBe("tools");
    expect(o.source).toBe("work:tool-recovery:marina_command:not-found:ok");
    expect(o.rule).toContain("confirm it exists with a lookup");
    expect(o.scope).toBe("method");
    expect(o.families).toEqual(["tool-agent.policy"]);
    const visible = JSON.stringify({ ...o, privateContext: undefined });
    expect(visible).not.toContain("88123");
    expect(visible).not.toContain("ORD-5531");
    expect(outcomeFromPattern(pattern({ source: "code-exec-denied", tool: "curl" })).domain).toBe(
      "code",
    );
  });

  it("a writer that quotes the case is discarded; the stored lesson never holds it", async () => {
    const sink = memoryLessonSink();
    const leaky = {
      name: "leaky",
      async complete() {
        return JSON.stringify({
          category: "orders",
          rule: "customer 88123 order ORD-5531 not found in store Austin-3 so retry",
        });
      },
    };
    const r = await learnPatterns(
      [pattern({ samples: ["customer 88123 order ORD-5531 not found in store Austin-3"] })],
      { mode: "on", sharedSink: sink, writer: leaky, judge: judge(), stopReason: () => undefined },
    );
    expect(r.learned).toBe(1);
    const stored = tools(sink);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).not.toContain("88123");
    expect(stored[0]!.provenance?.writer_note).toContain("writer rule discarded");
    expect(stored[0]!.trust).toBe("trusted");
  });
});

describe("learnPatterns: floors, dedupe, caps, spend, no model", () => {
  it("below-floor patterns wait; verdict sources teach on one", async () => {
    const sink = memoryLessonSink();
    const r = await learnPatterns(
      [
        pattern({ count: 1 }),
        pattern({
          source: "challenge",
          tool: "agent.spawn",
          errorClass: "deny",
          succeeded: false,
          count: 1,
        }),
      ],
      { mode: "on", sharedSink: sink, judge: judge(), stopReason: () => undefined },
    );
    expect(r.belowFloor).toBe(1);
    expect(r.carry).toHaveLength(1);
    expect(r.learned).toBe(1);
    expect(tools(sink)[0]!.source).toBe("work:challenge:agent.spawn:deny:fail");
  });

  it("a pattern already learned — or retired — is not learned again", async () => {
    const sink = memoryLessonSink();
    const deps = {
      mode: "on" as const,
      sharedSink: sink,
      judge: judge(),
      stopReason: () => undefined,
    };
    await learnPatterns([pattern()], deps);
    const again = await learnPatterns([pattern()], deps);
    expect(again.duplicates).toBe(1);
    const id = tools(sink)[0]!.id!;
    await sink.retire!("tools", id, { reason: "wrong", by: "op" });
    expect((await learnPatterns([pattern()], deps)).duplicates).toBe(1);
    expect(tools(sink)).toHaveLength(1);
  });

  it("caps per flush and stops at the spend cap (the rest carried over)", async () => {
    const sink = memoryLessonSink();
    const many = ["a", "b", "c", "d"].map((t) => pattern({ tool: `tool_${t}` }));
    const capped = await learnPatterns(many, {
      mode: "on",
      sharedSink: sink,
      judge: judge(),
      maxPerFlush: 2,
      stopReason: () => undefined,
    });
    expect(capped.learned).toBe(2);
    expect(capped.skipped.cap).toBe(2);
    expect(capped.carry).toHaveLength(2);
    const j = judge();
    const spent = await learnPatterns([pattern({ tool: "tool_e" })], {
      mode: "on",
      sharedSink: sink,
      judge: j,
      stopReason: () => "daily spend cap reached",
    });
    expect(spent.skipped.spend).toBe(1);
    expect(j.requests).toHaveLength(0);
  });

  it("no model reachable ⇒ nothing written (deferred, carried)", async () => {
    const sink = memoryLessonSink();
    const r = await learnPatterns([pattern()], {
      mode: "on",
      sharedSink: sink,
      judge: judge({ fail: true }),
      writer: {
        name: "down",
        async complete() {
          throw new Error("no model");
        },
      },
      stopReason: () => undefined,
    });
    expect(r.deferred).toBe(1);
    expect(r.carry).toHaveLength(1);
    expect(tools(sink)).toHaveLength(0);
  });

  it("observe counts candidates and calls no model", async () => {
    const sink = memoryLessonSink();
    const j = judge();
    const r = await learnPatterns([pattern(), pattern({ tool: "x", count: 1 })], {
      mode: "observe",
      sharedSink: sink,
      judge: j,
    });
    expect(r.candidates).toEqual({ "tool-recovery": 1 });
    expect(r.occurrences).toEqual({ "tool-recovery": 3 });
    expect(j.requests).toHaveLength(0);
    expect(tools(sink)).toHaveLength(0);
  });

  it("owner patterns never reach the shared sink and are never mirrored to meta", async () => {
    const shared = memoryLessonSink();
    const own = memoryLessonSink();
    const r = await learnPatterns([pattern({ scope: { kind: "owner", owner: "jeff" } })], {
      mode: "on",
      sharedSink: shared,
      ownerSink: (o) => (o === "jeff" ? own : undefined),
      judge: judge(),
      stopReason: () => undefined,
    });
    expect(r.learned).toBe(1);
    expect(shared.all()).toHaveLength(0);
    expect(own.all().map((l) => l.domain)).toEqual(["tools"]);
    const nobody = await learnPatterns([pattern({ scope: { kind: "owner", owner: "ghost" } })], {
      mode: "on",
      sharedSink: shared,
      ownerSink: () => undefined,
      judge: judge(),
      stopReason: () => undefined,
    });
    expect(nobody.skipped.noScope).toBe(1);
    expect(shared.all()).toHaveLength(0);
  });
});

describe("aggregation and modes", () => {
  it("aggregates per source/tool/class/result/scope with bounded refs and samples", () => {
    const a = new WorkAggregator();
    for (let i = 0; i < 12; i++) a.add(signal({ ref: `trace:${i}`, privateText: `case ${i}` }));
    a.add(signal({ scope: { kind: "owner", owner: "jeff" } }));
    const ps = a.take();
    expect(ps).toHaveLength(2);
    const shared = ps.find((p) => p.scope.kind === "shared")!;
    expect(shared.count).toBe(12);
    expect(shared.refs.length).toBeLessThanOrEqual(8);
    expect(shared.samples.length).toBeLessThanOrEqual(3);
    expect(a.size).toBe(0);
  });

  it("off collects nothing; observe flushes counts with no write; on writes", async () => {
    expect(lessonsFromWorkMode(OFF)).toBe("off");
    expect(lessonsFromWorkMode({ ...ON, MARINA_LESSONS: "off" })).toBe("off");
    const db = freshDb();
    try {
      noteWork(db, signal(), OFF);
      expect(pendingWorkPatterns(db)).toBe(0);
      noteWork(db, signal(), OBSERVE);
      noteWork(db, signal(), OBSERVE);
      expect(pendingWorkPatterns(db)).toBe(1);
      const sink = memoryLessonSink();
      const observed = await flushWorkLessons(db, { env: OBSERVE, sharedSink: sink });
      expect(observed?.candidates).toEqual({ "tool-recovery": 1 });
      expect(tools(sink)).toHaveLength(0);
      noteWork(db, signal(), ON);
      noteWork(db, signal(), ON);
      const learned = await flushWorkLessons(db, {
        env: ON,
        sharedSink: sink,
        judge: judge(),
        stopReason: () => undefined,
      });
      expect(learned?.learned).toBe(1);
      expect(tools(sink)).toHaveLength(1);
    } finally {
      resetWorkLearner(db);
      db.close();
    }
  });

  it("the engine listener feeds the tracker only when on/observe", () => {
    const db = freshDb();
    try {
      db.saveAgentConfig({ name: "Roamer", model: "m", spawnedBy: "system" });
      const ev = (isError: boolean, t: number): EngineEvent =>
        ({
          type: "agent_tool_result",
          name: "Roamer",
          toolName: "marina_command",
          origin: "autonomous",
          traceId: "agent-trace-9",
          isError,
          timestamp: t,
        }) as EngineEvent;
      observeWorkEvent(db, ev(true, 1), OFF);
      observeWorkEvent(db, ev(false, 2), OFF);
      expect(pendingWorkPatterns(db)).toBe(0);
      observeWorkEvent(db, ev(true, 3), OBSERVE);
      observeWorkEvent(db, ev(false, 4), OBSERVE);
      expect(pendingWorkPatterns(db)).toBe(1);
    } finally {
      resetWorkLearner(db);
      db.close();
    }
  });
});

describe("passthru: explicit opt-in, owner-scoped, never measurement", () => {
  const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
  const bound = { internal: false, openMode: false, boundEntityName: "jeff" } as PassthruAuthResult;

  it("needs the opt-in, a bound key, no eval header, not an internal caller", () => {
    expect(passthruLearnOwner(req({ "x-marina-learn": "on" }), bound)).toBe("jeff");
    expect(passthruLearnOwner(req({}), bound)).toBeUndefined();
    expect(
      passthruLearnOwner(
        req({ "x-marina-learn": "on", "x-marina-eval": "benchmark=tau2-retail; mode=measure" }),
        bound,
      ),
    ).toBeUndefined();
    expect(
      passthruLearnOwner(req({ "x-marina-learn": "on" }), { ...bound, internal: true }),
    ).toBeUndefined();
    expect(
      passthruLearnOwner(req({ "x-marina-learn": "on" }), {
        internal: false,
        openMode: false,
      } as PassthruAuthResult),
    ).toBeUndefined();
  });

  const conversation = [
    { role: "user", content: "cancel my order" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "cancel_order", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: '{"error":"order ORD-77 not found"}' },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c2", function: { name: "cancel_order", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c2", content: '{"status":"cancelled"}' },
  ];

  it("finds a tool error followed by a corrected success", () => {
    expect(toolMessageFailure('{"error":"x not found"}')).toBe("not-found");
    expect(toolMessageFailure('{"status":"ok"}')).toBeUndefined();
    const r = conversationRecoveries(conversation);
    expect(r).toEqual([
      expect.objectContaining({ tool: "cancel_order", errorClass: "not-found", failId: "c1" }),
    ]);
  });

  it("notes each recovery once even when the conversation is re-sent every turn", async () => {
    const db = freshDb();
    try {
      notePassthruRecoveries(db, "jeff", conversation);
      expect(pendingWorkPatterns(db)).toBe(0); // off by default: nothing collected
      resetPassthruLearnForTests();
      using _env = scopeProcessState({ env: { MARINA_LESSONS_FROM_WORK: "observe" } });
      for (let i = 0; i < 3; i++) notePassthruRecoveries(db, "jeff", conversation);
      const report = await flushWorkLessons(db, { env: OBSERVE });
      // Seen once (a pattern of one occurrence, below its floor of two), owner-scoped.
      expect(report?.belowFloor).toBe(1);
      expect(report?.candidates).toEqual({});
    } finally {
      resetWorkLearner(db);
      db.close();
    }
  });
});

describe("owner lessons: durable, private, and recalled on passthru and by the lessons command", () => {
  it("writes to the owner's own spaces; served only to that owner", async () => {
    const db = freshDb();
    try {
      db.createUser({ id: "u_jeff", name: "jeff" });
      db.createUser({ id: "u_ann", name: "ann" });
      const r = await learnPatterns([pattern({ scope: { kind: "owner", owner: "jeff" } })], {
        mode: "on",
        sharedSink: lessonSinkFor(db),
        ownerSink: (o) => (canHoldOwnLessons(db, o) ? ownerLessonSink(db, o) : undefined),
        judge: judge(),
        stopReason: () => undefined,
      });
      expect(r.learned).toBe(1);
      const q = "confirm the id exists with a lookup before acting";
      const shared = await recallLessons(db, "tools", q, { env: {} });
      expect(shared.recalled).toHaveLength(0);
      const own = await recallLessons(db, "tools", q, { env: {}, owner: "jeff" });
      expect(own.recalled).toHaveLength(1);
      expect(own.recalled[0]!.source).toBe("work:tool-recovery:marina_command:not-found:ok");
      const other = await recallLessons(db, "tools", q, { env: {}, owner: "ann" });
      expect(other.recalled).toHaveLength(0);
      // The shared reader never sees owner spaces.
      expect(await lessonRecallSinkFor(db).recall("tools", q, new Date().toISOString())).toEqual(
        [],
      );
      // Passthru recall (the tools/code domains) serves the owner's own lessons.
      const passthru = await recallForWork(db, PASSTHRU_LESSON_DOMAINS, q, {
        env: {},
        owner: "jeff",
      });
      expect(passthru.inject.map((l: Lesson) => l.source)).toContain(
        "work:tool-recovery:marina_command:not-found:ok",
      );
      // The lessons command (what the lean adapter reads) serves the asker's own.
      const out: string[] = [];
      const ctx = {
        send: (_e: EntityId, m: string) => out.push(m),
        getEntity: () => ({ name: "jeff" }),
      } as unknown as RoomContext;
      await lessonsCommand({ db }).handler(ctx, {
        entity: "e_jeff" as EntityId,
        verb: "lessons",
        args: "confirm lookup domain:tools",
        tokens: ["confirm", "lookup", "domain:tools"],
        raw: "lessons confirm lookup domain:tools",
      } as never);
      expect(out.join("\n")).toContain("lookup");
    } finally {
      db.close();
    }
  });
});

describe("backfill scan (read-only)", () => {
  it("counts candidates per source from recorded history without writing", () => {
    const raw = new Database(":memory:");
    raw.run(
      "CREATE TABLE principals (principal_id TEXT, principal_type TEXT, display_name TEXT, owner_principal_id TEXT, status TEXT)",
    );
    raw.run("CREATE TABLE users (id TEXT, name TEXT)");
    raw.run(
      "CREATE TABLE event_log (id INTEGER PRIMARY KEY, type TEXT, data TEXT, timestamp INTEGER)",
    );
    raw.run(
      "CREATE TABLE challenge_outcomes (id INTEGER PRIMARY KEY, token TEXT, kind TEXT, class TEXT, requester_name TEXT, answer TEXT, summary TEXT, reason TEXT, answered_at INTEGER)",
    );
    raw.run("CREATE TABLE coding_sessions (id TEXT, created_by TEXT)");
    raw.run(
      "CREATE TABLE coding_events (id TEXT, session_id TEXT, actor TEXT, kind TEXT, payload_json TEXT, created_at INTEGER)",
    );
    raw.run("INSERT INTO principals VALUES ('p1','agent','Builder',NULL,'active')");
    raw.run("INSERT INTO principals VALUES ('p2','human','jeff',NULL,'active')");
    raw.run("INSERT INTO users VALUES ('p2','jeff')");
    const ev = (type: string, data: Record<string, unknown>, t: number) =>
      raw.run("INSERT INTO event_log (type, data, timestamp) VALUES (?, ?, ?)", [
        type,
        JSON.stringify({ type, timestamp: t, ...data }),
        t,
      ]);
    for (const base of [0, 100]) {
      ev(
        "agent_tool_result",
        { name: "Builder", toolName: "marina_board", origin: "autonomous", isError: true },
        base + 1,
      );
      ev(
        "agent_tool_result",
        { name: "Builder", toolName: "marina_board", origin: "autonomous", isError: false },
        base + 2,
      );
    }
    raw.run(
      "INSERT INTO challenge_outcomes (token, kind, class, requester_name, answer, summary, reason, answered_at) VALUES ('ch_1','tool','tool:marina_command','Builder','deny','agent stop X','held',5)",
    );
    raw.run("INSERT INTO coding_sessions VALUES ('s1','jeff')");
    for (let i = 0; i < 2; i++)
      raw.run("INSERT INTO coding_events VALUES (?, 's1', 'e', 'exec_decision', ?, ?)", [
        `ce${i}`,
        JSON.stringify({ approved: false, argv: ["curl", "https://x"], outcome: "denied" }),
        10 + i,
      ]);
    const scan = scanWorkHistory(raw);
    expect(scan.candidates).toEqual({
      "tool-recovery": 1,
      challenge: 1,
      "code-exec-denied": 1,
    });
    expect(scan.byScope).toEqual({ shared: 2, owner: 1 });
    const denied = scan.patterns.find((p) => p.source === "code-exec-denied")!;
    expect(denied.tool).toBe("curl");
    expect(denied.scope).toEqual({ kind: "owner", owner: "jeff" });
    raw.close();
  });
});
