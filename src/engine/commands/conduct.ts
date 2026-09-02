// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentStatus } from "../../agent/agent-types";
import { getStanding } from "../../agent/standing";
import {
  parseAssignee,
  parseScore,
  type Score,
  ScoreError,
  topoLayers,
  validateScore,
} from "../../coordination/score";
import { loadScoreOutcomes, recordScoreOutcome } from "../../coordination/score-outcome";
import { characterizeScore } from "../../coordination/score-shape";
import { listScoreNames, loadScore, storeScore } from "../../coordination/score-store";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";

interface ConductCommandDeps {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
  /** Live agents — for resolving role:/model: assignees against the roster. */
  listAgents: () => AgentStatus[];
  /** Optional engine-event sink — for feed propagation of runs. */
  logEvent?: (event: EngineEvent) => void;
}

/** Everything after the `--` separator, trimmed. */
function afterDashes(args: string): string {
  const i = args.indexOf("--");
  return i >= 0 ? args.slice(i + 2).trim() : "";
}

/**
 * Resolve an assignee to a concrete target against the live roster. Entity and
 * model: address by value; role: picks the highest-standing live agent with
 * that role; conduct stays "conduct". Returns null when a role has no live
 * member.
 */
function resolveLive(assignee: string, deps: ConductCommandDeps): string | null {
  const a = parseAssignee(assignee);
  if (a.kind === "conduct") return "conduct";
  if (a.kind === "model" || a.kind === "entity") return a.value || null;
  const role = a.value.toLowerCase();
  const ranked = deps
    .listAgents()
    .filter((ag) => ag.entityId && ag.role && ag.role.toLowerCase() === role)
    .map((ag) => ({ name: ag.name, standing: getStanding(deps.db, ag.entityId!) }))
    .sort((x, y) => y.standing - x.standing);
  return ranked[0]?.name ?? null;
}

function fmtScore(name: string, score: Score): string {
  const lines = [header(`Score: ${name}`), separator(), dim(`goal: ${score.goal || "(none)"}`)];
  try {
    topoLayers(score).forEach((layer, i) => {
      lines.push(bold(`  layer ${i + 1}${layer.length > 1 ? " (parallel)" : ""}:`));
      for (const step of layer) {
        const deps = step.access.length ? dim(` ← ${step.access.join(", ")}`) : "";
        lines.push(`    ${step.id} [${step.assignee}]${deps}: ${step.instruction}`);
      }
    });
  } catch {
    for (const step of score.steps) {
      lines.push(`    ${step.id} [${step.assignee}]: ${step.instruction}`);
    }
  }
  return lines.join("\n");
}

export function conductCommand(deps: ConductCommandDeps): CommandDef {
  return {
    name: "conduct",
    aliases: [],
    minRank: 0,
    help:
      "Author, inspect, and run Scores — executable workflow plans (the Conductor grammar).\n" +
      "Usage:\n" +
      "  conduct list                          — stored Scores\n" +
      "  conduct show <name>                   — pretty-print a Score's layers\n" +
      "  conduct json <name>                   — raw Score JSON (for tools/scripts)\n" +
      "  conduct validate -- <json>            — check a Score without storing\n" +
      "  conduct create <name> -- <json>       — validate and store a Score\n" +
      "  conduct fork <name> <newname>         — copy a stored Score under a new name\n" +
      "  conduct resolve <assignee>            — resolve role:/model:/entity to a live target\n" +
      "  conduct track <name> <sampleId> predict=<0..1> [category=<c>]  — bet a Score on an outcome\n" +
      "  conduct ran <name> -- <summary>       — report a finished run (to the feed)\n" +
      "  conduct outcome <name> <0..1> [category=<c>] [-- <label>]  — record how a run went\n" +
      "  conduct learned [category]            — recall which shapes worked (priors)\n" +
      "Step JSON: { goal, steps: [{ id, instruction, assignee, access: [ids] }] }\n" +
      "Assignee: <agent> | role:<r> | model:<prov/id> | conduct",
    handler: (ctx: RoomContext, input) => {
      const caller = deps.getEntity(input.entity);
      if (!caller) return;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "list") {
        const names = listScoreNames(deps.db);
        if (names.length === 0) {
          ctx.send(
            input.entity,
            "No Scores stored. Author one with: conduct create <name> -- <json>",
          );
          return;
        }
        ctx.send(
          input.entity,
          [header("Scores"), separator(), ...names.sort().map((n) => `  ${n}`)].join("\n"),
        );
        return;
      }

      if (sub === "show") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: conduct show <name>");
          return;
        }
        const score = loadScore(deps.db, name);
        if (!score) {
          ctx.send(input.entity, `Score "${name}" not found.`);
          return;
        }
        ctx.send(input.entity, fmtScore(name, score));
        return;
      }

      if (sub === "json") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: conduct json <name>");
          return;
        }
        const score = loadScore(deps.db, name);
        if (!score) {
          ctx.send(input.entity, `Score "${name}" not found.`);
          return;
        }
        ctx.send(input.entity, JSON.stringify(score));
        return;
      }

      if (sub === "validate") {
        const json = afterDashes(input.args);
        if (!json) {
          ctx.send(input.entity, "Usage: conduct validate -- <json>");
          return;
        }
        try {
          const score = parseScore(json, { author: caller.name });
          const err = validateScore(score);
          if (err) {
            ctx.send(input.entity, `Invalid: ${err}`);
            return;
          }
          ctx.send(
            input.entity,
            `Valid — ${score.steps.length} step(s) in ${topoLayers(score).length} layer(s).`,
          );
        } catch (e) {
          ctx.send(input.entity, e instanceof ScoreError ? e.message : String(e));
        }
        return;
      }

      if (sub === "create") {
        const head = input.args.replace(/^create\s+/i, "");
        const dashIdx = head.indexOf("--");
        const name = (dashIdx >= 0 ? head.slice(0, dashIdx) : head).trim().split(/\s+/)[0];
        const json = dashIdx >= 0 ? head.slice(dashIdx + 2).trim() : "";
        if (!name || !json) {
          ctx.send(input.entity, "Usage: conduct create <name> -- <json>");
          return;
        }
        if (loadScore(deps.db, name)) {
          ctx.send(
            input.entity,
            `Score "${name}" already exists. Use a new name or 'conduct fork'.`,
          );
          return;
        }
        try {
          const score = parseScore(json, { author: caller.name });
          const err = validateScore(score);
          if (err) {
            ctx.send(input.entity, `Invalid: ${err}`);
            return;
          }
          if (!storeScore(deps.db, caller.name, name, score)) {
            ctx.send(
              input.entity,
              "Scores are stored in a memory pool and this world has none. Create one with `pool create scores`, then retry.",
            );
            return;
          }
          ctx.send(
            input.entity,
            `Score "${name}" created — ${score.steps.length} step(s), ${topoLayers(score).length} layer(s). Inspect with 'conduct show ${name}'.`,
          );
        } catch (e) {
          ctx.send(input.entity, e instanceof ScoreError ? e.message : String(e));
        }
        return;
      }

      if (sub === "fork") {
        const name = tokens[1];
        const newName = tokens[2];
        if (!name || !newName) {
          ctx.send(input.entity, "Usage: conduct fork <name> <newname>");
          return;
        }
        const score = loadScore(deps.db, name);
        if (!score) {
          ctx.send(input.entity, `Score "${name}" not found.`);
          return;
        }
        if (loadScore(deps.db, newName)) {
          ctx.send(input.entity, `Score "${newName}" already exists.`);
          return;
        }
        const forked: Score = {
          ...score,
          id: `score_${Date.now().toString(36)}`,
          author: caller.name,
        };
        storeScore(deps.db, caller.name, newName, forked);
        ctx.send(
          input.entity,
          `Forked "${name}" → "${newName}" (${forked.steps.length} steps). Mutate it freely.`,
        );
        return;
      }

      if (sub === "resolve") {
        const assignee = tokens[1];
        if (!assignee) {
          ctx.send(input.entity, "Usage: conduct resolve <assignee>");
          return;
        }
        const target = resolveLive(assignee, deps);
        ctx.send(input.entity, target ?? "(unresolved)");
        return;
      }

      if (sub === "track") {
        // conduct track <name> <sampleId> predict=<0..1> [category=<c>]
        const name = tokens[1];
        const sampleId = tokens[2];
        if (!name || !sampleId) {
          ctx.send(
            input.entity,
            "Usage: conduct track <name> <sampleId> predict=<0..1> [category=<c>]",
          );
          return;
        }
        const score = loadScore(deps.db, name);
        if (!score) {
          ctx.send(input.entity, `Score "${name}" not found.`);
          return;
        }
        let predict: number | undefined;
        let category = "general";
        for (const tok of tokens.slice(3)) {
          if (tok.toLowerCase().startsWith("predict=")) {
            const v = tok.slice(8).toLowerCase();
            predict = v === "yes" ? 1 : v === "no" ? 0 : Number(v);
          } else if (tok.toLowerCase().startsWith("category=")) {
            category = tok.slice(9);
          }
        }
        if (predict === undefined || !Number.isFinite(predict)) {
          ctx.send(input.entity, "Provide predict=<0..1|yes|no>.");
          return;
        }
        const clamped = Math.max(0, Math.min(1, predict));
        const topology = characterizeScore(score).topology;
        deps.db.createNote(
          caller.name,
          `[score-run:${sampleId}] score:${name} category:${category} topology:${topology} predict=${clamped.toFixed(2)}`,
          undefined,
          { importance: 6, noteType: "process" },
        );
        ctx.send(
          input.entity,
          `Tracking "${name}" against ${sampleId} (predict ${clamped.toFixed(2)}). When it resolves, the outcome is recorded automatically.`,
        );
        return;
      }

      if (sub === "ran") {
        const name = tokens[1];
        const summary = afterDashes(input.args);
        if (!name || !summary) {
          ctx.send(input.entity, "Usage: conduct ran <name> -- <summary>");
          return;
        }
        deps.logEvent?.({
          type: "feed_event",
          kind: "score_run",
          entity: input.entity as EntityId,
          ref: `score:${name}`,
          summary: `${caller.name} conducted "${name}": ${summary}`,
          payload: { score: name },
          timestamp: Date.now(),
        });
        ctx.send(input.entity, `Run of "${name}" reported.`);
        return;
      }

      if (sub === "outcome") {
        const name = tokens[1];
        const scoreVal = Number(tokens[2]);
        if (!name || !Number.isFinite(scoreVal)) {
          ctx.send(
            input.entity,
            "Usage: conduct outcome <name> <0..1> [category=<c>] [-- <label>]",
          );
          return;
        }
        const score = loadScore(deps.db, name);
        if (!score) {
          ctx.send(input.entity, `Score "${name}" not found.`);
          return;
        }
        let category: string | undefined;
        for (const tok of tokens.slice(3)) {
          if (tok.toLowerCase().startsWith("category=")) category = tok.slice(9);
        }
        const label = afterDashes(input.args) || undefined;
        const id = recordScoreOutcome(deps.db, score, {
          scoreName: name,
          score: scoreVal,
          category,
          label,
          recordedBy: caller.name,
        });
        ctx.send(
          input.entity,
          id
            ? `Recorded outcome for "${name}" (${(Math.max(0, Math.min(1, scoreVal)) * 100).toFixed(0)}%). Future conductors will recall this shape via 'conduct learned'.`
            : "Could not record outcome (no pool).",
        );
        return;
      }

      if (sub === "learned") {
        const category = tokens[1];
        const records = loadScoreOutcomes(deps.db, { category });
        if (records.length === 0) {
          ctx.send(
            input.entity,
            category
              ? `No recorded outcomes for "${category}" yet.`
              : "No recorded outcomes yet. Record one with 'conduct outcome <name> <0..1>'.",
          );
          return;
        }
        records.sort((a, b) => b.score - a.score);
        const lines = [
          header(category ? `Learned shapes: ${category}` : "Learned shapes"),
          separator(),
        ];
        for (const r of records.slice(0, 15)) lines.push(`  ${r.content}`);
        lines.push(separator(), dim(`${records.length} outcome(s) — best shapes first`));
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      ctx.send(
        input.entity,
        `Unknown conduct subcommand "${sub}". Try: list, show, json, validate, create, fork, resolve, track, ran, outcome, learned.`,
      );
    },
  };
}
