// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `pattern run <pattern> [budget:<usd>] -- <task>` — run ONE free-text task
 * under a named orchestration pattern (`runTextPattern`,
 * `src/orchestration/text-patterns.ts`), the in-world twin of
 * `POST /v1/patterns/run`. `pattern list` names the patterns.
 *
 * Rank 0, like `forecast`: every call costs money, so the guards are the
 * spend guards, not rank. The daily cap is checked up front and before every
 * stage (`SpendGuard`, with a per-run budget: default $0.50, at most $2), every
 * model call goes through `src/model` (recorded once under `purpose:other`,
 * traced as `pattern.run`), each entity has a small token bucket and one run
 * at a time. Members are the operator's models (the first available model,
 * `MARINA_ENSEMBLE_SIZE` times) — a caller never names a model. Patterns that
 * need a persistent crew are refused with a pointer to `marina:<crew>`.
 */

import { availableModels } from "../../agent/available-models";
import { RateLimiter } from "../../auth/rate-limiter";
import { experimentalHelp } from "../../config/feature-status";
import { modelComplete } from "../../model/complete";
import { bold, dim, header, separator } from "../../net/ansi";
import { providerSetupHint } from "../../net/model/provider-setup";
import { ensembleSize } from "../../net/model-api/ensemble";
import { canonicalFormationName, formationEntry } from "../../orchestration/formations/catalogue";
import {
  CREW_ONLY_PATTERNS,
  isTextPattern,
  type PatternRunResult,
  runTextPattern,
  TEXT_PATTERNS,
  type TextComplete,
} from "../../orchestration/text-patterns";
import { recordPatternRun } from "../../outcomes/orchestration";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import { refuseCommand } from "../command-response";
import { getErrorMessage, tryLog } from "../errors";
import { Logger } from "../logger";
import { parseModifiers, splitOnTerminator } from "../parse-input";
import { SpendGuard } from "../spend-guard";
import { dailyCapRefusal } from "../spend-ledger";

/** Longest task accepted, in characters (the HTTP route's limit). */
export const PATTERN_COMMAND_TASK_MAX_CHARS = 16_000;
/** Per-run budget when the caller names none, and the most a caller may name. */
export const PATTERN_DEFAULT_BUDGET_USD = 0.5;
export const PATTERN_MAX_BUDGET_USD = 2;
/** The whole run's deadline (every stage, every call). */
const PATTERN_RUN_TIMEOUT_MS = 600_000;

const logger = new Logger();

export const PATTERN_USAGE = [
  "Usage: pattern run <pattern> [budget:<usd>] -- <task>",
  "       pattern list",
  `patterns: ${TEXT_PATTERNS.join(", ")}`,
].join("\n");

export interface PatternCommandDeps {
  /** The member model ids (default: the operator's first available model, ensemble-size times). */
  members?: () => string[];
  /** One model call (default: `modelComplete` through `src/model`). Tests inject a fake. */
  complete?: (spec: string) => TextComplete;
  /** The world database: a run whose own review gave a verdict is recorded as an outcome. */
  db?: () => MarinaDB | undefined;
  /** The caller's name (the outcome's owner and scope). */
  nameOf?: (id: EntityId) => string | undefined;
}

function defaultMembers(): string[] {
  const first = availableModels()[0]?.spec;
  return first ? Array.from({ length: ensembleSize() }, () => first) : [];
}

function defaultComplete(spec: string): TextComplete {
  const made = modelComplete(spec, process.env, {
    purpose: "other",
    trace: { caller: "pattern.run" },
  });
  return async (_model, system, user) => {
    const before = made.usage.costUsd;
    const text = await made.complete(system, user);
    return { text, costUsd: made.usage.costUsd - before };
  };
}

/** The reply for a finished run: the answer, then the trace summary. */
export function renderPatternRun(r: PatternRunResult): string {
  const failed = r.trace.steps.filter((s) => s.status === "failed").length;
  return [
    header(`Pattern: ${r.pattern}`),
    separator(),
    r.message || "(no answer)",
    "",
    dim(
      `${r.success ? "completed" : `stopped early: ${r.trace.fallback ?? "no answer"}`} · ${r.trace.steps.length} step(s), ${failed} failed · cost $${r.trace.costUsd.toFixed(4)}`,
    ),
    ...r.trace.steps
      .slice(0, 12)
      .map((s) =>
        dim(
          `  ${s.stage} [${s.member}] ${s.status}${s.costUsd ? ` $${s.costUsd.toFixed(4)}` : ""}`,
        ),
      ),
  ].join("\n");
}

/** Validate a pattern name: the canonical pattern or the reason it cannot run here. */
export function resolveTextPattern(
  raw: string,
): { pattern: (typeof TEXT_PATTERNS)[number] } | { error: string } {
  const name = canonicalFormationName(raw);
  if (isTextPattern(name)) return { pattern: name };
  const crew = CREW_ONLY_PATTERNS[name];
  if (crew) {
    return {
      error: `"${name}" needs a persistent crew (${crew}); run it as a crew (\`crew create <name> <members> formation:${name}\`) and call it as model "marina:<crew>". pattern run takes: ${TEXT_PATTERNS.join(", ")}.`,
    };
  }
  if (formationEntry(name)) {
    return {
      error: `"${name}" is a catalogue formation with no free-text protocol; it runs through \`forecast\`. pattern run takes: ${TEXT_PATTERNS.join(", ")}.`,
    };
  }
  return { error: `Unknown pattern "${raw}". pattern run takes: ${TEXT_PATTERNS.join(", ")}.` };
}

export function patternCommand(deps: PatternCommandDeps = {}): CommandDef {
  /** Each run fans out to several models: a small per-entity budget, one run at a time. */
  const limiter = new RateLimiter({ maxTokens: 3, refillRate: 1, refillInterval: 10 * 60_000 });
  const running = new Set<string>();
  return {
    category: "Coordination",
    usage: [
      { syntax: "pattern list", effect: "read" },
      { syntax: "pattern run <pattern> [budget:<usd>] -- <task>", effect: "execute" },
    ],
    name: "pattern",
    aliases: ["patterns"],
    minRank: 0,
    help: experimentalHelp(
      `Run one free-text task under an orchestration pattern: several of the operator's models draft, argue, review or vote, and a checker picks ONE whole answer (never merged). Costs money: per-run budget (default $${PATTERN_DEFAULT_BUDGET_USD}, at most $${PATTERN_MAX_BUDGET_USD}) and the daily spend cap apply.\n${PATTERN_USAGE}`,
    ),
    handler: (ctx: RoomContext, input) => {
      const eid = input.entity as EntityId;
      const first = input.tokens[0];
      const sub = first?.toLowerCase();
      if (!sub || sub === "help") return ctx.send(eid, PATTERN_USAGE);
      if (sub === "list" || sub === "ls") {
        return ctx.send(
          eid,
          [
            header("Patterns"),
            separator(),
            `${bold("pattern run")}: ${TEXT_PATTERNS.join(", ")}`,
            ...TEXT_PATTERNS.map((p) => dim(`  ${p} — ${formationEntry(p)?.summary ?? ""}`)),
            dim(
              `crew-only (project <name> orchestrate <pattern>): ${Object.keys(CREW_ONLY_PATTERNS).join(", ")}`,
            ),
          ].join("\n"),
        );
      }
      if (sub !== "run") {
        return refuseCommand(ctx, eid, `Unknown pattern subcommand "${first}".\n${PATTERN_USAGE}`);
      }
      const args = input.args.replace(/^\s*run\b/i, "");
      // `-- <task>` keeps the task verbatim; without it, only modifiers right
      // after the pattern name are read and the rest is the task.
      const [head, taskText] = splitOnTerminator(args);
      const words = head.split(/\s+/).filter(Boolean);
      const spec = { budget: { type: "number" as const, aliases: ["budgetUsd"] } };
      const mods =
        taskText === undefined
          ? parseModifiers(words.slice(1), spec, { leading: true })
          : parseModifiers(words, spec);
      const patternName = taskText === undefined ? words[0] : mods.rest[0];
      const task = (taskText ?? mods.rest.join(" ")).trim();
      if (mods.errors.length || !patternName || !task) {
        return ctx.send(
          eid,
          `${mods.errors.length ? `${mods.errors.join("; ")}\n` : ""}${PATTERN_USAGE}`,
        );
      }
      const resolved = resolveTextPattern(patternName);
      if ("error" in resolved) return ctx.send(eid, resolved.error);
      if (task.length > PATTERN_COMMAND_TASK_MAX_CHARS) {
        return ctx.send(eid, `The task is over ${PATTERN_COMMAND_TASK_MAX_CHARS} characters.`);
      }
      const budget = mods.values.budget as number | undefined;
      if (budget !== undefined && (!(budget > 0) || budget > PATTERN_MAX_BUDGET_USD)) {
        return ctx.send(
          eid,
          `budget: takes USD greater than 0 and at most ${PATTERN_MAX_BUDGET_USD}.`,
        );
      }
      const capped = dailyCapRefusal();
      if (capped) return ctx.send(eid, `Not running: ${capped}.`);
      const members = (deps.members ?? defaultMembers)();
      if (members.length === 0) {
        return ctx.send(
          eid,
          `No model is available to run the pattern's members. ${providerSetupHint()} \`readiness providers\` checks it.`,
        );
      }
      if (running.has(eid))
        return ctx.send(eid, "A pattern run of yours is still going; wait for it.");
      if (!limiter.consume(eid)) {
        return ctx.send(eid, "Pattern budget used up for now — try again in a few minutes.");
      }
      running.add(eid);
      ctx.send(eid, dim(`Running ${resolved.pattern} over ${members.length} member(s)…`));
      return (async () => {
        const deadline = AbortSignal.timeout(PATTERN_RUN_TIMEOUT_MS);
        const make = deps.complete ?? defaultComplete;
        const calls = new Map<string, TextComplete>();
        const complete: TextComplete = (model, system, user) => {
          deadline.throwIfAborted();
          let call = calls.get(model);
          if (!call) {
            call = make(model);
            calls.set(model, call);
          }
          return call(model, system, user);
        };
        try {
          const result = await runTextPattern(resolved.pattern, task, members, {
            complete,
            checker: members[0]!,
            budget: new SpendGuard({
              label: "pattern budget",
              budgetUsd: budget ?? PATTERN_DEFAULT_BUDGET_USD,
              concurrency: members.length,
            }),
            signal: deadline,
          });
          ctx.send(eid, renderPatternRun(result));
          const db = deps.db?.();
          if (db) {
            tryLog(logger, "db", "Could not record the pattern run outcome", () =>
              recordPatternRun(db, {
                result,
                runId: `${eid}:${Date.now().toString(36)}`,
                ...(deps.nameOf?.(eid) ? { owner: deps.nameOf(eid) } : {}),
              }),
            );
          }
        } catch (err) {
          ctx.send(eid, `Could not run the pattern: ${getErrorMessage(err)}`);
        } finally {
          running.delete(eid);
        }
      })();
    },
  };
}
