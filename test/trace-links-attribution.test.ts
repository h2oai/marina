// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Span links: a turn that serves several requests (two concurrent requests in
 * one prompt, a request steered into a running prompt) and work handed on to a
 * crew-mate stay attributable to every originating request.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { AgentExecutionTracer, parseTraceLinks, traceLinksFor } from "../src/agent/execution-trace";
import {
  attributeRequest,
  resolveParticipants,
  servedTraces,
} from "../src/engine/benchmark-participants";
import { ConnectionManager } from "../src/engine/connection-manager";
import {
  ownedTraceLinks,
  resetTraceContextForTests,
  runWithTraceLinks,
  stampTraceLinks,
} from "../src/engine/trace-context";
import { projectTraces } from "../src/engine/trace-projection";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent, EntityId, Perception } from "../src/types";
import { cleanupDb, MockConnection } from "./helpers";

const T0 = 1_800_000_000_000;
const crew = ["Answerer", "Helper"];
const crewOf = (a: string) => (crew.includes(a) ? crew : undefined);

function lifecycle(traceId: string, phase: "received" | "routed" | "completed", at: number) {
  return {
    type: "model_request_lifecycle",
    phase,
    requestId: traceId,
    runId: traceId,
    traceId,
    spanId: `span-${traceId}`,
    model: "marina:answerer",
    ...(phase !== "received" ? { target: "Answerer" } : {}),
    ...(phase === "routed" ? { routeKind: "agent" } : {}),
    timestamp: at,
  } as EngineEvent;
}

function turnEnd(name: string, at: number, extra: Record<string, unknown>): EngineEvent {
  return {
    type: "agent_turn_end",
    name,
    hadToolCalls: true,
    toolCount: 1,
    model: `model-of-${name}`,
    costUsd: 0.04,
    timestamp: at,
    ...extra,
  } as EngineEvent;
}

const linkA = { traceId: "req-a", spanId: "span-req-a" };
const linkB = { traceId: "req-b", spanId: "span-req-b" };

/** Two requests in flight at once: the lead answers both in ONE autonomous-parented turn
 *  (ambiguous ⇒ no parent, both linked) and tells a helper, whose turn links both. */
function concurrentRun(): EngineEvent[] {
  return [
    lifecycle("req-a", "received", T0),
    lifecycle("req-b", "received", T0 + 10),
    lifecycle("req-a", "routed", T0 + 1),
    lifecycle("req-b", "routed", T0 + 11),
    turnEnd("Answerer", T0 + 400, {
      traceId: "agent-trace-1",
      runId: "agent-run-1",
      spanId: "turn-1",
      origin: "autonomous",
      links: [linkA, linkB],
    }),
    turnEnd("Helper", T0 + 600, {
      traceId: "agent-trace-2",
      runId: "agent-run-2",
      spanId: "turn-2",
      origin: "autonomous",
      links: [linkA, linkB],
    }),
    lifecycle("req-a", "completed", T0 + 900),
    lifecycle("req-b", "completed", T0 + 950),
  ];
}

afterEach(() => resetTraceContextForTests());

describe("span links on agent spans", () => {
  it("stamps every link of the turn on its turn and tool events, never its own trace", () => {
    let n = 0;
    const tracer = new AgentExecutionTracer(() => `id${++n}`);
    const parent = { runId: "req-a", traceId: "req-a", spanId: "span-req-a" };
    const start = tracer.trace("turn_start", undefined, parent, undefined, [linkA, linkB]);
    expect(start?.traceId).toBe("req-a");
    expect(start?.links).toEqual([linkB]);
    const call = tracer.trace("tool_call", "marina_tell");
    expect(call?.links).toEqual([linkB]);
    expect(call?.parentSpanId).toBe(start?.spanId);
    expect(tracer.trace("turn_end")?.links).toEqual([linkB]);
  });

  it("omits links when the turn serves only its parent", () => {
    const tracer = new AgentExecutionTracer(() => "x");
    const start = tracer.trace("turn_start", undefined, {
      runId: "req-a",
      traceId: "req-a",
      spanId: "span-req-a",
    });
    expect(start?.links).toBeUndefined();
  });

  it("collects every traced perception and carried link, deduplicated", () => {
    expect(
      traceLinksFor(
        [{ runId: "req-a", traceId: "req-a", spanId: "span-req-a" }, undefined],
        [[linkB, linkA]],
      ),
    ).toEqual([linkA, linkB]);
  });

  it("drops malformed links from untrusted input", () => {
    expect(
      parseTraceLinks([linkA, { traceId: "" }, "x", { traceId: "t", spanId: 3 }, linkA]),
    ).toEqual([linkA]);
    expect(parseTraceLinks("nope")).toEqual([]);
  });

  it("keeps links out of the span tree: a link is not a parent", () => {
    const events: EngineEvent[] = [
      {
        type: "agent_turn_start",
        name: "Answerer",
        runId: "agent-run-1",
        traceId: "agent-trace-1",
        spanId: "turn-1",
        origin: "autonomous",
        links: [linkA],
        timestamp: T0,
      } as EngineEvent,
      turnEnd("Answerer", T0 + 50, {
        traceId: "agent-trace-1",
        runId: "agent-run-1",
        spanId: "turn-1",
        origin: "autonomous",
        links: [linkA],
      }),
    ];
    const [trace] = projectTraces(events);
    expect(trace?.traceId).toBe("agent-trace-1");
    expect(trace?.spans[0]?.parentSpanId).toBeUndefined();
    expect(trace?.spans[0]?.links).toEqual([linkA]);
  });
});

describe("handoff propagation", () => {
  it("stamps a traced command's perceptions to OTHER entities and records them as delivered", () => {
    const p: Perception = { kind: "message", timestamp: T0, data: { text: "hi" } };
    const toHelper = runWithTraceLinks("e_lead", [linkA], () => stampTraceLinks("e_help", p));
    expect(toHelper.data.traceLinks).toEqual([linkA]);
    // The helper may now propagate req-a; it may not claim a trace it never saw.
    expect(ownedTraceLinks("e_help", [linkA, linkB])).toEqual([linkA]);
    // A command's own feedback is not a handoff.
    const toSelf = runWithTraceLinks("e_lead", [linkA], () => stampTraceLinks("e_lead", p));
    expect(toSelf.data.traceLinks).toBeUndefined();
    // Outside a traced command nothing is stamped.
    expect(stampTraceLinks("e_help", p).data.traceLinks).toBeUndefined();
  });

  it("records a model_request perception's trace as delivered to every recipient", () => {
    const body = JSON.stringify({
      type: "model_request",
      id: "req-a",
      trace: { runId: "req-a", traceId: "req-a", spanId: "span-req-a" },
      content: "q",
    });
    stampTraceLinks("e_member", { kind: "message", timestamp: T0, data: { content: body } });
    expect(ownedTraceLinks("e_member", [linkA])).toEqual([linkA]);
    expect(ownedTraceLinks("e_stranger", [linkA])).toEqual([]);
  });

  it("delivers stamped links through ConnectionManager.sendToEntity", () => {
    const cm = new ConnectionManager();
    const conn = new MockConnection("c1");
    cm.add(conn);
    cm.bindEntity("c1", "e_help" as EntityId);
    runWithTraceLinks("e_lead", [linkA], () =>
      cm.sendToEntity("e_help" as EntityId, {
        kind: "message",
        timestamp: T0,
        data: { text: "check this" },
      }),
    );
    const last = conn.messages.at(-1);
    expect(last?.data.traceLinks).toEqual([linkA]);
  });
});

describe("benchmark attribution through links", () => {
  it("credits both concurrent requests with the lead and the helper, splitting cost", () => {
    const events = concurrentRun();
    for (const id of ["req-a", "req-b"]) {
      const a = attributeRequest({
        traceId: id,
        traceEvents: events.filter((e) => "traceId" in e && e.traceId === id),
        linkedTurns: events.filter(
          (e) => e.type === "agent_turn_end" && e.links?.some((l) => l.traceId === id),
        ),
        windowTurns: events.filter((e) => e.type === "agent_turn_end"),
        nearbyRequests: events.filter((e) => e.type === "model_request_lifecycle"),
        crewOf,
      });
      expect(a.attribution).toBe("trace");
      expect(a.participants.map((p) => [p.agent, p.via, p.tracedShared])).toEqual([
        ["Answerer", "trace", true],
        ["Helper", "trace", true],
      ]);
      // Each 0.04 turn served two requests: 0.02 each, two turns.
      expect(a.costUsd).toBeCloseTo(0.04);
    }
  });

  it("charges a turn serving a single linked request in full (a steered request)", () => {
    const a = attributeRequest({
      traceId: "req-a",
      traceEvents: [lifecycle("req-a", "received", T0), lifecycle("req-a", "completed", T0 + 900)],
      linkedTurns: [
        turnEnd("Answerer", T0 + 400, {
          traceId: "agent-trace-9",
          spanId: "turn-9",
          origin: "autonomous",
          links: [linkA],
        }),
      ],
      windowTurns: [],
      nearbyRequests: [],
      crewOf,
    });
    expect(a.participants).toEqual([
      { agent: "Answerer", model: "model-of-Answerer", via: "trace", turns: 1, costUsd: 0.04 },
    ]);
  });

  it("never counts a turn serving a request as window evidence; autonomous turns still count", () => {
    expect(
      servedTraces(
        turnEnd("H", T0, { traceId: "agent-trace-1", origin: "autonomous" }) as Extract<
          EngineEvent,
          { type: "agent_turn_end" }
        >,
      ).size,
    ).toBe(0);
    const a = attributeRequest({
      traceId: "req-a",
      traceEvents: [
        lifecycle("req-a", "received", T0),
        lifecycle("req-a", "routed", T0 + 1),
        lifecycle("req-a", "completed", T0 + 900),
      ],
      windowTurns: [
        turnEnd("Helper", T0 + 300, {
          traceId: "agent-trace-5",
          spanId: "t5",
          origin: "autonomous",
        }),
        turnEnd("Helper", T0 + 310, {
          traceId: "agent-trace-6",
          spanId: "t6",
          origin: "autonomous",
          links: [linkB],
        }),
      ],
      nearbyRequests: [],
      crewOf,
    });
    expect(a.participants.map((p) => [p.agent, p.via, p.turns])).toEqual([["Helper", "window", 1]]);
  });

  it("resolves links from the event log", () => {
    const path = `/tmp/marina-trace-links-${Math.random().toString(36).slice(2)}.db`;
    const db = new MarinaDB(path);
    try {
      for (const e of concurrentRun()) db.logEvent(e);
      const resolved = resolveParticipants(db, ["req-a", "req-b"]);
      for (const id of ["req-a", "req-b"]) {
        expect(resolved.get(id)?.participants.map((p) => p.agent)).toEqual(["Answerer", "Helper"]);
      }
    } finally {
      db.close();
      cleanupDb(path);
    }
  });
});
