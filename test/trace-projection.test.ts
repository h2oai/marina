// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { projectTraces } from "../src/engine/trace-projection";
import type { EngineEvent } from "../src/types";

describe("projectTraces", () => {
  it("projects a request, child turn, and tool into one causal tree", () => {
    const base = { runId: "run-1", traceId: "trace-1" };
    const events: EngineEvent[] = [
      {
        type: "model_request_lifecycle",
        phase: "received",
        requestId: "req-1",
        ...base,
        spanId: "request",
        model: "marina",
        routeKind: "passthru",
        timestamp: 100,
      },
      {
        type: "agent_turn_start",
        name: "Ada",
        ...base,
        spanId: "turn",
        parentSpanId: "request",
        timestamp: 110,
      },
      {
        type: "agent_tool_call",
        name: "Ada",
        toolName: "marina_memory",
        ...base,
        spanId: "tool",
        parentSpanId: "turn",
        timestamp: 120,
      },
      {
        type: "agent_tool_result",
        name: "Ada",
        toolName: "marina_memory",
        isError: false,
        ...base,
        spanId: "tool",
        parentSpanId: "turn",
        timestamp: 130,
      },
      {
        type: "agent_turn_end",
        name: "Ada",
        hadToolCalls: true,
        toolCount: 1,
        ...base,
        spanId: "turn",
        parentSpanId: "request",
        timestamp: 140,
      },
      {
        type: "model_request_lifecycle",
        phase: "completed",
        requestId: "req-1",
        ...base,
        spanId: "request",
        model: "marina",
        durationMs: 50,
        timestamp: 150,
      },
    ];

    const [trace] = projectTraces(events);
    expect(trace).toMatchObject({
      traceId: "trace-1",
      runId: "run-1",
      status: "completed",
      startedAt: 100,
      endedAt: 150,
      durationMs: 50,
      partial: false,
    });
    expect(trace?.spans.map((span) => [span.kind, span.spanId, span.parentSpanId])).toEqual([
      ["model_request", "request", undefined],
      ["agent_turn", "turn", "request"],
      ["tool", "tool", "turn"],
    ]);
    expect(trace?.spans[0]?.attributes.routeKind).toBe("passthru");
  });

  it("marks an end observed without its retained start as partial", () => {
    const traces = projectTraces([
      {
        type: "agent_tool_result",
        name: "Ada",
        toolName: "marina_channel",
        isError: true,
        runId: "run",
        traceId: "trace",
        spanId: "tool",
        parentSpanId: "missing-turn",
        timestamp: 200,
      },
    ]);
    expect(traces[0]).toMatchObject({ status: "failed", partial: true });
    expect(traces[0]?.spans[0]).toMatchObject({ status: "failed", partial: true });
  });

  it("represents a live span as running without calling it retention-partial", () => {
    const traces = projectTraces([
      {
        type: "agent_turn_start",
        name: "Ada",
        runId: "run",
        traceId: "trace",
        spanId: "turn",
        timestamp: 200,
      },
    ]);
    expect(traces[0]).toMatchObject({ status: "running", partial: false });
    expect(traces[0]?.spans[0]).toMatchObject({ status: "running", partial: false });
  });

  it("ignores untraced and token-delta events", () => {
    expect(
      projectTraces([
        { type: "agent_turn_start", name: "Ada", timestamp: 100 },
        {
          type: "agent_text_delta",
          name: "Ada",
          delta: "secret intermediate text",
          runId: "run",
          traceId: "trace",
          spanId: "turn",
          timestamp: 110,
        },
      ]),
    ).toEqual([]);
  });
});
