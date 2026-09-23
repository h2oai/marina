// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  parsePromptSectionsAttribute,
  TraceExplorerView,
  traceSpanDepth,
  traceWaterfallLayout,
} from "../components/TraceExplorer";
import type { TraceSpanView, TracesResponse } from "../lib/types";

const data: TracesResponse = {
  source: "event-log",
  retention: "operator-managed",
  partial: false,
  truncated: false,
  otlp: {
    enabled: true,
    endpoint: "https://collector.example/v1/traces",
    protocol: "http/json",
    pendingTraces: 0,
    exportedSpans: 12,
    rejectedSpans: 0,
    droppedTraces: 0,
    exportFailures: 0,
    consecutiveFailures: 0,
  },
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
    expect(screen.getAllByText("marina_memory")).toHaveLength(2);
    expect(screen.getByLabelText("Trace spans")).toBeInTheDocument();
    expect(screen.getByLabelText("Trace waterfall")).toBeInTheDocument();
    expect(screen.getByTestId("waterfall-tool")).toHaveStyle({ left: "44.44444444444444%" });
    expect(screen.getByLabelText("Execution checks")).toBeInTheDocument();
    expect(screen.getByLabelText("Trace analytics")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenTelemetry delivery")).toHaveTextContent(
      "OTLP healthy · 12 spans exported",
    );
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

  it("filters by status and any recorded span evidence", () => {
    const failedTrace = {
      ...data.traces[0]!,
      traceId: "req-failed",
      status: "failed" as const,
      spans: data.traces[0]!.spans.map((span) =>
        span.spanId === "turn"
          ? { ...span, status: "failed" as const, attributes: { errorKind: "rate_limit" } }
          : span,
      ),
    };
    render(
      <TraceExplorerView
        data={{ ...data, traces: [data.traces[0]!, failedTrace] }}
        isLoading={false}
        onRefresh={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search traces"), {
      target: { value: "rate_limit" },
    });
    expect(screen.getByText("req-failed")).toBeInTheDocument();
    expect(screen.queryByText("req-visible")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter trace status"), {
      target: { value: "completed" },
    });
    expect(screen.getByText("No retained traces match these filters.")).toBeInTheDocument();
  });

  it("exposes server filter, paging, and authenticated export actions", () => {
    const onQueryChange = vi.fn();
    const onStatusChange = vi.fn();
    const onDimensionChange = vi.fn();
    const onTimeRangeChange = vi.fn();
    const onNextPage = vi.fn();
    const onPreviousPage = vi.fn();
    const onExport = vi.fn();
    render(
      <TraceExplorerView
        data={{ ...data, page: { limit: 100, hasMore: true, nextCursor: "opaque" } }}
        isLoading={false}
        onRefresh={() => {}}
        onQueryChange={onQueryChange}
        onStatusChange={onStatusChange}
        onDimensionChange={onDimensionChange}
        onTimeRangeChange={onTimeRangeChange}
        onNextPage={onNextPage}
        onPreviousPage={onPreviousPage}
        canPreviousPage
        onExport={onExport}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search traces"), { target: { value: "qwen" } });
    fireEvent.change(screen.getByLabelText("Filter trace status"), {
      target: { value: "failed" },
    });
    fireEvent.change(screen.getByLabelText("Filter trace model"), {
      target: { value: "qwen-local" },
    });
    fireEvent.change(screen.getByLabelText("Filter trace time range"), {
      target: { value: String(60 * 60_000) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Download eval dataset" }));
    expect(onQueryChange).toHaveBeenCalledWith("qwen");
    expect(onStatusChange).toHaveBeenCalledWith("failed");
    expect(onDimensionChange).toHaveBeenCalledWith("model", "qwen-local");
    expect(onTimeRangeChange).toHaveBeenCalledWith(60 * 60_000);
    expect(onNextPage).toHaveBeenCalledOnce();
    expect(onPreviousPage).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledWith("eval-json");
  });

  it("reports an exact requested trace that is outside retained history", () => {
    render(
      <TraceExplorerView
        data={data}
        isLoading={false}
        onRefresh={() => {}}
        requestedTraceId="expired-trace"
        requestedTraceMissing
      />,
    );
    expect(screen.getByText(/expired-trace/)).toHaveTextContent("not present in retained history");
    expect(screen.getByRole("link", { name: "permalink" })).toHaveAttribute(
      "href",
      expect.stringContaining("trace=req-visible"),
    );
  });
});

describe("TraceExplorerView · memory receipt", () => {
  it("renders a Memory block from a span's memoryReceipt attribute", () => {
    const receipt = {
      schema: "marina.memory.receipt.v1",
      requestId: "req-visible",
      entity: "Ada",
      tiers: [
        {
          tier: "evidence",
          ids: [
            { id: "r1", version: 2 },
            { id: "r2", version: 1 },
          ],
          bytes: 900,
        },
        { tier: "trusted", ids: [{ id: "n1" }], bytes: 300 },
      ],
      budgetBytes: 2048,
      usedBytes: 1200,
      truncated: true,
      degraded: ["proposal:world_identity_required"],
    };
    const withReceipt = {
      ...data,
      traces: [
        {
          ...data.traces[0]!,
          spans: data.traces[0]!.spans.map((span) =>
            span.spanId === "request"
              ? {
                  ...span,
                  attributes: {
                    ...span.attributes,
                    memoryReceipt: JSON.stringify(receipt),
                    // Span attributes are strings on the wire.
                    memoryCacheHit: "true",
                    memorySurface: "anthropic",
                  },
                }
              : span,
          ),
        },
      ],
    };
    render(<TraceExplorerView data={withReceipt} isLoading={false} onRefresh={() => {}} />);
    const block = screen.getByLabelText("Memory receipt");
    expect(block).toHaveTextContent("Memory");
    expect(block).toHaveTextContent("1.2 KB / 2.0 KB (59%)");
    expect(block).toHaveTextContent("truncated");
    expect(block).toHaveTextContent("cache hit");
    expect(block).not.toHaveTextContent("cache miss");
    expect(screen.getByTestId("receipt-surface")).toHaveTextContent("anthropic");
    expect(block).toHaveTextContent("degraded: proposal:world_identity_required");
    const segments = [...block.querySelectorAll<HTMLElement>("[data-tier]")];
    expect(segments.map((segment) => segment.dataset.tier)).toEqual(["trusted", "evidence"]);
    expect(segments[1]!.dataset.bytes).toBe("900");
    // Legend carries the per-tier counts.
    expect(block).toHaveTextContent("evidence×2");
    // Existing routing rendering is untouched.
    expect(screen.getByText(/strategy: adaptive/)).toBeInTheDocument();
  });

  it('reads memoryCacheHit="false" as a miss and renders an unknown surface as an em dash', () => {
    const receipt = {
      schema: "marina.memory.receipt.v1",
      requestId: "req-visible",
      entity: "Ada",
      tiers: [{ tier: "trusted", ids: [{ id: "n1" }], bytes: 300 }],
      budgetBytes: 2048,
      usedBytes: 300,
      truncated: false,
      degraded: [],
    };
    const miss = {
      ...data,
      traces: [
        {
          ...data.traces[0]!,
          spans: data.traces[0]!.spans.map((span) =>
            span.spanId === "request"
              ? {
                  ...span,
                  attributes: {
                    ...span.attributes,
                    memoryReceipt: JSON.stringify(receipt),
                    memoryCacheHit: "false",
                    memorySurface: "unknown",
                  },
                }
              : span,
          ),
        },
      ],
    };
    render(<TraceExplorerView data={miss} isLoading={false} onRefresh={() => {}} />);
    const block = screen.getByLabelText("Memory receipt");
    expect(block).toHaveTextContent("cache miss");
    expect(screen.getByTestId("receipt-surface")).toHaveTextContent("—");
    expect(block).not.toHaveTextContent("unknown");
  });

  it("ignores a malformed receipt attribute instead of throwing", () => {
    const broken = {
      ...data,
      traces: [
        {
          ...data.traces[0]!,
          spans: data.traces[0]!.spans.map((span) =>
            span.spanId === "request"
              ? { ...span, attributes: { ...span.attributes, memoryReceipt: "{not json" } }
              : span,
          ),
        },
      ],
    };
    render(<TraceExplorerView data={broken} isLoading={false} onRefresh={() => {}} />);
    expect(screen.queryByLabelText("Memory receipt")).not.toBeInTheDocument();
    expect(screen.getByText("req-visible")).toBeInTheDocument();
  });
});

describe("TraceExplorerView · prompt sections", () => {
  const sections = [
    { name: "world-events", bytes: 2100, deferred: false },
    { name: "relevant-notes", bytes: 1400, deferred: false },
    { name: "reflection", bytes: 900, deferred: true },
  ];
  const withSections = (attributes: Record<string, string | number | boolean>): TracesResponse => ({
    ...data,
    traces: [
      {
        ...data.traces[0]!,
        spans: data.traces[0]!.spans.map((span) =>
          span.spanId === "turn"
            ? { ...span, attributes: { ...span.attributes, ...attributes } }
            : span,
        ),
      },
    ],
  });

  it("lists a turn's sections with bytes, flags the deferred ones and shows the fixed sizes", () => {
    render(
      <TraceExplorerView
        data={withSections({
          promptBytes: 4300,
          systemPromptBytes: 6100,
          residentSchemaBytes: 9800,
          // Span attributes are scalar on the wire: the list rides as JSON.
          promptSections: JSON.stringify(sections),
        })}
        isLoading={false}
        onRefresh={() => {}}
      />,
    );
    const block = screen.getByTestId("prompt-sections-turn");
    expect(block).toHaveAttribute("aria-label", "Prompt sections");
    expect(block).toHaveTextContent("4.2 KB");
    expect(block).toHaveTextContent("3 sections");
    expect(block).toHaveTextContent("1 deferred");
    expect(block).toHaveTextContent("system 6.0 KB");
    expect(block).toHaveTextContent("schemas 9.6 KB");
    const items = [...block.querySelectorAll<HTMLElement>("li")];
    expect(items.map((item) => item.dataset.deferred)).toEqual(["false", "false", "true"]);
    expect(items[0]).toHaveTextContent("world-events 2.1 KB");
    expect(items[2]).toHaveTextContent("reflection 900 B · deferred");
    // Only the turn span carries the block — the request and tool spans do not.
    expect(screen.getAllByLabelText("Prompt sections")).toHaveLength(1);
  });

  it("renders no block for turns without metrics or with a malformed attribute", () => {
    render(<TraceExplorerView data={data} isLoading={false} onRefresh={() => {}} />);
    expect(screen.queryByLabelText("Prompt sections")).toBeNull();
    expect(
      parsePromptSectionsAttribute({
        ...data.traces[0]!.spans[1]!,
        attributes: { promptSections: "{not json" },
      }),
    ).toBeUndefined();
    // A model_request span never carries prompt sections even if an attribute is present.
    expect(
      parsePromptSectionsAttribute({
        ...data.traces[0]!.spans[0]!,
        attributes: { promptSections: JSON.stringify(sections) },
      }),
    ).toBeUndefined();
    expect(
      parsePromptSectionsAttribute({
        ...data.traces[0]!.spans[1]!,
        attributes: { promptBytes: 10, promptSections: JSON.stringify(sections.slice(0, 1)) },
      }),
    ).toEqual({ promptBytes: 10, sections: sections.slice(0, 1) });
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

describe("traceWaterfallLayout", () => {
  it("maps nested timings into the trace window", () => {
    expect(traceWaterfallLayout(data.traces[0]!, 145)).toEqual([
      { spanId: "request", leftPercent: 0, widthPercent: 100 },
      {
        spanId: "turn",
        leftPercent: 22.22222222222222,
        widthPercent: 66.66666666666666,
      },
      {
        spanId: "tool",
        leftPercent: 44.44444444444444,
        widthPercent: 22.22222222222222,
      },
    ]);
  });

  it("clamps partial timestamps to a visible bounded bar", () => {
    const trace = data.traces[0]!;
    const partial = {
      ...trace,
      spans: [{ ...trace.spans[0]!, startedAt: 20, endedAt: 500 }],
    };
    expect(traceWaterfallLayout(partial, 145)[0]).toEqual({
      spanId: "request",
      leftPercent: 0,
      widthPercent: 100,
    });
  });
});
