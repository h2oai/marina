// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderProbeResult } from "../../net/model-api";
import type { AutonomyPulseRow } from "../../persistence/db-telemetry";
import type { CommandContext, CommandDef } from "../../types";
import {
  AUTONOMY_REQUIREMENTS,
  type ReadinessReport,
  type ReadinessStatus,
  type ReadinessTrustProfile,
} from "../readiness";
import { isLocalUngated } from "../trust-profile";

const ICON: Record<ReadinessStatus, string> = { ok: "✓", degraded: "⚠", off: "✗" };

/** One line: `Trust profile: LOCAL — ungated · autonomy: guarded`. */
export function renderTrustProfileLine(trust: ReadinessTrustProfile): string {
  const state = trust.ungated ? "ungated" : "gates enforced";
  const why = trust.reason ? ` (${trust.reason})` : "";
  return `Trust profile: ${trust.profile.toUpperCase()} — ${state}${why} · autonomy: ${trust.autonomy}`;
}

/**
 * `readiness` (aliases `doctor`, `health`) — operator-facing capability health.
 * Reports each Marina capability as ok / degraded / off with a concrete fix.
 * (`status` is taken by `orient` for an agent's own cognitive status.)
 * Reads config presence only (never secret values), so it's safe at rank 0.
 */
/** Minimum rank to spend provider tokens on a live probe when the instance is gated. */
export const PROVIDER_PROBE_MIN_RANK = 4;

export function renderProviderProbe(results: ProviderProbeResult[]): string[] {
  if (results.length === 0)
    return ["No upstream LLM provider is configured (no provider key, no local runtime)."];
  const lines = [
    "Upstream provider conformance — one tiny request each, through the passthru proxy:",
  ];
  for (const r of results) {
    const checks = [
      r.status === null ? "no response" : `HTTP ${r.status}`,
      r.textOk ? "text ok" : "EMPTY TEXT",
      r.systemHonored ? "second system message honored" : "SECOND SYSTEM MESSAGE IGNORED",
      renderToolCallCheck(r),
      `${r.latencyMs} ms`,
    ];
    lines.push(`  ${r.ok ? "✓" : "✗"} ${r.provider}/${r.model} — ${checks.join(" · ")}`);
    if (!r.ok) {
      if (r.error) lines.push(`      error: ${r.error}`);
      if (r.servedBy && !r.error?.includes("served by fallback"))
        lines.push(`      served by: ${r.servedBy}`);
      if (!r.textOk && r.status !== null && !r.error)
        lines.push(
          "      → the provider answered but Marina saw no text: check the response-shape conversion for this provider",
        );
      if (r.textOk && !r.systemHonored)
        lines.push(
          "      → memory injected as a second system message would be dropped for this provider",
        );
      if (r.toolCallOk === false)
        lines.push(
          `      → tool call dropped${r.toolCallError ? ` (${r.toolCallError})` : ""}: tool schemas sent through this provider would be lost or answered in text`,
        );
    }
  }
  return lines;
}

/**
 * The tool-call column: `tool call ok` / `TOOL CALL DROPPED` for probed
 * providers, `tool call not probed` where the passthru path does not
 * translate tool schemas (`toolCallOk` undefined). `error` keeps its own line.
 */
export function renderToolCallCheck(r: Pick<ProviderProbeResult, "toolCallOk">): string {
  if (r.toolCallOk === undefined) return "tool call not probed";
  return r.toolCallOk ? "tool call ok" : "TOOL CALL DROPPED";
}

/**
 * `readiness autonomy`: the evidence `qualify:autonomy` waits for, each
 * requirement against what was observed in the last 5 minutes.
 */
/** The 24 h trend of 5-minute autonomy snapshots (plan goal: qualified in ≥ 70% of them). */
export const AUTONOMY_TREND_GOAL = 0.7;

export function renderAutonomyTrend(pulses: readonly AutonomyPulseRow[]): string[] {
  if (pulses.length === 0) {
    return ["Last 24 h: no snapshots yet (one is taken every 5 minutes while Marina runs)."];
  }
  const qualified = pulses.filter((p) => p.qualified === 1).length;
  const share = qualified / pulses.length;
  const agents = pulses.map((p) => p.active_agents).sort((a, b) => a - b);
  const median = agents[Math.floor(agents.length / 2)] ?? 0;
  return [
    `Last 24 h: qualified in ${qualified} of ${pulses.length} snapshots (${Math.round(share * 100)}%) — goal ≥ ${Math.round(AUTONOMY_TREND_GOAL * 100)}% ${share >= AUTONOMY_TREND_GOAL ? "✓" : "✗"} · median active agents ${median}`,
  ];
}

export function renderAutonomy(report: ReadinessReport): string[] {
  const d = report.demo;
  const req = AUTONOMY_REQUIREMENTS;
  const row = (ok: boolean, label: string, have: string, need: string) =>
    `  ${ok ? "✓" : "✗"} ${label.padEnd(26)} ${have.padStart(6)}  (need ${need})`;
  const median = d.medianResponseMs;
  return [
    `Autonomy (last 5 min): ${d.autonomyQualified ? "QUALIFIED" : "not yet"}`,
    row(
      d.activeAgents >= req.activeAgents,
      "active agents",
      String(d.activeAgents),
      `≥ ${req.activeAgents}`,
    ),
    row(
      d.recentPrimitiveActions >= req.recentPrimitiveActions,
      "meaningful world actions",
      String(d.recentPrimitiveActions),
      `≥ ${req.recentPrimitiveActions}`,
    ),
    row(
      d.recentCommunications >= req.recentCommunications,
      "agent communications",
      String(d.recentCommunications),
      `≥ ${req.recentCommunications}`,
    ),
    row(
      d.marinaToolCalls >= req.marinaToolCalls,
      "Marina tool calls",
      String(d.marinaToolCalls),
      `≥ ${req.marinaToolCalls}`,
    ),
    row(
      median === undefined || median < req.maximumMedianResponseMs,
      "median response",
      median === undefined ? "n/a" : `${Math.round(median / 1000)}s`,
      `< ${req.maximumMedianResponseMs / 1000}s`,
    ),
    ...(d.autonomyQualified
      ? []
      : [
          "",
          "  → Run a multi-agent task with at least two agents, a targeted handoff and two Marina tool",
          "    calls; watch it with `productivity primitives`. From outside: bun run qualify:autonomy",
        ]),
  ];
}

export function readinessCommand(deps: {
  readiness: () => ReadinessReport;
  probeProviders?: (providers?: string[]) => Promise<ProviderProbeResult[]>;
  /** 5-minute autonomy snapshots since a time (the `autonomy-pulse` tick job). */
  pulseHistory?: (sinceMs: number) => AutonomyPulseRow[];
}): CommandDef {
  return {
    name: "readiness",
    aliases: ["doctor", "health"],
    help: "Show which Marina capabilities are active, degraded, or off — with fixes. `readiness providers [name]` sends one tiny request per configured LLM provider and checks the reply shape. `readiness autonomy` shows whether agents are acting on their own right now, requirement by requirement.",
    handler: async (ctx, input) => {
      const sub = input.tokens[0]?.toLowerCase();
      if (sub === "providers" || sub === "probe") {
        // Built-in commands receive a CommandContext (caller = { id, name, rank }).
        const rank = (ctx as Partial<CommandContext>).caller?.rank ?? 0;
        if (!deps.probeProviders) {
          ctx.send(input.entity, "Provider probing is not available on this instance.");
          return;
        }
        if (!isLocalUngated() && rank < PROVIDER_PROBE_MIN_RANK) {
          ctx.send(
            input.entity,
            `readiness providers spends provider tokens; it needs rank ${PROVIDER_PROBE_MIN_RANK}+ on a gated instance (yours: ${rank}).`,
          );
          return;
        }
        const only = input.tokens.slice(1).map((a) => a.toLowerCase());
        const results = await deps.probeProviders(only.length > 0 ? only : undefined);
        ctx.send(input.entity, renderProviderProbe(results).join("\n"));
        return;
      }
      if (sub === "autonomy") {
        const history = deps.pulseHistory?.(Date.now() - 24 * 3_600_000);
        ctx.send(
          input.entity,
          [
            ...renderAutonomy(deps.readiness()),
            ...(history ? ["", ...renderAutonomyTrend(history)] : []),
          ].join("\n"),
        );
        return;
      }
      const report = deps.readiness();
      const counts = { ok: 0, degraded: 0, off: 0 };
      for (const c of report.checks) counts[c.status]++;

      const lines: string[] = [];
      lines.push(`Marina readiness — ${report.instanceName} · world: ${report.world}`);
      lines.push(renderTrustProfileLine(report.trustProfile));
      lines.push(`${counts.ok} ok · ${counts.degraded} degraded · ${counts.off} off`);
      lines.push("");
      for (const c of report.checks) {
        lines.push(`  ${ICON[c.status]} ${c.label} — ${c.detail}`);
        if (c.status !== "ok" && c.remediation) lines.push(`      → ${c.remediation}`);
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
