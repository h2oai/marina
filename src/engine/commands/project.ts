// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { GroupManager } from "../../coordination/group-manager";
import type { TaskManager } from "../../coordination/task-manager";
import {
  bold,
  dim,
  entity as fmtEntity,
  status as fmtStatus,
  header,
  sectionHead,
  separator,
} from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, EntityRank, RoomContext } from "../../types";

/** Emit a coordination_change so the dashboard's Projects list refreshes live. */
function emitProjectChange(
  ctx: RoomContext,
  entity: EntityId,
  action: "create" | "update",
  name: string,
): void {
  ctx.logEvent?.({
    type: "coordination_change",
    resource: "project",
    action,
    entity,
    name,
    timestamp: Date.now(),
  });
}

import {
  HTDAG_TEMPLATE,
  LAZY_EXPANSION_TEMPLATE,
  NON_OVERLAPPING_TEMPLATE,
  PLAN_EXEC_VERIFY_TEMPLATE,
  WORKLOAD_TIERS_TEMPLATE,
} from "../../world/templates/decomposition";
import {
  GENERATIVE_TEMPLATE,
  GRAPH_TEMPLATE,
  SHARED_TEMPLATE,
  TIERED_TEMPLATE,
} from "../../world/templates/memory";
import {
  BLACKBOARD_TEMPLATE,
  CHORUS_TEMPLATE,
  DEBATE_TEMPLATE,
  DELIBERATION_TEMPLATE,
  FOUNDRY_TEMPLATE,
  MAPREDUCE_TEMPLATE,
  normalizePatternName,
  ORCHESTRATION_HELP,
  ORCHESTRATION_PATTERNS,
  PIPELINE_TEMPLATE,
  RESEARCH_TEMPLATE,
  SWARM_TEMPLATE,
  SYMBIOSIS_TEMPLATE,
  suggestPatterns,
  type TemplateNote,
} from "../../world/templates/orchestration";

const VALID_ORCHESTRATIONS = new Set<string>(ORCHESTRATION_PATTERNS);
const VALID_MEMORY_ARCHS = new Set(["tiered", "generative", "graph", "shared", "custom"]);
const VALID_DECOMPOSITIONS = new Set([
  "htdag",
  "plan-exec-verify",
  "lazy-expansion",
  "non-overlapping",
  "workload-tiers",
  "custom",
]);
const PROJECT_ACTIONS = new Set([
  "orchestrate",
  "decompose",
  "memory",
  "join",
  "status",
  "propose",
  "tasks",
  "outcome",
  "budget",
  "usage",
  "recommend",
  "verify",
]);

function learnedPatternScore(db: MarinaDB, pattern: string): { average?: number; samples: number } {
  const pool = db.getMemoryPool(`orchestration:${pattern}`);
  if (!pool) return { samples: 0 };
  const notes = db.getPoolNotes(pool.id, 200);
  const scores = notes
    .map((note) => /score=(0(?:\.\d+)?|1(?:\.0+)?)/.exec(note.content)?.[1])
    .filter((score): score is string => score !== undefined)
    .map(Number);
  return {
    samples: scores.length,
    ...(scores.length > 0
      ? { average: scores.reduce((sum, score) => sum + score, 0) / scores.length }
      : {}),
  };
}

function getOrchestrationTemplate(name: string): TemplateNote[] | undefined {
  switch (name) {
    case "deliberation":
      return DELIBERATION_TEMPLATE;
    case "chorus":
      return CHORUS_TEMPLATE;
    case "foundry":
      return FOUNDRY_TEMPLATE;
    case "swarm":
      return SWARM_TEMPLATE;
    case "pipeline":
      return PIPELINE_TEMPLATE;
    case "debate":
      return DEBATE_TEMPLATE;
    case "mapreduce":
      return MAPREDUCE_TEMPLATE;
    case "blackboard":
      return BLACKBOARD_TEMPLATE;
    case "symbiosis":
      return SYMBIOSIS_TEMPLATE;
    case "research":
      return RESEARCH_TEMPLATE;
    default:
      return undefined;
  }
}

function getDecompositionTemplate(name: string): TemplateNote[] | undefined {
  switch (name) {
    case "htdag":
      return HTDAG_TEMPLATE;
    case "plan-exec-verify":
      return PLAN_EXEC_VERIFY_TEMPLATE;
    case "lazy-expansion":
      return LAZY_EXPANSION_TEMPLATE;
    case "non-overlapping":
      return NON_OVERLAPPING_TEMPLATE;
    case "workload-tiers":
      return WORKLOAD_TIERS_TEMPLATE;
    default:
      return undefined;
  }
}

function getMemoryTemplate(name: string): TemplateNote[] | undefined {
  switch (name) {
    case "tiered":
      return TIERED_TEMPLATE;
    case "generative":
      return GENERATIVE_TEMPLATE;
    case "graph":
      return GRAPH_TEMPLATE;
    case "shared":
      return SHARED_TEMPLATE;
    default:
      return undefined;
  }
}

function seedPoolWithNotes(
  db: MarinaDB,
  poolId: string,
  author: string,
  notes: TemplateNote[],
): void {
  for (const note of notes) {
    db.addPoolNote(poolId, author, note.content, note.importance, note.type);
  }
}

export function projectCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  groupManager?: GroupManager;
  promote?: (entityId: EntityId, rank: EntityRank) => void;
}): CommandDef {
  return {
    name: "project",
    aliases: ["proj"],
    help: "Projects combine tasks, groups, pools, orchestration, verification, and resource envelopes.\nUsage: project create|list|info | project <name> orchestrate|recommend|decompose|memory|join|status|propose|tasks|budget|usage|verify|outcome\n\nExamples:\n  project create Alpha | Investigate grid patterns\n  project Alpha recommend\n  project Alpha orchestrate deliberation\n  project Alpha budget tokens 50000 cost 2 duration 1h\n  project Alpha usage 1200 0.03\n  project Alpha verify\n  project Alpha status",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Projects require database support.");
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();
      const rawFirst = tokens[0]; // preserve original case for project name

      if (!sub) {
        ctx.send(
          input.entity,
          "Usage: project create <name> | <desc> | project <name> orchestrate|decompose|memory|join|status|propose|tasks | project list | project info <name>",
        );
        return;
      }

      // ─── project list ──────────────────────────────────────────────
      if (sub === "list") {
        const projects = db.listProjects();
        if (projects.length === 0) {
          ctx.send(input.entity, "No projects exist yet.");
          return;
        }
        const lines = [
          header("Projects"),
          separator(),
          ...projects.map((p) => {
            const orch =
              p.orchestration !== "custom" ? ` ${fmtStatus(p.orchestration, "info")}` : "";
            const mem = p.memory_arch !== "custom" ? ` ${dim(`(${p.memory_arch})`)}` : "";
            const st = fmtStatus(p.status, "active");
            const desc = p.description.slice(0, 50) || dim("(no description)");
            return `  ${bold(p.name)} — ${st}${orch}${mem}: ${desc}`;
          }),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── project create <name> | <description> ────────────────────
      if (sub === "create") {
        if (!deps.taskManager || !deps.groupManager) {
          ctx.send(input.entity, "Projects require task and group support.");
          return;
        }
        const rest = tokens.slice(1).join(" ");
        if (!rest) {
          ctx.send(input.entity, "Usage: project create <name> | <description>");
          return;
        }
        const pipeIdx = rest.indexOf("|");
        let name: string;
        let description: string;
        if (pipeIdx >= 0) {
          name = rest.slice(0, pipeIdx).trim();
          description = rest.slice(pipeIdx + 1).trim();
        } else {
          name = rest.trim();
          description = "";
        }

        if (!name || name.length < 2) {
          ctx.send(input.entity, "Project name must be at least 2 characters.");
          return;
        }

        // Check uniqueness
        const existing = db.getProjectByName(name);
        if (existing) {
          ctx.send(input.entity, `Project "${name}" already exists.`);
          return;
        }

        // 1. Create task bundle
        const bundle = deps.taskManager.create({
          title: name,
          description: description || `Project: ${name}`,
          creatorId: input.entity,
          creatorName: entity.name,
        });

        // 2. Create memory pool
        const poolId = `pool_project_${name.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}`;
        db.createMemoryPool(poolId, `project:${name}`, entity.name);

        // 3. Create group (auto-creates channel + board)
        const groupId = `project_${name.toLowerCase().replace(/\s+/g, "_")}`;
        deps.groupManager.create({
          id: groupId,
          name: `project:${name}`,
          description: description || `Project: ${name}`,
          leaderId: input.entity,
        });

        // 4. Insert project row
        const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        db.createProject({
          id: projectId,
          name,
          description,
          bundleId: bundle.id,
          poolId,
          groupId,
          createdBy: entity.name,
        });
        emitProjectChange(ctx, input.entity, "create", name);

        // 5. Seed pool with welcome note
        db.addPoolNote(
          poolId,
          entity.name,
          `Project "${name}" created by ${entity.name}. ${description || "No description provided."} Use 'project ${name} orchestrate <pattern>' to set orchestration and 'project ${name} memory <arch>' to set memory architecture. Use 'project ${name} join' to join the team.`,
          9,
          "fact",
        );

        deps.promote?.(input.entity, 2);

        const lines = [
          header(`Project "${name}" created`),
          separator(),
          `  Bundle: #${bundle.id}`,
          `  Pool: project:${name}`,
          `  Group: project:${name}`,
          "",
          `Use 'project ${name} orchestrate <pattern>' to set orchestration.`,
          `Use 'project ${name} memory <arch>' to set memory architecture.`,
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── project info <name> ──────────────────────────────────────
      if (sub === "info") {
        const name = tokens.slice(1).join(" ");
        if (!name) {
          ctx.send(input.entity, "Usage: project info <name>");
          return;
        }
        const project = db.getProjectByName(name);
        if (!project) {
          ctx.send(input.entity, `Project "${name}" not found.`);
          return;
        }
        const lines = [
          header(`Project: ${project.name}`),
          project.description || dim("(no description)"),
          separator(),
          `  Status: ${fmtStatus(project.status, "active")}`,
          `  Orchestration: ${fmtStatus(project.orchestration, "info")}`,
          `  Memory: ${bold(project.memory_arch)}`,
          `  Created by: ${fmtEntity(project.created_by)}`,
          `  Bundle: #${project.bundle_id ?? dim("none")}`,
          `  Pool: ${project.pool_id ? bold(`project:${project.name}`) : dim("none")}`,
          `  Group: ${project.group_id ?? dim("none")}`,
        ];

        // Show bundle progress if available
        if (project.bundle_id && deps.taskManager) {
          const bs = deps.taskManager.getBundleStatus(project.bundle_id);
          if (bs.total > 0) {
            lines.push(
              sectionHead("Tasks"),
              `  ${bold(`${bs.completed}/${bs.total}`)} completed (${bs.open} open)`,
            );
          }
        }

        // Show group members if available
        if (project.group_id && deps.groupManager) {
          const members = deps.groupManager.getMembers(project.group_id);
          lines.push(sectionHead("Team"), `  ${bold(String(members.length))} member(s)`);
        }

        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── project <name> <action> [args] ───────────────────────────
      // Everything else: resolve the first known action so project names may
      // contain spaces (all use-case projects do).
      const actionIndex = tokens.findIndex(
        (token, index) => index > 0 && PROJECT_ACTIONS.has(token.toLowerCase()),
      );
      const projectName = actionIndex > 0 ? tokens.slice(0, actionIndex).join(" ") : rawFirst!;
      const action =
        actionIndex > 0 ? tokens[actionIndex]?.toLowerCase() : tokens[1]?.toLowerCase();
      const actionArgs = actionIndex > 0 ? tokens.slice(actionIndex + 1) : tokens.slice(2);
      const project = db.getProjectByName(projectName);

      if (!project) {
        ctx.send(
          input.entity,
          `Project "${projectName}" not found. Use 'project list' to see projects.`,
        );
        return;
      }

      if (!action) {
        // Default to showing info
        ctx.send(input.entity, `Use 'project info ${projectName}' for details.`);
        return;
      }

      switch (action) {
        case "orchestrate": {
          const rawPattern = actionArgs[0]?.toLowerCase();
          const pattern = rawPattern ? normalizePatternName(rawPattern) : undefined;
          if (!pattern) {
            ctx.send(
              input.entity,
              `Usage: project <name> orchestrate ${ORCHESTRATION_HELP} <desc>`,
            );
            return;
          }

          if (pattern === "custom") {
            const desc = actionArgs.slice(1).join(" ");
            if (!desc) {
              ctx.send(input.entity, "Usage: project <name> orchestrate custom <description>");
              return;
            }
            db.updateProjectOrchestration(project.id, "custom");
            emitProjectChange(ctx, input.entity, "update", project.name);
            if (project.pool_id) {
              db.addPoolNote(
                project.pool_id,
                entity.name,
                `Custom orchestration: ${desc}`,
                8,
                "skill",
              );
            }
            ctx.send(input.entity, `Set custom orchestration for "${project.name}".`);
            return;
          }

          if (!VALID_ORCHESTRATIONS.has(pattern)) {
            ctx.send(
              input.entity,
              `Unknown orchestration pattern. Valid: ${[...VALID_ORCHESTRATIONS].join(", ")}`,
            );
            return;
          }

          db.updateProjectOrchestration(project.id, pattern);
          emitProjectChange(ctx, input.entity, "update", project.name);
          const template = getOrchestrationTemplate(pattern);
          if (template && project.pool_id) {
            seedPoolWithNotes(db, project.pool_id, entity.name, template);
          }
          ctx.send(
            input.entity,
            `Set orchestration to "${pattern}" for "${project.name}". Pool seeded with ${pattern.toUpperCase()} conventions.`,
          );
          return;
        }

        case "decompose": {
          const pattern = actionArgs[0]?.toLowerCase();
          if (!pattern) {
            ctx.send(
              input.entity,
              "Usage: project <name> decompose htdag|plan-exec-verify|lazy-expansion|non-overlapping|workload-tiers|custom <desc>",
            );
            return;
          }

          if (pattern === "custom") {
            const desc = actionArgs.slice(1).join(" ");
            if (!desc) {
              ctx.send(input.entity, "Usage: project <name> decompose custom <description>");
              return;
            }
            if (project.pool_id) {
              db.addPoolNote(
                project.pool_id,
                entity.name,
                `Custom decomposition pattern: ${desc}`,
                8,
                "skill",
              );
            }
            ctx.send(input.entity, `Seeded custom decomposition for "${project.name}".`);
            return;
          }

          if (!VALID_DECOMPOSITIONS.has(pattern)) {
            ctx.send(
              input.entity,
              `Unknown decomposition pattern. Valid: ${[...VALID_DECOMPOSITIONS].join(", ")}`,
            );
            return;
          }

          const template = getDecompositionTemplate(pattern);
          if (template && project.pool_id) {
            seedPoolWithNotes(db, project.pool_id, entity.name, template);
          }
          ctx.send(
            input.entity,
            `Seeded "${pattern}" decomposition pattern for "${project.name}". Pool now contains ${template?.length ?? 0} guidance notes.`,
          );
          return;
        }

        case "memory": {
          const arch = actionArgs[0]?.toLowerCase();
          if (!arch) {
            ctx.send(
              input.entity,
              "Usage: project <name> memory tiered|generative|graph|shared|custom <desc>",
            );
            return;
          }

          if (arch === "custom") {
            const desc = actionArgs.slice(1).join(" ");
            if (!desc) {
              ctx.send(input.entity, "Usage: project <name> memory custom <description>");
              return;
            }
            db.updateProjectMemoryArch(project.id, "custom");
            emitProjectChange(ctx, input.entity, "update", project.name);
            if (project.pool_id) {
              db.addPoolNote(
                project.pool_id,
                entity.name,
                `Custom memory architecture: ${desc}`,
                8,
                "skill",
              );
            }
            ctx.send(input.entity, `Set custom memory architecture for "${project.name}".`);
            return;
          }

          if (!VALID_MEMORY_ARCHS.has(arch)) {
            ctx.send(
              input.entity,
              `Unknown memory architecture. Valid: ${[...VALID_MEMORY_ARCHS].join(", ")}`,
            );
            return;
          }

          db.updateProjectMemoryArch(project.id, arch);
          emitProjectChange(ctx, input.entity, "update", project.name);
          const template = getMemoryTemplate(arch);
          if (template && project.pool_id) {
            seedPoolWithNotes(db, project.pool_id, entity.name, template);
          }
          ctx.send(
            input.entity,
            `Set memory architecture to "${arch}" for "${project.name}". Pool seeded with ${arch} conventions.`,
          );
          return;
        }

        case "join": {
          if (!deps.groupManager) {
            ctx.send(input.entity, "Groups not available.");
            return;
          }
          if (!project.group_id) {
            ctx.send(input.entity, "This project has no group.");
            return;
          }
          const group = deps.groupManager.get(project.group_id);
          if (!group) {
            ctx.send(input.entity, "Project group not found.");
            return;
          }
          if (deps.groupManager.isMember(group.id, input.entity)) {
            ctx.send(input.entity, `You are already in project "${project.name}".`);
            return;
          }
          deps.groupManager.addMember(group.id, input.entity);

          // Send orientation from pool
          const lines = [
            header(`Joined project "${project.name}"`),
            separator(),
            `  Orchestration: ${project.orchestration}`,
            `  Memory: ${project.memory_arch}`,
          ];

          if (project.pool_id) {
            // Show recent pool notes as orientation
            const recent = db.recallPoolNotes(
              project.pool_id,
              "project conventions orchestration memory",
            );
            if (recent.length > 0) {
              lines.push("", "Project knowledge:");
              for (const note of recent.slice(0, 5)) {
                lines.push(`  - ${note.content.slice(0, 80)}`);
              }
            }
          }

          lines.push(
            "",
            `Use 'pool project:${project.name} recall <topic>' to explore project knowledge.`,
          );
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "status": {
          const elapsedMs = Date.now() - project.created_at;
          const lines = [
            header(`${project.name} Status`),
            separator(),
            `  Status: ${fmtStatus(project.status, "active")}`,
            `  Orchestration: ${fmtStatus(project.orchestration, "info")}`,
            `  Memory: ${bold(project.memory_arch)}`,
            `  Elapsed: ${Math.max(0, Math.round(elapsedMs / 1000))}s`,
          ];

          // Bundle progress
          if (project.bundle_id && deps.taskManager) {
            const bundleStatus = deps.taskManager.getBundleStatus(project.bundle_id);
            if (bundleStatus.total > 0) {
              const children = deps.taskManager.listChildren(project.bundle_id);
              const claims = children.flatMap((task) => deps.taskManager!.getClaims(task.id));
              const recovered = claims.filter(
                (claim) => claim.releaseReason === "lease_expired",
              ).length;
              const resolvedMs = claims
                .filter((claim) => claim.resolvedAt !== null)
                .map((claim) => claim.resolvedAt! - claim.claimedAt)
                .filter((duration) => duration >= 0);
              lines.push(
                `  Tasks: ${bundleStatus.completed}/${bundleStatus.total} (${bundleStatus.open} open)`,
                `  Recoveries: ${recovered}`,
              );
              if (resolvedMs.length > 0) {
                lines.push(
                  `  Mean task cycle: ${Math.round(resolvedMs.reduce((a, b) => a + b, 0) / resolvedMs.length)}ms`,
                );
              }
              const byWorker = new Map<string, { claims: number; recoveries: number }>();
              for (const claim of claims) {
                const current = byWorker.get(claim.entityName) ?? { claims: 0, recoveries: 0 };
                current.claims++;
                if (claim.releaseReason === "lease_expired") current.recoveries++;
                byWorker.set(claim.entityName, current);
              }
              if (byWorker.size > 0) {
                lines.push(
                  `  Workers: ${[...byWorker.entries()]
                    .map(
                      ([name, metrics]) =>
                        `${name} ${metrics.claims} claim${metrics.claims === 1 ? "" : "s"}${metrics.recoveries > 0 ? `/${metrics.recoveries} recovered` : ""}`,
                    )
                    .join(" · ")}`,
                );
              }
            } else {
              lines.push("  Tasks: none yet");
            }
          }

          const tokenBudget = project.budget_tokens
            ? `${project.used_tokens}/${project.budget_tokens}`
            : `${project.used_tokens}/unbounded`;
          const costBudget = project.budget_cost
            ? `$${project.used_cost.toFixed(3)}/$${project.budget_cost.toFixed(3)}`
            : `$${project.used_cost.toFixed(3)}/unbounded`;
          lines.push(`  Resources: ${tokenBudget} tokens · ${costBudget}`);
          if (project.budget_duration_ms) {
            lines.push(
              `  Time budget: ${Math.round(elapsedMs / 1000)}/${Math.round(project.budget_duration_ms / 1000)}s`,
            );
          }
          const budgetExceeded =
            (project.budget_tokens !== null && project.used_tokens > project.budget_tokens) ||
            (project.budget_cost !== null && project.used_cost > project.budget_cost) ||
            (project.budget_duration_ms !== null && elapsedMs > project.budget_duration_ms);
          lines.push(
            `  Budget state: ${budgetExceeded ? fmtStatus("exceeded — pause or revise", "warn") : fmtStatus("within envelope", "done")}`,
          );

          // Team
          if (project.group_id && deps.groupManager) {
            const members = deps.groupManager.getMembers(project.group_id);
            lines.push(`  Team: ${members.length} member(s)`);
          }

          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "budget": {
          const budget: { tokens?: number; cost?: number; durationMs?: number } = {};
          for (let i = 0; i < actionArgs.length; i += 2) {
            const key = actionArgs[i]?.toLowerCase();
            const raw = actionArgs[i + 1];
            if (!key || !raw) continue;
            if (key === "tokens") budget.tokens = Number(raw);
            if (key === "cost") budget.cost = Number(raw);
            if (key === "duration") {
              const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw.toLowerCase());
              if (match) {
                const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!]!;
                budget.durationMs = Number(match[1]) * scale;
              }
            }
          }
          if (
            Object.keys(budget).length === 0 ||
            Object.values(budget).some((value) => !Number.isFinite(value) || value! <= 0)
          ) {
            ctx.send(
              input.entity,
              "Usage: project <name> budget [tokens <n>] [cost <usd>] [duration <n>ms|s|m|h]",
            );
            return;
          }
          db.updateProjectBudget(project.id, budget);
          emitProjectChange(ctx, input.entity, "update", project.name);
          ctx.send(input.entity, `Updated resource budget for "${project.name}".`);
          return;
        }

        case "usage": {
          const tokens = Number(actionArgs[0]);
          const cost = Number(actionArgs[1] ?? 0);
          if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(cost) || cost < 0) {
            ctx.send(input.entity, "Usage: project <name> usage <tokens> [cost-usd]");
            return;
          }
          db.addProjectUsage(project.id, tokens, cost);
          const updated = db.getProject(project.id)!;
          const exceeded =
            (updated.budget_tokens !== null && updated.used_tokens > updated.budget_tokens) ||
            (updated.budget_cost !== null && updated.used_cost > updated.budget_cost);
          ctx.send(
            input.entity,
            `Recorded ${Math.round(tokens)} tokens and $${cost.toFixed(3)} for "${project.name}"${exceeded ? "; budget exceeded — pause or revise the plan" : ""}.`,
          );
          return;
        }

        case "recommend": {
          const candidates = suggestPatterns(`${project.name} ${project.description}`, 5);
          if (candidates.length === 0) {
            ctx.send(
              input.entity,
              "No coordination-heavy shape detected; keep the smallest workflow.",
            );
            return;
          }
          const ranked = candidates
            .map((candidate, index) => {
              const learned = learnedPatternScore(db, candidate.pattern);
              const fit = candidates.length - index;
              const score = fit + (learned.average ?? 0.5) * Math.min(3, learned.samples);
              return { ...candidate, ...learned, score };
            })
            .sort((a, b) => b.score - a.score);
          const lines = [header(`${project.name} Orchestration Recommendation`), separator()];
          for (const [index, candidate] of ranked.entries()) {
            const evidence =
              candidate.average === undefined
                ? "no recorded outcomes"
                : `${candidate.samples} outcomes, mean ${candidate.average.toFixed(2)}`;
            lines.push(
              `  ${index + 1}. ${bold(candidate.pattern)} — ${candidate.why} (${evidence})`,
            );
          }
          lines.push("", dim(`Apply: project ${project.name} orchestrate ${ranked[0]!.pattern}`));
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "verify": {
          if (!project.bundle_id || !deps.taskManager) {
            ctx.send(input.entity, "No project tasks are available to verify.");
            return;
          }
          const children = deps.taskManager.listChildren(project.bundle_id);
          if (children.length === 0) {
            ctx.send(input.entity, "No project tasks are available to verify.");
            return;
          }
          const completed = children.filter((task) => task.status === "completed");
          const claims = children.flatMap((task) => deps.taskManager!.getClaims(task.id));
          const approved = claims.filter((claim) => claim.status === "approved");
          const evidenceClaims = approved.filter((claim) =>
            /https?:\/\/|(?:note|artifact|test|citation|verified|evidence)\b|#\d+/i.test(
              claim.submissionText ?? "",
            ),
          );
          const independentlyReviewed = approved.filter((claim) => {
            const task = children.find((candidate) => candidate.id === claim.taskId);
            return task !== undefined && task.creatorId !== claim.entityId;
          });
          const completionRatio = completed.length / children.length;
          const evidenceRatio = completed.length > 0 ? evidenceClaims.length / completed.length : 0;
          const reviewRatio =
            completed.length > 0 ? independentlyReviewed.length / completed.length : 0;
          const score = Math.max(
            0,
            Math.min(
              1,
              completionRatio * 0.6 +
                Math.min(1, evidenceRatio) * 0.25 +
                Math.min(1, reviewRatio) * 0.15,
            ),
          );
          const blockers: string[] = [];
          if (completed.length < children.length)
            blockers.push(`${children.length - completed.length} task(s) incomplete`);
          if (evidenceClaims.length < completed.length)
            blockers.push(
              `${completed.length - evidenceClaims.length} completion(s) lack inspectable evidence`,
            );
          if (independentlyReviewed.length < completed.length)
            blockers.push(
              `${completed.length - independentlyReviewed.length} completion(s) lack independent review`,
            );
          const summary =
            `[verification-proposal:${project.id}] score=${score.toFixed(2)} ` +
            `completed=${completed.length}/${children.length} evidence=${evidenceClaims.length}/${Math.max(1, completed.length)} ` +
            `reviewed=${independentlyReviewed.length}/${Math.max(1, completed.length)}`;
          if (project.pool_id) {
            db.addPoolNote(project.pool_id, entity.name, summary, 8, "observation");
          }
          const lines = [
            header(`${project.name} Verification Proposal`),
            separator(),
            `  Proposed outcome: ${bold(score.toFixed(2))}`,
            `  Completion: ${completed.length}/${children.length}`,
            `  Evidence-backed: ${evidenceClaims.length}/${completed.length}`,
            `  Independently reviewed: ${independentlyReviewed.length}/${completed.length}`,
          ];
          if (blockers.length > 0)
            lines.push("", "  Blockers:", ...blockers.map((b) => `    - ${b}`));
          lines.push(
            "",
            dim(
              `Confirm only after inspection: project ${project.name} outcome ${score.toFixed(2)} | <verified evidence and lessons>`,
            ),
          );
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "propose": {
          const text = actionArgs.join(" ");
          if (!text) {
            ctx.send(input.entity, "Usage: project <name> propose <text>");
            return;
          }
          if (!project.group_id || !deps.groupManager) {
            ctx.send(input.entity, "Project group not available.");
            return;
          }
          const group = deps.groupManager.get(project.group_id);
          if (!group?.boardId) {
            ctx.send(input.entity, "Project board not available.");
            return;
          }
          // Post to the project's group board
          const postId = db.createBoardPost({
            boardId: group.boardId,
            authorId: input.entity,
            authorName: entity.name,
            title: `[proposal] ${text.slice(0, 80)}`,
            body: text,
            tags: ["proposal"],
          });
          ctx.send(input.entity, `Proposal posted to project board (post #${postId}).`);
          return;
        }

        case "outcome": {
          const score = Number(actionArgs[0]);
          const separatorIndex = actionArgs.indexOf("|");
          const evidence = actionArgs
            .slice(separatorIndex >= 0 ? separatorIndex + 1 : 1)
            .join(" ")
            .trim();
          if (!Number.isFinite(score) || score < 0 || score > 1 || !evidence) {
            ctx.send(
              input.entity,
              "Usage: project <name> outcome <0..1> | <evidence-backed result and lessons>",
            );
            return;
          }
          const pattern = normalizePatternName(project.orchestration || "custom");
          const content =
            `[project-outcome:${project.id} orchestration:${pattern}] score=${score.toFixed(2)} ` +
            evidence;
          if (project.pool_id) {
            db.addPoolNote(project.pool_id, entity.name, content, 9, "reflection");
          }
          if (pattern !== "custom") {
            const traditionName = `orchestration:${pattern}`;
            let tradition = db.getMemoryPool(traditionName);
            if (!tradition) {
              db.createMemoryPool(
                `pool_orchestration_${pattern}_${Date.now()}`,
                traditionName,
                "system",
              );
              tradition = db.getMemoryPool(traditionName);
            }
            if (tradition) {
              db.addPoolNote(tradition.id, entity.name, content, 8, "reflection");
            }
          }
          db.updateProjectStatus(project.id, "completed");
          emitProjectChange(ctx, input.entity, "update", project.name);
          ctx.send(
            input.entity,
            `Recorded outcome ${score.toFixed(2)} for "${project.name}" and shared the lesson with ${pattern} successors.`,
          );
          return;
        }

        case "tasks": {
          if (!project.bundle_id || !deps.taskManager) {
            ctx.send(input.entity, "No tasks for this project.");
            return;
          }
          const children = deps.taskManager.listChildren(project.bundle_id);
          if (children.length === 0) {
            ctx.send(input.entity, `Project "${project.name}" has no tasks yet.`);
            return;
          }
          const bundleStatus = deps.taskManager.getBundleStatus(project.bundle_id);
          const lines = [
            header(`${project.name} Tasks`),
            `Progress: ${bundleStatus.completed}/${bundleStatus.total} completed`,
            separator(),
            ...children.map((t) => {
              const mark = t.status === "completed" ? "[x]" : "[ ]";
              return `  ${mark} #${t.id}: ${t.title} (${t.status})`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        default:
          ctx.send(
            input.entity,
            `Unknown project action "${action}". Use: orchestrate, recommend, decompose, memory, join, status, propose, tasks, budget, usage, verify, outcome`,
          );
      }
    },
  };
}
