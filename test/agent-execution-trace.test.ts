// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createAgentEventRelay } from "../src/agent/agent-runtime";
import {
  AgentExecutionTracer,
  type TraceParent,
  traceParentFromPerception,
  unambiguousTraceParent,
} from "../src/agent/execution-trace";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { EngineEvent, Perception } from "../src/types";

describe("AgentExecutionTracer", () => {
  it("uses one turn span across the turn lifecycle and streaming deltas", () => {
    const tracer = new AgentExecutionTracer(() => "one");

    const start = tracer.trace("turn_start");
    const thinking = tracer.trace("thinking_delta");
    const text = tracer.trace("text_delta");
    const end = tracer.trace("turn_end");

    expect(start).toEqual({
      runId: "agent-run-one",
      traceId: "agent-trace-one",
      spanId: "turn-one",
    });
    expect(thinking).toEqual(start);
    expect(text).toEqual(start);
    expect(end).toEqual(start);
    expect(tracer.trace("text_delta")).toBeUndefined();
  });

  it("parents tool results to the turn and reuses the matching call span", () => {
    const ids = ["turn", "first-tool", "second-tool"];
    const tracer = new AgentExecutionTracer(() => ids.shift() ?? "unexpected");
    const turn = tracer.trace("turn_start")!;

    const firstCall = tracer.trace("tool_call", "marina_memory")!;
    const secondCall = tracer.trace("tool_call", "marina_channel")!;
    const firstResult = tracer.trace("tool_result", "marina_memory")!;
    const secondResult = tracer.trace("tool_result", "marina_channel")!;

    expect(firstCall).toMatchObject({
      traceId: turn.traceId,
      spanId: "tool-first-tool",
      parentSpanId: turn.spanId,
    });
    expect(firstResult).toEqual(firstCall);
    expect(secondResult).toEqual(secondCall);
  });

  it("does not invent orphan spans outside an active turn", () => {
    const tracer = new AgentExecutionTracer(() => "unused");
    expect(tracer.trace("tool_call", "marina_memory")).toBeUndefined();
    expect(tracer.trace("tool_result", "marina_memory")).toBeUndefined();
  });

  it("parents a turn to an explicitly propagated model-request trace", () => {
    const tracer = new AgentExecutionTracer(() => "child");
    const turn = tracer.trace("turn_start", undefined, {
      runId: "req-1",
      traceId: "req-1",
      spanId: "span-req-1",
    });

    expect(turn).toEqual({
      runId: "req-1",
      traceId: "req-1",
      spanId: "turn-child",
      parentSpanId: "span-req-1",
    });
  });

  it("extracts only valid model-request parents and rejects ambiguous batches", () => {
    const first = traceParentFromPerception(
      '[channel] {"type":"model_request","id":"req-1","trace":{"runId":"run","traceId":"trace","spanId":"root"}}',
    );
    const same = first!;
    const other = { runId: "run-2", traceId: "trace-2", spanId: "root-2" };

    expect(first).toEqual({ runId: "run", traceId: "trace", spanId: "root" });
    expect(unambiguousTraceParent([undefined, first, same])).toEqual(first);
    expect(unambiguousTraceParent([first, other])).toBeUndefined();
    expect(traceParentFromPerception('{"type":"model_response","trace":{}}')).toBeUndefined();
    expect(traceParentFromPerception("not json")).toBeUndefined();
  });
});

/**
 * Adapter-level trace-parent integration: the previously untested link in the
 * end-to-end chain. A model_request perception carrying an explicit trace is
 * driven through the REAL adapter internals — perception extraction
 * (setupPerceptionHandlers), unambiguous parent resolution
 * (buildContinuationPrompt), turn_start emission (setupActionTracking) — and
 * the REAL runtime bridge (createAgentEventRelay, the exact function
 * AgentRuntime.spawnAgent subscribes) must emit an agent_turn_start
 * EngineEvent parented under the originating request span.
 *
 * The adapter constructor is I/O-free (MarinaClient connects only in start()),
 * so we can drive the client's perception emitter and the pi-agent's
 * subscribed listeners directly — same technique as
 * lean-adapter-coding-task.test.ts and agent-modules.test.ts.
 */
describe("adapter trace-parent integration (perception → agent_turn_start)", () => {
  type AdapterInternals = {
    autonomousMode: boolean;
    loopIterationCount: number;
    client: { emit(event: "perception", p: Perception): void };
    agent: { listeners: Set<(event: { type: string }, signal: AbortSignal) => unknown> };
    buildContinuationPrompt(): Promise<string>;
    setupActionTracking(): void;
    currentPromptTraceParent?: TraceParent;
  };

  function makeAdapter(name: string): { adapter: LeanAgentAdapter; internals: AdapterInternals } {
    const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
    const internals = adapter as unknown as AdapterInternals;
    internals.autonomousMode = true; // perception buffering only happens in autonomous mode
    internals.setupActionTracking(); // normally registered by start(); start() would do I/O
    return { adapter, internals };
  }

  function modelRequestPerception(requestId: string, content: string): Perception {
    return {
      kind: "message",
      timestamp: Date.now(),
      data: {
        from: "model-api",
        channel: "model",
        message: JSON.stringify({
          type: "model_request",
          id: requestId,
          trace: { runId: requestId, traceId: requestId, spanId: `span-${requestId}` },
          content,
          target: "e_1",
        }),
      },
    };
  }

  /** Fire a pi-agent turn_start through the adapter's real setupActionTracking handler. */
  function fireTurnStart(internals: AdapterInternals): void {
    const signal = new AbortController().signal;
    for (const listener of internals.agent.listeners) listener({ type: "turn_start" }, signal);
  }

  it("emits agent_turn_start carrying the propagated request trace", async () => {
    const { adapter, internals } = makeAdapter("trace-int-propagated");
    const events: EngineEvent[] = [];
    const unsubscribe = adapter.subscribe(
      createAgentEventRelay("trace-int-propagated", (event) => events.push(event)),
    );

    const requestId = "req-abc12345";
    internals.client.emit("perception", modelRequestPerception(requestId, "what is 2+2?"));

    // Prompt assembly resolves ONE unambiguous parent from the flushed batch.
    const prompt = await internals.buildContinuationPrompt();
    expect(prompt).toContain('"type":"model_request"');
    expect(internals.currentPromptTraceParent).toEqual({
      runId: requestId,
      traceId: requestId,
      spanId: `span-${requestId}`,
    });

    fireTurnStart(internals);
    unsubscribe();

    const turnStart = events.find((event) => event.type === "agent_turn_start");
    expect(turnStart).toMatchObject({
      type: "agent_turn_start",
      name: "trace-int-propagated",
      runId: requestId,
      traceId: requestId,
      parentSpanId: `span-${requestId}`,
    });
    expect(turnStart && "spanId" in turnStart ? turnStart.spanId : "").toStartWith("turn-");
  });

  it("does not parent the turn when the batch carries two different traces", async () => {
    const { adapter, internals } = makeAdapter("trace-int-ambiguous");
    const events: EngineEvent[] = [];
    const unsubscribe = adapter.subscribe(
      createAgentEventRelay("trace-int-ambiguous", (event) => events.push(event)),
    );

    internals.client.emit("perception", modelRequestPerception("req-first111", "first question"));
    internals.client.emit("perception", modelRequestPerception("req-second22", "second question"));

    await internals.buildContinuationPrompt();
    expect(internals.currentPromptTraceParent).toBeUndefined();

    fireTurnStart(internals);
    unsubscribe();

    const turnStart = events.find((event) => event.type === "agent_turn_start");
    expect(turnStart).toBeDefined();
    if (turnStart?.type !== "agent_turn_start") throw new Error("unreachable");
    expect(turnStart.runId).toStartWith("agent-run-");
    expect(turnStart.traceId).toStartWith("agent-trace-");
    expect(turnStart.parentSpanId).toBeUndefined();
  });
});
