// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Budget-terminal answering: every bounded loop ends in an answer. The shared
// mechanism (src/agent/budget-terminal.ts), the benchmark/research tool loop,
// crew request deadlines and typed forecasts. Every fixture is synthetic.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type AgentOptions,
  type ChatMessage,
  emptyRun,
  toolLoop,
} from "../benchmarks/browsecomp-plus/agent";
import {
  budgetFinalRequest,
  budgetPhase,
  budgetSteerAt,
  budgetSteerNote,
  draftAnswerKey,
  mostAgreedDraft,
} from "../src/agent/budget-terminal";
import { runCapWarningAt } from "../src/agent/lean-agent-adapter";
import type { ChannelManager } from "../src/coordination/channel-manager";
import {
  parseDeadlineHeader,
  RequestDraftCollector,
  requestDeadlineMs,
  upstreamRefusalStatus,
} from "../src/coordination/request-deadline";
import { Engine } from "../src/engine/engine";
import type { ModelPart, TypedForecastDeps } from "../src/forecast/typed";
import { forecastTyped, settleWithinBudget } from "../src/forecast/typed";
import { routeToChannel } from "../src/net/model-api/routing";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("the shared mechanism", () => {
  it("steers from three quarters of the budget and finalises at the cap", () => {
    expect(budgetSteerAt(30)).toBe(23);
    expect(budgetSteerAt(1)).toBe(1);
    expect(budgetPhase(10, 30)).toBe("work");
    expect(budgetPhase(23, 30)).toBe("steer");
    expect(budgetPhase(30, 30)).toBe("final");
    expect(budgetPhase(0, 0)).toBe("final");
    // The lean agent's run-cap warning is the same point.
    expect(runCapWarningAt(16)).toBe(budgetSteerAt(16));
    expect(budgetSteerNote(23, 30, "turns")).toContain("7 turns left of 30 turns");
    expect(budgetSteerNote(29, 30, "turns")).toContain("1 turn left");
    expect(budgetFinalRequest(30, "turns")).toContain("no more tool calls");
    expect(budgetSteerNote(45_000, 60_000, "ms")).toContain("15s left");
  });

  it("finds the most-agreed draft by its labelled answer, ties to the latest", () => {
    expect(draftAnswerKey("Explanation: long\nExact Answer: **Paris**\nConfidence: 80%")).toBe(
      "paris",
    );
    const best = mostAgreedDraft([
      "Exact Answer: Paris",
      "Exact Answer: Lyon",
      "reasoning…\nExact Answer: paris.",
    ]);
    expect(best?.text).toContain("paris.");
    expect(best?.support).toBeCloseTo(2 / 3);
    expect(mostAgreedDraft(["a", "b"])?.text).toBe("b");
    expect(mostAgreedDraft(["", "  "])).toBeUndefined();
  });
});

// ─── The tool loop (BrowseComp-Plus adapter) ───────────────────────────────

function fakeEndpoint(answerWhenToolsOff: string | null) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const message =
      body.tool_choice === "none"
        ? { role: "assistant", content: answerWhenToolsOff }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `c${bodies.length}`,
                type: "function",
                function: { name: "search", arguments: JSON.stringify({ query: "q" }) },
              },
            ],
          };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "x-marina-cost-usd": "0.001" },
    });
  }) as unknown as typeof fetch;
  return { ep: { baseUrl: "http://bench.local", fetch: fetchImpl }, bodies };
}

const agentOpts = (over: Partial<AgentOptions> = {}): AgentOptions => ({
  corpus: "c",
  backend: {
    search: async () => [
      { docid: "d1", score: 1, title: "", url: "", passage: "snippet", lead: "snippet" },
    ],
    get: async () => undefined,
  },
  k: 5,
  snippetChars: 100,
  docChars: 100,
  maxTurns: 8,
  timeoutMs: 5_000,
  ...over,
});

describe("tool loop: budget-terminal answering", () => {
  it("steers at ~75 % and asks for a final answer with tools off at the cap", async () => {
    const { ep, bodies } = fakeEndpoint("Exact Answer: Paris");
    const run = emptyRun("m", "q1", {});
    const messages: ChatMessage[] = [{ role: "user", content: "question" }];
    const out = await toolLoop(ep, "m", messages, agentOpts({ finalAnswer: true }), run);
    expect(out.text).toBe("Exact Answer: Paris");
    expect(out.budgetForced).toMatchObject({ reason: "turns", used: 8, cap: 8 });
    // 8 tool turns, then one answer call with tools disabled.
    expect(bodies).toHaveLength(9);
    expect(bodies.slice(0, 8).every((b) => b.tool_choice === "auto")).toBe(true);
    expect(bodies[8]!.tool_choice).toBe("none");
    const toolNotes = messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(toolNotes.filter((t) => t.includes("[Budget]"))).toHaveLength(1);
    expect(toolNotes.at(-1)).toContain("[Budget reached]");
    // The steer lands after turn 6 (= ceil(0.75 × 8)), with 2 turns left.
    expect(toolNotes[5]).toContain("2 turns left");
    // No extra user turns were added: the notes ride on tool results.
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(run.record.result.at(-1)).toMatchObject({ type: "output_text" });
  });

  it("keeps the official protocol when off: the cap ends the loop with no answer", async () => {
    const { ep, bodies } = fakeEndpoint("never asked");
    const run = emptyRun("m", "q1", {});
    const out = await toolLoop(ep, "m", [{ role: "user", content: "q" }], agentOpts(), run);
    expect(out.text).toBeUndefined();
    expect(out.budgetForced).toBeUndefined();
    expect(bodies).toHaveLength(8);
    expect(JSON.stringify(bodies)).not.toContain("[Budget");
  });

  it("returns no answer when the forced call is empty", async () => {
    const { ep } = fakeEndpoint(null);
    const out = await toolLoop(
      ep,
      "m",
      [{ role: "user", content: "q" }],
      agentOpts({ finalAnswer: true, maxTurns: 2 }),
      emptyRun("m", "q1", {}),
    );
    expect(out.text).toBeUndefined();
    expect(out.budgetForced).toBeUndefined();
  });
});

// ─── Crew request deadlines ────────────────────────────────────────────────

describe("crew request deadlines", () => {
  it("reads the deadline header and keeps a margin before the client's", () => {
    expect(parseDeadlineHeader("900000")).toBe(900_000);
    expect(parseDeadlineHeader("junk")).toBeUndefined();
    expect(parseDeadlineHeader(null)).toBeUndefined();
    expect(requestDeadlineMs(600_000)).toBe(600_000);
    expect(requestDeadlineMs(600_000, 900_000)).toBe(600_000);
    expect(requestDeadlineMs(1_200_000, 900_000)).toBe(885_000);
    expect(requestDeadlineMs(600_000, 100)).toBe(1_000);
  });

  it("fails fast only on non-retryable upstream refusals", () => {
    expect(upstreamRefusalStatus("LLM error (attempt 1) [m]: 400 invalid_request_error")).toBe(400);
    expect(upstreamRefusalStatus("LLM error (attempt 2) [m]: HTTP 422: bad")).toBe(422);
    expect(upstreamRefusalStatus("LLM error (attempt 1) [m]: 429 rate limited")).toBeUndefined();
    expect(upstreamRefusalStatus("LLM error (attempt 1) [m]: 503 overloaded")).toBeUndefined();
    expect(upstreamRefusalStatus("Prompt timeout (120000ms)")).toBeUndefined();
  });

  it("prefers the lead's explicit draft, then members' agreement, then trace text", () => {
    const text = (name: string, delta: string, traceId = "req-1"): EngineEvent[] => [
      { type: "agent_text_delta", name, delta, traceId, timestamp: 1 },
      {
        type: "agent_turn_end",
        name,
        traceId,
        hadToolCalls: false,
        toolCount: 0,
        timestamp: 2,
      },
    ];
    const c = new RequestDraftCollector("req-1", "Lead");
    expect(c.best()).toBeUndefined();
    for (const e of text("Other", "unrelated", "req-2")) c.onEvent(e);
    expect(c.best()).toBeUndefined();
    for (const e of text("Mate", "Answer: 7")) c.onEvent(e);
    expect(c.best()).toEqual({ text: "Answer: 7", source: "member-text" });
    for (const e of text("Lead", "Answer: 8")) c.onEvent(e);
    expect(c.best()).toEqual({ text: "Answer: 8", source: "lead-text" });
    c.addExplicit("Mate", "9");
    expect(c.best()).toEqual({ text: "9", source: "member-plurality" });
    c.addExplicit("Lead", "10");
    expect(c.best()).toEqual({ text: "10", source: "lead-draft" });
  });

  describe("routed request", () => {
    const TEST_DB = `/tmp/marina-budget-terminal-${process.pid}.db`;
    let db: MarinaDB;
    let engine: Engine;
    let conn: MockConnection;
    let cm: ChannelManager;

    beforeEach(() => {
      db = new MarinaDB(TEST_DB);
      engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
      engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
      conn = new MockConnection("c1");
      engine.addConnection(conn);
      engine.spawnEntity("c1", "Lead");
      cm = engine.channelManager!;
      cm.createChannel({ type: "model", name: "model-crewx", retentionHours: 24 });
      engine.processCommand(conn.entity!, "channel join model-crewx");
    });

    afterEach(() => {
      engine.stop();
      db.close();
      cleanupDb(TEST_DB);
    });

    /** The lead posts a draft for every request, and never answers. */
    function draftOnRequest(draft: string) {
      const channel = cm.getChannelByName("model-crewx")!;
      cm.onMessage((channelId, senderId, _n, content) => {
        if (channelId !== channel.id || senderId !== "__model_api__") return;
        const parsed = JSON.parse(content) as { type?: string; id?: string; reminder?: boolean };
        if (parsed.type === "model_request" && !parsed.reminder) {
          cm.send(
            channelId,
            conn.entity!,
            "Lead",
            JSON.stringify({ type: "model_draft", id: parsed.id, content: draft }),
          );
        }
      });
    }

    it("answers with the lead's draft at the deadline, labelled", async () => {
      draftOnRequest("draft answer 42");
      const started = Date.now();
      const result = await routeToChannel(engine, "marina:crewx", "q?", { deadlineMs: 1_100 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.content).toBe("draft answer 42");
      expect(result.budgetForced).toMatchObject({ reason: "deadline", source: "lead-draft" });
      const completed = engine
        .getEventLog()
        .find(
          (e) =>
            e.type === "model_request_lifecycle" &&
            e.phase === "completed" &&
            e.requestId === result.requestId,
        ) as { routeReason?: string; detail?: string } | undefined;
      expect(completed?.routeReason).toContain("budget-forced:deadline");
      expect(completed?.detail).toContain("lead-draft");
    });

    /** Resolves once the routed request has been posted (the route is listening). */
    function requestPosted(): Promise<void> {
      const channel = cm.getChannelByName("model-crewx")!;
      return new Promise((resolve) => {
        cm.onMessage((channelId, senderId, _n, content) => {
          if (channelId !== channel.id || senderId !== "__model_api__") return;
          if ((JSON.parse(content) as { type?: string }).type === "model_request") resolve();
        });
      });
    }

    const refuse = () =>
      engine.logEvent({
        type: "agent_error",
        name: "Lead",
        error: "LLM error (attempt 1) [vendor/model]: 400 invalid_request_error",
        timestamp: Date.now(),
      });

    it("fails fast on repeated non-retryable refusals with the draft so far", async () => {
      draftOnRequest("partial");
      const posted = requestPosted();
      const pending = routeToChannel(engine, "marina:crewx", "q?", { deadlineMs: 60_000 });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await posted;
      refuse();
      await Promise.resolve();
      expect(settled).toBe(false); // one refusal is not enough
      refuse();
      const result = await pending;
      expect(result.content).toBe("partial");
      expect(result.budgetForced).toMatchObject({ reason: "upstream_error" });
    });

    it("without any draft, a permanent refusal is an immediate 502", async () => {
      const posted = requestPosted();
      const pending = routeToChannel(engine, "marina:crewx", "q?", { deadlineMs: 60_000 });
      await posted;
      refuse();
      refuse();
      await expect(pending).rejects.toMatchObject({ status: 502 });
    });
  });
});

// ─── Typed forecasts ───────────────────────────────────────────────────────

function analyst(name: string, answer: string, delayMs = 0): ModelPart {
  return {
    name,
    complete: async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return JSON.stringify({ answer, confidence: 0.6, reason: "r", sd: 1 });
    },
  };
}

describe("typed forecasts: a time budget ends in an answer", () => {
  it("settles what finished by the deadline, else the first to finish", async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(2), 300));
    const fast = Promise.resolve(1);
    expect(await settleWithinBudget([fast, slow], Date.now() + 20)).toEqual([1, undefined]);
    const later = new Promise<number>((r) => setTimeout(() => r(3), 30));
    const never = new Promise<number>(() => {});
    expect(await settleWithinBudget([never, later], Date.now())).toEqual([undefined, 3]);
  });

  it("combines the finished runs at the cap and labels the answer", async () => {
    const deps: TypedForecastDeps = {
      retriever: async () => ({
        report: "",
        sources: [],
        costUsd: 0,
        searches: 0,
        retriever: "none",
      }),
      analysts: [analyst("fast", "A"), analyst("slow", "B", 400)],
      options: { runs: 2, plan: false, critique: true, researchRounds: 1, budgetMs: 60 },
      critic: analyst("critic", "B"),
    };
    const out = await forecastTyped(
      { question: "Which?", answer: { type: "choice", options: [{ id: "A" }, { id: "B" }] } },
      deps,
    );
    expect(out.formatted).toBe("A");
    expect(out.runs[1]!.status).toBe("budget: unfinished at the cap");
    expect(out.budgetForced).toMatchObject({ reason: "time", source: "runs-so-far" });
    expect(out.budget?.skipped).toEqual(expect.arrayContaining(["unfinished runs", "critique"]));
    expect(out.critique).toBeUndefined();
  });

  it("labels nothing without a budget, or when everything finished in time", async () => {
    const deps: TypedForecastDeps = {
      retriever: async () => ({
        report: "",
        sources: [],
        costUsd: 0,
        searches: 0,
        retriever: "none",
      }),
      analysts: [analyst("a", "A")],
      options: { runs: 1, plan: false, critique: false, researchRounds: 1, budgetMs: 60_000 },
    };
    const spec = { type: "choice" as const, options: [{ id: "A" }, { id: "B" }] };
    const out = await forecastTyped({ question: "Which?", answer: spec }, deps);
    expect(out.formatted).toBe("A");
    expect(out.budgetForced).toBeUndefined();
    expect(out.budget).toMatchObject({ capMs: 60_000, skipped: [] });
    const none = await forecastTyped(
      { question: "Which?", answer: spec },
      { ...deps, options: { ...deps.options, budgetMs: undefined } },
    );
    expect(none.budget).toBeUndefined();
  });
});
