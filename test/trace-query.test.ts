// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { TraceView } from "../src/engine/trace-projection";
import { decodeTraceCursor, queryTraces } from "../src/engine/trace-query";

function trace(
  traceId: string,
  startedAt: number,
  status: TraceView["status"] = "completed",
): TraceView {
  return {
    traceId,
    runId: `run-${traceId}`,
    status,
    startedAt,
    partial: false,
    spans: [
      {
        spanId: `span-${traceId}`,
        kind: "model_request",
        name: traceId === "b" ? "qwen/local" : "gpt/remote",
        status,
        startedAt,
        partial: false,
        attributes: {},
      },
      {
        spanId: `tool-${traceId}`,
        kind: "tool",
        name: traceId === "b" ? "search" : "read",
        status,
        startedAt,
        partial: false,
        attributes: { agent: traceId === "b" ? "Ada" : "Lin" },
      },
    ],
  };
}

describe("trace retrieval query", () => {
  const traces = [trace("a", 300), trace("b", 200, "failed"), trace("c", 200), trace("d", 100)];

  it("paginates by stable timestamp and ID instead of array offset", () => {
    const first = queryTraces(traces, { limit: 2 });
    expect(first.traces.map((item) => item.traceId)).toEqual(["a", "b"]);
    expect(first.hasMore).toBe(true);
    const second = queryTraces([trace("new", 400), ...traces], {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.traces.map((item) => item.traceId)).toEqual(["c", "d"]);
    expect(second.hasMore).toBe(false);
  });

  it("filters structural trace fields without request or output content", () => {
    expect(queryTraces(traces, { limit: 10, status: "failed" }).traces).toHaveLength(1);
    expect(queryTraces(traces, { limit: 10, model: "qwen" }).traces[0]?.traceId).toBe("b");
    expect(queryTraces(traces, { limit: 10, agent: "ada" }).traces[0]?.traceId).toBe("b");
    expect(queryTraces(traces, { limit: 10, tool: "search" }).traces[0]?.traceId).toBe("b");
    expect(queryTraces(traces, { limit: 10, q: "tool-b" }).traces[0]?.traceId).toBe("b");
    expect(queryTraces(traces, { limit: 10, since: 150, until: 250 }).traces).toHaveLength(2);
  });

  it("rejects malformed and structurally invalid cursors", () => {
    expect(() => decodeTraceCursor("not_valid")).toThrow("Invalid trace cursor");
    expect(() => decodeTraceCursor(btoa(JSON.stringify({ startedAt: 1 })))).toThrow(
      "Invalid trace cursor",
    );
  });
});
