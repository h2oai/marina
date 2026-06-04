import { bold, dim, id as fmtId, status as fmtStatus, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { requireRank } from "../permissions";

export function experimentCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "experiment",
    aliases: ["exp"],
    help: "Structured experiments with participants and recorded results.\nUsage: experiment list|create|join|start|status|results|complete|record\n\nExamples:\n  experiment create Temperature_Study 4 300\n  experiment join Temperature_Study\n  experiment start Temperature_Study\n  experiment record Temperature_Study accuracy 0.85",
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
              return `  ${bold(e.name)} ${fmtStatus(e.status, kind)} - ${bold(`${participants}/${e.required_agents}`)} agents - by ${dim(e.creator_name)}`;
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
            ctx.send(input.entity, "Usage: experiment create <name> [agents] [time_limit]");
            return;
          }
          const existing = db.getExperimentByName(name);
          if (existing) {
            ctx.send(input.entity, `Experiment "${name}" already exists.`);
            return;
          }
          const agents = Number.parseInt(tokens[2] ?? "2", 10);
          const timeLimit = tokens[3] ? Number.parseInt(tokens[3], 10) : undefined;
          const id = db.createExperiment({
            name,
            creatorName: entity.name,
            requiredAgents: Number.isNaN(agents) ? 2 : agents,
            timeLimit: timeLimit && !Number.isNaN(timeLimit) ? timeLimit : undefined,
          });
          db.addParticipant(id, entity.name);
          ctx.send(
            input.entity,
            `Experiment "${bold(name)}" created ${dim(`(${fmtId(id)})`)}. You have been added as a participant.`,
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
          const results = db.getResults(exp.id);
          if (results.length === 0) {
            ctx.send(input.entity, "No results recorded yet.");
            return;
          }
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
          ctx.send(input.entity, `Experiment "${name}" completed.`);
          return;
        }

        case "record": {
          const name = tokens[1];
          const metric = tokens[2];
          const value = Number.parseFloat(tokens[3] ?? "");
          if (!name || !metric || Number.isNaN(value)) {
            ctx.send(input.entity, "Usage: experiment record <name> <metric> <value>");
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
