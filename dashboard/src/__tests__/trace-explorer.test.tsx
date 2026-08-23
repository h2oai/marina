// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TraceExplorerView, traceSpanDepth } from "../components/TraceExplorer";
import type { TraceSpanView, TracesResponse } from "../lib/types";

const data: TracesResponse = {
  source: "event-log",
  retention: "operator-managed",
  partial: false,
  truncated: false,
  analytics: {
    schema: "marina.trace.analytics.v1",
    tracesObserved: 1,
    partialTraces: 0,
    models: [
      {
        name: "marina",
        observed: 1,
        eligible: 1,
        excludedPartial: 0,
        completed: 1,
        failed: 0,
        running: 0,
        terminalRate: 1,
        successRate: 1,
        latency: { samples: 1, p50Ms: 45, p95Ms: 45 },
        ttft: { samples: 1, p50Ms: 8, p95Ms: 8 },
        tokens: { samples: 1, input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
        cost: { samples: 1, totalUsd: 0.001, averageUsd: 0.001 },
      },
    ],
    agentModels: [],
    routes: [],
    tools: [],
  },
  comparisons: {
    models: [
      {
        dimension: "model",
        name: "marina",
        mechanics: {
          name: "marina",
          observed: 1,
          eligible: 1,
          excludedPartial: 0,
          completed: 1,
          failed: 0,
          running: 0,
          terminalRate: 1,
          successRate: 1,
          latency: { samples: 1, p50Ms: 45, p95Ms: 45 },
        },
        judgments: {
          total: 1,
          passed: 1,
          failed: 0,
          inconclusive: 0,
          evaluators: 1,
          criteria: { correctness: 1 },
        },
      },
    ],
    routes: [],
  },
  shadowAdvice: {
    models: {
      schema: "marina.routing.shadow.v1",
      dimension: "model",
      mode: "insufficient",
      candidates: [],
      reasons: ["Fewer than two observed cohorts."],
      advisoryOnly: true,
    },
    routes: {
      schema: "marina.routing.shadow.v1",
      dimension: "route",
      mode: "insufficient",
      candidates: [],
      reasons: ["Fewer than two observed cohorts."],
      advisoryOnly: true,
    },
  },
  traces: [
    {
      traceId: "req-visible",
      runId: "req-visible",
      status: "completed",
      startedAt: 100,
      endedAt: 145,
      durationMs: 45,
      partial: false,
      evaluation: {
        evaluator: "marina.execution.v2",
        checks: [
          {
            id: "terminal_outcome",
            result: "passed",
            summary: "The root span completed.",
            evidenceSpanIds: ["request"],
          },
          {
            id: "history_integrity",
            result: "passed",
            summary: "All parent links are valid.",
            evidenceSpanIds: ["request", "turn", "tool"],
          },
          {
            id: "agent_turns",
            result: "passed",
            summary: "All observed agent turns completed.",
            evidenceSpanIds: ["turn"],
          },
          {
            id: "tool_results",
            result: "passed",
            summary: "All observed tool results completed.",
            evidenceSpanIds: ["tool"],
          },
          {
            id: "metrics_integrity",
            result: "passed",
            summary: "Normalized metrics are internally consistent.",
            evidenceSpanIds: ["turn"],
          },
        ],
      },
      judgments: [
        {
          id: "tj-visible",
          traceId: "req-visible",
          evaluatorEntity: "Reviewer",
          verdict: "passed",
          criterion: "correctness",
          rationale: "Matched the expected result.",
          evidenceSpanIds: ["request"],
          createdAt: 150,
        },
      ],
      spans: [
        {
          spanId: "request",
          kind: "model_request",
          name: "marina",
          status: "completed",
          startedAt: 100,
          endedAt: 145,
          durationMs: 45,
          partial: false,
          attributes: {
            routeStrategy: "adaptive",
            routeAdviceMode: "insufficient",
            routeReason: "No advised route was eligible; used least-busy fallback.",
          },
        },
        {
          spanId: "turn",
          parentSpanId: "request",
          kind: "agent_turn",
          name: "Ada",
          status: "completed",
          startedAt: 110,
          endedAt: 140,
          durationMs: 30,
          partial: false,
          attributes: {
            model: "openai/gpt-4o",
            origin: "request",
            ttftMs: 8,
            inputTokens: 20,
            outputTokens: 5,
            costUsd: 0.001,
          },
        },
        {
          spanId: "tool",
          parentSpanId: "turn",
          kind: "tool",
          name: "marina_memory",
          status: "completed",
          startedAt: 120,
          endedAt: 130,
          durationMs: 10,
          partial: false,
          attributes: {},
        },
      ],
    },
  ],
};

describe("TraceExplorerView", () => {
  it("renders source, trace status, and causal span hierarchy", () => {
    render(<TraceExplorerView data={data} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText("event-log · operator-managed")).toBeInTheDocument();
    expect(screen.getByText("req-visible")).toBeInTheDocument();
    expect(screen.getByText("marina_memory")).toBeInTheDocument();
    expect(screen.getByLabelText("Trace spans")).toBeInTheDocument();
    expect(screen.getByLabelText("Execution checks")).toBeInTheDocument();
    expect(screen.getByLabelText("Trace analytics")).toBeInTheDocument();
    expect(screen.getByText("terminal outcome")).toBeInTheDocument();
    expect(screen.getByText("evidence: request")).toBeInTheDocument();
    expect(screen.getByLabelText("Participant judgments")).toBeInTheDocument();
    expect(screen.getByText("Matched the expected result.")).toBeInTheDocument();
    expect(screen.getByLabelText("Shadow routing advice")).toBeInTheDocument();
    expect(screen.getByText(/model: openai\/gpt-4o/)).toBeInTheDocument();
    expect(screen.getByText(/ttft: 8ms/)).toBeInTheDocument();
    expect(screen.getByText(/strategy: adaptive/)).toHaveTextContent("advice: insufficient");
    expect(screen.getByText(/strategy: adaptive/)).toHaveTextContent("least-busy fallback");
  });

  it("supports servers from before analytics was added", () => {
    const { analytics: _analytics, ...legacyData } = data;
    render(<TraceExplorerView data={legacyData} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText("req-visible")).toBeInTheDocument();
    expect(screen.queryByLabelText("Trace analytics")).not.toBeInTheDocument();
  });

  it("renders honest empty and error states and refreshes on demand", () => {
    const refresh = vi.fn();
    const { rerender } = render(
      <TraceExplorerView data={{ ...data, traces: [] }} isLoading={false} onRefresh={refresh} />,
    );
    expect(screen.getByText(/No traced executions yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledOnce();

    rerender(
      <TraceExplorerView
        data={{ ...data, traces: [] }}
        isLoading={false}
        error="Not authorized"
        onRefresh={refresh}
      />,
    );
    expect(screen.getByText("Not authorized")).toBeInTheDocument();
  });
});

describe("traceSpanDepth", () => {
  it("bounds malformed cycles instead of looping", () => {
    const spans: TraceSpanView[] = [
      { ...data.traces[0]!.spans[0]!, spanId: "a", parentSpanId: "b" },
      { ...data.traces[0]!.spans[1]!, spanId: "b", parentSpanId: "a" },
    ];
    expect(traceSpanDepth(spans[0]!, spans)).toBe(1);
  });
});
