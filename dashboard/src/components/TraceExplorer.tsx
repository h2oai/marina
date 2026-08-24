// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, CheckCircle2, CircleDot, RefreshCw } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { traceQueryString, useEvidenceReceipts, useTrace, useTraces } from "../hooks/use-api";
import { describeApiError, downloadApi } from "../lib/api";
import { tracePermalink } from "../lib/trace-links";
import type {
  TraceAggregate,
  TraceCheckResult,
  TraceCohortComparison,
  TraceRoutingAdvice,
  TraceSpanView,
  TraceStatus,
  TracesResponse,
  TraceView,
} from "../lib/types";

const STATUS_CLASS: Record<TraceStatus, string> = {
  running: "text-cyan-300",
  completed: "text-emerald-400",
  failed: "text-red-400",
};

const CHECK_CLASS: Record<TraceCheckResult, string> = {
  passed: "text-emerald-400",
  failed: "text-red-400",
  inconclusive: "text-cyan-300",
  not_applicable: "text-text-dim",
};

export function traceSpanDepth(span: TraceSpanView, spans: readonly TraceSpanView[]): number {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate]));
  const seen = new Set<string>([span.spanId]);
  let parentId = span.parentSpanId;
  let depth = 0;
  while (parentId && depth < 8) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentSpanId;
  }
  return depth;
}

export interface TraceWaterfallBar {
  spanId: string;
  leftPercent: number;
  widthPercent: number;
}

/**
 * Converts absolute span timestamps into bounded percentages. The calculation
 * is pure so malformed or partial retained history cannot push bars outside
 * the visible waterfall.
 */
export function traceWaterfallLayout(trace: TraceView, now = Date.now()): TraceWaterfallBar[] {
  const observedEnd = trace.endedAt
    ? Math.max(trace.startedAt + 1, trace.endedAt)
    : Math.max(
        trace.startedAt + 1,
        ...trace.spans.map((span) => span.endedAt ?? span.startedAt + (span.durationMs ?? 0)),
        trace.status === "running" ? now : 0,
      );
  const windowMs = Math.max(1, observedEnd - trace.startedAt);
  return trace.spans.map((span) => {
    const start = Math.min(observedEnd, Math.max(trace.startedAt, span.startedAt));
    const end = Math.min(
      observedEnd,
      Math.max(
        start,
        span.endedAt ?? start + (span.durationMs ?? (span.status === "running" ? now - start : 0)),
      ),
    );
    const leftPercent = ((start - trace.startedAt) / windowMs) * 100;
    const measuredWidth = ((end - start) / windowMs) * 100;
    return {
      spanId: span.spanId,
      leftPercent,
      widthPercent: Math.min(100 - leftPercent, Math.max(0.8, measuredWidth)),
    };
  });
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return "live";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function StatusIcon({ status }: { status: TraceStatus }) {
  if (status === "completed") return <CheckCircle2 size={11} aria-label="completed" />;
  if (status === "failed") return <AlertTriangle size={11} aria-label="failed" />;
  return <CircleDot size={11} aria-label="running" />;
}

export function TraceExplorerView({
  data,
  isLoading,
  error,
  onRefresh,
  requestedTraceId,
  requestedTraceMissing = false,
  onQueryChange,
  onStatusChange,
  onDimensionChange,
  onTimeRangeChange,
  onNextPage,
  onPreviousPage,
  canPreviousPage = false,
  onExport,
}: {
  data?: TracesResponse;
  isLoading: boolean;
  error?: string;
  onRefresh: () => void;
  requestedTraceId?: string;
  requestedTraceMissing?: boolean;
  onQueryChange?: (query: string) => void;
  onStatusChange?: (status: "all" | TraceStatus) => void;
  onDimensionChange?: (key: "model" | "agent" | "tool", value: string) => void;
  onTimeRangeChange?: (milliseconds?: number) => void;
  onNextPage?: () => void;
  onPreviousPage?: () => void;
  canPreviousPage?: boolean;
  onExport?: (format: "native" | "eval-json" | "otlp-json") => void;
}) {
  const traces = data?.traces ?? [];
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | TraceStatus>("all");
  const visibleTraces = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return traces.filter((trace) => {
      if (status !== "all" && trace.status !== status) return false;
      if (!needle) return true;
      return (
        trace.traceId.toLowerCase().includes(needle) ||
        trace.spans.some(
          (span) =>
            span.name.toLowerCase().includes(needle) ||
            span.kind.toLowerCase().includes(needle) ||
            Object.values(span.attributes).some((value) =>
              String(value).toLowerCase().includes(needle),
            ),
        )
      );
    });
  }, [query, status, traces]);
  useEffect(() => {
    if (requestedTraceId && traces.some((trace) => trace.traceId === requestedTraceId)) {
      setSelectedId(requestedTraceId);
      return;
    }
    if (!selectedId || !visibleTraces.some((trace) => trace.traceId === selectedId)) {
      setSelectedId(visibleTraces[0]?.traceId);
    }
  }, [requestedTraceId, selectedId, traces, visibleTraces]);
  const selected = visibleTraces.find((trace) => trace.traceId === selectedId) ?? visibleTraces[0];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-[10px]">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-text-dim">
          {data ? `${data.source} · ${data.retention}` : "Recent execution traces"}
          {data?.truncated ? " · event window truncated" : ""}
        </div>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 text-primary hover:underline"
          onClick={onRefresh}
        >
          <RefreshCw size={10} /> Refresh
        </button>
      </div>
      {data?.otlp && <OtlpDeliveryStatus status={data.otlp} />}
      {error && <div className="text-red-400">{error}</div>}
      {requestedTraceMissing && requestedTraceId && (
        <div className="rounded border border-amber-400/40 bg-amber-400/5 p-2 text-amber-300">
          Trace “{requestedTraceId}” is not present in retained history. It may have expired or come
          from a different Marina instance.
        </div>
      )}
      {isLoading && traces.length === 0 && <div className="text-text-dim">Loading traces…</div>}
      {!isLoading && !error && traces.length === 0 && (
        <div className="rounded border border-border p-3 text-text-dim">
          No traced executions yet. Start an agent turn or send a request through Marina’s model
          endpoint to begin.
        </div>
      )}
      {traces.length > 0 && (
        <>
          {data?.analytics && (
            <AnalyticsSummary
              models={data.analytics.models}
              agentModels={data.analytics.agentModels ?? []}
              routes={data.analytics.routes}
              tools={data.analytics.tools}
            />
          )}
          {data?.comparisons && (
            <CohortSummary rows={[...data.comparisons.models, ...data.comparisons.routes]} />
          )}
          {data?.shadowAdvice && (
            <ShadowAdvice
              rows={[
                data.shadowAdvice.models,
                data.shadowAdvice.routes,
                data.shadowAdvice.autonomousModels,
                data.shadowAdvice.tools,
              ].filter((row): row is TraceRoutingAdvice => row !== undefined)}
            />
          )}
          <fieldset className="flex min-w-0 items-center gap-2 border-0 p-0">
            <legend className="sr-only">Trace filters</legend>
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                onQueryChange?.(event.target.value);
              }}
              placeholder="Search ID, model, agent, tool, error…"
              aria-label="Search traces"
              className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-text outline-none focus:border-primary/60"
            />
            <select
              value={status}
              onChange={(event) => {
                const value = event.target.value as "all" | TraceStatus;
                setStatus(value);
                onStatusChange?.(value);
              }}
              aria-label="Filter trace status"
              className="rounded border border-border bg-bg px-2 py-1 text-text"
            >
              <option value="all">all statuses</option>
              <option value="running">running</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
            </select>
            {onTimeRangeChange && (
              <select
                aria-label="Filter trace time range"
                defaultValue="all"
                className="rounded border border-border bg-bg px-2 py-1 text-text"
                onChange={(event) =>
                  onTimeRangeChange(
                    event.target.value === "all" ? undefined : Number(event.target.value),
                  )
                }
              >
                <option value="all">all retained time</option>
                <option value={15 * 60_000}>last 15 minutes</option>
                <option value={60 * 60_000}>last hour</option>
                <option value={24 * 60 * 60_000}>last 24 hours</option>
              </select>
            )}
            <span className="shrink-0 text-text-dim">
              {visibleTraces.length}/{traces.length}
            </span>
          </fieldset>
          {onDimensionChange && (
            <fieldset className="grid grid-cols-3 gap-2 border-0 p-0">
              <legend className="sr-only">Trace dimensions</legend>
              {(["model", "agent", "tool"] as const).map((key) => (
                <input
                  key={key}
                  type="search"
                  aria-label={`Filter trace ${key}`}
                  placeholder={`${key} contains…`}
                  className="min-w-0 rounded border border-border bg-bg px-2 py-1 text-text outline-none focus:border-primary/60"
                  onChange={(event) => onDimensionChange(key, event.target.value)}
                />
              ))}
            </fieldset>
          )}
          {(onExport || onNextPage || onPreviousPage) && (
            <div className="flex items-center justify-between gap-2 text-[9px]">
              <div className="flex gap-2">
                {onExport && (
                  <>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => onExport("native")}
                    >
                      Download JSON
                    </button>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => onExport("eval-json")}
                    >
                      Download eval dataset
                    </button>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => onExport("otlp-json")}
                    >
                      Download OTLP
                    </button>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!canPreviousPage}
                  className="text-primary enabled:hover:underline disabled:text-text-dim"
                  onClick={onPreviousPage}
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={!data?.page?.hasMore}
                  className="text-primary enabled:hover:underline disabled:text-text-dim"
                  onClick={onNextPage}
                >
                  Next
                </button>
              </div>
            </div>
          )}
          {visibleTraces.length === 0 && (
            <div className="rounded border border-border p-2 text-text-dim">
              No retained traces match these filters.
            </div>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(8rem,0.8fr)_minmax(12rem,1.6fr)] gap-2">
            <div className="min-h-0 space-y-1 overflow-auto border-r border-border pr-2">
              {visibleTraces.map((trace) => (
                <TraceRow
                  key={trace.traceId}
                  trace={trace}
                  selected={trace.traceId === selected?.traceId}
                  onSelect={() => setSelectedId(trace.traceId)}
                />
              ))}
            </div>
            <section className="min-h-0 overflow-auto" aria-label="Trace spans">
              {selected && <SpanTree trace={selected} />}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function OtlpDeliveryStatus({ status }: { status: NonNullable<TracesResponse["otlp"]> }) {
  if (!status.enabled) {
    return (
      <section className="text-[9px] text-text-dim" aria-label="OpenTelemetry delivery">
        OpenTelemetry export: off
      </section>
    );
  }
  const unhealthy = status.consecutiveFailures > 0 || status.droppedTraces > 0;
  return (
    <section
      className={`rounded border px-2 py-1 ${
        unhealthy ? "border-amber-400/40 text-amber-300" : "border-emerald-400/30 text-emerald-300"
      }`}
      aria-label="OpenTelemetry delivery"
      title={status.lastError}
    >
      OTLP {unhealthy ? "degraded" : "healthy"} · {status.exportedSpans} spans exported ·{" "}
      {status.pendingTraces} traces queued · {status.rejectedSpans} rejected ·{" "}
      {status.exportFailures} failures
    </section>
  );
}

function ShadowAdvice({ rows }: { rows: TraceRoutingAdvice[] }) {
  return (
    <section className="rounded border border-border px-2 py-1" aria-label="Shadow routing advice">
      <div className="text-[9px] uppercase tracking-wider text-text-dim">
        routing evidence · applied only by explicit adaptive routing
      </div>
      <div className="flex gap-3 text-[9px] text-text-dim">
        {rows.map((row) => (
          <div key={row.dimension} title={row.reasons.join(" ")}>
            <span className="text-text">{row.dimension}</span>: {row.mode} ·{" "}
            {row.candidates.join(", ") || "none"}
          </div>
        ))}
      </div>
    </section>
  );
}

function CohortSummary({ rows }: { rows: TraceCohortComparison[] }) {
  if (rows.length < 2) return null;
  return (
    <section className="rounded border border-border px-2 py-1" aria-label="Trace cohorts">
      <div className="mb-1 text-[9px] uppercase tracking-wider text-text-dim">
        observed cohorts · descriptive, no winner inferred
      </div>
      <div className="flex gap-3 overflow-x-auto text-[9px] text-text-dim">
        {rows.slice(0, 6).map((row) => (
          <div key={`${row.dimension}-${row.name}`} className="shrink-0">
            <span className="text-text">
              {row.dimension}:{row.name}
            </span>{" "}
            n={row.mechanics.eligible}/{row.mechanics.observed} · judgments={row.judgments.total}
          </div>
        ))}
      </div>
    </section>
  );
}

function AnalyticsSummary({
  models,
  agentModels,
  routes,
  tools,
}: {
  models: TraceAggregate[];
  agentModels: TraceAggregate[];
  routes: TraceAggregate[];
  tools: TraceAggregate[];
}) {
  const rows = [
    ...models.slice(0, 1).map((row) => ({ kind: "model", row })),
    ...agentModels.slice(0, 1).map((row) => ({ kind: "autonomous", row })),
    ...routes.slice(0, 1).map((row) => ({ kind: "route", row })),
    ...tools.slice(0, 2).map((row) => ({ kind: "tool", row })),
  ];
  if (rows.length === 0) return null;
  return (
    <section className="grid grid-cols-2 gap-1 md:grid-cols-4" aria-label="Trace analytics">
      {rows.map(({ kind, row }) => (
        <div key={`${kind}-${row.name}`} className="rounded border border-border px-2 py-1">
          <div className="truncate text-text" title={`${kind}: ${row.name}`}>
            {kind}: {row.name}
          </div>
          <div className="text-[9px] text-text-dim">
            n={row.eligible}/{row.observed} · success {formatRate(row.successRate)} · p50{" "}
            {formatDuration(row.latency.p50Ms)} · ttft {formatDuration(row.ttft?.p50Ms)}
            {(row.tokens?.samples ?? 0) > 0
              ? ` · ${row.tokens!.input}in/${row.tokens!.output}out`
              : ""}
            {(row.cost?.samples ?? 0) > 0 ? ` · $${row.cost!.totalUsd.toFixed(4)}` : ""}
          </div>
        </div>
      ))}
    </section>
  );
}

function formatRate(rate?: number): string {
  return rate === undefined ? "n/a" : `${Math.round(rate * 100)}%`;
}

function routeDetails(span: TraceSpanView): string | undefined {
  const strategy = span.attributes.routeStrategy;
  if (typeof strategy !== "string") return undefined;
  const mode = span.attributes.routeAdviceMode;
  const reason = span.attributes.routeReason;
  return [
    `strategy: ${strategy}`,
    typeof mode === "string" ? `advice: ${mode}` : undefined,
    typeof reason === "string" ? reason : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function metricDetails(span: TraceSpanView): string | undefined {
  const values = [
    typeof span.attributes.model === "string" ? `model: ${span.attributes.model}` : undefined,
    typeof span.attributes.origin === "string" ? `origin: ${span.attributes.origin}` : undefined,
    typeof span.attributes.ttftMs === "number"
      ? `ttft: ${formatDuration(span.attributes.ttftMs)}`
      : undefined,
    typeof span.attributes.inputTokens === "number"
      ? `input: ${span.attributes.inputTokens}`
      : undefined,
    typeof span.attributes.outputTokens === "number"
      ? `output: ${span.attributes.outputTokens}`
      : undefined,
    typeof span.attributes.costUsd === "number"
      ? `cost: $${span.attributes.costUsd.toFixed(4)}`
      : undefined,
    typeof span.attributes.errorKind === "string"
      ? `error: ${span.attributes.errorKind}`
      : undefined,
  ].filter(Boolean);
  return values.length > 0 ? values.join(" · ") : undefined;
}

function TraceRow({
  trace,
  selected,
  onSelect,
}: {
  trace: TraceView;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`w-full rounded border px-2 py-1.5 text-left ${
        selected ? "border-primary/60 bg-primary/10" : "border-border hover:border-primary/30"
      }`}
      onClick={onSelect}
    >
      <div className={`flex items-center gap-1 ${STATUS_CLASS[trace.status]}`}>
        <StatusIcon status={trace.status} />
        <span className="truncate font-medium">{trace.traceId}</span>
      </div>
      <div className="mt-0.5 flex justify-between text-text-dim">
        <span>{trace.spans.length} spans</span>
        <span>{formatDuration(trace.durationMs)}</span>
      </div>
    </button>
  );
}

function SpanTree({ trace }: { trace: TraceView }) {
  const depths = useMemo(
    () => new Map(trace.spans.map((span) => [span.spanId, traceSpanDepth(span, trace.spans)])),
    [trace],
  );
  return (
    <div className="space-y-1">
      <div className="mb-2 flex items-center gap-2 text-text-dim">
        <span className={STATUS_CLASS[trace.status]}>{trace.status}</span>
        <span>{formatDuration(trace.durationMs)}</span>
        {trace.partial && <span className="text-amber-300">partial history</span>}
        <a
          href={tracePermalink(trace.traceId, window.location.href)}
          className="ml-auto text-primary hover:underline"
          title="Open or copy a durable link to this retained trace"
        >
          permalink
        </a>
      </div>
      <TraceWaterfall trace={trace} depths={depths} />
      {trace.spans.map((span) => {
        const routing = routeDetails(span);
        const metrics = metricDetails(span);
        return (
          <div
            key={span.spanId}
            className="relative rounded border border-border bg-bg/30 px-2 py-1"
            style={{ marginLeft: `${(depths.get(span.spanId) ?? 0) * 14}px` }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`flex min-w-0 items-center gap-1 ${STATUS_CLASS[span.status]}`}>
                <StatusIcon status={span.status} />
                <span className="truncate text-text">{span.name}</span>
              </span>
              <span className="shrink-0 text-text-dim">{formatDuration(span.durationMs)}</span>
            </div>
            <div className="mt-0.5 flex gap-2 text-[9px] text-text-dim">
              <span>{span.kind.replace("_", " ")}</span>
              {span.partial && <span className="text-amber-300">partial</span>}
            </div>
            {routing && (
              <div className="mt-0.5 text-[9px] text-text-dim" title={routing}>
                {routing}
              </div>
            )}
            {metrics && (
              <div className="mt-0.5 text-[9px] text-text-dim" title={metrics}>
                {metrics}
              </div>
            )}
          </div>
        );
      })}
      <section className="mt-3 border-t border-border pt-2" aria-label="Execution checks">
        <div className="mb-1 text-[9px] uppercase tracking-wider text-text-dim">
          {trace.evaluation.evaluator}
        </div>
        <div className="space-y-1">
          {trace.evaluation.checks.map((check) => (
            <div key={check.id} className="rounded border border-border px-2 py-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-text">{check.id.replaceAll("_", " ")}</span>
                <span className={CHECK_CLASS[check.result]}>{check.result.replace("_", " ")}</span>
              </div>
              <div className="text-[9px] text-text-dim">{check.summary}</div>
              {check.evidenceSpanIds.length > 0 && (
                <div
                  className="truncate text-[9px] text-text-dim"
                  title={check.evidenceSpanIds.join(", ")}
                >
                  evidence: {check.evidenceSpanIds.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
      {trace.judgments && trace.judgments.length > 0 && (
        <section className="mt-3 border-t border-border pt-2" aria-label="Participant judgments">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-text-dim">
            attributed participant judgments · advisory
          </div>
          <div className="space-y-1">
            {trace.judgments.map((judgment) => (
              <div key={judgment.id} className="rounded border border-border px-2 py-1">
                <div className="flex justify-between gap-2">
                  <span className="text-text">{judgment.criterion}</span>
                  <span className={CHECK_CLASS[judgment.verdict]}>{judgment.verdict}</span>
                </div>
                <div className="text-[9px] text-text-dim">by {judgment.evaluatorEntity}</div>
                <div className="text-[9px] text-text-dim">{judgment.rationale}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const WATERFALL_KIND_CLASS: Record<TraceSpanView["kind"], string> = {
  model_request: "bg-cyan-400",
  agent_turn: "bg-violet-400",
  tool: "bg-amber-400",
};

function TraceWaterfall({
  trace,
  depths,
}: {
  trace: TraceView;
  depths: ReadonlyMap<string, number>;
}) {
  const bars = useMemo(() => traceWaterfallLayout(trace), [trace]);
  const byId = new Map(bars.map((bar) => [bar.spanId, bar]));
  return (
    <section className="mb-2 rounded border border-border p-2" aria-label="Trace waterfall">
      <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-text-dim">
        <span>causal waterfall</span>
        <span>0 → {formatDuration(trace.durationMs)}</span>
      </div>
      <div className="space-y-1">
        {trace.spans.map((span) => {
          const bar = byId.get(span.spanId);
          if (!bar) return null;
          return (
            <div
              key={span.spanId}
              className="grid grid-cols-[minmax(5rem,0.8fr)_1.5fr] items-center gap-2"
            >
              <div
                className="truncate text-[9px] text-text-dim"
                style={{ paddingLeft: `${(depths.get(span.spanId) ?? 0) * 8}px` }}
                title={`${span.kind}: ${span.name}`}
              >
                {span.name}
              </div>
              <div className="relative h-2 overflow-hidden rounded bg-white/5">
                <div
                  className={`absolute inset-y-0 rounded ${WATERFALL_KIND_CLASS[span.kind]} ${
                    span.status === "running" ? "animate-pulse" : ""
                  } ${span.partial ? "opacity-50" : "opacity-80"}`}
                  style={{ left: `${bar.leftPercent}%`, width: `${bar.widthPercent}%` }}
                  title={`${span.name} · ${formatDuration(span.durationMs)} · ${span.status}`}
                  data-testid={`waterfall-${span.spanId}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-3 text-[8px] text-text-dim">
        <span>
          <i className="mr-1 inline-block h-1.5 w-1.5 rounded bg-cyan-400" />
          request
        </span>
        <span>
          <i className="mr-1 inline-block h-1.5 w-1.5 rounded bg-violet-400" />
          agent
        </span>
        <span>
          <i className="mr-1 inline-block h-1.5 w-1.5 rounded bg-amber-400" />
          tool
        </span>
      </div>
    </section>
  );
}

export function TraceExplorer({ requestedTraceId }: { requestedTraceId?: string }) {
  const evidence = useEvidenceReceipts();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState<"all" | TraceStatus>("all");
  const [dimensions, setDimensions] = useState({ model: "", agent: "", tool: "" });
  const deferredDimensions = useDeferredValue(dimensions);
  const [since, setSince] = useState<number>();
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [exportError, setExportError] = useState<string>();
  const filters = {
    limit: 100,
    ...(deferredSearch.trim() ? { q: deferredSearch.trim() } : {}),
    ...(status === "all" ? {} : { status }),
    ...(deferredDimensions.model.trim() ? { model: deferredDimensions.model.trim() } : {}),
    ...(deferredDimensions.agent.trim() ? { agent: deferredDimensions.agent.trim() } : {}),
    ...(deferredDimensions.tool.trim() ? { tool: deferredDimensions.tool.trim() } : {}),
    ...(cursor ? { cursor } : {}),
    ...(since === undefined ? {} : { since }),
  };
  const query = useTraces(filters);
  const detailQuery = useTrace(requestedTraceId);
  const data = useMemo(() => {
    if (!query.data) return detailQuery.data;
    const requested = detailQuery.data?.traces[0];
    if (!requested || query.data.traces.some((trace) => trace.traceId === requested.traceId)) {
      return query.data;
    }
    return { ...query.data, traces: [requested, ...query.data.traces] };
  }, [detailQuery.data, query.data]);
  return (
    <div className="space-y-2">
      <section className="rounded border border-border bg-bg/40 px-2 py-1 text-[10px] text-text-dim">
        {evidence.isLoading ? (
          "Verifying local evidence receipts…"
        ) : evidence.isError ? (
          <span className="text-warning">Evidence receipt status unavailable.</span>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={evidence.data?.verification.valid ? "text-success" : "text-danger"}>
              Local receipt chain {evidence.data?.verification.valid ? "consistent" : "invalid"}
            </span>
            <span>{evidence.data?.verification.entries ?? 0} receipts</span>
            {evidence.data?.verification.headHash && (
              <code title={evidence.data.verification.headHash}>
                head {evidence.data.verification.headHash.slice(0, 12)}…
              </code>
            )}
            <span title={evidence.data?.trustBoundary}>
              local linkage, not external immutability
            </span>
          </div>
        )}
      </section>
      <TraceExplorerView
        data={data}
        isLoading={query.isLoading || (Boolean(requestedTraceId) && detailQuery.isLoading)}
        error={
          query.error
            ? describeApiError(query.error)
            : detailQuery.error
              ? describeApiError(detailQuery.error)
              : exportError
        }
        onRefresh={() =>
          void Promise.all(
            requestedTraceId ? [query.refetch(), detailQuery.refetch()] : [query.refetch()],
          )
        }
        requestedTraceId={requestedTraceId}
        requestedTraceMissing={
          Boolean(requestedTraceId) &&
          !detailQuery.isLoading &&
          detailQuery.data?.traces.length === 0
        }
        onQueryChange={(value) => {
          setSearch(value);
          setCursor(undefined);
          setCursorHistory([]);
        }}
        onStatusChange={(value) => {
          setStatus(value);
          setCursor(undefined);
          setCursorHistory([]);
        }}
        onDimensionChange={(key, value) => {
          setDimensions((current) => ({ ...current, [key]: value }));
          setCursor(undefined);
          setCursorHistory([]);
        }}
        onTimeRangeChange={(milliseconds) => {
          setSince(milliseconds === undefined ? undefined : Date.now() - milliseconds);
          setCursor(undefined);
          setCursorHistory([]);
        }}
        canPreviousPage={cursorHistory.length > 0}
        onPreviousPage={() => {
          const previous = cursorHistory.at(-1);
          setCursor(previous);
          setCursorHistory((history) => history.slice(0, -1));
        }}
        onNextPage={() => {
          if (!query.data?.page?.nextCursor) return;
          setCursorHistory((history) => [...history, cursor]);
          setCursor(query.data.page!.nextCursor);
        }}
        onExport={(format) => {
          const exportFilters = {
            limit: 100,
            ...(deferredSearch.trim() ? { q: deferredSearch.trim() } : {}),
            ...(status === "all" ? {} : { status }),
            ...(since === undefined ? {} : { since }),
            ...(deferredDimensions.model.trim() ? { model: deferredDimensions.model.trim() } : {}),
            ...(deferredDimensions.agent.trim() ? { agent: deferredDimensions.agent.trim() } : {}),
            ...(deferredDimensions.tool.trim() ? { tool: deferredDimensions.tool.trim() } : {}),
          };
          const formatQuery = format === "native" ? "" : `&format=${format}`;
          setExportError(undefined);
          void downloadApi(
            `/api/traces?${traceQueryString(exportFilters)}${formatQuery}&download=1`,
            `marina-traces-${format}.json`,
          ).catch((cause) => setExportError(describeApiError(cause)));
        }}
      />
    </div>
  );
}
