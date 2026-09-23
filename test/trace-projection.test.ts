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
        origin: "request",
        model: "openai/gpt-4o",
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
        origin: "request",
        model: "openai/gpt-4o",
        durationMs: 30,
        ttftMs: 8,
        inputTokens: 20,
        outputTokens: 5,
        costUsd: 0.001,
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
    expect(trace?.spans[1]).toMatchObject({
      durationMs: 30,
      attributes: {
        origin: "request",
        model: "openai/gpt-4o",
        ttftMs: 8,
        inputTokens: 20,
        outputTokens: 5,
        costUsd: 0.001,
      },
    });
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

describe("projectTraces memory attributes", () => {
  const base = { runId: "run-m", traceId: "trace-m", spanId: "request", model: "marina" } as const;
  const receipt = '{"schema":"marina.memory.receipt.v1","entity":"Ada"}';

  it("exposes memoryCacheHit=true, memorySurface and memoryReceipt on a cache-served passthru span", () => {
    const [trace] = projectTraces([
      {
        type: "model_request_lifecycle",
        phase: "received",
        requestId: "req-m",
        ...base,
        routeKind: "passthru",
        surface: "openai",
        memoryReceipt: receipt,
        timestamp: 100,
      },
      {
        type: "model_request_lifecycle",
        phase: "completed",
        requestId: "req-m",
        ...base,
        routeKind: "passthru",
        surface: "openai",
        target: "response-cache",
        memoryReceipt: receipt,
        durationMs: 2,
        timestamp: 102,
      },
    ]);
    expect(trace?.spans[0]?.attributes).toMatchObject({
      routeKind: "passthru",
      memoryCacheHit: "true",
      memorySurface: "openai",
      memoryReceipt: receipt,
    });
    // Strings, not booleans — the dashboard reads `attributes.memoryCacheHit === "true"`.
    expect(typeof trace?.spans[0]?.attributes.memoryCacheHit).toBe("string");
  });

  it("reports memoryCacheHit=false for an upstream-served passthru span and keeps each surface", () => {
    for (const surface of ["anthropic", "ollama-generate", "responses"] as const) {
      const [trace] = projectTraces([
        {
          type: "model_request_lifecycle",
          phase: "received",
          requestId: `req-${surface}`,
          ...base,
          routeKind: "passthru",
          surface,
          timestamp: 100,
        },
        {
          type: "model_request_lifecycle",
          phase: "routed",
          requestId: `req-${surface}`,
          ...base,
          routeKind: "passthru",
          surface,
          target: "openai/gpt-4o",
          timestamp: 101,
        },
        {
          type: "model_request_lifecycle",
          phase: "completed",
          requestId: `req-${surface}`,
          ...base,
          routeKind: "passthru",
          surface,
          target: "openai/gpt-4o",
          durationMs: 5,
          timestamp: 105,
        },
      ]);
      expect(trace?.spans[0]?.attributes).toMatchObject({
        memoryCacheHit: "false",
        memorySurface: surface,
        target: "openai/gpt-4o",
      });
    }
  });

  it("falls back to memorySurface=unknown for passthru producers that predate the field, and omits both on non-passthru spans", () => {
    const [legacy] = projectTraces([
      {
        type: "model_request_lifecycle",
        phase: "completed",
        requestId: "req-legacy",
        ...base,
        routeKind: "passthru",
        target: "anthropic/claude",
        durationMs: 1,
        timestamp: 200,
      },
    ]);
    expect(legacy?.spans[0]?.attributes).toMatchObject({
      memoryCacheHit: "false",
      memorySurface: "unknown",
    });
    const [agent] = projectTraces([
      {
        type: "model_request_lifecycle",
        phase: "completed",
        requestId: "req-agent",
        ...base,
        routeKind: "agent",
        target: "Ada",
        durationMs: 1,
        timestamp: 300,
      },
    ]);
    expect(agent?.spans[0]?.attributes.memoryCacheHit).toBeUndefined();
    expect(agent?.spans[0]?.attributes.memorySurface).toBeUndefined();
  });
});
