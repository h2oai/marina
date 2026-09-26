// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, category, dim, header, separator, status, stripAnsi } from "../../net/ansi";
import type { EvolutionSessionRow, MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { tryLog } from "../errors";
import { analyzeEvolutionEvidence } from "../evolution-analysis";
import { resolveEvolutionEvidence } from "../evolution-evidence";
import {
  createEvolutionProtocol,
  evolutionBudgetState,
  parseEvolutionProtocol,
} from "../evolution-protocol";
import {
  assessEvolutionQualification,
  type EvolutionQualificationSession,
  evolutionSessionsWithEvidence,
} from "../evolution-qualification";
import { runTrial, type TrialArm, type TrialDeps, type TrialResult } from "../evolution-trial";
import { Logger } from "../logger";
import { type ModifierSpec, parseModifiers } from "../parse-input";
import { getRank } from "../permissions";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";
import { requiresPersistence } from "./command-messages";

/**
 * Evolve — the self-improvement coach. A read-only composer over existing
 * primitives that ties the scattered pieces of the "evolver" loop into one
 * discoverable view: where you stand, what you've banked, and the single next
 * step to get better.
 *
 * Agents reported there was no in-world path explaining how to use the
 * benchmarks / skills / reflect machinery together. This command is that path:
 *   - `evolve`              → your loop status + next step
 *   - `evolve loop|help`    → the integrated narrative + how the two benchmark
 *                             systems differ
 *
 * No agent spawning, no LLM, no mutation. The "next →" line is the only
 * prescription, and it's derived from your own state.
 */

const ARROW = "→";

/** The integrated loop, written for an agent who just asked "how do I improve?" */
const LOOP_TEXT = [
  header("The evolution loop"),
  separator(),
  "You get better by measuring, changing one thing, and measuring again —",
  "then keeping only what helped. The five moves:",
  "",
  `  1. ${bold("Baseline")}   — measure where you are. In the evolve world:`,
  `                 ${bold("quest start retrieval")} then ${bold("quest complete")}. Anywhere: ${bold("debrief")}.`,
  `  2. ${bold("Change")}     — alter one approach: write a sharper ${bold("note")}, build a`,
  "                 mind-room, refine how you `recall`/`pool … recall`.",
  `  3. ${bold("Re-measure")} — run the same benchmark again and compare scores.`,
  `  4. ${bold("Bank it")}    — if it helped, capture the procedure as a reusable`,
  `                 skill: ${bold("skill store <name> | <what> | <steps>")}. If not, revert.`,
  `  5. ${bold("Reflect")}    — every few cycles, ${bold("reflect")} to consolidate what you`,
  "                 learned into durable memory for you and your successors.",
  "",
  category("Two benchmark systems — don't confuse them"),
  `  ${bold("evolve world quests")} — in-world capability gyms (navigation, retrieval,`,
  "      memory, self-modification, …). Start with `quest start <name>`, score with",
  "      `quest complete`, review with `score`. Rank 0. This is where you practice.",
  `  ${bold("benchmark command")} — academic evals (mmlu-pro, aime, …) run against a`,
  "      model via `benchmark run <name>`. Rank 4 (burns real tokens). Results land",
  "      in the `benchmark:<name>` pool — `pool benchmark:<name> recall <topic>` to",
  "      learn from past mistakes.",
  "",
  dim("See also: `pool guide recall evolve`, `skill list`, `next`."),
].join("\n");

/** Evolve-world score property keys → human labels (mirrors worlds/evolve.ts). */
const BENCH_SCORE_KEYS: [string, string][] = [
  ["bench_navigation_best", "Navigation"],
  ["bench_retrieval_best", "Retrieval"],
  ["bench_codegen_best", "Code-Gen"],
  ["bench_memory_best", "Memory"],
  ["bench_adaptation_best", "Adaptation"],
  ["bench_selfmod_best", "Self-Modification"],
  ["bench_coordination_best", "Coordination"],
  ["bench_collaboration_best", "Collaboration"],
];

export function evolveCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  /** Runtime parts for `evolve trial` (agents, channels, benchmarks); absent ⇒ trials unavailable. */
  trialDeps?: (opts: TrialOptions) => TrialDeps | undefined;
  notifyEvolutionState?: (
    entityNames: string[],
    state: { sessionId: number; experimentName: string; active: boolean },
  ) => void;
}): CommandDef {
  return {
    name: "evolve",
    aliases: ["coach"],
    help: "Your self-improvement loop: where you stand + the next step. `evolve` for status, `evolve loop` for the how-to.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const arg = (input.tokens[0] ?? "").toLowerCase();
      if (arg === "loop" || arg === "help" || arg === "how") {
        ctx.send(input.entity, LOOP_TEXT);
        return;
      }

      if (
        [
          "sessions",
          "qualify",
          "trial",
          "create",
          "start",
          "status",
          "analyze",
          "propose",
          "evaluate",
          "decide",
          "pause",
          "resume",
          "complete",
        ].includes(arg)
      ) {
        handleEvolutionProtocol(ctx, input, entity, deps, arg);
        return;
      }

      const db = deps.db;
      if (!db) {
        ctx.send(input.entity, LOOP_TEXT);
        return;
      }

      const lines: string[] = [header(`Evolution loop: ${entity.name}`), separator()];

      // ── Goal ──────────────────────────────────────────────────────────────
      const goal = db.getCoreMemory(entity.name, "goal")?.value;
      lines.push(category("Goal"));
      lines.push(
        goal ? `  ${goal}` : dim("  None set — `memory set goal <what you want to accomplish>`"),
      );

      // ── Evolve-world scores (only show if any have been attempted) ─────────
      const scores = BENCH_SCORE_KEYS.map(
        ([key, label]) => [label, (entity.properties[key] as number) ?? 0] as const,
      );
      const attempted = scores.filter(([, v]) => v > 0);
      if (attempted.length > 0) {
        lines.push(category(`Benchmark scores (${attempted.length}/${scores.length})`));
        for (const [label, v] of scores) {
          lines.push(`  ${label.padEnd(18)} ${v > 0 ? bold(String(v)) : dim("-")}`);
        }
      }

      // ── Platform benchmark runs you've launched ───────────────────────────
      const runs = db.queryBenchmarkRuns({ agentId: input.entity, limit: 3 });
      if (runs.length > 0) {
        lines.push(category("Recent benchmark runs"));
        for (const r of runs) {
          const score = r.score != null ? `${(r.score * 100).toFixed(1)}%` : r.status;
          lines.push(`  ${r.benchmark.padEnd(14)} ${score}  ${dim(r.id)}`);
        }
      }

      // ── Skills banked ─────────────────────────────────────────────────────
      const skillCount = db
        .getNotesByEntity(entity.name, 200)
        .filter((n) => n.note_type === "skill").length;
      lines.push(category("Skills banked"));
      lines.push(
        skillCount > 0
          ? `  ${bold(String(skillCount))} — review with \`skill list\``
          : dim(
              "  None yet — `skill store <name> | <what it does> | <steps>` once something works",
            ),
      );

      // ── Next step — derived from your own state ───────────────────────────
      lines.push("");
      lines.push(
        `${category("Next")}  ${nextStep(db, entity, goal, attempted.length, skillCount)}`,
      );

      lines.push(dim("`evolve loop` explains the full cycle."));
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}

function evolutionProtocolsEnabled(): boolean {
  return /^(1|true|on)$/i.test(process.env.MARINA_EVOLUTION_PROTOCOLS ?? "");
}

function handleEvolutionProtocol(
  ctx: RoomContext,
  input: Parameters<CommandDef["handler"]>[1],
  entity: Entity,
  deps: {
    db?: MarinaDB;
    notifyEvolutionState?: (
      entityNames: string[],
      state: { sessionId: number; experimentName: string; active: boolean },
    ) => void;
    trialDeps?: (opts: TrialOptions) => TrialDeps | undefined;
  },
  sub: string,
): void {
  const db = deps.db;
  if (!evolutionProtocolsEnabled()) {
    ctx.send(
      input.entity,
      "Native evolution protocols are disabled. Set MARINA_EVOLUTION_PROTOCOLS=true to opt in; the existing evolution coach remains available with `evolve`.",
    );
    return;
  }
  if (!db) {
    ctx.send(input.entity, requiresPersistence("evolution protocols"));
    return;
  }

  if (sub === "qualify") {
    // The same verdict `bun run qualify:evolution` polls for, read-only: it
    // never continues, decides or promotes a session.
    const report = assessEvolutionQualification(
      evolutionSessionsWithEvidence(db) as EvolutionQualificationSession[],
    );
    const words = (key: string) => key.replace(/([A-Z])/g, " $1").toLowerCase();
    const passing = Object.entries(report.checks)
      .filter(([, ok]) => ok)
      .map(([key]) => words(key));
    ctx.send(
      input.entity,
      [
        header(`Evolution qualification: ${report.qualified ? "QUALIFIED" : "not yet"}`),
        separator(),
        `  ${report.sessions} session(s) · ${report.runs} run(s) · ${report.decidedRuns} decided`,
        ...report.failures.map((f) => `  ✗ ${f}`),
        ...(passing.length ? [dim(`  ✓ ${passing.join(" · ")}`)] : []),
        dim("The release gate reads the same evidence from outside: bun run qualify:evolution"),
      ].join("\n"),
    );
    return;
  }

  if (sub === "sessions") {
    const sessions = db.listEvolutionSessions();
    if (sessions.length === 0) {
      ctx.send(input.entity, "No evolution sessions exist.");
      return;
    }
    ctx.send(
      input.entity,
      [
        header("Evolution sessions"),
        separator(),
        ...sessions.map((session) => {
          const experiment = db.getExperiment(session.experiment_id);
          return `  ${bold(experiment?.name ?? `experiment:${session.experiment_id}`)} ${status(session.status, session.status === "active" ? "active" : "info")} — ${session.objective}`;
        }),
      ].join("\n"),
    );
    return;
  }

  const experimentName = input.tokens[1];
  if (!experimentName) {
    ctx.send(input.entity, protocolUsage(sub));
    return;
  }
  const experiment = db.getExperimentByName(experimentName);
  if (!experiment) {
    ctx.send(input.entity, `Experiment "${experimentName}" not found.`);
    return;
  }
  const session = db.getEvolutionSessionByExperiment(experiment.id);

  if (sub === "create") {
    if (session) {
      ctx.send(input.entity, `Experiment "${experimentName}" already has an evolution session.`);
      return;
    }
    if (experiment.creator_name !== entity.name) {
      ctx.send(input.entity, "Only the experiment creator can attach its evolution protocol.");
      return;
    }
    const [objective, ...options] = pipeParts(input.args.replace(/^create\s+\S+\s*/i, ""));
    if (!objective) {
      ctx.send(input.entity, protocolUsage(sub));
      return;
    }
    const experimentConfig = parseExperimentEvidenceConfig(experiment.config);
    let protocol: ReturnType<typeof createEvolutionProtocol>;
    try {
      protocol = createEvolutionProtocol({
        primaryMetric: experimentConfig.metric,
        direction: experimentConfig.direction,
        options,
      });
    } catch (error) {
      ctx.send(input.entity, error instanceof Error ? error.message : String(error));
      return;
    }
    db.createEvolutionSession({
      experimentId: experiment.id,
      objective,
      createdBy: entity.name,
      protocol,
    });
    ctx.send(
      input.entity,
      `Evolution protocol drafted for "${experimentName}". It records evidence only; it cannot continue or promote itself. Start explicitly with evolve start ${experimentName}.`,
    );
    return;
  }

  if (!session) {
    ctx.send(input.entity, `Experiment "${experimentName}" has no evolution protocol.`);
    return;
  }

  if (sub === "status") {
    renderProtocolStatus(ctx, input.entity, db, session, experiment.name);
    return;
  }

  if (sub === "analyze") {
    const config = parseExperimentEvidenceConfig(experiment.config);
    if (!config.metric || config.arms.length < 2) {
      ctx.send(
        input.entity,
        "Robust analysis requires an armed experiment with a configured primary metric.",
      );
      return;
    }
    const summary = analyzeEvolutionEvidence({
      samples: db.getResults(experiment.id),
      arms: config.arms,
      metric: config.metric,
      direction: config.direction,
    });
    const lines = [
      header(`Evolution evidence: ${experiment.name}`),
      separator(),
      dim(`${summary.metric} · ${summary.direction} is better · advisory evidence only`),
      ...summary.arms.map(
        (arm) =>
          `  ${bold(arm.arm)} median=${arm.median.toFixed(3)} MAD=${arm.mad.toFixed(3)} mean=${arm.mean.toFixed(3)} ${dim(`n=${arm.n}`)}`,
      ),
    ];
    if (summary.leader) lines.push(`  Observed leader: ${bold(summary.leader)}`);
    if (summary.effect !== undefined)
      lines.push(`  Effect vs baseline: ${summary.effect.toFixed(3)}`);
    if (summary.confidence !== undefined) {
      lines.push(`  Effect/noise ratio: ${summary.confidence.toFixed(2)}×`);
    }
    if (summary.limitations.length > 0) {
      lines.push(`  Limitations: ${summary.limitations.join("; ")}`);
    }
    const protocol = parseEvolutionProtocol(session.protocol);
    for (const guardrail of protocol.guardrails) {
      const guardrailSummary = analyzeEvolutionEvidence({
        samples: db.getResults(experiment.id),
        arms: config.arms,
        metric: guardrail.metric,
        direction: guardrail.direction,
      });
      const observed = guardrailSummary.leader
        ? `${guardrailSummary.leader}${guardrailSummary.effect !== undefined ? ` effect=${guardrailSummary.effect.toFixed(3)}` : ""}`
        : "insufficient samples";
      lines.push(`  Guardrail ${guardrail.metric} (${guardrail.direction}): ${observed}`);
    }
    lines.push(dim("This report cannot accept, activate, or promote a candidate."));
    ctx.send(input.entity, lines.join("\n"));
    return;
  }

  const isCreator = session.created_by === entity.name;
  const isParticipant = db.isParticipant(experiment.id, entity.name);
  if (!isParticipant) {
    ctx.send(
      input.entity,
      "Join the underlying experiment before participating in its evolution protocol.",
    );
    return;
  }

  if (["start", "pause", "resume", "complete"].includes(sub)) {
    if (!isCreator) {
      ctx.send(input.entity, "Only the protocol creator can change the shared session state.");
      return;
    }
    const allowed: Record<string, { from: string[]; to: "active" | "paused" | "completed" }> = {
      start: { from: ["draft"], to: "active" },
      pause: { from: ["active"], to: "paused" },
      resume: { from: ["paused"], to: "active" },
      complete: { from: ["active", "paused"], to: "completed" },
    };
    const transition = allowed[sub]!;
    if (!transition.from.includes(session.status)) {
      ctx.send(input.entity, `Cannot ${sub} an evolution session that is ${session.status}.`);
      return;
    }
    db.updateEvolutionSessionStatus(session.id, transition.to);
    deps.notifyEvolutionState?.(
      db.getParticipants(experiment.id).map((participant) => participant.entity_name),
      {
        sessionId: session.id,
        experimentName: experiment.name,
        active: transition.to === "active",
      },
    );
    ctx.send(
      input.entity,
      `Evolution session for "${experimentName}" is now ${transition.to}. No participant was prompted or candidate activated.`,
    );
    return;
  }

  if (session.status !== "active") {
    ctx.send(
      input.entity,
      `Evolution session is ${session.status}; proposals and reviews require active status.`,
    );
    return;
  }

  if (sub === "propose") {
    const runs = db.listEvolutionRuns(session.id);
    const budget = evolutionBudgetState(session, runs.length);
    if (budget.exhausted) {
      ctx.send(
        input.entity,
        `Proposal refused: ${budget.reasons.join("; ")}. The creator may explicitly complete the session; Marina will not continue it automatically.`,
      );
      return;
    }
    const [hypothesis, candidateRef, parentOption] = pipeParts(
      input.args.replace(/^propose\s+\S+\s*/i, ""),
    );
    if (!hypothesis || !candidateRef) {
      ctx.send(input.entity, protocolUsage(sub));
      return;
    }
    let parentRunId: number | undefined;
    if (parentOption) {
      const match = /^parent=(\d+)$/i.exec(parentOption);
      if (!match) {
        ctx.send(input.entity, "Optional lineage must use parent=<run-id>.");
        return;
      }
      parentRunId = Number(match[1]);
      const parent = db.getEvolutionRun(parentRunId);
      if (!parent || parent.session_id !== session.id) {
        ctx.send(input.entity, `Parent run ${parentRunId} is not part of this evolution session.`);
        return;
      }
    }
    const id = db.createEvolutionRun({
      sessionId: session.id,
      hypothesis,
      candidateRef,
      proposedBy: entity.name,
      parentRunId,
    });
    ctx.send(input.entity, `Proposal recorded as run ${id}. No work was executed or activated.`);
    return;
  }

  const runId = Number.parseInt(input.tokens[2] ?? "", 10);
  const run = Number.isFinite(runId) ? db.getEvolutionRun(runId) : undefined;
  if (!run || run.session_id !== session.id) {
    ctx.send(
      input.entity,
      `Evolution run ${input.tokens[2] ?? "(missing)"} not found in this session.`,
    );
    return;
  }

  if (sub === "trial") {
    handleTrial(ctx, input, entity, deps, db, run);
    return;
  }

  if (sub === "evaluate") {
    if (run.status !== "proposed") {
      ctx.send(input.entity, `Run ${run.id} is already ${run.status}.`);
      return;
    }
    const protocol = parseEvolutionProtocol(session.protocol);
    if (protocol.independentReview && run.proposed_by === entity.name) {
      ctx.send(
        input.entity,
        "This protocol requires evidence from someone other than the proposer.",
      );
      return;
    }
    const evidence = pipeParts(input.args.replace(/^evaluate\s+\S+\s+\S+\s*/i, ""))[0];
    if (!evidence) {
      ctx.send(input.entity, protocolUsage(sub));
      return;
    }
    // Cited benchmark runs must resolve; their verified scores are kept with it.
    const refs = resolveEvolutionEvidence(db, evidence);
    if (refs.missing.length > 0) {
      ctx.send(
        input.entity,
        `Not recorded — cited evidence does not resolve: ${refs.missing.join("; ")}. Cite a completed run (\`benchmark runs\`).`,
      );
      return;
    }
    const stored = refs.verified.length
      ? `${evidence}\n[verified] ${refs.verified.join("\n[verified] ")}`
      : evidence;
    db.evaluateEvolutionRun(run.id, entity.name, stored);
    ctx.send(
      input.entity,
      [
        `Evidence recorded for run ${run.id}; it remains advisory and inactive.`,
        ...refs.verified.map((v) => `  verified ${v}`),
      ].join("\n"),
    );
    return;
  }

  if (sub === "decide") {
    if (run.status !== "evaluated") {
      ctx.send(input.entity, `Run ${run.id} must be evaluated before a decision is recorded.`);
      return;
    }
    const protocol = parseEvolutionProtocol(session.protocol);
    if (
      protocol.independentReview &&
      (run.proposed_by === entity.name || run.evaluator_name === entity.name)
    ) {
      ctx.send(
        input.entity,
        "This protocol requires the decision recorder to differ from both proposer and evaluator.",
      );
      return;
    }
    const decision = input.tokens[3]?.toLowerCase();
    if (decision !== "accept" && decision !== "reject" && decision !== "inconclusive") {
      ctx.send(input.entity, protocolUsage(sub));
      return;
    }
    db.decideEvolutionRun(run.id, entity.name, decision);
    ctx.send(
      input.entity,
      `Decision "${decision}" recorded for run ${run.id}. Recording acceptance does not activate or promote the candidate.`,
    );
  }
}

function renderProtocolStatus(
  ctx: RoomContext,
  entityId: string,
  db: MarinaDB,
  session: EvolutionSessionRow,
  experimentName: string,
): void {
  const runs = db.listEvolutionRuns(session.id);
  const protocol = parseEvolutionProtocol(session.protocol);
  const budget = evolutionBudgetState(session, runs.length);
  const lines = [
    header(`Evolution protocol: ${experimentName}`),
    separator(),
    `  Status: ${status(session.status, session.status === "active" ? "active" : "info")}`,
    `  Objective: ${session.objective}`,
    `  Creator: ${dim(session.created_by)}`,
    `  Runs: ${bold(String(runs.length))}`,
    `  Automatic continuation: ${protocol.automaticContinuation ? "enabled" : "off"}`,
    `  Automatic promotion: ${protocol.automaticPromotion ? "enabled" : "off"}`,
    `  Independent review: ${protocol.independentReview ? "required" : "optional"}`,
  ];
  if (budget.runsRemaining !== undefined) lines.push(`  Runs remaining: ${budget.runsRemaining}`);
  if (budget.secondsRemaining !== undefined) {
    lines.push(`  Time remaining: ${budget.secondsRemaining}s`);
  }
  if (budget.exhausted) {
    lines.push(`  Budget: ${status("exhausted", "warn")} ${budget.reasons.join("; ")}`);
  }
  if (protocol.guardrails.length > 0) {
    lines.push(
      `  Guardrails: ${protocol.guardrails.map((item) => `${item.metric}:${item.direction}`).join(", ")}`,
    );
  }
  for (const run of runs.slice(-5)) {
    lines.push(
      `  #${run.id} ${status(run.status, run.status === "accepted" ? "done" : "info")} ${run.hypothesis} ${dim(`→ ${run.candidate_ref}`)}`,
    );
  }
  ctx.send(entityId as Parameters<RoomContext["send"]>[0], lines.join("\n"));
}

function pipeParts(raw: string): string[] {
  return raw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function protocolUsage(sub: string): string {
  const usages: Record<string, string> = {
    create:
      "Usage: evolve create <experiment> | <objective> [| max-runs=N | max-seconds=N | min-trials=N | min-effect=N | independent-review=true | guardrail=<metric>:<higher|lower>]",
    propose:
      "Usage: evolve propose <experiment> | <hypothesis> | <candidate-reference> [| parent=<run-id>]",
    evaluate: "Usage: evolve evaluate <experiment> <run-id> | <evidence>",
    decide: "Usage: evolve decide <experiment> <run-id> <accept|reject|inconclusive>",
    trial:
      "Usage: evolve trial <experiment> <run-id> [incumbent:<role>] [benchmark:smoke] [limit:N] [seed:N] [model:<m>] [timeout:30m] | evolve trial <experiment> <run-id> result",
  };
  return usages[sub] ?? `Usage: evolve ${sub} <experiment>`;
}

function parseExperimentEvidenceConfig(configJson: string): {
  arms: string[];
  metric?: string;
  direction: "higher" | "lower";
} {
  try {
    const config = JSON.parse(configJson || "{}") as Record<string, unknown>;
    return {
      arms: Array.isArray(config.arms)
        ? config.arms.filter((arm): arm is string => typeof arm === "string")
        : [],
      metric: typeof config.metric === "string" ? config.metric : undefined,
      direction: config.goal === "lower" ? "lower" : "higher",
    };
  } catch {
    return { arms: [], direction: "higher" };
  }
}

/** Single, concrete next move based on where the agent is in the loop. */
function nextStep(
  db: MarinaDB,
  entity: Entity,
  goal: string | undefined,
  benchmarksAttempted: number,
  skillCount: number,
): string {
  const arrow = dim(ARROW);
  if (!goal) {
    return `${status("no goal", "warn")} ${arrow} ${bold("memory set goal <your purpose>")}`;
  }
  if (benchmarksAttempted === 0) {
    return `set a baseline ${arrow} ${bold("quest start retrieval")} (in the evolve world), or ${bold("debrief")} to see where you stand`;
  }
  // Enough fresh notes to justify a reflection?
  const recentNotes = db.getNotesByEntity(entity.name, 5);
  if (recentNotes.length >= 3 && skillCount === 0) {
    return `you've learned things but banked no skills ${arrow} ${bold("skill store <name> | <what> | <steps>")}`;
  }
  if (recentNotes.length >= 3) {
    return `consolidate what you learned ${arrow} ${bold("reflect")}`;
  }
  return `change one approach, then re-measure ${arrow} re-run a benchmark and compare, or ${bold("evolve loop")} for the full cycle`;
}

// ─── evolve trial ────────────────────────────────────────────────────────────

export interface TrialOptions {
  benchmark: string;
  limit?: number;
  seed?: number;
  agentModel: string;
  callerId: string;
}

const TRIAL_MODS: ModifierSpec = {
  incumbent: { type: "string" },
  benchmark: { type: "string" },
  limit: { type: "int" },
  seed: { type: "int" },
  model: { type: "string" },
  timeout: { type: "duration" },
};
let trialRunning = false;
const TRIAL_NOTE_TYPE = "evolve_trial";

/** Test hook: trials are single-flight per world. */
export function resetEvolveTrialForTests(): void {
  trialRunning = false;
}

/**
 * Measure a proposed candidate role against the incumbent in THIS world —
 * which must be a child or parallel world — without adopting anything
 * (src/engine/evolution-trial.ts). Replies at once and posts the result when
 * both arms finish: a trial takes minutes, and awaiting it would stall the
 * caller's command queue.
 */
function handleTrial(
  ctx: RoomContext,
  input: { entity: string; tokens: string[] },
  entity: Entity,
  deps: { trialDeps?: (opts: TrialOptions) => TrialDeps | undefined },
  db: MarinaDB,
  run: { id: number; status: string; candidate_ref: string | null },
): void {
  const say = (text: string) => ctx.send(input.entity as never, text);
  // `… result`: the latest stored outcome. A trial started over `world run`
  // outlives the bridge's short connection, so results are kept, not only sent.
  if (input.tokens[3]?.toLowerCase() === "result") {
    const tag = `[evolve_trial run=${run.id}]`;
    const note = db
      .getNotesByType(entity.name, TRIAL_NOTE_TYPE, 50)
      .find((n) => n.content.startsWith(tag));
    say(
      note
        ? note.content.slice(tag.length).trim()
        : `No finished trial recorded for run ${run.id} yet.`,
    );
    return;
  }
  if (process.env.MARINA_COLLECTIVE_CHILD !== "1" && process.env.MARINA_EVOLVE_TRIALS !== "here") {
    say(
      "Trials run in a child or parallel world, never this one. From here: `world run <child> evolve trial …` (seed the roles first with `world seed-role`). A dedicated parallel world can opt in with MARINA_EVOLVE_TRIALS=here.",
    );
    return;
  }
  if (getRank(entity) < 4) {
    say(
      "evolve trial needs rank 4 (builder): it spawns agents and runs benchmarks, which cost real tokens.",
    );
    return;
  }
  if (run.status !== "proposed") {
    say(`Run ${run.id} is ${run.status}; trials measure a proposal before it is evaluated.`);
    return;
  }
  const candidate = /^role:([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(run.candidate_ref ?? "")?.[1];
  if (!candidate) {
    say(`Run ${run.id}'s candidate is "${run.candidate_ref ?? ""}"; a trial needs role:<name>.`);
    return;
  }
  const mods = parseModifiers(input.tokens.slice(3), TRIAL_MODS);
  const incumbent = mods.values.incumbent as string | undefined;
  for (const role of [candidate, incumbent].filter((r): r is string => !!r)) {
    if (!db.getRole(role)) {
      say(
        `Role "${role}" does not exist in this world — seed it first (\`world seed-role\` from the parent).`,
      );
      return;
    }
  }
  const benchmark = (mods.values.benchmark as string | undefined) ?? "smoke";
  const opts: TrialOptions = {
    benchmark,
    ...(mods.values.limit ? { limit: mods.values.limit as number } : {}),
    ...(mods.values.seed !== undefined ? { seed: mods.values.seed as number } : {}),
    agentModel: (mods.values.model as string | undefined) ?? "marina/default",
    callerId: entity.id,
  };
  const trialDeps = deps.trialDeps?.(opts);
  if (!trialDeps) {
    say("Trials need the agent runtime and the benchmark runner, which this world does not have.");
    return;
  }
  const gate = checkGateForExecution(db, entity.id, "agent.spawn");
  if (!gate.ok) {
    say(gate.reason ?? "agent.spawn refused");
    return;
  }
  if (trialRunning) {
    say("A trial is already running in this world — one at a time.");
    return;
  }
  trialRunning = true;
  recordGateExecution(db, entity.id, "agent.spawn", gate, `evolve trial run ${run.id}`);
  const arms: TrialArm[] = [
    { label: "candidate", role: candidate },
    ...(incumbent ? [{ label: "incumbent" as const, role: incumbent }] : []),
  ];
  const timeoutMs = (mods.values.timeout as number | undefined) ?? 30 * 60_000;
  say(
    `Trial started for run ${run.id}: ${candidate}${incumbent ? ` vs ${incumbent}` : " (no incumbent: one arm)"} on ${benchmark}${opts.limit ? ` (${opts.limit} items)` : ""}, deadline ${Math.round(timeoutMs / 60_000)} min. Nothing is adopted; results follow here.`,
  );
  void runTrial(trialDeps, { runId: run.id, arms, timeoutMs })
    .then((result) => {
      const text = renderTrial(run.id, result);
      tryLog(new Logger(), "evolve", "Trial result not stored", () => {
        db.createNote(entity.name, `[evolve_trial run=${run.id}] ${stripAnsi(text)}`, undefined, {
          noteType: TRIAL_NOTE_TYPE,
          tier: "process",
          skipDedup: true,
        });
      });
      say(text);
    })
    .catch((err) =>
      say(`Trial for run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`),
    )
    .finally(() => {
      trialRunning = false;
    });
}

export function renderTrial(runId: number, result: TrialResult): string {
  const pct = (x?: number) => (x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
  const lines = [
    header(`Trial for run ${runId}`),
    separator(),
    ...result.arms.map(
      (a) =>
        `  ${bold(a.label.padEnd(9))} ${a.role.padEnd(18)} ${a.status.padEnd(9)} ${pct(a.score)}${a.total ? dim(` (${a.answered}/${a.total})`) : ""}${a.runId ? dim(` benchmark:${a.runId}`) : ""}${a.error ? dim(` — ${a.error}`) : ""}`,
    ),
  ];
  if (result.delta !== undefined) {
    lines.push(
      `  candidate − incumbent: ${result.delta >= 0 ? "+" : ""}${(result.delta * 100).toFixed(1)} points`,
    );
  }
  const cited = result.arms
    .filter((a) => a.status === "completed" && a.runId)
    .map((a) => `benchmark:${a.runId}`);
  if (cited.length) {
    lines.push(
      dim(
        `Someone other than the proposer can now record it: evolve evaluate <experiment> ${runId} | <what you saw> ${cited.join(" ")}`,
      ),
    );
  }
  return lines.join("\n");
}
