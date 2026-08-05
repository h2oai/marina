import { bold, category, dim, header, separator, status } from "../../net/ansi";
import type { EvolutionSessionRow, MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { analyzeEvolutionEvidence } from "../evolution-analysis";
import {
  createEvolutionProtocol,
  evolutionBudgetState,
  parseEvolutionProtocol,
} from "../evolution-protocol";

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
    ctx.send(input.entity, "Evolution protocols require database support.");
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
    db.evaluateEvolutionRun(run.id, entity.name, evidence);
    ctx.send(
      input.entity,
      `Evidence recorded for run ${run.id}; it remains advisory and inactive.`,
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
