// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parsePartition } from "../../../benchmarks/partition";
import { encodeRoleBundle, exportRoleBundle } from "../../agent/role-bundle";
import { getStanding } from "../../agent/standing";
import { bold, category, dim, header, separator, status, stripAnsi } from "../../net/ansi";
import type { EvolutionSessionRow, MarinaDB } from "../../persistence/database";
import { isGrantedCompetence } from "../../persistence/db-competence";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { MAX_REPLICAS_PER_RUN } from "../constants";
import { sanitizeEntityName } from "../entity-name";
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
import {
  armBreakdown,
  runTrial,
  type TrialArm,
  type TrialDeps,
  type TrialResult,
} from "../evolution-trial";
import { promotionMargin } from "../fishing-margin";
import { Logger } from "../logger";
import { type ModifierSpec, parseModifiers } from "../parse-input";
import { rankFloorRefusal } from "../rank-floor";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";
import { dailyCapRefusal } from "../spend-ledger";
import { spawnBudget } from "./agent";
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
  /** Runtime parts for `evolve replicate` (spawning copies, live counts). */
  replicateDeps?: () => ReplicateDeps | undefined;
  /** Whether a benchmark's dataset is available (picks the default trial benchmark). */
  benchmarkReady?: (name: string) => boolean;
  notifyEvolutionState?: (
    entityNames: string[],
    state: { sessionId: number; experimentName: string; active: boolean },
  ) => void;
}): CommandDef {
  return {
    category: "Growth",
    usage: ["evolve", "evolve loop"],
    name: "evolve",
    aliases: ["coach"],
    help: "Your self-improvement loop: where you stand + the next step. `evolve` for status, `evolve loop` for the how-to.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const arg = (input.tokens[0] ?? "").toLowerCase();
      if (arg === "adoption") {
        if (!deps.db) {
          ctx.send(input.entity, requiresPersistence("evolution protocols"));
          return;
        }
        ctx.send(input.entity, renderAdoption(deps.db, input.tokens[1] ?? ""));
        return;
      }
      if (arg === "loop" || arg === "help" || arg === "how") {
        ctx.send(input.entity, LOOP_TEXT);
        return;
      }

      if (
        [
          "sessions",
          "qualify",
          "trial",
          "replicate",
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
        // Returned so a bounded async step (replicate) completes before the
        // command does — its reply must reach a short-lived bridge connection.
        return handleEvolutionProtocol(ctx, input, entity, deps, arg);
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
    replicateDeps?: () => ReplicateDeps | undefined;
    benchmarkReady?: (name: string) => boolean;
  },
  sub: string,
): void | Promise<void> {
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

  if (sub === "replicate") {
    return handleReplicate(ctx, input, entity, deps, db, session.id, run);
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
    replicate:
      "Usage: evolve replicate <experiment> <run-id> [n:1] [budget:200] [model:<m>] — spawn copies of an accepted candidate that won its trial",
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
  partition?: "holdout" | "tune";
  limit?: number;
  seed?: number;
  agentModel: string;
  callerId: string;
}

/** Where trials judge by default (its fixed holdout split, 100 items). */
export const DEFAULT_TRIAL_BENCHMARK = "arc-challenge";

const TRIAL_MODS: ModifierSpec = {
  incumbent: { type: "string" },
  benchmark: { type: "string" },
  partition: { type: "string" },
  limit: { type: "int" },
  seed: { type: "int" },
  model: { type: "string" },
  timeout: { type: "duration" },
};
let trialRunning = false;
const TRIAL_NOTE_TYPE = "evolve_trial";
/** World-level owner of trial and replication records. */
export const TRIAL_OWNER = "evolve-trials";
const REPLICA_NOTE_TYPE = "evolve_replica";

interface StoredTrial {
  run: number;
  by: string;
  result: TrialResult;
  at: number;
}

const trialTag = (runId: number) => `[evolve_trial run=${runId}]`;

/** The latest stored trial for a run: its record and its rendered text. */
function storedTrial(
  db: MarinaDB,
  runId: number,
): { record: StoredTrial; text: string } | undefined {
  const tag = trialTag(runId);
  const note = db
    .getNotesByType(TRIAL_OWNER, TRIAL_NOTE_TYPE, 500)
    .find((n) => n.content.startsWith(`${tag} `));
  if (!note) return undefined;
  const body = note.content.slice(tag.length + 1);
  const nl = body.indexOf("\n");
  try {
    return {
      record: JSON.parse(nl >= 0 ? body.slice(0, nl) : body) as StoredTrial,
      text: nl >= 0 ? body.slice(nl + 1) : "",
    };
  } catch {
    return undefined;
  }
}

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
  deps: {
    trialDeps?: (opts: TrialOptions) => TrialDeps | undefined;
    benchmarkReady?: (name: string) => boolean;
  },
  db: MarinaDB,
  run: { id: number; status: string; candidate_ref: string | null },
): void {
  const say = (text: string) => ctx.send(input.entity as never, text);
  // `… result`: the latest stored outcome. A trial started over `world run`
  // outlives the bridge's short connection, so results are kept, not only sent.
  if (input.tokens[3]?.toLowerCase() === "result") {
    const stored = storedTrial(db, run.id);
    say(stored ? stored.text : `No finished trial recorded for run ${run.id} yet.`);
    return;
  }
  if (process.env.MARINA_COLLECTIVE_CHILD !== "1" && process.env.MARINA_EVOLVE_TRIALS !== "here") {
    say(
      "Trials run in a child or parallel world, never this one. From here: `world run <child> evolve trial …` (seed the roles first with `world seed-role`). A dedicated parallel world can opt in with MARINA_EVOLVE_TRIALS=here.",
    );
    return;
  }
  const trialFloor = rankFloorRefusal(
    entity,
    4,
    "evolve trial needs rank 4 (builder): it spawns agents and runs benchmarks, which cost real tokens.",
  );
  if (trialFloor) {
    say(trialFloor);
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
  // Judge on a held-out sample large enough to mean something: 100 items from
  // the fixed holdout split of ARC-Challenge when it is cached, else smoke.
  const benchmark =
    (mods.values.benchmark as string | undefined) ??
    (deps.benchmarkReady?.(DEFAULT_TRIAL_BENCHMARK) ? DEFAULT_TRIAL_BENCHMARK : "smoke");
  const partition =
    benchmark === "smoke" ? undefined : (parsePartition(mods.values.partition) ?? "holdout");
  const limit =
    (mods.values.limit as number | undefined) ?? (benchmark === "smoke" ? undefined : 100);
  const opts: TrialOptions = {
    benchmark,
    ...(partition ? { partition } : {}),
    ...(limit ? { limit } : {}),
    ...(mods.values.seed !== undefined ? { seed: mods.values.seed as number } : {}),
    agentModel: (mods.values.model as string | undefined) ?? "marina/default",
    callerId: entity.id,
  };
  const smokeWarning =
    benchmark === "smoke"
      ? " Note: smoke has 15 items — too few to separate a small gain from noise; cache arc-challenge for held-out trials."
      : "";
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
    `Trial started for run ${run.id}: ${candidate}${incumbent ? ` vs ${incumbent}` : " (no incumbent: one arm)"} on ${benchmark}${opts.limit && benchmark !== "smoke" ? ` (${opts.limit} items${partition ? `, ${partition} split` : ""})` : ""}, deadline ${Math.round(timeoutMs / 60_000)} min. Nothing is adopted; results follow here.${smokeWarning}`,
  );
  void runTrial(trialDeps, { runId: run.id, arms, timeoutMs })
    .then((result) => {
      const text = renderTrial(run.id, result);
      tryLog(new Logger(), "evolve", "Trial result not stored", () => {
        // Structured (for `evolve replicate`) + rendered (for `… result`), under
        // one world-level owner: whoever replicates need not be who ran the trial.
        const record: StoredTrial = { run: run.id, by: entity.name, result, at: Date.now() };
        db.createNote(
          TRIAL_OWNER,
          `${trialTag(run.id)} ${JSON.stringify(record)}\n${stripAnsi(text)}`,
          undefined,
          { noteType: TRIAL_NOTE_TYPE, tier: "process", skipDedup: true },
        );
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

/** "(97/100 answered · 96.9% of answered)" — the two things a score mixes. */
function splitNote(a: { score?: number; answered?: number; total?: number }): string {
  const b = armBreakdown(a);
  if (!b) return "";
  return dim(
    ` (${b.answered}/${b.total} answered · ${(b.answeredAccuracy * 100).toFixed(1)}% of answered)`,
  );
}

/** Where a difference came from: better answers, or answering more often. */
export function splitLine(
  c: NonNullable<ReturnType<typeof armBreakdown>>,
  i: NonNullable<ReturnType<typeof armBreakdown>>,
): string {
  const q = (c.answeredAccuracy - i.answeredAccuracy) * 100;
  const r = c.answered - i.answered;
  return `split: quality on answered items ${q >= 0 ? "+" : ""}${q.toFixed(1)} points (${(c.answeredAccuracy * 100).toFixed(1)}% vs ${(i.answeredAccuracy * 100).toFixed(1)}%) · answered ${r >= 0 ? "+" : ""}${r} (${c.answered} vs ${i.answered} of ${c.total})`;
}

export function renderTrial(runId: number, result: TrialResult): string {
  const pct = (x?: number) => (x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
  const lines = [
    header(`Trial for run ${runId}`),
    separator(),
    ...result.arms.map(
      (a) =>
        `  ${bold(a.label.padEnd(9))} ${a.role.padEnd(18)} ${a.status.padEnd(9)} ${pct(a.score)}${splitNote(a)}${a.runId ? dim(` benchmark:${a.runId}`) : ""}${a.error ? dim(` — ${a.error}`) : ""}`,
    ),
  ];
  if (result.delta !== undefined) {
    const ci = result.deltaCi
      ? ` (95% interval ${(result.deltaCi[0] * 100).toFixed(1)} to ${(result.deltaCi[1] * 100).toFixed(1)}${result.deltaCi[0] > 0 ? " — above zero" : " — includes zero: not distinguishable from noise"})`
      : "";
    lines.push(
      `  candidate − incumbent: ${result.delta >= 0 ? "+" : ""}${(result.delta * 100).toFixed(1)} points${ci}`,
    );
    const c = armBreakdown(result.arms.find((a) => a.label === "candidate") ?? {});
    const i = armBreakdown(result.arms.find((a) => a.label === "incumbent") ?? {});
    if (c && i) lines.push(`  ${splitLine(c, i)}`);
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

// ─── evolve replicate ────────────────────────────────────────────────────────

export interface ReplicateDeps {
  spawn(opts: {
    name: string;
    role: string;
    model: string;
    budgetCalls: number;
    spawnedBy: string;
  }): Promise<void>;
  /** Live agents this spawner already keeps alive. */
  liveChildren(spawnerName: string): number;
  /** Agents the runtime can still start (MAX_AGENTS − running). */
  agentsLeft(): number;
}

/** A run can seed at most this many copies in total (MARINA_MAX_REPLICAS_PER_RUN). */
export { MAX_REPLICAS_PER_RUN };

const REPLICATE_MODS: ModifierSpec = {
  n: { type: "int" },
  budget: { type: "int" },
  model: { type: "string" },
};

/**
 * Earned replication: an accepted candidate that WON its trial may spawn
 * copies of itself. Winning means both arms completed and the candidate beat
 * the incumbent by the fishing margin (it grows with every candidate this
 * session has trialed). Copies count against the caller's spawn budget,
 * MAX_AGENTS, the world's daily cap and a per-run ceiling, and each records
 * its lineage. Child or parallel world only, like trials.
 */
async function handleReplicate(
  ctx: RoomContext,
  input: { entity: string; tokens: string[] },
  entity: Entity,
  deps: { replicateDeps?: () => ReplicateDeps | undefined },
  db: MarinaDB,
  sessionId: number,
  run: { id: number; status: string; candidate_ref: string | null },
): Promise<void> {
  const say = (text: string) => ctx.send(input.entity as never, text);
  if (process.env.MARINA_COLLECTIVE_CHILD !== "1" && process.env.MARINA_EVOLVE_TRIALS !== "here") {
    say(
      "Replication runs in a child or parallel world, never this one: `world run <child> evolve replicate …`.",
    );
    return;
  }
  const replicateFloor = rankFloorRefusal(
    entity,
    4,
    "evolve replicate needs rank 4 (builder): copies are agents that spend real tokens.",
  );
  if (replicateFloor) {
    say(replicateFloor);
    return;
  }
  if (run.status !== "accepted") {
    say(
      `Run ${run.id} is ${run.status}; only an accepted run (decided by an independent reviewer) may replicate.`,
    );
    return;
  }
  const role = /^role:([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(run.candidate_ref ?? "")?.[1];
  if (!role || !db.getRole(role)) {
    say(`Run ${run.id}'s candidate "${run.candidate_ref ?? ""}" is not a role that exists here.`);
    return;
  }
  const win = earnedWin(db, sessionId, run.id);
  if (!win.ok) {
    say(win.reason);
    return;
  }
  const { inc, margin, delta } = win;
  const replicaTag = `[evolve_replica run=${run.id}]`;
  const already = db
    .getNotesByType(TRIAL_OWNER, REPLICA_NOTE_TYPE, 500)
    .filter((n) => n.content.startsWith(replicaTag)).length;
  const r = deps.replicateDeps?.();
  if (!r) {
    say("Replication needs the agent runtime, which this world does not have.");
    return;
  }
  const capped = dailyCapRefusal();
  if (capped) {
    say(`Not replicating: ${capped}.`);
    return;
  }
  const gate = checkGateForExecution(db, entity.id, "agent.spawn");
  if (!gate.ok) {
    say(gate.reason ?? "agent.spawn refused");
    return;
  }
  const standing = getStanding(db, entity.id);
  const granted = isGrantedCompetence(db.getCompetence(entity.id, "agent.spawn"));
  const budgetLeft = spawnBudget(standing, granted) - r.liveChildren(entity.name);
  const mods = parseModifiers(input.tokens.slice(3), REPLICATE_MODS);
  const wanted = Math.max(1, (mods.values.n as number | undefined) ?? 1);
  const n = Math.min(wanted, MAX_REPLICAS_PER_RUN - already, budgetLeft, r.agentsLeft());
  if (n <= 0) {
    say(
      `No room to replicate: ${already}/${MAX_REPLICAS_PER_RUN} copies of run ${run.id} exist, your spawn budget has ${Math.max(0, budgetLeft)} left, the runtime ${r.agentsLeft()}.`,
    );
    return;
  }
  const model = (mods.values.model as string | undefined) ?? "marina/default";
  const budgetCalls = Math.min(
    Math.max((mods.values.budget as number | undefined) ?? 200, 10),
    2_000,
  );
  const made: string[] = [];
  const failed: string[] = [];
  for (let k = already + 1; k <= already + n; k++) {
    const name = sanitizeEntityName(`${role.replace(/[^A-Za-z0-9]/g, "")}r${run.id}n${k}`);
    try {
      if (made.length > 0) await new Promise((res) => setTimeout(res, 1_100)); // spawn cooldown
      await r.spawn({ name, role, model, budgetCalls, spawnedBy: entity.name });
      recordGateExecution(db, entity.id, "agent.spawn", gate, `evolve replicate run ${run.id}`);
      db.createNote(
        TRIAL_OWNER,
        `${replicaTag} ${JSON.stringify({ run: run.id, role, agent: name, parent: entity.name, delta, margin, at: Date.now() })}`,
        undefined,
        { noteType: REPLICA_NOTE_TYPE, tier: "process", skipDedup: true },
      );
      made.push(name);
    } catch (err) {
      failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  say(
    [
      header(`Replicated run ${run.id}: ${role}`),
      separator(),
      `  earned: +${(delta * 100).toFixed(1)} points over ${inc.role} (bar ${(margin * 100).toFixed(1)})`,
      ...(made.length
        ? [
            `  spawned ${made.join(", ")} (budget ${budgetCalls} calls each, lineage: spawned by ${entity.name})`,
          ]
        : []),
      ...(failed.length ? [`  failed: ${failed.join("; ")}`] : []),
      dim(
        `  copies of this run: ${already + made.length}/${MAX_REPLICAS_PER_RUN}. Nothing in the parent world changed.`,
      ),
    ].join("\n"),
  );
}

export type EarnedWin =
  | {
      ok: true;
      trial: StoredTrial;
      cand: TrialResult["arms"][number];
      inc: TrialResult["arms"][number];
      margin: number;
      lower: number;
      delta: number;
    }
  | { ok: false; reason: string };

/**
 * Did run `runId`'s candidate EARN its win? Both trial arms completed, both
 * cited runs still resolve, the 95% interval on the difference is above zero,
 * and the difference clears the fishing margin for its session. The one test
 * behind `evolve replicate` and adoption into a parent world.
 */
export function earnedWin(db: MarinaDB, sessionId: number, runId: number): EarnedWin {
  const trial = storedTrial(db, runId)?.record;
  const cand = trial?.result.arms.find((a) => a.label === "candidate");
  const inc = trial?.result.arms.find((a) => a.label === "incumbent");
  if (
    !trial ||
    cand?.status !== "completed" ||
    inc?.status !== "completed" ||
    trial.result.delta === undefined
  ) {
    return {
      ok: false,
      reason: `Run ${runId} has no completed two-arm trial. Run one first: evolve trial <experiment> ${runId} incumbent:<role>`,
    };
  }
  for (const arm of [cand, inc]) {
    const row = arm.runId ? db.getBenchmarkRun(arm.runId) : undefined;
    if (row?.status !== "completed" || row.answered <= 0) {
      return {
        ok: false,
        reason: `Trial evidence benchmark:${arm.runId ?? "?"} no longer resolves; re-run the trial.`,
      };
    }
  }
  const triedBefore = db
    .listEvolutionRuns(sessionId)
    .filter((r) => r.id !== runId && storedTrial(db, r.id)).length;
  const margin = promotionMargin(triedBefore);
  const lower = trial.result.deltaCi?.[0];
  if (lower === undefined || lower <= 0) {
    return {
      ok: false,
      reason: `Not earned: +${(trial.result.delta * 100).toFixed(1)} points, but the 95% interval ${lower === undefined ? "is unknown" : `starts at ${(lower * 100).toFixed(1)}`} — the win is not distinguishable from noise. Trial on more held-out items (limit:N).`,
    };
  }
  if (trial.result.delta < margin) {
    return {
      ok: false,
      reason: `Not earned: the candidate beat the incumbent by ${(trial.result.delta * 100).toFixed(1)} points; this session needs ${(margin * 100).toFixed(1)} (${triedBefore} other candidate(s) trialed — every try raises the bar).`,
    };
  }
  return { ok: true, trial, cand, inc, margin, lower, delta: trial.result.delta };
}

// ─── evolve adoption (read by a parent world) ────────────────────────────────

export interface AdoptionOffer {
  v: 1;
  bundle: string;
  evidence: {
    world?: string;
    experiment: string;
    run: number;
    candidateRole: string;
    incumbentRole: string;
    delta: number;
    interval: [number, number];
    margin: number;
    candidateRun: string;
    incumbentRun: string;
    candidateScore: number;
    incumbentScore: number;
    items: number;
    candidateAnswered?: number;
    incumbentAnswered?: number;
    benchmark?: string;
    /** `holdout` when judged on the fixed held-out split; absent otherwise. */
    partition?: string;
    evaluator: string | null;
    reviewer: string | null;
  };
}

export const ADOPTION_MARKER = "ADOPTION:";

/** The latest ACCEPTED run of `role:<name>` whose trial earned its win, as an offer. */
export function adoptionOffer(db: MarinaDB, roleName: string): AdoptionOffer | { reason: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(roleName))
    return { reason: "Usage: evolve adoption <role>" };
  const bundle = exportRoleBundle(db, roleName);
  if (!bundle) return { reason: `Role "${roleName}" does not exist in this world.` };
  let lastReason = `No accepted run proposes role:${roleName}.`;
  for (const session of [...db.listEvolutionSessions()].reverse()) {
    const runs = db
      .listEvolutionRuns(session.id)
      .filter((r) => r.status === "accepted" && r.candidate_ref === `role:${roleName}`)
      .reverse();
    for (const run of runs) {
      const win = earnedWin(db, session.id, run.id);
      if (!win.ok) {
        lastReason = win.reason;
        continue;
      }
      let judged: { benchmark?: string; partition?: string } = {};
      try {
        judged = JSON.parse(db.getBenchmarkRun(win.cand.runId!)?.config_json ?? "{}");
      } catch {
        // The score stands; only the label is unknown.
      }
      return {
        v: 1,
        bundle: encodeRoleBundle(bundle),
        evidence: {
          ...(process.env.MARINA_NAME ? { world: process.env.MARINA_NAME } : {}),
          experiment:
            db.getExperiment(session.experiment_id)?.name ?? `experiment:${session.experiment_id}`,
          run: run.id,
          candidateRole: roleName,
          incumbentRole: win.inc.role,
          delta: win.delta,
          interval: win.trial.result.deltaCi!,
          margin: win.margin,
          candidateRun: win.cand.runId!,
          incumbentRun: win.inc.runId!,
          candidateScore: win.cand.score!,
          incumbentScore: win.inc.score!,
          items: win.cand.total ?? 0,
          ...(win.cand.answered === undefined ? {} : { candidateAnswered: win.cand.answered }),
          ...(win.inc.answered === undefined ? {} : { incumbentAnswered: win.inc.answered }),
          ...(judged.benchmark ? { benchmark: judged.benchmark } : {}),
          ...(judged.partition ? { partition: judged.partition } : {}),
          evaluator: run.evaluator_name ?? null,
          reviewer: run.reviewer_name ?? null,
        },
      };
    }
  }
  return { reason: lastReason };
}

/** The quality / answered split behind an adoption offer's scores. */
export function evidenceSplit(e: AdoptionOffer["evidence"]): string | undefined {
  const c = armBreakdown({
    score: e.candidateScore,
    answered: e.candidateAnswered,
    total: e.items,
  });
  const i = armBreakdown({
    score: e.incumbentScore,
    answered: e.incumbentAnswered,
    total: e.items,
  });
  return c && i ? splitLine(c, i) : undefined;
}

/** "100 held-out arc-challenge items" — "held-out" only when the holdout split judged it. */
export function judgedOn(e: AdoptionOffer["evidence"]): string {
  return `${e.items}${e.partition === "holdout" ? " held-out" : ""} ${e.benchmark ?? "benchmark"} items`;
}

function renderAdoption(db: MarinaDB, roleName: string): string {
  const offer = adoptionOffer(db, roleName);
  if ("reason" in offer) return `Not adoptable: ${offer.reason}`;
  const e = offer.evidence;
  const pct = (x: number) => `${(x * 100).toFixed(1)}`;
  return [
    header(`Adoptable: ${e.candidateRole}`),
    separator(),
    `  run ${e.run} (${e.experiment}) accepted — evaluated by ${e.evaluator ?? "?"}, decided by ${e.reviewer ?? "?"}`,
    `  ${e.candidateRole} ${pct(e.candidateScore)}% vs ${e.incumbentRole} ${pct(e.incumbentScore)}% on ${judgedOn(e)}: +${pct(e.delta)} points (95% ${pct(e.interval[0])} to ${pct(e.interval[1])}, bar ${pct(e.margin)})`,
    ...(evidenceSplit(e) ? [`  ${evidenceSplit(e)}`] : []),
    `  evidence benchmark:${e.candidateRun} benchmark:${e.incumbentRun}`,
    `${ADOPTION_MARKER}${Buffer.from(JSON.stringify(offer), "utf8").toString("base64url")}`,
  ].join("\n");
}
