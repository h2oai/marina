// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntime } from "../../agent/agent-runtime";
import type { TaskManager } from "../../coordination/task-manager";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId } from "../../types";
import type { ReadinessReport } from "../readiness";
import { checkGate, recordDemonstration } from "../safety-gates";

const DEMO_AGENTS = ["Host", "Builder", "Critic", "Chronicler"];

export function demoCommand(deps: {
  db: MarinaDB;
  tasks: TaskManager;
  runtime: AgentRuntime;
  readiness: () => ReadinessReport;
  getEntity: (id: EntityId) => Entity | undefined;
}): CommandDef {
  return {
    name: "demo",
    aliases: [],
    minRank: 0,
    help: "Operate the default demo safely. Usage: demo preflight|qualify|warm|recover|reset|status",
    handler: async (ctx, input) => {
      const action = input.tokens[0]?.toLowerCase() ?? "status";
      const report = deps.readiness();

      if (action === "status" || action === "preflight" || action === "qualify") {
        const blockers = report.checks.filter((check) => check.status === "off");
        const lines = [
          header("Demo Preflight"),
          separator(),
          `  Score: ${bold(`${report.demo.score}/100`)} (${report.demo.status})`,
          `  Agents: ${report.demo.warmAgents}/${report.demo.expectedAgents} warm`,
          `  Activity: ${report.demo.recentMeaningfulEvents} meaningful events in 5m`,
          `  Response: ${report.demo.medianResponseMs === undefined ? "not measured" : `${report.demo.medianResponseMs}ms median`}`,
          `  Autonomy: ${report.demo.autonomyQualified ? "QUALIFIED" : "not yet qualified"}`,
          `  Evidence: ${report.demo.activeAgents}/2 agents · ${report.demo.recentPrimitiveActions}/3 actions · ${report.demo.recentCommunications}/1 communications · ${report.demo.marinaToolCalls}/2 Marina tools`,
        ];
        if (blockers.length > 0) {
          lines.push("", `  Blockers (${blockers.length}):`);
          for (const blocker of blockers) lines.push(`    - ${blocker.label}: ${blocker.detail}`);
        } else {
          lines.push("", "  No hard capability blockers detected.");
        }
        lines.push(
          "",
          dim("Controls: demo warm · demo recover · demo reset · bun run qualify:autonomy [url]"),
        );
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (action === "recover") {
        const recovered = deps.tasks.recoverExpired();
        ctx.send(
          input.entity,
          recovered.length > 0
            ? `Recovered ${recovered.length} expired work lease(s).`
            : "No expired work leases.",
        );
        return;
      }

      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      if (action === "reset") {
        if ((entity.properties.rank ?? 0) < 2) {
          ctx.send(input.entity, "Demo reset requires coordinator rank (2).");
          return;
        }
        const project = deps.db.getProjectByName("Demo Pulse");
        if (!project?.bundle_id) {
          ctx.send(input.entity, "Demo Pulse project is not present in this world.");
          return;
        }
        const count = deps.db.resetProjectTasks(project.bundle_id);
        deps.db.updateProjectStatus(project.id, "active");
        ctx.send(
          input.entity,
          `Reset ${count} Demo Pulse task(s); claims were released with an audit reason.`,
        );
        return;
      }

      if (action === "warm") {
        const gate = checkGate(deps.db, input.entity, "agent.spawn");
        if (!gate.ok) {
          ctx.send(input.entity, gate.reason ?? "agent.spawn capability is unavailable.");
          return;
        }
        if (!deps.runtime.isAvailable()) {
          ctx.send(
            input.entity,
            "No model provider is available; configure a key before warming agents.",
          );
          return;
        }
        const running = new Set(deps.runtime.list().map((agent) => agent.name));
        const configs = deps.db
          .getAllAgentConfigs()
          .filter((config) => DEMO_AGENTS.includes(config.name) && !running.has(config.name));
        let started = 0;
        const failures: string[] = [];
        for (const [index, config] of configs.entries()) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1_100));
          try {
            await deps.runtime.spawn({
              name: config.name,
              model: config.model,
              role: config.role || undefined,
              goal: config.goal || undefined,
              room: config.room || undefined,
              spawnedBy: entity.name,
            });
            started++;
          } catch (error) {
            failures.push(
              `${config.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (gate.supervisedOnly && started > 0)
          recordDemonstration(deps.db, input.entity, "agent.spawn");
        ctx.send(
          input.entity,
          `Demo warm complete: ${started} started, ${DEMO_AGENTS.length - configs.length} already running/config-unavailable${failures.length > 0 ? `; ${failures.join("; ")}` : ""}.`,
        );
        return;
      }

      ctx.send(input.entity, "Usage: demo preflight|qualify|warm|recover|reset|status");
    },
  };
}
