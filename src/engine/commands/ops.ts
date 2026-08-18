// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntime } from "../../agent/agent-runtime";
import type { TaskManager } from "../../coordination/task-manager";
import { bold, dim, header, separator, status } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef } from "../../types";
import type { ReadinessReport } from "../readiness";

export interface OpsDependencies {
  db: MarinaDB;
  tasks: TaskManager;
  runtime: AgentRuntime;
  readiness: () => ReadinessReport;
}

export function syncOperationalAlerts(deps: OpsDependencies): void {
  const active = new Map<string, string[]>();
  const add = (category: string, alert: Parameters<MarinaDB["upsertOperationalAlert"]>[0]) => {
    deps.db.upsertOperationalAlert(alert);
    active.set(category, [...(active.get(category) ?? []), alert.key]);
  };
  const report = deps.readiness();
  for (const check of report.checks) {
    if (check.status === "off" || check.status === "degraded")
      add("readiness", {
        key: `readiness:${check.id}`,
        severity: check.status === "off" ? "critical" : "warning",
        category: "readiness",
        title: check.label,
        detail: check.detail,
        remedy: "demo preflight",
      });
  }
  for (const agent of deps.runtime.list()) {
    if (agent.healthState === "degraded" || agent.state === "error")
      add("agent", {
        key: `agent:${agent.name}:health`,
        severity: "critical",
        category: "agent",
        title: `${agent.name} is degraded`,
        detail: agent.diagnosis ?? agent.errorReason ?? "Agent health degraded",
        remedy: `agent diagnose ${agent.name}`,
      });
    if ((agent.queuedPerceptions ?? 0) > 25)
      add("agent", {
        key: `agent:${agent.name}:attention`,
        severity: "warning",
        category: "agent",
        title: `${agent.name} attention backlog`,
        detail: `${agent.queuedPerceptions} perceptions queued`,
        remedy: `agent attention-mode ${agent.name} focused`,
      });
  }
  deps.db.refreshContradictionCases();
  const memory = deps.db.getMemoryQualitySummary();
  if (memory.contradictions > 0)
    add("memory", {
      key: "memory:contradictions",
      severity: "warning",
      category: "memory",
      title: "Contradictory memories",
      detail: `${memory.contradictions} unresolved candidate(s)`,
      remedy: "note conflicts",
    });
  if (memory.staleSources > 0)
    add("memory", {
      key: "memory:stale-sources",
      severity: "warning",
      category: "memory",
      title: "Stale memory sources",
      detail: `${memory.staleSources} sourced memories are older than 90 days`,
      remedy: "note explain <id>",
    });
  for (const project of deps.db.listProjects("active")) {
    const overTokens =
      project.budget_tokens !== null && project.used_tokens > project.budget_tokens;
    const overCost = project.budget_cost !== null && project.used_cost > project.budget_cost;
    const overTime =
      project.budget_duration_ms !== null &&
      Date.now() - project.created_at > project.budget_duration_ms;
    if (overTokens || overCost || overTime)
      add("project", {
        key: `project:${project.id}:budget`,
        severity: "critical",
        category: "project",
        title: `${project.name} exceeded budget`,
        detail: [overTokens && "tokens", overCost && "cost", overTime && "duration"]
          .filter(Boolean)
          .join(", "),
        remedy: `project status ${project.name}`,
      });
  }
  for (const binding of deps.db.listFlywheelBindings()) {
    if (binding.state === "unavailable" || binding.last_error) {
      add("flywheel", {
        key: `flywheel:${binding.entity_id}:state`,
        severity: binding.state === "unavailable" ? "critical" : "warning",
        category: "flywheel",
        title: `Sandbox ${binding.sandbox_id} needs attention`,
        detail: binding.last_error ?? `state=${binding.state}`,
        remedy: "code sandbox ops reconcile",
      });
    }
    if (binding.published_url) {
      add("flywheel", {
        key: `flywheel:${binding.entity_id}:published`,
        severity: "info",
        category: "flywheel",
        title: `Sandbox ${binding.sandbox_id} has public exposure`,
        detail: binding.published_url,
        remedy: "code service revoke <service>",
      });
    }
    if (
      binding.state === "running" &&
      binding.lifecycle_expires_at !== null &&
      binding.lifecycle_expires_at <= Date.now()
    ) {
      add("flywheel", {
        key: `flywheel:${binding.entity_id}:lifecycle`,
        severity: "warning",
        category: "flywheel",
        title: `Sandbox ${binding.sandbox_id} exceeded its lifecycle deadline`,
        detail: "Active services or publication may be preventing recoverable hibernation.",
        remedy: "code sandbox ops inventory",
      });
    }
  }
  const recentFailures = deps.db
    .getFlywheelOperationSummary()
    .filter((row) => row.outcome === "failure" || row.outcome === "blocked")
    .reduce((sum, row) => sum + row.count, 0);
  if (recentFailures > 0) {
    add("flywheel", {
      key: "flywheel:operations:failures",
      severity: "warning",
      category: "flywheel",
      title: "Flywheel operations require review",
      detail: `${recentFailures} failed or policy-blocked operation(s) in the last 24 hours`,
      remedy: "code sandbox ops metrics",
    });
  }
  for (const category of ["readiness", "agent", "memory", "project", "flywheel"])
    deps.db.resolveOperationalAlertsExcept(category, active.get(category) ?? []);
}

export function opsCommand(deps: OpsDependencies): CommandDef {
  return {
    name: "ops",
    aliases: ["alerts"],
    minRank: 0,
    help: "Durable operations inbox. Usage: ops inbox|ack <id>|resolve <id>|history|recover",
    handler: (ctx, input) => {
      const action = input.tokens[0]?.toLowerCase() ?? "inbox";
      if (action === "recover") {
        const recovered = deps.tasks.recoverExpired();
        const expired = deps.db.expireDirectMessages();
        syncOperationalAlerts(deps);
        ctx.send(
          input.entity,
          `Recovery complete: ${recovered.length} work lease(s), ${expired} message deadline(s).`,
        );
        return;
      }
      if (action === "ack" || action === "resolve") {
        const id = Number(input.tokens[1]);
        const ok =
          Number.isInteger(id) &&
          deps.db.setOperationalAlertStatus(id, action === "ack" ? "acknowledged" : "resolved");
        ctx.send(
          input.entity,
          ok
            ? `Alert #${id} ${action === "ack" ? "acknowledged" : "resolved"}.`
            : "Alert not found.",
        );
        return;
      }
      if (!["inbox", "status", "history"].includes(action)) {
        ctx.send(input.entity, "Usage: ops inbox|ack <id>|resolve <id>|history|recover");
        return;
      }
      syncOperationalAlerts(deps);
      const alerts =
        action === "history"
          ? deps.db.listOperationalAlerts(undefined, 100)
          : [
              ...deps.db.listOperationalAlerts("open"),
              ...deps.db.listOperationalAlerts("acknowledged"),
            ];
      const report = deps.readiness();
      const lines = [
        header("Operations Inbox"),
        separator(),
        `  Readiness: ${bold(`${report.demo.score}/100`)}`,
      ];
      if (alerts.length === 0) lines.push(`  ${status("CLEAR", "done")} No actionable alerts.`);
      for (const alert of alerts)
        lines.push(
          `  #${alert.id} ${status(alert.severity.toUpperCase(), alert.severity === "critical" ? "fail" : alert.severity === "warning" ? "warn" : "info")} ${alert.title} [${alert.status}]\n     ${alert.detail}\n     ${dim(`Remedy: ${alert.remedy}`)}`,
        );
      lines.push("", dim("Controls: ops ack <id> · ops resolve <id> · ops recover · ops history"));
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
