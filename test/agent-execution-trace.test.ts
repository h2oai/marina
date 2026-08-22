// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  AgentExecutionTracer,
  traceParentFromPerception,
  unambiguousTraceParent,
} from "../src/agent/execution-trace";

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
