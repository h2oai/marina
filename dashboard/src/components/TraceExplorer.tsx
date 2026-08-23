// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, CheckCircle2, CircleDot, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTraces } from "../hooks/use-api";
import { describeApiError } from "../lib/api";
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
}: {
  data?: TracesResponse;
  isLoading: boolean;
  error?: string;
  onRefresh: () => void;
}) {
  const traces = data?.traces ?? [];
  const [selectedId, setSelectedId] = useState<string>();
  useEffect(() => {
    if (!selectedId || !traces.some((trace) => trace.traceId === selectedId)) {
      setSelectedId(traces[0]?.traceId);
    }
  }, [selectedId, traces]);
  const selected = traces.find((trace) => trace.traceId === selectedId) ?? traces[0];

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
      {error && <div className="text-red-400">{error}</div>}
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
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(8rem,0.8fr)_minmax(12rem,1.6fr)] gap-2">
            <div className="min-h-0 space-y-1 overflow-auto border-r border-border pr-2">
              {traces.map((trace) => (
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
      </div>
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

export function TraceExplorer() {
  const query = useTraces();
  return (
    <TraceExplorerView
      data={query.data}
      isLoading={query.isLoading}
      error={query.error ? describeApiError(query.error) : undefined}
      onRefresh={() => void query.refetch()}
    />
  );
}
