// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TaskManager } from "../../coordination/task-manager";
import { parseTaskNodeType, TASK_NODE_TYPE_MEANING } from "../../coordination/task-node-type";
import { getDecisionProvider } from "../../decisions/config";
import {
  clearSubmissionAttempts,
  decisionVerifyEnabled,
  nextSubmissionAttempt,
  verifySubmission,
} from "../../decisions/verify";
import {
  bold,
  dim,
  entity as fmtEntity,
  id as fmtId,
  status as fmtStatus,
  header,
  progressBar,
  separator,
} from "../../net/ansi";
import type {
  CommandDef,
  EngineEvent,
  Entity,
  EntityId,
  EntityRank,
  RoomContext,
} from "../../types";
import { canonicalSub, parseModifiers, unknownSubcommand } from "../parse-input";

const TASK_SUBS = [
  "list",
  "info",
  "create",
  "goal",
  "progress",
  "claim",
  "heartbeat",
  "recover",
  "submit",
  "approve",
  "reject",
  "cancel",
  "bundle",
  "assign",
  "children",
  "standing",
];

const TASK_USAGE =
  "Usage: task list|info|create|goal|progress|claim|heartbeat|recover|submit|approve|reject|cancel|bundle|assign|children|standing [args]";

/** Split `<title> | <description>` on the first pipe. */
function splitTitle(rest: string): { title: string; rawDesc: string } {
  const pipeIdx = rest.indexOf("|");
  if (pipeIdx >= 0) {
    return { title: rest.slice(0, pipeIdx).trim(), rawDesc: rest.slice(pipeIdx + 1).trim() };
  }
  return { title: rest, rawDesc: "" };
}

export function taskCommand(
  tasks: TaskManager,
  findEntity: (name: string) => Entity | undefined,
  logEvent?: (event: EngineEvent) => void,
  promote?: (entityId: EntityId, rank: EntityRank) => void,
): CommandDef {
  return {
    name: "task",
    aliases: [],
    help: "Manage tasks with leased create/claim/submit workflow.\nUsage: task list|info|create|goal|progress|claim|heartbeat|recover|submit|approve|reject|cancel|bundle|assign|children|standing\n  task create <title> | <description> [standing:N] [bounty]   (also !N)\n  task goal <title> | <description> [priority:N]   (also !pN / --priority N)\n  task info <id>   (also show/view)\n\nExamples:\n  task create Map the grid | Explore all sectors and document exits\n  task goal Explore the world | Visit every sector priority:7\n  task progress 3 +20\n  task claim 3\n  task heartbeat 3\n  task submit 3 All sectors documented\n  task standing\n  task list mine",
    handler: (ctx: RoomContext, input) => {
      const self = ctx.getEntity(input.entity);
      if (!self) return;

      const tokens = input.tokens;
      // `task show/view <id>` normalize onto `info`; `task ls` onto `list`.
      const sub = canonicalSub(tokens[0], TASK_SUBS) ?? "list";

      switch (sub) {
        case "list": {
          const arg = tokens[1]?.toLowerCase();
          const validStatuses = ["open", "completed", "cancelled", "claimed"];

          // "task list mine" — show tasks claimed by this entity
          if (arg === "mine") {
            const myClaims = tasks.listClaimedBy(input.entity);
            if (myClaims.length === 0) {
              ctx.send(input.entity, "No claimed tasks.");
              return;
            }
            const lines = [
              header("My Tasks"),
              separator(),
              ...myClaims.map((t) => {
                const prio = t.priority > 0 ? ` ${fmtStatus(`p${t.priority}`, "info")}` : "";
                const prog = t.progress > 0 ? ` ${progressBar(t.progress, 100, 8)}` : "";
                return `  ${fmtId(t.id)} ${t.title}${prio}${prog}`;
              }),
            ];
            ctx.send(input.entity, lines.join("\n"));
            return;
          }

          const status = arg && validStatuses.includes(arg) ? arg : "open";
          const groupId = arg && !validStatuses.includes(arg) ? tokens[1] : tokens[2];
          const taskList = tasks.list({
            status,
            groupId,
            orderByStanding: true,
          });
          if (taskList.length === 0) {
            ctx.send(input.entity, `No ${status} tasks.`);
            return;
          }
          const lines = [
            header(`${status.charAt(0).toUpperCase() + status.slice(1)} Tasks`),
            separator(),
            ...taskList.map((t) => {
              const group = t.groupId ? dim(` [${t.groupId}]`) : "";
              const bounty =
                t.validationMode === "bounty"
                  ? ` ${fmtStatus(`bounty${t.standing > 0 ? ` !${t.standing}` : ""}`, "warn")}`
                  : "";
              const prio = t.priority > 0 ? ` ${fmtStatus(`p${t.priority}`, "info")}` : "";
              return `  ${fmtId(t.id)} ${t.title}${bounty}${prio} ${dim(`— ${t.creatorName}`)}${group}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "info": {
          const idStr = tokens[1];
          if (!idStr) {
            ctx.send(input.entity, "Usage: task info <id>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          const task = tasks.get(id);
          if (!task) {
            ctx.send(input.entity, `Task #${idStr} not found.`);
            return;
          }
          const claims = tasks.getClaims(task.id);
          const standingLabel =
            task.standing > 0 ? ` | Standing: ${bold(`!${task.standing}`)}` : "";
          const statusKind =
            task.status === "completed" ? "done" : task.status === "cancelled" ? "fail" : "active";
          const prioLabel = task.priority > 0 ? ` | Priority: ${bold(`${task.priority}`)}` : "";
          const lines = [
            header(`Task ${fmtId(task.id)}: ${task.title}`),
            `${fmtStatus(task.status, statusKind)} | Creator: ${fmtEntity(task.creatorName)} | ${dim(task.validationMode)}${standingLabel}${prioLabel}`,
            separator(),
            task.description || dim("(no description)"),
          ];
          const nodeType = parseTaskNodeType(task.title);
          if (nodeType !== "leaf") {
            lines.push(`Type: ${bold(nodeType)} — ${TASK_NODE_TYPE_MEANING[nodeType]}`);
          }
          if (task.progress > 0) {
            lines.push(`Progress: ${progressBar(task.progress, 100)}`);
          }
          if (task.parentTaskId) {
            lines.push(`Parent bundle: #${task.parentTaskId}`);
          }
          const bundleStatus = tasks.getBundleStatus(task.id);
          if (bundleStatus.total > 0) {
            lines.push(
              `Children: ${bundleStatus.completed}/${bundleStatus.total} completed (${bundleStatus.open} open)`,
            );
          }
          if (task.validationMode === "bounty" && claims.length > 0) {
            const submissions = claims.filter((c) => c.status === "submitted").length;
            lines.push(`Submissions: ${submissions}/${claims.length} claims`);
          }
          if (claims.length > 0) {
            lines.push("", "Claims:");
            for (const c of claims) {
              const lease =
                c.status === "claimed" && c.leaseExpiresAt
                  ? ` — lease ${Math.max(0, Math.ceil((c.leaseExpiresAt - Date.now()) / 1000))}s`
                  : c.releaseReason
                    ? ` — ${c.releaseReason}`
                    : "";
              lines.push(
                `  ${c.entityName}: ${c.status}${c.submissionText ? ` — "${c.submissionText}"` : ""}${lease}`,
              );
            }
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "create": {
          // task create <title> | <description> [standing:N] [bounty]   (also !N)
          const createMods = parseModifiers(tokens.slice(1), {
            standing: { type: "int" },
            bounty: { type: "bool" },
          });
          if (createMods.errors.length > 0) {
            ctx.send(input.entity, `task create: ${createMods.errors.join("; ")}`);
            return;
          }
          const rest = createMods.rest.join(" ");
          if (!rest) {
            ctx.send(
              input.entity,
              "Usage: task create <title> | <description> [standing:N] [bounty]   (also !N)",
            );
            return;
          }
          const split = splitTitle(rest);
          const title = split.title;
          let rawDesc = split.rawDesc;

          // Legacy !N standing and bare bounty keyword in the description.
          let standing = (createMods.values.standing as number | undefined) ?? 0;
          let isBounty = createMods.values.bounty === true;
          const standingMatch = rawDesc.match(/!(\d+)/);
          if (standingMatch?.[1]) {
            if (standing === 0) standing = Number.parseInt(standingMatch[1], 10);
            rawDesc = rawDesc.replace(standingMatch[0], "").trim();
          }
          if (/\bbounty\b/i.test(rawDesc)) {
            isBounty = true;
            rawDesc = rawDesc.replace(/\bbounty\b/i, "").trim();
          }

          const task = tasks.create({
            title,
            description: rawDesc,
            creatorId: input.entity,
            creatorName: self.name,
            validationMode: isBounty ? "bounty" : undefined,
            standing: standing > 0 ? standing : undefined,
          });
          promote?.(input.entity, 2);
          const bountyLabel = isBounty ? ` [bounty !${standing}]` : "";
          ctx.send(input.entity, `Created task #${task.id}: "${title}"${bountyLabel}.`);
          return;
        }

        case "goal": {
          // task goal <title> | <description> [priority:N]   (also !pN)
          const goalMods = parseModifiers(tokens.slice(1), { priority: { type: "int" } });
          if (goalMods.errors.length > 0) {
            ctx.send(input.entity, `task goal: ${goalMods.errors.join("; ")}`);
            return;
          }
          const rest = goalMods.rest.join(" ");
          if (!rest) {
            ctx.send(
              input.entity,
              "Usage: task goal <title> | <description> [priority:N]   (also !pN / --priority N)",
            );
            return;
          }
          const split = splitTitle(rest);
          const title = split.title;
          let rawDesc = split.rawDesc;

          // Priority: modifier first, then legacy !pN in the description.
          let priority = 5;
          const prioMod = goalMods.values.priority as number | undefined;
          const prioMatch = rawDesc.match(/!p(\d+)/);
          if (prioMatch?.[1]) {
            priority = Number.parseInt(prioMatch[1], 10);
            rawDesc = rawDesc.replace(prioMatch[0], "").trim();
          }
          if (prioMod !== undefined) priority = prioMod;
          priority = Math.max(0, Math.min(10, priority));

          const task = tasks.create({
            title,
            description: rawDesc,
            creatorId: input.entity,
            creatorName: self.name,
            priority,
          });
          // Auto-claim
          tasks.claim(task.id, input.entity, self.name);
          promote?.(input.entity, 2);
          ctx.send(input.entity, `Goal set: ${fmtId(task.id)} "${title}" (priority ${priority}).`);
          return;
        }

        case "progress": {
          // task progress <id> [+N | N]
          const idStr = tokens[1];
          const valueStr = tokens[2];
          if (!idStr) {
            ctx.send(input.entity, "Usage: task progress <id> [+N | N]");
            return;
          }
          const taskId = Number.parseInt(idStr, 10);
          const task = tasks.get(taskId);
          if (!task) {
            ctx.send(input.entity, `Task #${idStr} not found.`);
            return;
          }
          if (!valueStr) {
            // Just show progress
            ctx.send(
              input.entity,
              `Task ${fmtId(taskId)}: ${task.title} — ${progressBar(task.progress, 100)}`,
            );
            return;
          }
          let newProgress: number;
          if (valueStr.startsWith("+")) {
            newProgress = task.progress + Number.parseInt(valueStr.slice(1), 10);
          } else {
            newProgress = Number.parseInt(valueStr, 10);
          }
          if (Number.isNaN(newProgress)) {
            ctx.send(input.entity, "Progress must be a number (e.g., +20 or 50).");
            return;
          }
          tasks.updateProgress(taskId, newProgress);
          // Progress is an implicit liveness signal for the current worker.
          tasks.heartbeat(taskId, input.entity);
          const clamped = Math.max(0, Math.min(100, newProgress));
          if (clamped >= 100) {
            ctx.send(input.entity, `Task ${fmtId(taskId)} completed!`);
            logEvent?.({
              type: "task_approved",
              entity: input.entity,
              taskId,
              timestamp: Date.now(),
            });
          } else {
            ctx.send(input.entity, `Task ${fmtId(taskId)}: ${progressBar(clamped, 100)}`);
          }
          return;
        }

        case "claim": {
          const idStr = tokens[1];
          if (!idStr) {
            ctx.send(input.entity, "Usage: task claim <id>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          const claim = tasks.claim(id, input.entity, self.name);
          if (!claim) {
            ctx.send(
              input.entity,
              `Cannot claim task #${idStr}. It may not exist, not be open, or you already claimed it.`,
            );
            return;
          }
          promote?.(input.entity, 2);
          ctx.send(input.entity, `Claimed task #${id}.`);
          logEvent?.({
            type: "task_claimed",
            entity: input.entity,
            taskId: id,
            timestamp: Date.now(),
          });
          return;
        }

        case "heartbeat": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          if (!Number.isFinite(id)) {
            ctx.send(input.entity, "Usage: task heartbeat <id>");
            return;
          }
          const claim = tasks.heartbeat(id, input.entity);
          if (!claim?.leaseExpiresAt) {
            ctx.send(input.entity, `Cannot renew task #${id}; no active claim was found.`);
            return;
          }
          const seconds = Math.max(1, Math.ceil((claim.leaseExpiresAt - Date.now()) / 1000));
          ctx.send(input.entity, `Renewed task #${id} lease for ${seconds}s.`);
          return;
        }

        case "recover": {
          const recovered = tasks.recoverExpired();
          for (const claim of recovered) {
            logEvent?.({
              type: "task_released",
              entity: claim.entityId as EntityId,
              taskId: claim.taskId,
              reason: "lease_expired",
              timestamp: Date.now(),
            });
          }
          ctx.send(
            input.entity,
            recovered.length === 0
              ? "No expired task leases."
              : `Recovered ${recovered.length} expired task lease(s); work is open for reallocation.`,
          );
          return;
        }

        case "submit": {
          const idStr = tokens[1];
          const text = tokens.slice(2).join(" ");
          if (!idStr || !text) {
            ctx.send(input.entity, "Usage: task submit <id> <text>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          const task = tasks.get(id);
          const record = () => {
            if (!tasks.submit(id, input.entity, text)) {
              ctx.send(
                input.entity,
                `Cannot submit for task #${idStr}. You may not have claimed it or already submitted.`,
              );
              return;
            }
            clearSubmissionAttempts(id, input.entity);
            ctx.send(input.entity, `Submitted work for task #${id}.`);
            if (task && task.creatorId !== input.entity) {
              ctx.send(
                task.creatorId as EntityId,
                `${fmtEntity(self.name)} submitted task ${fmtId(id)}: ${task.title}\n${dim(`Review: task info ${id}  ·  task approve ${id} ${self.name}  ·  task reject ${id} ${self.name}`)}`,
              );
            }
            logEvent?.({
              type: "task_submitted",
              entity: input.entity,
              taskId: id,
              timestamp: Date.now(),
            });
          };
          // Verifier (opt-in, src/decisions/verify.ts): only for a live claim,
          // so a doomed submit never costs a judge call. One bounce at most.
          const provider = decisionVerifyEnabled() ? getDecisionProvider() : undefined;
          if (!provider || !task || tasks.getClaim(id, input.entity)?.status !== "claimed") {
            record();
            return;
          }
          const attempt = nextSubmissionAttempt(id, input.entity);
          return verifySubmission(provider, task, text, attempt).then((verdict) => {
            logEvent?.({
              type: "agent_decision",
              name: self.name,
              stage: "verify",
              verdict: verdict.action,
              subject: `task #${id}`,
              reason: verdict.reason,
              signals: verdict.signals,
              ...(verdict.provider ? { provider: verdict.provider } : {}),
              ...(verdict.model ? { model: verdict.model } : {}),
              ...(verdict.latencyMs === undefined ? {} : { latencyMs: verdict.latencyMs }),
              ...(verdict.costUsd === undefined ? {} : { costUsd: verdict.costUsd }),
              ...(verdict.error ? { error: verdict.error } : {}),
              timestamp: Date.now(),
            });
            if (verdict.action === "accept") {
              record();
              return;
            }
            ctx.send(
              input.entity,
              `Not submitted yet — the verifier scored this below the bar (${verdict.reason}). ` +
                `Report the work actually done (results, evidence, artifacts) and run \`task submit ${id} …\` again; ` +
                "the next submission is recorded as is.",
            );
          });
        }

        case "approve": {
          const idStr = tokens[1];
          const claimantName = tokens[2];
          if (!idStr || !claimantName) {
            ctx.send(input.entity, "Usage: task approve <id> <claimant>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          const target = findEntity(claimantName);
          if (!target) {
            ctx.send(input.entity, `Player "${claimantName}" not found.`);
            return;
          }
          if (tasks.approveSubmission(id, target.id, input.entity)) {
            ctx.send(input.entity, `Approved ${target.name}'s submission for task #${id}.`);
            ctx.send(target.id, `Your submission for task #${id} was approved!`);
            logEvent?.({
              type: "task_approved",
              entity: input.entity,
              taskId: id,
              timestamp: Date.now(),
            });
          } else {
            ctx.send(
              input.entity,
              `Cannot approve. You may not be the creator or the submission doesn't exist.`,
            );
          }
          return;
        }

        case "reject": {
          const idStr = tokens[1];
          const claimantName = tokens[2];
          if (!idStr || !claimantName) {
            ctx.send(input.entity, "Usage: task reject <id> <claimant>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          const target = findEntity(claimantName);
          if (!target) {
            ctx.send(input.entity, `Player "${claimantName}" not found.`);
            return;
          }
          if (tasks.rejectSubmission(id, target.id, input.entity)) {
            ctx.send(input.entity, `Rejected ${target.name}'s submission for task #${id}.`);
            ctx.send(target.id, `Your submission for task #${id} was rejected.`);
            logEvent?.({
              type: "task_rejected",
              entity: input.entity,
              taskId: id,
              timestamp: Date.now(),
            });
          } else {
            ctx.send(
              input.entity,
              `Cannot reject. You may not be the creator or the submission doesn't exist.`,
            );
          }
          return;
        }

        case "cancel": {
          const idStr = tokens[1];
          if (!idStr) {
            ctx.send(input.entity, "Usage: task cancel <id>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          if (tasks.cancel(id, input.entity)) {
            ctx.send(input.entity, `Cancelled task #${id}.`);
          } else {
            ctx.send(
              input.entity,
              `Cannot cancel task #${idStr}. You may not be the creator or it's not open.`,
            );
          }
          return;
        }

        case "bundle": {
          const rest = tokens.slice(1).join(" ");
          if (!rest) {
            ctx.send(input.entity, "Usage: task bundle <title> | <description>");
            return;
          }
          const pipeIdx = rest.indexOf("|");
          let title: string;
          let description: string;
          if (pipeIdx >= 0) {
            title = rest.slice(0, pipeIdx).trim();
            description = rest.slice(pipeIdx + 1).trim();
          } else {
            title = rest;
            description = "";
          }
          const task = tasks.create({
            title,
            description,
            creatorId: input.entity,
            creatorName: self.name,
          });
          ctx.send(input.entity, `Created bundle #${task.id}: "${title}".`);
          return;
        }

        case "assign": {
          const idStr = tokens[1];
          const bundleIdStr = tokens[2];
          if (!idStr || !bundleIdStr) {
            ctx.send(input.entity, "Usage: task assign <id> <bundle_id>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          const bundleId = Number.parseInt(bundleIdStr, 10);
          if (tasks.assignToBundle(id, bundleId, input.entity)) {
            ctx.send(input.entity, `Assigned task #${id} to bundle #${bundleId}.`);
          } else {
            ctx.send(
              input.entity,
              `Cannot assign. You may not be the task creator or the bundle doesn't exist.`,
            );
          }
          return;
        }

        case "children": {
          const idStr = tokens[1];
          if (!idStr) {
            ctx.send(input.entity, "Usage: task children <id>");
            return;
          }
          const id = Number.parseInt(idStr, 10);
          const parent = tasks.get(id);
          if (!parent) {
            ctx.send(input.entity, `Task #${idStr} not found.`);
            return;
          }
          const children = tasks.listChildren(id);
          if (children.length === 0) {
            ctx.send(input.entity, `Bundle ${fmtId(id)} has no children.`);
            return;
          }
          const bundleStatus = tasks.getBundleStatus(id);
          const lines = [
            header(`Bundle ${fmtId(id)}: ${parent.title}`),
            `Progress: ${progressBar(bundleStatus.completed, bundleStatus.total)}`,
            separator(),
            ...children.map((t) => {
              const mark =
                t.status === "completed" ? fmtStatus("\u2713", "done") : fmtStatus(" ", "warn");
              return `  ${mark} ${fmtId(t.id)} ${t.title}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "standing": {
          const leaderboard = tasks.getStandingLeaderboard(10);
          if (leaderboard.length === 0) {
            ctx.send(input.entity, "No standing earned yet.");
            return;
          }
          const lines = [
            header("Standing Leaderboard"),
            separator(),
            ...leaderboard.map(
              (e, i) =>
                `  ${bold(`${i + 1}.`)} ${fmtEntity(e.entityName)}: ${bold(String(e.total))} standing ${dim(`(${e.taskCount} tasks)`)}`,
            ),
          ];
          const myStanding = tasks.getEntityStanding(input.entity);
          if (myStanding > 0) {
            lines.push("", `  Your standing: ${bold(String(myStanding))}`);
          }
          // Disambiguate: this is the global leaderboard. A single task's bounty
          // is shown by `task info <id>` (the "Standing: !N" field), not here.
          lines.push("", dim("A specific task's bounty is shown in `task info <id>`."));
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        default:
          ctx.send(input.entity, unknownSubcommand("task", tokens[0], TASK_USAGE));
      }
    },
  };
}
