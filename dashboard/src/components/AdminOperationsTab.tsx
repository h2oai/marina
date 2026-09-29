// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Activity, AlertTriangle, Bell, Brain, CheckCircle2, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
  useContradictions,
  useMemoryQuality,
  useOperationalAlerts,
  useProductivity,
  useReadiness,
} from "../hooks/use-api";
import { describeApiError, postApi } from "../lib/api";

export function OperationsTab() {
  const alertsQuery = useOperationalAlerts();
  const productivityQuery = useProductivity();
  const readinessQuery = useReadiness();
  const memoryQuery = useMemoryQuality();
  const conflictsQuery = useContradictions();
  const [rationales, setRationales] = useState<Record<number, string>>({});
  const [alertScope, setAlertScope] = useState<"active" | "history">("active");
  const [alertCategory, setAlertCategory] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const alerts = alertsQuery.data ?? [];
  const productivity = productivityQuery.data;
  const readiness = readinessQuery.data;
  const memory = memoryQuery.data;
  const conflicts = conflictsQuery.data ?? [];
  const refresh = async () => {
    setError(null);
    try {
      await Promise.all([
        alertsQuery.refetch(),
        productivityQuery.refetch(),
        readinessQuery.refetch(),
        memoryQuery.refetch(),
        conflictsQuery.refetch(),
      ]);
    } catch (e) {
      setError(describeApiError(e));
    }
  };
  const act = async (id: number, action: "ack" | "resolve") => {
    try {
      await postApi(`/api/operations/alerts/${id}/${action}`);
      await refresh();
    } catch (e) {
      setError(describeApiError(e));
    }
  };
  const resolveConflict = async (id: number, resolution: "left" | "right" | "both" | "neither") => {
    const rationale = rationales[id]?.trim();
    if (!rationale) {
      setError("Add an evidence-based rationale before resolving a contradiction.");
      return;
    }
    try {
      await postApi(`/api/memory/contradictions/${id}/resolve`, { resolution, rationale });
      setRationales((current) => ({ ...current, [id]: "" }));
      await Promise.all([conflictsQuery.refetch(), alertsQuery.refetch(), memoryQuery.refetch()]);
    } catch (e) {
      setError(describeApiError(e));
    }
  };
  const active = alerts.filter((a) => a.status !== "resolved");
  const critical = active.filter((a) => a.severity === "critical").length;
  const visibleAlerts = alerts.filter(
    (alert) =>
      (alertScope === "history" || alert.status !== "resolved") &&
      (alertScope === "history" || !alert.snoozed_until || alert.snoozed_until <= Date.now()) &&
      (alertCategory === "all" || alert.category === alertCategory),
  );
  const categories = [...new Set(alerts.map((alert) => alert.category))].sort();
  return (
    <div className="space-y-2 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-primary uppercase tracking-wider">
          <Bell size={10} /> Operations Inbox
        </span>
        <button type="button" className="text-primary hover:underline" onClick={refresh}>
          Refresh
        </button>
      </div>
      {error && <div className="text-red-400">{error}</div>}
      {productivity && (
        <div className="space-y-1">
          <div className="grid grid-cols-4 gap-1">
            <Metric
              label="Success"
              value={`${Math.round(productivity.summary.successRate * 100)}%`}
              tone="success"
            />
            <Metric label="Outcomes / 7d" value={String(productivity.summary.outcomesLast7d)} />
            <Metric
              label="Open conflicts"
              value={String(conflicts.length)}
              tone={conflicts.length ? "warning" : "success"}
            />
            <Metric
              label="Critical"
              value={String(critical)}
              tone={critical ? "danger" : "success"}
            />
          </div>
          <div className="grid grid-cols-4 gap-1">
            <Metric label="Median" value={formatDuration(productivity.summary.medianDurationMs)} />
            <Metric
              label="Avg latency"
              value={formatDuration(productivity.summary.averageDurationMs)}
            />
            <Metric
              label="Tools / outcome"
              value={productivity.summary.averageToolCalls.toFixed(1)}
            />
            <Metric label="Handoffs" value={productivity.summary.averageHandoffs.toFixed(1)} />
          </div>
          <div className="grid grid-cols-4 gap-1">
            <Metric
              label="Meaningful"
              value={`${Math.round(productivity.primitiveUsage.meaningfulRate * 100)}%`}
              tone={productivity.primitiveUsage.meaningfulActions ? "success" : "warning"}
            />
            <Metric
              label="World actions"
              value={String(productivity.primitiveUsage.worldActions)}
            />
            <Metric
              label="Communications"
              value={String(productivity.primitiveUsage.communications)}
            />
            <Metric
              label="Primitive range"
              value={String(productivity.primitiveUsage.primitiveDiversity)}
            />
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Metric
              label="Trust-attributed tools"
              value={String(productivity.primitiveUsage.untrustedToolCalls)}
            />
            <Metric
              label="Consequential tools"
              value={String(productivity.primitiveUsage.consequentialToolCalls)}
              tone={productivity.primitiveUsage.consequentialToolCalls ? "warning" : undefined}
            />
          </div>
          {productivity.promptOutcomes.length > 0 && (
            <div className="rounded border border-border/70 bg-bg/40 p-1.5 text-[10px]">
              <div className="mb-1 uppercase tracking-wider text-text-dim">Prompt outcomes</div>
              {productivity.promptOutcomes.slice(0, 3).map((row) => (
                <div
                  key={row.promptVersion}
                  className="flex justify-between gap-2"
                  title={`${row.agents} agents · ${row.successes} successes · ${row.failures} failures · ${formatDuration(row.averageDurationMs)} average latency · ${Math.round(row.averageInputTokens + row.averageOutputTokens)} tokens/outcome · $${row.averageCostUsd.toFixed(4)}/outcome`}
                >
                  <span className="font-mono text-text-muted">{row.promptVersion}</span>
                  <span>
                    {Math.round(row.successRate * 100)}% · {row.meaningfulActions} actions ·{" "}
                    {row.averageToolCalls.toFixed(1)} tools ·{" "}
                    {Math.round(row.averageInputTokens + row.averageOutputTokens)} tok
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {readiness && (
        <div className="rounded border border-border bg-bg-surface/50 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1 uppercase tracking-wider text-text-dim">
              <Activity size={10} /> Readiness
            </span>
            <strong
              className={
                readiness.demo.score >= 80
                  ? "text-success"
                  : readiness.demo.score >= 55
                    ? "text-warning"
                    : "text-danger"
              }
            >
              {readiness.demo.score}/100
            </strong>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <div
              className={`col-span-2 flex items-center justify-center gap-1 rounded px-1.5 py-1 font-semibold ${readiness.demo.autonomyQualified ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
            >
              {readiness.demo.autonomyQualified ? (
                <CheckCircle2 size={10} />
              ) : (
                <Activity size={10} />
              )}
              {readiness.demo.autonomyQualified
                ? "Live autonomy qualified"
                : "Awaiting live autonomy evidence"}
            </div>
            {readiness.checks.map((check) => (
              <div
                key={check.id}
                title={`${check.detail}${check.remediation ? `\n${check.remediation}` : ""}`}
                className={`flex items-center gap-1 rounded px-1.5 py-1 ${check.status === "ok" ? "bg-success/10 text-success" : check.status === "degraded" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger"}`}
              >
                {check.status === "ok" ? <CheckCircle2 size={9} /> : <AlertTriangle size={9} />}
                <span className="truncate">{check.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-1 text-text-dim">
            Live proof: {readiness.demo.activeAgents} agents ·{" "}
            {readiness.demo.recentPrimitiveActions} meaningful actions ·{" "}
            {readiness.demo.recentCommunications} communications · {readiness.demo.marinaToolCalls}{" "}
            Marina tools / 5m
          </div>
        </div>
      )}
      {productivity && productivity.trend.length > 0 && (
        <div className="rounded border border-border bg-bg-surface/50 p-2">
          <div className="mb-1 flex items-center gap-1 uppercase tracking-wider text-text-dim">
            <TrendingUp size={10} /> 14-day outcomes
          </div>
          <TrendChart points={productivity.trend} />
          <div className="mt-2 space-y-1">
            {productivity.leaderboard.slice(0, 5).map((row, index) => (
              <div key={row.entityName ?? index} className="flex items-center gap-2">
                <span className="w-3 text-text-dim">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{row.entityName}</span>
                <span className="text-success">
                  {row.successes}/{row.outcomes}
                </span>
                <span className="w-8 text-right text-text-dim">
                  {Math.round(row.successRate * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {productivity && productivity.primitiveLeaderboard.length > 0 && (
        <div className="rounded border border-border bg-bg-surface/50 p-2">
          <div className="mb-1 flex items-center gap-1 uppercase tracking-wider text-text-dim">
            <Activity size={10} /> Agent primitive use
          </div>
          <div className="space-y-1">
            {productivity.primitiveLeaderboard.slice(0, 5).map((row, index) => (
              <div key={row.entityName ?? index} className="flex items-center gap-2">
                <span className="w-3 text-text-dim">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{row.entityName}</span>
                <span className="text-success">{row.meaningfulActions} actions</span>
                <span
                  className="w-20 text-right text-text-dim"
                  title={`${row.marinaToolCalls}/${row.toolCalls} Marina tool calls; reasoning-only calls do not count as actions`}
                >
                  {row.primitiveDiversity} primitives
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {memory && (
        <div className="rounded border border-border bg-bg-surface/50 p-2">
          <div className="mb-1 flex items-center gap-1 uppercase tracking-wider text-text-dim">
            <Brain size={10} /> Memory quality
          </div>
          <div className="grid grid-cols-4 gap-1 text-center">
            <Metric label="Notes" value={String(memory.total)} />
            <Metric
              label="Unverified"
              value={String(memory.unverified)}
              tone={memory.unverified ? "warning" : "success"}
            />
            <Metric
              label="Disputed"
              value={String(memory.disputed)}
              tone={memory.disputed ? "danger" : "success"}
            />
            <Metric
              label="Stale"
              value={String(memory.staleSources)}
              tone={memory.staleSources ? "warning" : "success"}
            />
          </div>
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="space-y-1 rounded border border-warning/30 bg-warning/5 p-2">
          <div className="flex items-center gap-1 uppercase tracking-wider text-warning">
            <AlertTriangle size={10} /> Contradictions
          </div>
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="rounded border border-border bg-bg/60 p-2">
              <div className="mb-1 text-text-dim">
                #{conflict.id} · {conflict.scope_type}
                {conflict.scope_id ? `:${conflict.scope_id}` : ""}
              </div>
              <div>
                <span className="text-primary">Left · {conflict.left?.entity_name}</span>{" "}
                {conflict.left?.content}
              </div>
              <div>
                <span className="text-secondary">Right · {conflict.right?.entity_name}</span>{" "}
                {conflict.right?.content}
              </div>
              <input
                value={rationales[conflict.id] ?? ""}
                onChange={(event) =>
                  setRationales((current) => ({ ...current, [conflict.id]: event.target.value }))
                }
                placeholder="Evidence-based rationale"
                className="mt-1 w-full rounded border border-border bg-bg px-1.5 py-1 text-text outline-none focus:border-primary"
              />
              <div className="mt-1 flex flex-wrap gap-2">
                {(["left", "right", "both", "neither"] as const).map((resolution) => (
                  <button
                    key={resolution}
                    type="button"
                    onClick={() => resolveConflict(conflict.id, resolution)}
                    className="capitalize text-primary hover:underline"
                  >
                    {resolution}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 rounded border border-border bg-bg-surface/40 p-1">
        <button
          type="button"
          onClick={() => setAlertScope("active")}
          className={`rounded px-1.5 py-0.5 ${alertScope === "active" ? "bg-primary/15 text-primary" : "text-text-dim"}`}
        >
          Active
        </button>
        <button
          type="button"
          onClick={() => setAlertScope("history")}
          className={`rounded px-1.5 py-0.5 ${alertScope === "history" ? "bg-primary/15 text-primary" : "text-text-dim"}`}
        >
          History
        </button>
        <select
          value={alertCategory}
          onChange={(event) => setAlertCategory(event.target.value)}
          aria-label="Filter alerts by category"
          className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text-dim outline-none focus:border-primary"
        >
          <option value="all">All categories</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </div>
      {visibleAlerts.length === 0 && alertScope === "active" && (
        <div className="rounded border border-emerald-400/30 bg-emerald-400/10 p-2 text-emerald-400">
          No actionable alerts.
        </div>
      )}
      {visibleAlerts.map((alert) => (
        <div
          key={alert.id}
          className={`rounded border p-2 ${alert.status === "resolved" ? "border-border opacity-60" : alert.severity === "critical" ? "border-red-400/40 bg-red-400/5" : alert.severity === "warning" ? "border-warning/40 bg-warning/5" : "border-primary/30 bg-primary/5"}`}
        >
          <div className="flex justify-between gap-2">
            <strong>{alert.title}</strong>
            <span className="uppercase text-text-dim">
              {alert.severity} · {alert.category}
            </span>
          </div>
          <div className="mt-1 text-text-dim">{alert.detail}</div>
          <div className="mt-1 font-mono text-primary">{alert.remedy}</div>
          <div className="mt-1 text-[8px] text-text-dim">
            Seen {alert.occurrences}× · {new Date(alert.last_seen_at).toLocaleString()} ·{" "}
            {alert.status}
          </div>
          <div className="mt-2 flex gap-2">
            {alert.status === "open" && (
              <button
                type="button"
                onClick={() => act(alert.id, "ack")}
                className="text-primary hover:underline"
              >
                Acknowledge
              </button>
            )}
            {alert.status !== "resolved" && (
              <button
                type="button"
                onClick={() => act(alert.id, "resolve")}
                className="text-primary hover:underline"
              >
                Resolve
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!ms) return "n/a";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-text-bright";
  return (
    <div className="rounded border border-border bg-bg-surface/50 p-1.5">
      <div className="truncate text-[8px] uppercase text-text-dim">{label}</div>
      <strong className={color}>{value}</strong>
    </div>
  );
}

function TrendChart({ points }: { points: import("../lib/types").ProductivityTrendPoint[] }) {
  const width = 260;
  const height = 52;
  const max = Math.max(1, ...points.map((point) => point.outcomes));
  const step = width / Math.max(1, points.length - 1);
  const path = points
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${index * step},${height - (point.outcomes / max) * (height - 8)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-14 w-full"
      role="img"
      aria-label="Productivity outcome trend"
    >
      <path
        d={`${path} L${(points.length - 1) * step},${height} L0,${height} Z`}
        fill="var(--color-primary)"
        opacity="0.12"
      />
      <path d={path} fill="none" stroke="var(--color-primary)" strokeWidth="2" />
      {points.map((point, index) => (
        <circle
          key={point.date}
          cx={index * step}
          cy={height - (point.outcomes / max) * (height - 8)}
          r="2.5"
          fill="var(--color-primary)"
        >
          <title>
            {point.date}: {point.successes}/{point.outcomes} successful
          </title>
        </circle>
      ))}
    </svg>
  );
}
