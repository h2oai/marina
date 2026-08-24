// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { tracesToOtlpJson } from "../src/engine/otlp-trace-export";
import type { TraceView } from "../src/engine/trace-projection";

interface ExportShape {
  resourceSpans: Array<{
    scopeSpans: Array<{
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status: { code: number };
        attributes: unknown[];
      }>;
    }>;
  }>;
}

const trace: TraceView = {
  traceId: "req-readable",
  runId: "run-readable",
  status: "completed",
  startedAt: 100,
  endedAt: 150,
  durationMs: 50,
  partial: false,
  spans: [
    {
      spanId: "request-readable",
      kind: "model_request",
      name: "marina",
      status: "completed",
      startedAt: 100,
      endedAt: 150,
      durationMs: 50,
      partial: false,
      attributes: { requestId: "req-readable", detail: "provider secret detail" },
    },
    {
      spanId: "turn-readable",
      parentSpanId: "request-readable",
      kind: "agent_turn",
      name: "Ada",
      status: "failed",
      startedAt: 110,
      endedAt: 140,
      durationMs: 30,
      partial: false,
      attributes: { toolCount: 1 },
    },
  ],
};

describe("tracesToOtlpJson", () => {
  it("emits OTLP JSON identifiers, integer enums, and string nanoseconds", () => {
    const body = tracesToOtlpJson([trace]) as unknown as ExportShape;
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[1]!.parentSpanId).toBe(spans[0]!.spanId);
    expect(spans[0]!).toMatchObject({
      kind: 2,
      startTimeUnixNano: "100000000",
      endTimeUnixNano: "150000000",
      status: { code: 1 },
    });
    expect(spans[1]!.status).toEqual({ code: 2 });
  });

  it("preserves native IDs as attributes and maps deterministically", () => {
    const first = tracesToOtlpJson([trace]) as unknown as ExportShape;
    const second = tracesToOtlpJson([trace]) as unknown as ExportShape;
    const span = first.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(first).toEqual(second);
    expect(span.attributes).toContainEqual({
      key: "marina.trace_id",
      value: { stringValue: "req-readable" },
    });
    expect(JSON.stringify(first)).not.toContain("provider secret detail");
  });

  it("omits running spans because OTLP export represents completed spans", () => {
    const running: TraceView = {
      ...trace,
      status: "running",
      endedAt: undefined,
      durationMs: undefined,
      spans: [{ ...trace.spans[0]!, status: "running", endedAt: undefined, durationMs: undefined }],
    };
    expect(tracesToOtlpJson([running])).toEqual({ resourceSpans: [] });
  });
});
