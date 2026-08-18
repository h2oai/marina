// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { record as recordStanding } from "../../agent/standing";
import { bold, dim, id as fmtId, status as fmtStatus, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { requireRank } from "../permissions";

interface ExperimentConfig {
  arms: string[];
  metric?: string;
  goal: "higher" | "lower";
}

interface ExperimentResultRow {
  entity_name: string;
  metric_name: string;
  metric_value: number;
  arm: string;
}

interface ArmSummary {
  arm: string;
  mean: number;
  n: number;
  metrics: Map<string, { sum: number; n: number }>;
}

/** Read the arms/metric/goal comparison spec out of the experiment's config JSON. */
function parseConfig(configJson: string): ExperimentConfig {
  let c: Record<string, unknown> = {};
  try {
    c = JSON.parse(configJson || "{}") as Record<string, unknown>;
  } catch {
    /* corrupt config — treat as un-armed */
  }
  const arms = Array.isArray(c.arms)
    ? c.arms.filter((x): x is string => typeof x === "string")
    : [];
  const metric = typeof c.metric === "string" ? c.metric : undefined;
  const goal = c.goal === "lower" ? "lower" : "higher";
  return { arms, metric, goal };
}

/**
 * Aggregate armed results into per-arm means, ranked by the primary metric.
 * Primary metric = the configured one, else the most-recorded metric. Higher
 * is better unless goal is "lower".
 */
function summarize(
  results: ExperimentResultRow[],
  cfg: ExperimentConfig,
): { primary?: string; ranked: ArmSummary[] } {
  const byArm = new Map<string, Map<string, { sum: number; n: number }>>();
  const metricFreq = new Map<string, number>();
  for (const r of results) {
    if (!r.arm) continue; // armed summary ignores legacy/unassigned samples
    if (!byArm.has(r.arm)) byArm.set(r.arm, new Map());
    const m = byArm.get(r.arm)!;
    const cur = m.get(r.metric_name) ?? { sum: 0, n: 0 };
    cur.sum += r.metric_value;
    cur.n += 1;
    m.set(r.metric_name, cur);
    metricFreq.set(r.metric_name, (metricFreq.get(r.metric_name) ?? 0) + 1);
  }
  const primary =
    cfg.metric ?? [...metricFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? undefined;
  if (!primary) return { primary, ranked: [] };

  const ranked: ArmSummary[] = [];
  for (const [arm, metrics] of byArm) {
    const pm = metrics.get(primary);
    if (!pm) continue;
    ranked.push({ arm, mean: pm.sum / pm.n, n: pm.n, metrics });
  }
  ranked.sort((a, b) => (cfg.goal === "lower" ? a.mean - b.mean : b.mean - a.mean));
  return { primary, ranked };
}

export function experimentCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "experiment",
    aliases: ["exp"],
    help: `Run a controlled A/B comparison — define arms, record metrics per arm, get a ranked winner.
Use this when you're MEASURING which of several conditions wins on a metric — not for getting work done.
  • plain work for one person → task        • a team coordinating a bundle of work → project
  • scored capability runs (MMLU, etc.)  → benchmark   • forecasting an outcome → market / scenario

Usage:
  experiment create <name> [arms A,B,...] [metric <name>] [goal higher|lower] [agents] [time]
  experiment join|start|status|results|complete <name>
  experiment record <name> <arm> <metric> <value>     (when arms are defined)
  experiment record <name> <metric> <value>           (un-armed: flat per-recorder log)

Examples:
  experiment create PromptStyle arms terse,verbose metric accuracy goal higher
  experiment start PromptStyle
  experiment record PromptStyle terse accuracy 0.82
  experiment record PromptStyle verbose accuracy 0.71
  experiment results PromptStyle      # ranked arms + winner
  experiment complete PromptStyle     # records the outcome + credits you`,
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Experiments require database support.");
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase() ?? "list";

      switch (sub) {
        case "list": {
          const experiments = db.listExperiments();
          if (experiments.length === 0) {
            ctx.send(input.entity, "No experiments exist.");
            return;
          }
          const lines = [
            header("Experiments"),
            separator(50),
            ...experiments.map((e) => {
              const participants = db.getParticipants(e.id).length;
              const kind =
                e.status === "active" ? "active" : e.status === "completed" ? "done" : "info";
              const arms = parseConfig(e.config).arms;
              const armTag = arms.length ? ` ${dim(`[${arms.join(" vs ")}]`)}` : "";
              return `  ${bold(e.name)} ${fmtStatus(e.status, kind)}${armTag} - ${bold(`${participants}/${e.required_agents}`)} agents - by ${dim(e.creator_name)}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "create": {
          if (!requireRank(entity, 2)) {
            ctx.send(input.entity, "Requires coordinator rank (2+) to create experiments.");
            return;
          }
          const name = tokens[1];
          if (!name) {
            ctx.send(
              input.entity,
              "Usage: experiment create <name> [arms A,B,...] [metric <name>] [goal higher|lower]",
            );
            return;
          }
          const existing = db.getExperimentByName(name);
          if (existing) {
            ctx.send(input.entity, `Experiment "${name}" already exists.`);
            return;
          }

          // Parse the rest: `arms`/`metric`/`goal` keyword args plus legacy
          // positional [agents] [time_limit] numbers.
          const arms: string[] = [];
          let metric: string | undefined;
          let goal: "higher" | "lower" = "higher";
          let agents: number | undefined;
          let timeLimit: number | undefined;
          const rest = tokens.slice(2);
          for (let i = 0; i < rest.length; i++) {
            const t = rest[i]!.toLowerCase();
            if (t === "arms") {
              arms.push(
                ...(rest[++i] ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              );
            } else if (t === "metric") {
              metric = rest[++i];
            } else if (t === "goal") {
              const g = rest[++i]?.toLowerCase();
              if (g === "lower" || g === "higher") goal = g;
            } else if (/^\d+$/.test(rest[i]!)) {
              if (agents === undefined) agents = Number.parseInt(rest[i]!, 10);
              else if (timeLimit === undefined) timeLimit = Number.parseInt(rest[i]!, 10);
            }
          }
          if (arms.length === 1) {
            ctx.send(input.entity, "An A/B comparison needs at least two arms, e.g. arms A,B.");
            return;
          }

          const config: Record<string, unknown> = {};
          if (arms.length) {
            config.arms = arms;
            config.goal = goal;
            if (metric) config.metric = metric;
          }
          // Armed experiments are startable solo (the experimenter runs the
          // arms); un-armed multi-agent experiments keep the old default of 2.
          const requiredAgents = agents ?? (arms.length ? 1 : 2);
          const id = db.createExperiment({
            name,
            creatorName: entity.name,
            config,
            requiredAgents,
            timeLimit,
          });
          db.addParticipant(id, entity.name);
          const armNote = arms.length
            ? ` Comparing ${bold(arms.join(" vs "))}${metric ? ` on ${bold(metric)} (${goal})` : ""}.`
            : "";
          ctx.send(
            input.entity,
            `Experiment "${bold(name)}" created ${dim(`(${fmtId(id)})`)}.${armNote} You are a participant.`,
          );
          return;
        }

        case "join": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: experiment join <name>");
            return;
          }
          const exp = db.getExperimentByName(name);
          if (!exp) {
            ctx.send(input.entity, `Experiment "${name}" not found.`);
            return;
          }
          if (exp.status !== "pending") {
            ctx.send(input.entity, `Experiment "${name}" is already ${exp.status}.`);
            return;
          }
          if (db.isParticipant(exp.id, entity.name)) {
            ctx.send(input.entity, "You are already a participant.");
            return;
          }
          db.addParticipant(exp.id, entity.name);
          const count = db.getParticipants(exp.id).length;
          ctx.send(
            input.entity,
            `Joined experiment "${name}" (${count}/${exp.required_agents} agents).`,
          );
          return;
        }

        case "start": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: experiment start <name>");
            return;
          }
          const exp = db.getExperimentByName(name);
          if (!exp) {
            ctx.send(input.entity, `Experiment "${name}" not found.`);
            return;
          }
          if (exp.status !== "pending") {
            ctx.send(input.entity, `Experiment "${name}" is already ${exp.status}.`);
            return;
          }
          const participants = db.getParticipants(exp.id);
          if (participants.length < exp.required_agents) {
            ctx.send(
              input.entity,
              `Need ${exp.required_agents} agents, have ${participants.length}.`,
            );
            return;
          }
          db.startExperiment(exp.id);
          ctx.send(input.entity, `Experiment "${name}" started!`);
          return;
        }

        case "status": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: experiment status <name>");
            return;
          }
          const exp = db.getExperimentByName(name);
          if (!exp) {
            ctx.send(input.entity, `Experiment "${name}" not found.`);
            return;
          }
          const participants = db.getParticipants(exp.id);
          const cfg = parseConfig(exp.config);
          const kind =
            exp.status === "active" ? "active" : exp.status === "completed" ? "done" : "info";
          const lines = [
            header(`Experiment: ${exp.name}`),
            separator(),
            `  Status: ${fmtStatus(exp.status, kind)}`,
            `  Creator: ${dim(exp.creator_name)}`,
            `  Agents: ${bold(`${participants.length}/${exp.required_agents}`)}`,
            `  Participants: ${participants.map((p) => p.entity_name).join(", ") || dim("none")}`,
          ];
          if (cfg.arms.length) {
            lines.push(`  Arms: ${bold(cfg.arms.join(" vs "))}`);
            lines.push(`  Metric: ${cfg.metric ?? dim("auto")} (${cfg.goal} is better)`);
          }
          if (exp.time_limit) {
            lines.push(`  Time Limit: ${dim(`${exp.time_limit}s`)}`);
          }
          if (exp.started_at) {
            const elapsed = Math.floor((Date.now() - exp.started_at) / 1000);
            lines.push(`  Elapsed: ${bold(`${elapsed}s`)}`);
          }
          if (exp.description) {
            lines.push(`  Description: ${exp.description}`);
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "results": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: experiment results <name>");
            return;
          }
          const exp = db.getExperimentByName(name);
          if (!exp) {
            ctx.send(input.entity, `Experiment "${name}" not found.`);
            return;
          }
          const results = db.getResults(exp.id) as ExperimentResultRow[];
          if (results.length === 0) {
            ctx.send(input.entity, "No results recorded yet.");
            return;
          }
          const cfg = parseConfig(exp.config);
          if (cfg.arms.length) {
            ctx.send(input.entity, renderArmedResults(exp.name, results, cfg));
            return;
          }
          // Un-armed: flat per-recorder log (legacy behavior).
          const lines = [
            header(`Results: ${exp.name}`),
            separator(),
            ...results.map(
              (r) => `  ${r.entity_name}: ${r.metric_name} = ${bold(String(r.metric_value))}`,
            ),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "complete": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: experiment complete <name>");
            return;
          }
          const exp = db.getExperimentByName(name);
          if (!exp) {
            ctx.send(input.entity, `Experiment "${name}" not found.`);
            return;
          }
          if (exp.status !== "active") {
            ctx.send(input.entity, `Experiment "${name}" is not active.`);
            return;
          }
          db.completeExperiment(exp.id);

          const cfg = parseConfig(exp.config);
          const results = db.getResults(exp.id) as ExperimentResultRow[];
          const { primary, ranked } = cfg.arms.length
            ? summarize(results, cfg)
            : { primary: undefined, ranked: [] as ArmSummary[] };

          if (ranked.length > 0 && primary) {
            const top = ranked[0]!;
            const tie = ranked.length > 1 && ranked[1]!.mean === top.mean;
            const board = ranked.map((a) => `${a.arm}=${a.mean.toFixed(3)}(n=${a.n})`).join(", ");
            // Outcome note authored by the creator so successors recall the
            // verdict via the generational-memory loop.
            const verdict = tie
              ? `inconclusive — tie on ${primary} (${board})`
              : `arm "${top.arm}" wins on ${primary}: ${board}`;
            db.createNote(exp.creator_name, `Experiment "${exp.name}" → ${verdict}.`, undefined, {
              noteType: "experiment-outcome",
              tier: "reflection",
              importance: 6,
            });
            recordStanding(
              db,
              entity.id,
              entity.name,
              "experiment_complete",
              `experiment:${exp.id}`,
            );
            ctx.send(
              input.entity,
              `Experiment "${name}" completed — ${tie ? "tie" : `winner: ${bold(top.arm)}`} on ${primary}. Outcome recorded.`,
            );
            return;
          }

          ctx.send(input.entity, `Experiment "${name}" completed.`);
          return;
        }

        case "record": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: experiment record <name> <arm> <metric> <value>");
            return;
          }
          const exp = db.getExperimentByName(name);
          if (!exp) {
            ctx.send(input.entity, `Experiment "${name}" not found.`);
            return;
          }
          if (exp.status !== "active") {
            ctx.send(input.entity, `Experiment "${name}" is not active.`);
            return;
          }
          const cfg = parseConfig(exp.config);

          if (cfg.arms.length) {
            const armTok = tokens[2];
            const metric = tokens[3];
            const value = Number.parseFloat(tokens[4] ?? "");
            if (!armTok || !metric || Number.isNaN(value)) {
              ctx.send(input.entity, "Usage: experiment record <name> <arm> <metric> <value>");
              return;
            }
            const arm = cfg.arms.find((a) => a.toLowerCase() === armTok.toLowerCase());
            if (!arm) {
              ctx.send(input.entity, `Unknown arm "${armTok}". Arms: ${cfg.arms.join(", ")}.`);
              return;
            }
            db.recordResult(exp.id, entity.name, metric, value, arm);
            ctx.send(input.entity, `Recorded: ${arm} / ${metric} = ${value}`);
            return;
          }

          // Un-armed (legacy): record <name> <metric> <value>.
          const metric = tokens[2];
          const value = Number.parseFloat(tokens[3] ?? "");
          if (!metric || Number.isNaN(value)) {
            ctx.send(input.entity, "Usage: experiment record <name> <metric> <value>");
            return;
          }
          db.recordResult(exp.id, entity.name, metric, value);
          ctx.send(input.entity, `Recorded: ${metric} = ${value}`);
          return;
        }

        default: {
          ctx.send(
            input.entity,
            "Usage: experiment [list|create|join|start|status|results|complete|record]",
          );
        }
      }
    },
  };
}

/** Ranked-arm results view with a flagged winner and deltas vs the leader. */
function renderArmedResults(
  name: string,
  results: ExperimentResultRow[],
  cfg: ExperimentConfig,
): string {
  const { primary, ranked } = summarize(results, cfg);
  if (!primary || ranked.length === 0) {
    return `No arm results recorded yet for "${name}". Record with: experiment record ${name} <arm> ${cfg.metric ?? "<metric>"} <value>`;
  }
  const top = ranked[0]!;
  const lines = [
    header(`Results: ${name}`),
    separator(),
    dim(`Ranked by ${primary} (${cfg.goal} is better)`),
  ];
  for (const a of ranked) {
    const winner = a === top && !(ranked.length > 1 && ranked[1]!.mean === top.mean);
    const marker = winner ? bold("★") : " ";
    const delta =
      a === top
        ? ""
        : dim(` (${(a.mean - top.mean >= 0 ? "+" : "") + (a.mean - top.mean).toFixed(3)})`);
    // Secondary metrics recorded for this arm, for context.
    const others = [...a.metrics.entries()]
      .filter(([m]) => m !== primary)
      .map(([m, v]) => `${m}=${(v.sum / v.n).toFixed(3)}`);
    const extra = others.length ? dim(`  · ${others.join(", ")}`) : "";
    lines.push(
      `  ${marker} ${bold(a.arm)}: ${primary}=${a.mean.toFixed(3)} ${dim(`(n=${a.n})`)}${delta}${extra}`,
    );
  }
  return lines.join("\n");
}
