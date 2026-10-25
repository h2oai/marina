// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { retireLessonsForRun } from "../../learning/intake";
import { bold, category, dim, status as fmtStatus, header, separator } from "../../net/ansi";
import type { BenchmarkRunRow, MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import {
  type CompareRunJob,
  type CompareRunReport,
  compareRunReport,
  DEFAULT_COMPARE_REPLICATES,
  getCompareRun,
  listCompareRuns,
  MAX_COMPARE_REPLICATES,
  parseArms,
  startCompareRun,
} from "../benchmark-compare-run";
import { benchmarkExecution, formatBenchmarkExecution } from "../benchmark-execution";
import {
  getKitJob,
  KIT_FLAGS,
  kitArgs,
  kitCapture,
  kitLogTail,
  listKitJobs,
  startKitJob,
} from "../benchmark-kit";
import {
  compareRuns,
  formatVerificationCounts,
  invalidReason,
  MAX_VALIDITY_REASON,
  paretoFrontier,
  participantCredit,
  runLabel,
  verificationCounts,
} from "../benchmark-ledger";
import { parsePartition } from "../benchmark-partition";
import {
  type ChallengeEvaluation,
  eligiblePromotions,
  fileSlotPromotion,
  lookupChallenge,
  type SplitStats,
} from "../benchmark-promotion";
import {
  knownReferenceModels,
  REFERENCE_SCORES,
  referenceScoresForBenchmark,
  referenceScoresForModel,
} from "../benchmark-reference-scores";
import {
  comparePooledGroups,
  type LoadedGroup,
  loadReplicateGroup,
  pooledSummary,
  replicateGroupOf,
} from "../benchmark-replicates";
import {
  BENCHMARKS,
  type BenchmarkRunner,
  type BenchmarkSubject,
  purgeBenchmarkContentNotes,
  retireOutcomeNotesForRun,
} from "../benchmark-runner";
import { resolveRunTarget, type ServingCrew } from "../benchmark-target";
import { BENCHMARK_RUN_MIN_RANK } from "../constants";
import { recentResolutions } from "../default-resolution";
import { extractModifiers, parseModifiers, resolveMultiWordName } from "../parse-input";
import { rankName } from "../permissions";
import { rankFloorRefusal } from "../rank-floor";
import { checkRoleEdit } from "../role-guard";
import { formatAge } from "./format-duration";

/** Render an id-shaped string with dim styling (ansi.id is numeric-only). */
function fmtId(s: string): string {
  return dim(s);
}

function variantFromStatus(s: string): "active" | "done" | "fail" | "info" | "warn" {
  if (s === "completed") return "done";
  if (s === "failed") return "fail";
  if (s === "invalid") return "warn";
  if (s === "running") return "active";
  return "info";
}

const HELP = `Run, track, and rank benchmark evaluations from inside the world.
Usage:
  benchmark list                                   — show available benchmarks + cache status
  benchmark orchestrations                         — show live marina:<name> endpoints
  benchmark run <name> [crew:<name> | model:<id>] [--limit N] [--seed N] [--judge M] [self-judge:on]
                   [--concurrency N] [--partition holdout|tune] [lessons:on] [lessons-mode:measure|live]
                                                   — kick off one run. It measures RESIDENTS: crew:<name>,
                                                     or with no target the world's serving crew (refused
                                                     when there is none, or several). model:<id> is a
                                                     bare-model CONTROL (no residents), labelled as one.
  benchmark sweep <name|all> [--limit N] [--seed N] [--judge M]
                                                   — fan out across every live orchestration
  benchmark result <id>                            — show a single run's score + breakdown
  benchmark runs [--benchmark X] [--limit N]      — list recent runs
  benchmark leaderboard <benchmark> [--limit N]   — top scoring configs for a benchmark
                                                     (interleaves reference-model scores;
                                                     ledger runs show n, 95% CI and $/item)
  benchmark frontier <benchmark>                   — the accuracy vs $/item Pareto set
  benchmark compare <runA> <runB>                  — paired on shared items: exact McNemar,
                                                     each run's CI, $/item and its delta; with
                                                     replicates, the pooled two-stage bootstrap
                                                     (a single run is flagged "not replicated")
  benchmark compare-run <name> arms:<a>,<b> cap:<usd> [replicates:N] [limit:N] [seed:N]
                       [model:M] [judge:M] [concurrency:N] [partition:holdout|tune]
                                                   — a paired comparison as one command: each
                                                     replicate runs both arms at once on the same
                                                     items, model and code; replicates default to
                                                     ${DEFAULT_COMPARE_REPLICATES}. Arms: bare, on, full, or members
                                                     joined by + (lessons+obligations). cap: is the
                                                     whole comparison's spend, split per run. Needs
                                                     rank 4.
  benchmark compare-run status [id]                — progress, then per arm: accuracy with a
                                                     Wilson interval, spend, cost per success and
                                                     model@source; the paired bootstrap delta
  benchmark replicates <run>                       — the run's replicate group: each run, pooled
                                                     accuracy, between-run SD, per-item agreement
  benchmark participants <benchmark>               — per agent / per model: items touched,
                                                     accuracy on them, cost
  benchmark reference [model|benchmark]            — show published reference scores
  benchmark defaults                               — promoted defaults: each slot's incumbent run
  benchmark eligible [board]                       — read-only: configurations whose holdout
                                                     evidence would pass the promotion rule now,
                                                     with every other candidate read counted as
                                                     tried; files nothing (promote stays manual,
                                                     behind role.edit)
  benchmark challenge <slot> <run> [--max-cost-ratio R]
                                                   — dry run on the slot's SELECTION split (the
                                                     holdout stays unread); shows what promotion needs
  benchmark promote <slot> <run> [--max-cost-ratio R] [--holdout F]
                                                   — seed an empty slot, or promote a challenger that
                                                     EARNED it on the holdout: same benchmark, judge and
                                                     items; paired 95% interval above 0; delta above a
                                                     fishing margin that grows with every attempt;
                                                     the challenger needs MARINA_PROMOTION_MIN_REPLICATES
                                                     replicates (default 2) before the holdout is read.
                                                     Needs role.edit; never the run's own author.
  benchmark invalidate <run> reason:<text>         — retire a run that measured the infrastructure,
                                                     not the target (spend cap, outage): status
                                                     invalid, excluded from every ranking, pooling,
                                                     comparison, promotion and route evidence; items
                                                     kept; an append-only audit row records who,
                                                     when and why. Needs role.edit. An invalidated
                                                     incumbent never frees its slot: a challenger must
                                                     beat the best earlier valid incumbent, and the
                                                     invalidator can't fill the slot.
  benchmark revalidate <run> reason:<text>         — undo an invalidation (audited the same way);
                                                     needs role.edit, never the run's own author.
  benchmark purge-content-notes [confirm:yes]      — find the per-item notes older runs left in
                                                     benchmark:<name> pools (each held an item's
                                                     question and answer); dry run by default.
                                                     confirm:yes retires them through note delete's
                                                     audited path (needs role.edit). Runs now teach
                                                     only through judged lessons (\`lessons\`).

Benchmarks: ${Object.keys(BENCHMARKS).join(", ")}
  (smoke is the 15-item prompt A/B set, always ready; run "benchmark list" for status)

Targets: crew:<name> = the residents serving marina:<name> (a model-<name> channel with a live
  agent; see "benchmark orchestrations"); model:<id> = the bare model as a control ("marina" =
  the default upstream model; model:marina:<name> is the crew <name>).
Judge: judge-scored benchmarks (frames, simple-qa, hle-verified-gold*, narrativeqa, mt-bench)
  are graded by judge:<model>, else MARINA_BENCHMARK_JUDGE_MODEL, else marina/default — never
  by the target itself: a judge that names the target is refused unless self-judge:on, which
  the run records (its ledger judge is marked [self-judge]).

Note: "run", "sweep" and "compare-run" need rank 4 — they burn real tokens. Discovery commands
  (list, runs, result, leaderboard, frontier, compare, replicates, participants, reference,
  orchestrations, defaults, eligible, challenge, compare-run status) are rank 0. Invalid runs are listed by runs and
  result, marked with their reason; every other reader skips them. A run whose items were
  more than MARINA_BENCHMARK_MAX_FALLBACK_RATE (default 25%) fallbacks — errors, spend-cap
  or provider failures instead of answers — is recorded invalid automatically. Results
  recorded outside the world are imported by the operator with \`bun run benchmark:import\`
  (which also takes --invalidate|--revalidate <run> --reason). Promoted defaults are
  read by worlds (e.g. slot showcase:crew sets the showcase crew's model when
  MARINA_CREW_MODEL is unset); environment variables always win.

Examples:
  benchmark list
  benchmark run aime --limit 10                    # the world's serving crew
  benchmark run aime --limit 10 crew:answerer
  benchmark run aime --limit 10 model:marina      # control: the bare default model
  benchmark sweep aime --limit 10 --seed 42        # aime × every live marina:<name>
  benchmark sweep all --limit 5 --seed 42          # every bench × every orchestration
  benchmark leaderboard aime
  benchmark reference                              # all models we have numbers for
  benchmark reference anthropic/claude-opus-4-6
  benchmark reference mmlu-pro                    # all models' published scores for mmlu-pro`;

const RUN_MODIFIERS = [
  "limit",
  "seed",
  "judge-model",
  "model",
  "crew",
  "judge",
  "self-judge",
  "concurrency",
  "partition",
  "lessons",
  "lessons-mode",
  "arm",
  "cap",
];
const SWEEP_MODIFIERS = ["limit", "seed", "judge", "judge-model", "concurrency"];

/**
 * The argument tokens with every `key:value` / `key=value` of a known key
 * rewritten as `--key value`, so the canonical modifier grammar (`crew:answerer`,
 * `model:marina`, `self-judge:on`) parses alongside `--key value`. Only the
 * first `:`/`=` splits, so `model:marina:answerer` keeps its value.
 */
export function canonicalModifierArgs(tokens: readonly string[], known: readonly string[]): string {
  return tokens
    .map((t) => {
      const m = /^([a-z][a-z-]*)[:=](.+)$/i.exec(t);
      const key = m?.[1]?.toLowerCase();
      return m && key && known.includes(key) ? `--${key} ${m[2]}` : t;
    })
    .join(" ");
}

function formatRunLine(row: BenchmarkRunRow): string {
  const score =
    row.status === "invalid"
      ? fmtStatus("invalid".padEnd(6), "warn")
      : row.score === null || row.score === undefined
        ? fmtStatus(row.status.padEnd(10), variantFromStatus(row.status))
        : `${(row.score * 100).toFixed(1)}%`.padStart(6);
  const age = dim(`${formatAge(Date.now() - row.started_at)} ago`.padStart(8));
  const ans = row.total > 0 ? `${row.answered}/${row.total}` : "-";
  const id = fmtId(row.id);
  const agent = row.agent_id ? bold(row.agent_id) : dim("—");
  return `  ${age}  ${score}  ${category(row.benchmark.padEnd(16))}  ${ans.padEnd(7)}  ${agent.padEnd(18)}  ${id}`;
}

export function benchmarkCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
  runner: BenchmarkRunner;
  /**
   * Returns the list of live marina:<name> orchestration endpoints —
   * every model-* channel (excluding "model" and conversation channels)
   * that has at least one online agent subscribed. Used by
   * `benchmark sweep` to fan out without needing an external discovery.
   */
  listOrchestrations: () => string[];
  logEvent?: (event: EngineEvent) => void;
  /** The agents behind a `marina:<name>` target (role, prompt version), recorded with the run. */
  describeTarget?: (model: string) => BenchmarkSubject[];
  /**
   * Crews serving a live `marina:<name>` endpoint, with their formation. A
   * `benchmark run` without a target measures the one serving crew.
   */
  servingCrews?: () => ServingCrew[];
}): CommandDef {
  const { db, runner, listOrchestrations } = deps;
  return {
    category: "Growth",
    usage: [
      { syntax: "benchmark challenge <slot> <run> [--max-cost-ratio R]", effect: "read" },
      { syntax: "benchmark compare <runA> <runB>", effect: "read" },
      {
        syntax:
          "benchmark compare-run <name> arms:<a>,<b> cap:<usd> [replicates:N] [limit:N] [seed:N] [model:M] [judge:M] [concurrency:N] [partition:holdout|tune]",
        effect: "execute",
      },
      { syntax: "benchmark compare-run status [id]", effect: "read" },
      { syntax: "benchmark defaults", effect: "read" },
      { syntax: "benchmark eligible [board]", effect: "read" },
      {
        syntax: "benchmark promote <slot> <run> [--max-cost-ratio R] [--holdout F]",
        effect: "write",
      },
      { syntax: "benchmark purge-content-notes [confirm:yes]", effect: "delete" },
      { syntax: "benchmark frontier <benchmark>", effect: "read" },
      { syntax: "benchmark invalidate <run> reason:<text>", effect: "write" },
      { syntax: "benchmark leaderboard <benchmark> [--limit N]", effect: "read" },
      { syntax: "benchmark participants <benchmark>", effect: "read" },
      { syntax: "benchmark replicates <run>", effect: "read" },
      { syntax: "benchmark list", effect: "read" },
      { syntax: "benchmark orchestrations", effect: "read" },
      { syntax: "benchmark reference", effect: "read" },
      { syntax: "benchmark reference benchmark", effect: "read" },
      { syntax: "benchmark reference model", effect: "read" },
      { syntax: "benchmark result <id>", effect: "read" },
      { syntax: "benchmark revalidate <run> reason:<text>", effect: "write" },
      { syntax: "benchmark run <name> [crew:<name>] [--limit N] [--seed N]", effect: "execute" },
      {
        syntax:
          "benchmark run <name> [crew:<name> | model:<id>] [--limit N] [--seed N] [--judge M] [self-judge:on] [--concurrency N] [--partition holdout|tune] [lessons:on] [lessons-mode:measure|live] [arm:bare|on|full|<members>] [cap:<usd>]",
        effect: "execute",
      },
      { syntax: "benchmark runs [--benchmark X] [--limit N]", effect: "read" },
      { syntax: "benchmark kit [list]", effect: "execute" },
      { syntax: "benchmark kit doctor [setup]", effect: "execute" },
      { syntax: "benchmark kit status [id]", effect: "read" },
      {
        syntax:
          "benchmark kit <setup> [arms:a,b] [replicates:N] [limit:N] [budget:<usd>] [model:M] [domain:D] [dry-run]",
        effect: "execute",
      },
      {
        syntax: "benchmark sweep <name|all> [--limit N] [--seed N] [--judge M]",
        effect: "execute",
      },
    ],
    name: "benchmark",
    aliases: ["bench"],
    minRank: 0,
    help: HELP,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase() ?? "list";

      switch (sub) {
        case "list": {
          const specs = runner.list();
          if (specs.length === 0) {
            ctx.send(input.entity, "No benchmarks registered.");
            return;
          }
          const lines = [
            header(`Benchmarks (${specs.length})`),
            separator(),
            ...specs.map((s) => {
              const ready = runner.datasetReady(s.name)
                ? fmtStatus("ready", "done")
                : fmtStatus("missing", "warn");
              return `  ${category(s.name.padEnd(16))} ${ready}  ${dim(s.description)}`;
            }),
            "",
            dim("Run one with: benchmark run <name> [--limit N] [--seed N]"),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "orchestrations": {
          const orchs = listOrchestrations();
          if (orchs.length === 0) {
            ctx.send(
              input.entity,
              "No live orchestrations. Spawn agents that join model-* channels.",
            );
            return;
          }
          const lines = [
            header(`Live orchestrations (${orchs.length})`),
            separator(),
            ...orchs.map((o) => `  ${category(o)}`),
            "",
            dim("Fire one bench across all of them: benchmark sweep <name> [--limit N]"),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "sweep": {
          const rawTarget = tokens[1];
          if (!rawTarget) {
            ctx.send(
              input.entity,
              "Usage: benchmark sweep <name|all> [--limit N] [--seed N] [--judge M]",
            );
            return;
          }
          const sweepFloor = rankFloorRefusal(
            entity,
            4,
            "benchmark sweep requires rank 4 (builder). Benchmarks fan out across every live orchestration and burn real tokens — earn the rank via competence.",
          );
          if (sweepFloor) {
            ctx.send(input.entity, sweepFloor);
            return;
          }
          // Voice-friendly name resolution: accept "mmlu pro" / "simple qa" /
          // "aime 2025" in addition to the canonical hyphenated keys.
          let sweepName: string | null = null;
          let consumed = 1;
          if (rawTarget.toLowerCase() === "all") {
            sweepName = "all";
          } else {
            const resolved = resolveMultiWordName(tokens, 1, Object.keys(BENCHMARKS));
            if (resolved) {
              sweepName = resolved.name;
              consumed = resolved.consumed;
            }
          }
          const rawArgs = canonicalModifierArgs(tokens.slice(1 + consumed), SWEEP_MODIFIERS);
          const { modifiers } = extractModifiers(rawArgs, SWEEP_MODIFIERS);
          const limit = Number.parseInt(modifiers.limit ?? "", 10);
          const seed = Number.parseInt(modifiers.seed ?? "", 10);
          const concurrency = Number.parseInt(modifiers.concurrency ?? "", 10);

          const orchs = listOrchestrations();
          if (orchs.length === 0) {
            ctx.send(
              input.entity,
              "No live orchestrations to sweep across. See: benchmark orchestrations",
            );
            return;
          }

          if (!sweepName) {
            ctx.send(
              input.entity,
              `Unknown benchmark: ${rawTarget}. Known: ${Object.keys(BENCHMARKS).join(", ")}`,
            );
            return;
          }
          const benches = sweepName === "all" ? Object.keys(BENCHMARKS) : [sweepName];

          const formations = new Map(
            (deps.servingCrews?.() ?? []).map((c) => [`marina:${c.name}`, c.formation]),
          );
          const handles: { bench: string; orch: string; id: string; err?: string }[] = [];
          for (const bench of benches) {
            for (const orch of orchs) {
              try {
                const handle = runner.start({
                  benchmark: bench,
                  limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
                  seed: Number.isFinite(seed) ? seed : undefined,
                  model: orch,
                  ...(formations.get(orch) ? { formation: formations.get(orch) } : {}),
                  subjects: deps.describeTarget?.(orch) ?? [],
                  judgeModel: modifiers.judge ?? modifiers["judge-model"],
                  concurrency:
                    Number.isFinite(concurrency) && concurrency > 0 ? concurrency : undefined,
                  agentId: entity.id,
                });
                handles.push({ bench, orch, id: handle.id });
              } catch (err) {
                handles.push({
                  bench,
                  orch,
                  id: "",
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
          const started = handles.filter((h) => !h.err).length;
          const failed = handles.filter((h) => h.err);
          const lines = [
            header(`Sweep started — ${started} run(s) across ${orchs.length} orchestration(s)`),
            separator(),
            ...handles
              .filter((h) => !h.err)
              .map(
                (h) =>
                  `  ${category(h.bench.padEnd(16))}  ${dim("→")}  ${h.orch.padEnd(24)}  ${fmtId(h.id)}`,
              ),
          ];
          if (failed.length > 0) {
            lines.push("", bold(`  Failed to start (${failed.length}):`));
            for (const f of failed) {
              lines.push(`    ${f.bench} → ${f.orch}: ${f.err}`);
            }
          }
          lines.push(
            "",
            dim("Follow progress: benchmark runs --limit 30"),
            dim(`Compare when done: benchmark leaderboard ${benches[0] ?? "<name>"}`),
          );
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "run": {
          if (!tokens[1]) {
            ctx.send(
              input.entity,
              "Usage: benchmark run <name> [crew:<name> | model:<id>] [--limit N] [--seed N] [--judge M] [--partition holdout|tune]",
            );
            return;
          }
          const runFloor = rankFloorRefusal(
            entity,
            BENCHMARK_RUN_MIN_RANK,
            `benchmark run requires rank ${BENCHMARK_RUN_MIN_RANK} (${rankName(BENCHMARK_RUN_MIN_RANK)}). Every run burns real tokens — earn the rank via competence.`,
          );
          if (runFloor) {
            ctx.send(input.entity, runFloor);
            return;
          }
          // Voice-friendly name resolution: "mmlu pro" == "mmlu-pro", etc.
          const resolved = resolveMultiWordName(tokens, 1, Object.keys(BENCHMARKS));
          if (!resolved) {
            ctx.send(
              input.entity,
              `Unknown benchmark: ${tokens[1]}. Known: ${Object.keys(BENCHMARKS).join(", ")}`,
            );
            return;
          }
          const name = resolved.name;
          const rawArgs = canonicalModifierArgs(tokens.slice(1 + resolved.consumed), RUN_MODIFIERS);
          const { modifiers } = extractModifiers(rawArgs, RUN_MODIFIERS);
          const limit = Number.parseInt(modifiers.limit ?? "", 10);
          const seed = Number.parseInt(modifiers.seed ?? "", 10);
          const concurrency = Number.parseInt(modifiers.concurrency ?? "", 10);
          const lessonsMode = modifiers["lessons-mode"]?.toLowerCase();
          if (lessonsMode !== undefined && lessonsMode !== "measure" && lessonsMode !== "live") {
            ctx.send(input.entity, "lessons-mode must be measure or live.");
            return;
          }
          const cap =
            modifiers.cap === undefined ? undefined : Number(modifiers.cap.replace(/^\$/, ""));
          if (cap !== undefined && !(Number.isFinite(cap) && cap > 0)) {
            ctx.send(input.entity, "cap is a dollar amount above 0 (cap:5 or cap:$5).");
            return;
          }
          // What the run measures: residents by default (src/engine/benchmark-target.ts).
          const target = resolveRunTarget({
            ...(modifiers.crew ? { crew: modifiers.crew } : {}),
            ...(modifiers.model ? { model: modifiers.model } : {}),
            orchestrations: listOrchestrations(),
            crews: deps.servingCrews?.() ?? [],
          });
          if ("error" in target) {
            ctx.send(input.entity, `benchmark run: ${target.error}`);
            return;
          }
          try {
            const handle = runner.start({
              benchmark: name,
              limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
              seed: Number.isFinite(seed) ? seed : undefined,
              model: target.model,
              ...(target.kind === "crew" && target.formation
                ? { formation: target.formation }
                : {}),
              ...(parsePartition(modifiers.partition)
                ? { partition: parsePartition(modifiers.partition) }
                : {}),
              ...(target.kind === "crew"
                ? { subjects: deps.describeTarget?.(target.model) ?? [] }
                : {}),
              judgeModel: modifiers.judge ?? modifiers["judge-model"],
              ...(/^(on|true|yes|1)$/i.test(modifiers["self-judge"] ?? "")
                ? { selfJudge: true }
                : {}),
              concurrency:
                Number.isFinite(concurrency) && concurrency > 0 ? concurrency : undefined,
              agentId: entity.id,
              ...(/^(on|true|yes|1)$/i.test(modifiers.lessons ?? "") ? { lessons: true } : {}),
              ...(lessonsMode ? { lessonsMode } : {}),
              ...(modifiers.arm ? { arm: modifiers.arm } : {}),
              ...(cap !== undefined ? { capUsd: cap } : {}),
            });
            const measured =
              target.kind === "crew"
                ? `crew ${target.crew} (residents${target.formation ? `, formation ${target.formation}` : ""})${target.defaulted ? dim(" — the world's serving crew") : ""}`
                : `${target.model} ${fmtStatus("CONTROL", "warn")} ${dim("bare model, no residents")}`;
            ctx.send(
              input.entity,
              `Benchmark run started.\n  ${bold("id")}:       ${fmtId(handle.id)}\n  ${bold("benchmark")}: ${category(name)}\n  ${bold("target")}:    ${measured}\n  ${bold("config")}:    ${handle.configHash}\n\nCheck status with: benchmark result ${handle.id}`,
            );
          } catch (err) {
            ctx.send(
              input.entity,
              `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }

        case "kit": {
          // The reproduction kit (benchmarks/repro): isolated servers per arm and
          // third-party harnesses, filing into THIS world's ledger.
          const action = tokens[1]?.toLowerCase();
          if (!action || action === "list") {
            const { output } = await kitCapture(["list"]);
            ctx.send(
              input.entity,
              `${output}\n\nRun one: benchmark kit <setup> arms:a,b replicates:2 limit:N budget:<usd> (dry-run first: add dry-run)`,
            );
            return;
          }
          if (action === "doctor") {
            const { output } = await kitCapture(["doctor", ...(tokens[2] ? [tokens[2]] : [])]);
            ctx.send(input.entity, output);
            return;
          }
          if (action === "status") {
            const id = tokens[2];
            const job = id ? getKitJob(id) : undefined;
            if (id && !job) {
              ctx.send(
                input.entity,
                `No kit job ${fmtId(id)} in this server (jobs are listed until restart).`,
              );
              return;
            }
            if (job) {
              ctx.send(
                input.entity,
                `${header(`Kit job ${job.id}`)}\n  ${bold("status")}: ${job.status}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}\n  ${bold("started")}: ${new Date(job.startedAt).toISOString()}\n  ${bold("run dir")}: ${job.runDir}\n\n${kitLogTail(job)}`,
              );
              return;
            }
            const all = listKitJobs();
            ctx.send(
              input.entity,
              all.length
                ? all
                    .map(
                      (j) =>
                        `  ${fmtId(j.id)}  ${j.status}  ${j.setup}  ${new Date(j.startedAt).toISOString()}`,
                    )
                    .join("\n")
                : "No kit jobs since this server started.",
            );
            return;
          }
          const kitFloor = rankFloorRefusal(
            entity,
            4,
            "benchmark kit runs require rank 4 (builder). Every run burns real tokens — earn the rank via competence.",
          );
          if (kitFloor) {
            ctx.send(input.entity, kitFloor);
            return;
          }
          const spec = Object.fromEntries(
            [...Object.keys(KIT_FLAGS), "dry-run"].map((k) => [
              k,
              { type: (k === "dry-run" ? "bool" : "string") as "bool" | "string" },
            ]),
          );
          const { values, rest, errors } = parseModifiers(tokens.slice(2), spec);
          if (errors.length || rest.length) {
            ctx.send(
              input.entity,
              `benchmark kit: ${[...errors, ...rest.map((r) => `unexpected "${r}"`)].join("; ")}`,
            );
            return;
          }
          const dryRun = values["dry-run"] === true;
          const flags: Record<string, string> = {};
          for (const [k, v] of Object.entries(values))
            if (k !== "dry-run" && typeof v === "string") flags[k] = v;
          if (!dryRun && flags.budget === undefined) {
            ctx.send(
              input.entity,
              "benchmark kit: a run needs budget:<usd> — the kit refuses when its estimate exceeds it. Add dry-run to see the plan and estimate first.",
            );
            return;
          }
          const argv = kitArgs(action, flags, dryRun ? ["--dry-run"] : []);
          if ("error" in argv) {
            ctx.send(input.entity, `benchmark kit: ${argv.error}`);
            return;
          }
          if (dryRun) {
            const { output } = await kitCapture(argv);
            ctx.send(input.entity, output);
            return;
          }
          const job = startKitJob({
            setup: action,
            argv,
            owner: entity.name,
            onExit: (done) =>
              deps.logEvent?.({
                type: "feed_event",
                kind:
                  done.status === "completed" ? "benchmark_kit_completed" : "benchmark_kit_failed",
                entity: entity.id,
                ref: done.id,
                summary: `benchmark kit ${done.setup} ${done.status}${done.exitCode ? ` (exit ${done.exitCode})` : ""}`,
                payload: { id: done.id, setup: done.setup, exitCode: done.exitCode ?? null },
                timestamp: Date.now(),
              }),
          });
          deps.logEvent?.({
            type: "feed_event",
            kind: "benchmark_kit_started",
            entity: entity.id,
            ref: job.id,
            summary: `benchmark kit ${action} started`,
            payload: { id: job.id, setup: action },
            timestamp: job.startedAt,
          });
          ctx.send(
            input.entity,
            `Kit run started: ${fmtId(job.id)} (${action}). Its runs file into this world's ledger.\n  benchmark kit status ${job.id}   — progress\n  benchmark runs / compare / replicates — results`,
          );
          return;
        }

        case "result": {
          const id = tokens[1];
          if (!id) {
            ctx.send(input.entity, "Usage: benchmark result <id>");
            return;
          }
          const row = db.getBenchmarkRun(id);
          if (!row) {
            ctx.send(input.entity, `No run found with id ${fmtId(id)}.`);
            return;
          }
          const lines: string[] = [
            header(`Benchmark run ${row.id}`),
            separator(),
            `  ${bold("benchmark")}:   ${category(row.benchmark)}`,
            `  ${bold("status")}:      ${fmtStatus(row.status, variantFromStatus(row.status))}`,
            ...validityLines(db, row),
            `  ${bold("started")}:     ${new Date(row.started_at).toISOString()} (${formatAge(Date.now() - row.started_at)} ago)`,
          ];
          if (row.duration_ms) {
            lines.push(`  ${bold("duration")}:    ${Math.round(row.duration_ms / 1000)}s`);
          }
          if (row.score !== null) {
            lines.push(
              `  ${bold("score")}:       ${(row.score * 100).toFixed(2)}%  (${row.answered}/${row.total} answered)`,
            );
          }
          if (row.agent_id) {
            lines.push(`  ${bold("launched by")}: ${row.agent_id}`);
          }
          {
            // Item labels (migration 157): checks that never ran are not failures,
            // and a budget-forced answer is counted apart from a free one.
            const items = db.getBenchmarkItems(row.id);
            lines.push(...formatBenchmarkExecution(benchmarkExecution(items)));
            for (const evidence of db.listBenchmarkRunEvidence(row.id)) {
              lines.push(
                `Source evidence: ${evidence.changed_items} items from ${evidence.source_run_id}, sha256:${evidence.source_hash} (operator-attached; not remote attestation).`,
              );
            }
            const verification = formatVerificationCounts(verificationCounts(items));
            if (verification) lines.push(`  ${bold("checks")}:      ${verification}`);
            const forced = items.filter((i) => i.budget_forced === 1).length;
            if (forced > 0) {
              lines.push(
                `  ${bold("forced")}:      ${forced}/${items.length} answers forced at a budget`,
              );
            }
          }
          if (row.config_json) {
            try {
              const config = JSON.parse(row.config_json) as Record<string, unknown>;
              const subjects = Array.isArray(config.subjects)
                ? (config.subjects as BenchmarkSubject[])
                : [];
              if (subjects.length > 0) {
                lines.push(
                  `  ${bold("declared")}:    ${subjects
                    .map(
                      (s) =>
                        `${s.agent}${s.role ? ` (role ${s.role}` : " ("}${s.promptVersion ? `, prompt ${s.promptVersion}` : ""})`,
                    )
                    .join(", ")}`,
                );
              }
              const entries = Object.entries(config)
                .filter(([k, v]) => k !== "subjects" && v !== undefined && v !== null)
                .map(([k, v]) => `    ${dim(k)}=${typeof v === "string" ? v : JSON.stringify(v)}`);
              if (entries.length > 0) {
                lines.push(`  ${bold("config")}:`);
                lines.push(...entries);
              }
            } catch {
              // ignore
            }
          }
          if (row.breakdown_json) {
            try {
              const breakdown = JSON.parse(row.breakdown_json) as Record<string, unknown>;
              const entries = Object.entries(breakdown);
              if (entries.length > 0) {
                lines.push("", bold("  breakdown:"));
                for (const [k, v] of entries) {
                  if (typeof v === "number") {
                    lines.push(`    ${dim(k.padEnd(22))} ${(v * 100).toFixed(1)}%`);
                  } else {
                    lines.push(`    ${dim(k.padEnd(22))} ${JSON.stringify(v)}`);
                  }
                }
              }
            } catch {
              // ignore
            }
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "runs": {
          const rawArgs = tokens.slice(1).join(" ");
          const { modifiers } = extractModifiers(rawArgs, ["benchmark", "limit", "status"]);
          const limitArg = Number.parseInt(modifiers.limit ?? "", 10);
          const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(limitArg, 100) : 20;
          const rows = db.queryBenchmarkRuns({
            benchmark: modifiers.benchmark,
            status: modifiers.status,
            limit,
          });
          if (rows.length === 0) {
            ctx.send(input.entity, "No benchmark runs yet.");
            return;
          }
          const lines = [
            header(
              `Recent benchmark runs${modifiers.benchmark ? ` — ${modifiers.benchmark}` : ""} (${rows.length})`,
            ),
            separator(),
            `  ${dim("age".padStart(8))}  ${dim("score".padStart(6))}  ${dim("benchmark".padEnd(16))}  ${dim("ans/tot".padEnd(7))}  ${dim("agent".padEnd(18))}  ${dim("id")}`,
            ...rows.flatMap((row) => {
              const why = invalidReason(db, row);
              return why
                ? [formatRunLine(row), `            ${fmtStatus("INVALID", "warn")} ${dim(why)}`]
                : [formatRunLine(row)];
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "leaderboard": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: benchmark leaderboard <benchmark> [--limit N]");
            return;
          }
          const rawArgs = tokens.slice(2).join(" ");
          const { modifiers } = extractModifiers(rawArgs, ["limit"]);
          const limitArg = Number.parseInt(modifiers.limit ?? "", 10);
          const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(limitArg, 50) : 10;
          const rows = db.leaderboardBenchmark(name, limit);
          const refs = referenceScoresForBenchmark(name);
          if (rows.length === 0 && refs.length === 0) {
            ctx.send(input.entity, `No completed runs or reference scores for ${category(name)}.`);
            return;
          }
          const lines = [
            header(`Leaderboard — ${name}`),
            separator(),
            `  ${dim("rank")}  ${dim("score".padStart(6))}  ${dim("source".padEnd(12))}  ${dim("ans/tot".padEnd(7))}  ${dim("who".padEnd(36))}`,
          ];
          // Published reference scores (foundation models). These are the
          // bar Marina rows must beat.
          for (const r of refs) {
            const score = `${(r.score * 100).toFixed(1)}%`.padStart(6);
            const ans = r.n ? `N=${r.n}`.padEnd(7) : "full   ";
            const who = bold(r.modelId).padEnd(36);
            lines.push(
              `  ${dim("ref ")}  ${score}  ${dim("reference".padEnd(12))}  ${ans}  ${who}  ${dim(r.asOf)}`,
            );
          }
          if (refs.length > 0 && rows.length > 0) lines.push(dim("  ─── marina runs ───"));
          // Marina-measured runs.
          rows.forEach((row, i) => {
            const rank = `${(i + 1).toString().padStart(4)}.`;
            const score = row.score === null ? "-" : `${(row.score * 100).toFixed(1)}%`.padStart(6);
            const hash = row.config_hash.padEnd(12);
            const ans = row.total > 0 ? `${row.answered}/${row.total}`.padEnd(7) : "-      ";
            const agent = row.agent_id ? bold(row.agent_id) : dim("—");
            const ledger = ledgerColumns(row);
            lines.push(
              `  ${rank}  ${score}  ${hash}  ${ans}  ${agent.padEnd(36)}  ${fmtId(row.id)}${ledger}`,
            );
          });
          lines.push(...pooledLeaderboardLines(db, rows));
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "reference": {
          const arg = tokens[1];
          if (!arg) {
            // No filter — summarize all entries, grouped by model.
            const models = knownReferenceModels();
            if (models.length === 0) {
              ctx.send(input.entity, "No reference scores loaded.");
              return;
            }
            const lines = [
              header(
                `Reference scores (${REFERENCE_SCORES.length} entries, ${models.length} models)`,
              ),
              separator(),
            ];
            for (const m of models) {
              lines.push(bold(m));
              for (const r of referenceScoresForModel(m)) {
                const score = `${(r.score * 100).toFixed(1)}%`.padStart(6);
                const n = r.n ? `N=${r.n}` : "full";
                lines.push(
                  `  ${category(r.benchmark.padEnd(16))}  ${score}  ${dim(n.padEnd(7))}  ${dim(r.asOf)}  ${dim(r.sourceUrl)}`,
                );
              }
            }
            ctx.send(input.entity, lines.join("\n"));
            return;
          }
          // With argument: try it as a benchmark key first, then as a model id.
          const benchEntries = referenceScoresForBenchmark(arg);
          if (benchEntries.length > 0) {
            const lines = [
              header(`Reference scores — ${arg}`),
              separator(),
              `  ${dim("score".padStart(6))}  ${dim("N".padEnd(7))}  ${dim("model".padEnd(40))}  ${dim("asOf")}`,
            ];
            for (const r of benchEntries) {
              const score = `${(r.score * 100).toFixed(1)}%`.padStart(6);
              const n = r.n ? `N=${r.n}`.padEnd(7) : "full   ";
              lines.push(
                `  ${score}  ${n}  ${bold(r.modelId.padEnd(40))}  ${dim(r.asOf)}  ${dim(r.sourceUrl)}`,
              );
            }
            ctx.send(input.entity, lines.join("\n"));
            return;
          }
          const modelEntries = referenceScoresForModel(arg);
          if (modelEntries.length > 0) {
            const lines = [
              header(`Reference scores — ${arg}`),
              separator(),
              `  ${dim("benchmark".padEnd(16))}  ${dim("score".padStart(6))}  ${dim("N".padEnd(7))}  ${dim("asOf")}`,
            ];
            for (const r of modelEntries) {
              const score = `${(r.score * 100).toFixed(1)}%`.padStart(6);
              const n = r.n ? `N=${r.n}`.padEnd(7) : "full   ";
              lines.push(
                `  ${category(r.benchmark.padEnd(16))}  ${score}  ${n}  ${dim(r.asOf)}  ${dim(r.sourceUrl)}`,
              );
            }
            ctx.send(input.entity, lines.join("\n"));
            return;
          }
          ctx.send(
            input.entity,
            `No reference scores for "${arg}". Try: benchmark reference (no args to list all).`,
          );
          return;
        }

        case "compare-run": {
          const action = tokens[1]?.toLowerCase();
          if (!action || action === "status" || action === "list") {
            const id = action ? tokens[2] : undefined;
            if (!id) {
              const known = listCompareRuns();
              ctx.send(
                input.entity,
                known.length === 0
                  ? "No comparisons in this server since it started. Start one: benchmark compare-run <name> arms:bare,on cap:<usd>"
                  : [
                      header("Comparisons"),
                      separator(),
                      ...known.map(
                        (j) =>
                          `  ${fmtId(j.id)}  ${j.spec.benchmark}  ${j.spec.arms.join(" vs ")}  ×${j.spec.replicates}  ${fmtStatus(j.status.toUpperCase(), variantFromStatus(j.status))}  ${dim(`${formatAge(Date.now() - j.startedAt)} ago`)}`,
                      ),
                    ].join("\n"),
              );
              return;
            }
            const job = getCompareRun(id);
            const report = compareRunReport(db, id, job?.spec.arms);
            if (!job && !report) {
              ctx.send(input.entity, `No comparison ${fmtId(id)}.`);
              return;
            }
            ctx.send(input.entity, renderCompareRun(id, job, report));
            return;
          }
          const floor = rankFloorRefusal(
            entity,
            4,
            "benchmark compare-run requires rank 4 (builder). Every run burns real tokens — earn the rank via competence.",
          );
          if (floor) {
            ctx.send(input.entity, floor);
            return;
          }
          const name = BENCHMARKS[action] ? action : undefined;
          if (!name) {
            ctx.send(
              input.entity,
              `Unknown benchmark: ${tokens[1]}. Known: ${Object.keys(BENCHMARKS).join(", ")}`,
            );
            return;
          }
          const str = { type: "string" as const };
          const { values, rest, errors } = parseModifiers(tokens.slice(2), {
            arms: str,
            replicates: str,
            cap: str,
            limit: str,
            seed: str,
            model: str,
            judge: str,
            concurrency: str,
            partition: str,
          });
          const v = (k: string) =>
            typeof values[k] === "string" ? (values[k] as string) : undefined;
          const problems = [...errors, ...rest.map((r) => `unexpected "${r}"`)];
          const arms = parseArms(v("arms"));
          if ("error" in arms) problems.push(arms.error);
          const cap = v("cap") === undefined ? Number.NaN : Number(v("cap")?.replace(/^\$/, ""));
          if (!(Number.isFinite(cap) && cap > 0))
            problems.push("cap:<usd> is required — the spend cap for the whole comparison");
          const int = (k: string, min: number, max: number) => {
            const raw = v(k);
            if (raw === undefined) return undefined;
            const n = Number(raw);
            if (!Number.isInteger(n) || n < min || n > max) {
              problems.push(`${k}: a whole number from ${min} to ${max}`);
              return undefined;
            }
            return n;
          };
          const replicates =
            int("replicates", 1, MAX_COMPARE_REPLICATES) ?? DEFAULT_COMPARE_REPLICATES;
          const limit = int("limit", 1, 100_000);
          const seed = int("seed", 0, 2 ** 31 - 1);
          const concurrency = int("concurrency", 1, 64);
          const partition = parsePartition(v("partition"));
          if (v("partition") !== undefined && !partition)
            problems.push("partition: holdout or tune");
          if (problems.length > 0 || "error" in arms) {
            ctx.send(input.entity, `benchmark compare-run: ${problems.join("; ")}`);
            return;
          }
          if (!runner.datasetReady(name)) {
            ctx.send(
              input.entity,
              `Dataset not cached for ${name}. Run "bun run benchmarks/download-all.ts".`,
            );
            return;
          }
          const model = v("model");
          const job = startCompareRun(
            runner,
            {
              benchmark: name,
              arms,
              replicates,
              capUsd: cap,
              ...(limit !== undefined ? { limit } : {}),
              ...(seed !== undefined ? { seed } : {}),
              ...(model ? { model } : {}),
              ...(v("judge") ? { judgeModel: v("judge") } : {}),
              ...(concurrency !== undefined ? { concurrency } : {}),
              ...(partition ? { partition } : {}),
              owner: entity.id,
            },
            (done) => {
              const report = compareRunReport(db, done.id, done.spec.arms);
              deps.logEvent?.({
                type: "feed_event",
                kind:
                  done.status === "completed"
                    ? "benchmark_compare_completed"
                    : "benchmark_compare_failed",
                entity: entity.id,
                ref: done.id,
                summary: `benchmark compare-run ${done.spec.benchmark} ${done.spec.arms.join(" vs ")} ${done.status}${report?.paired ? ` — delta ${(report.paired.delta * 100).toFixed(1)} pts [${(report.paired.low * 100).toFixed(1)}, ${(report.paired.high * 100).toFixed(1)}]` : ""}`,
                payload: {
                  id: done.id,
                  benchmark: done.spec.benchmark,
                  arms: done.spec.arms,
                  replicates: done.spec.replicates,
                  runs: done.slots.map((s) => s.runId ?? null),
                },
                timestamp: Date.now(),
              });
              ctx.send(input.entity, renderCompareRun(done.id, done, report));
            },
          );
          deps.logEvent?.({
            type: "feed_event",
            kind: "benchmark_compare_started",
            entity: entity.id,
            ref: job.id,
            summary: `benchmark compare-run ${name} ${arms.join(" vs ")} ×${replicates} started`,
            payload: { id: job.id, benchmark: name, arms, replicates, capUsd: cap },
            timestamp: job.startedAt,
          });
          const lines = [
            `Comparison started: ${fmtId(job.id)} — ${name}, ${arms[0]} vs ${arms[1]}, ${replicates} replicate${replicates === 1 ? "" : "s"} each, cap $${cap.toFixed(2)} ($${(cap / (2 * replicates)).toFixed(2)} per run).`,
            "  Each replicate runs both arms at once; the report arrives here when every run has finished.",
            `  benchmark compare-run status ${job.id}   — progress and results`,
          ];
          if (replicates < 2)
            lines.push(
              `  ${fmtStatus("WARN", "warn")} 1 replicate — run-to-run variance stays unmeasured; a single draw can move by more than a small effect.`,
            );
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "compare": {
          const [a, b] = [tokens[1], tokens[2]];
          if (!a || !b) {
            ctx.send(input.entity, "Usage: benchmark compare <runA> <runB>");
            return;
          }
          const runA = db.getBenchmarkRun(a);
          const runB = db.getBenchmarkRun(b);
          if (!runA || !runB) {
            ctx.send(input.entity, `No run ${runA ? b : a}.`);
            return;
          }
          const invalid = [runA, runB].find((r) => r.status === "invalid");
          if (invalid) {
            ctx.send(
              input.entity,
              `Run ${invalid.id} is invalid (${invalidReason(db, invalid)}) — invalid runs are never compared. \`benchmark revalidate\` restores it if the reason no longer holds.`,
            );
            return;
          }
          const itemsA = db.getBenchmarkItems(a);
          const itemsB = db.getBenchmarkItems(b);
          if (itemsA.length === 0 || itemsB.length === 0) {
            ctx.send(
              input.entity,
              `No item outcomes recorded for ${itemsA.length === 0 ? a : b} — a paired comparison needs per-item results (import them with \`bun run benchmark:import\`).`,
            );
            return;
          }
          const c = compareRuns(runA, itemsA, runB, itemsB);
          const line = (tag: string, run: BenchmarkRunRow, sum: typeof c.a) =>
            `  ${tag}  ${bold(runLabel(run)).padEnd(32)}  ${pct(sum.accuracy)} (${sum.correct}/${sum.n})  CI [${pct(sum.ciLow)}, ${pct(sum.ciHigh)}]  ${usd(sum.costPerItemUsd ?? perItemCost(run))}/item  ${fmtId(run.id)}`;
          const lines = [
            header(
              `Compare — ${runA.benchmark}${runA.benchmark === runB.benchmark ? "" : ` vs ${runB.benchmark}`}`,
            ),
            separator(),
            ...c.warnings.map((w) => `  ${fmtStatus("WARN", "warn")} ${w}`),
            line("A", runA, c.a),
            line("B", runB, c.b),
            `  shared ${c.shared}  (only A ${c.onlyA}, only B ${c.onlyB})`,
            `  A right / B wrong ${c.aWins}   A wrong / B right ${c.bWins}   exact McNemar p=${c.p.toFixed(3)}`,
            `  $/item delta (B − A): ${c.costDeltaPerItemUsd === null ? dim("unpriced") : usd(c.costDeltaPerItemUsd, true)}`,
            ...pooledCompareLines(loadReplicateGroup(db, runA), loadReplicateGroup(db, runB)),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "replicates": {
          const id = tokens[1];
          if (!id) {
            ctx.send(input.entity, "Usage: benchmark replicates <run>");
            return;
          }
          const run = db.getBenchmarkRun(id);
          if (!run) {
            ctx.send(input.entity, `No run ${id}.`);
            return;
          }
          const why = invalidReason(db, run);
          const body = renderReplicates(loadReplicateGroup(db, run));
          ctx.send(
            input.entity,
            why
              ? `${fmtStatus("INVALID", "warn")} ${id} is invalid (${why}) and is excluded from its group.\n${body}`
              : body,
          );
          return;
        }

        case "invalidate":
        case "revalidate": {
          const id = tokens[1];
          const reason = freeTextModifier(tokens.slice(2), "reason");
          if (!id || !reason) {
            ctx.send(input.entity, `Usage: benchmark ${sub} <run> reason:<text>`);
            return;
          }
          const why = reason.slice(0, MAX_VALIDITY_REASON);
          const result = setValidity(db, entity, sub, id, why, deps.logEvent);
          ctx.send(input.entity, result.message);
          if (result.changed && sub === "invalidate") {
            // Lessons learned from (or comparing against) the run measured the
            // infrastructure, not the target: retire them through the audited path.
            const r = await retireLessonsForRun(db, id, {
              reason: why,
              by: db.durableEntityKey(entity.id),
            });
            if (r.retired.length || r.failed.length || r.error)
              ctx.send(
                input.entity,
                `  Lessons citing ${id}: ${r.retired.length} retired${r.failed.length ? `, ${r.failed.length} failed` : ""}${r.error ? ` (${r.error})` : ""}.`,
              );
            // So were the per-item outcome notes the runner deposited for it.
            const n = retireOutcomeNotesForRun(db, id);
            if (n.retired || n.ambiguous || n.error)
              ctx.send(
                input.entity,
                `  Outcome notes citing ${id}: ${n.retired} retired${n.ambiguous ? `, ${n.ambiguous} left (legacy prefix shared with another run)` : ""}${n.error ? ` (${n.error})` : ""}.`,
              );
          }
          return;
        }

        case "purge-content-notes": {
          const parsed = parseModifiers(tokens.slice(1), { confirm: { type: "bool" } });
          if (parsed.errors.length || parsed.rest.length) {
            ctx.send(input.entity, "Usage: benchmark purge-content-notes [confirm:yes]");
            return;
          }
          ctx.send(
            input.entity,
            purgeContentNotes(db, entity, parsed.values.confirm === true, deps.logEvent),
          );
          return;
        }

        case "frontier": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: benchmark frontier <benchmark>");
            return;
          }
          const rows = db.leaderboardBenchmark(name, 100);
          const points = rows
            .map((row) => ({ row, accuracy: row.score ?? 0, costPerItemUsd: perItemCost(row) }))
            .filter(
              (p): p is { row: BenchmarkRunRow; accuracy: number; costPerItemUsd: number } =>
                p.costPerItemUsd !== null,
            )
            .map((p) => ({ ...p, id: p.row.id }));
          if (points.length === 0) {
            ctx.send(
              input.entity,
              `No priced runs for ${category(name)} — the frontier needs cost.`,
            );
            return;
          }
          const frontier = paretoFrontier(points);
          const lines = [
            header(
              `Frontier — ${name} (accuracy vs $/item, ${frontier.length} of ${points.length} priced runs)`,
            ),
            separator(),
            ...frontier.map(
              (p) =>
                `  ${pct(p.accuracy)}  ${usd(p.costPerItemUsd)}/item  n=${p.row.n ?? p.row.total}  ${bold(runLabel(p.row))}  ${fmtId(p.row.id)}`,
            ),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "participants": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: benchmark participants <benchmark>");
            return;
          }
          const items = db.getBenchmarkItemsForBenchmark(name);
          const { credit, withParticipants } = participantCredit(items);
          if (withParticipants === 0) {
            ctx.send(
              input.entity,
              items.length === 0
                ? `No item outcomes recorded for ${category(name)}.`
                : `No participants recorded on ${items.length} ${category(name)} item outcomes — execution is unknown, not proven inactive. Participant credit needs each item's source trace.`,
            );
            return;
          }
          const lines = [
            header(
              `Participants — ${name} (${withParticipants} of ${items.length} items attributed)`,
            ),
            separator(),
            "Participation is association with outcomes, not causal credit for improving them.",
            ...credit.map(
              (c) =>
                `  ${dim(c.kind.padEnd(5))}  ${bold(c.name).padEnd(40)}  ${pct(c.accuracy)} (${c.correct}/${c.items})  ${c.costUsd === null ? dim("unpriced") : usd(c.costUsd)}`,
            ),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "defaults": {
          const rows = db.listBenchmarkDefaults();
          // How each default was last resolved in this process (resolveDefault).
          const resolved = recentResolutions().map(
            (r) => `  ${(r.surface ? `${r.surface} ` : "") + r.slot}: ${r.source} ${dim(r.reason)}`,
          );
          const resolvedBlock = resolved.length
            ? [
                "",
                "  last resolutions (env > board slot > family slot > upstream > built-in):",
                ...resolved,
              ]
            : [];
          if (rows.length === 0) {
            ctx.send(
              input.entity,
              [
                "No promoted defaults yet. Seed a slot with `benchmark promote <slot> <run>`.",
                ...resolvedBlock,
              ].join("\n"),
            );
            return;
          }
          const lines = [header(`Promoted defaults (${rows.length})`), separator()];
          for (const r of rows) {
            const history = db.listBenchmarkPromotions(r.slot);
            const won = history.filter((h) => h.outcome === "promoted").length;
            const refused = history.filter((h) => h.outcome === "refused").length;
            lines.push(
              `  ${bold(r.slot).padEnd(36)}  incumbent ${fmtId(r.incumbent_run_id ?? "—")}  holdout ${pct(r.holdout_fraction).trim()}  promotions ${won}  refused ${refused}  ${dim(`${formatAge(Date.now() - r.updated_at)} ago by ${r.updated_by ?? "?"}`)}`,
              `    ${dim(r.value_json.length > 160 ? `${r.value_json.slice(0, 157)}...` : r.value_json)}`,
            );
          }
          lines.push(...resolvedBlock);
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "eligible": {
          ctx.send(input.entity, renderEligible(db, tokens[1]));
          return;
        }

        case "challenge":
        case "promote": {
          const [slot, runId] = [tokens[1], tokens[2]];
          if (!slot || !runId) {
            ctx.send(
              input.entity,
              `Usage: benchmark ${sub} <slot> <run> [--max-cost-ratio R]${sub === "promote" ? " [--holdout F]" : ""}`,
            );
            return;
          }
          const { modifiers } = extractModifiers(tokens.slice(3).join(" "), [
            "max-cost-ratio",
            "holdout",
          ]);
          const maxCostRatio = modifiers["max-cost-ratio"]
            ? Number.parseFloat(modifiers["max-cost-ratio"])
            : undefined;
          if (maxCostRatio !== undefined && !(maxCostRatio > 0)) {
            ctx.send(input.entity, "--max-cost-ratio must be a positive number.");
            return;
          }
          if (sub === "challenge") {
            ctx.send(input.entity, renderChallenge(db, slot, runId, maxCostRatio));
            return;
          }
          ctx.send(
            input.entity,
            promote(db, entity, slot, runId, {
              ...(maxCostRatio !== undefined ? { maxCostRatio } : {}),
              ...(modifiers.holdout ? { holdout: modifiers.holdout } : {}),
            }),
          );
          return;
        }

        default:
          ctx.send(input.entity, HELP);
      }
    },
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`.padStart(6);
}

function usd(x: number | null, signed = false): string {
  if (x === null) return dim("—");
  const sign = signed && x > 0 ? "+" : "";
  return `${sign}$${x.toFixed(Math.abs(x) < 0.01 ? 4 : 3)}`;
}

/** A run's cost per item from its ledger columns, or null when unpriced. */
function perItemCost(row: BenchmarkRunRow): number | null {
  const n = row.n ?? row.total;
  return typeof row.cost_usd === "number" && n > 0 ? row.cost_usd / n : null;
}

/** The ledger columns of a leaderboard row (empty for pre-ledger runs). */
function ledgerColumns(row: BenchmarkRunRow): string {
  if (typeof row.ci_low !== "number" || typeof row.ci_high !== "number") return "";
  const cost = perItemCost(row);
  return `  ${dim(`n=${row.n ?? row.total} CI [${pct(row.ci_low).trim()}, ${pct(row.ci_high).trim()}]`)}  ${cost === null ? "" : `${usd(cost)}/item  `}${dim(runLabel(row))}`;
}

// ─── Run validity ──────────────────────────────────────────────────────────

/**
 * The free text of a `key:<text>` modifier to the end of the input: `key:a b c`,
 * `key=a b c`, `--key a b c` or `--key=a b c` all give "a b c" (the tokenizer
 * has no quotes, so a reason is everything after its key).
 */
export function freeTextModifier(tokens: readonly string[], key: string): string | undefined {
  const re = new RegExp(`^(?:--)?${key}(?:[:=](.*))?$`, "i");
  for (let i = 0; i < tokens.length; i++) {
    const m = re.exec(tokens[i] ?? "");
    if (!m) continue;
    const text = [m[1] ?? "", ...tokens.slice(i + 1)].join(" ").trim();
    return text || undefined;
  }
  return undefined;
}

/** The validity block of `benchmark result`: the reason and the audit history. */
function validityLines(db: MarinaDB, row: BenchmarkRunRow): string[] {
  const history = db.listBenchmarkRunValidity(row.id);
  if (history.length === 0) return [];
  const lines: string[] = [];
  const why = invalidReason(db, row);
  if (why) {
    lines.push(
      `  ${bold("INVALID")}:     ${why} — excluded from leaderboard, frontier, compare, replicates, participants, promotion and route evidence`,
    );
  }
  lines.push(`  ${bold("validity")}:`);
  for (const h of history) {
    lines.push(
      `    ${dim(new Date(h.created_at).toISOString())}  ${h.action}  ${dim(`by ${h.actor ?? h.source} (${h.source})`)}  ${h.reason}`,
    );
  }
  return lines;
}

/**
 * `benchmark purge-content-notes [confirm:yes]`: the dry run (rank 0) reports
 * counts per pool, never content; applying needs role.edit, retires through
 * `note delete`'s audited path and logs one feed event.
 */
function purgeContentNotes(
  db: MarinaDB,
  entity: Entity,
  apply: boolean,
  logEvent: ((event: EngineEvent) => void) | undefined,
): string {
  const preview = purgeBenchmarkContentNotes(db);
  if (preview.error) return `Content-note scan failed: ${preview.error}`;
  if (preview.found === 0)
    return "No benchmark content notes: no benchmark:<name> pool holds item text.";
  const pools = preview.pools.map((p) => `  ${category(p.name)}  ${p.notes} note(s)`);
  if (!apply)
    return [
      `${preview.found} benchmark content note(s) would be retired (each holds an item's question and answer):`,
      ...pools,
      "Repeat with confirm:yes to retire them (needs role.edit; audited, nothing is erased).",
    ].join("\n");
  const gate = checkRoleEdit(db, entity, "benchmark purge-content-notes");
  if ("reason" in gate) return gate.reason;
  const done = purgeBenchmarkContentNotes(db, { apply: true });
  if (done.retired) gate.record();
  logEvent?.({
    type: "feed_event",
    kind: "benchmark_content_notes_retired",
    entity: entity.id,
    summary: `benchmark content notes retired: ${done.retired} of ${done.found}${done.failed ? `, ${done.failed} failed` : ""}`,
    payload: {
      retired: done.retired,
      failed: done.failed,
      pools: done.pools,
      actor: db.durableEntityKey(entity.id),
    },
    timestamp: Date.now(),
  });
  return [
    `Retired ${done.retired} of ${done.found} benchmark content note(s)${done.failed ? ` (${done.failed} failed)` : ""}${done.error ? ` (${done.error})` : ""}:`,
    ...done.pools.map((p) => `  ${category(p.name)}  ${p.notes} note(s)`),
  ].join("\n");
}

/** `benchmark invalidate|revalidate`: role.edit, audited, never deletes anything. */
function setValidity(
  db: MarinaDB,
  entity: Entity,
  action: "invalidate" | "revalidate",
  runId: string,
  reason: string,
  logEvent: ((event: EngineEvent) => void) | undefined,
): { message: string; changed: boolean } {
  const no = (message: string) => ({ message, changed: false });
  const gate = checkRoleEdit(db, entity, `benchmark ${action} ${runId}`);
  if ("reason" in gate) return no(gate.reason);
  const run = db.getBenchmarkRun(runId);
  if (!run) return no(`No run ${runId}.`);
  // Re-admitting your own run as valid is self-attestation; retiring it is not.
  const author = run.agent_id;
  if (
    action === "revalidate" &&
    author &&
    (author === entity.id || db.durableEntityKey(author) === db.durableEntityKey(entity.id))
  ) {
    return no(
      `Refused: you ran ${runId}. Someone else must revalidate it — self-attestation is never accepted.`,
    );
  }
  const now = Date.now();
  const res = db.setBenchmarkRunValidity({
    run_id: runId,
    action,
    reason,
    // Append-only: the opaque durable account key, never a display name.
    actor: db.durableEntityKey(entity.id),
    source: "in-world",
    created_at: now,
  });
  if (!res.ok) return no(res.error);
  gate.record();
  logEvent?.({
    type: "feed_event",
    kind: action === "invalidate" ? "benchmark_invalidated" : "benchmark_revalidated",
    entity: entity.id,
    ref: runId,
    summary: `benchmark run ${runId} (${run.benchmark}) ${action}d: ${reason.slice(0, 200)}`,
    payload: { id: runId, benchmark: run.benchmark, reason, source: "in-world" },
    timestamp: now,
  });
  return {
    changed: true,
    message:
      action === "invalidate"
        ? `Invalidated ${runId} (${run.benchmark}, ${runLabel(run)}): ${reason}\n  Its items are kept; every ranking, pooling, comparison, promotion and route evidence now skips it. Audit row ${res.id}.`
        : `Revalidated ${runId} (${run.benchmark}, ${runLabel(run)}): ${reason}\n  It counts again in every ledger reader. Audit row ${res.id}.`,
  };
}

// ─── Earned promotion of defaults ──────────────────────────────────────────

function statsLine(s: SplitStats): string {
  if (s.pooled) {
    const pl = s.pooled;
    return `  ${s.split}: ${s.n} paired items, pooled ×${pl.challengerReplicates} vs ×${pl.incumbentReplicates} replicates  challenger ${pct(pl.challengerAccuracy).trim()}  incumbent ${pct(pl.incumbentAccuracy).trim()}  delta ${(s.delta * 100).toFixed(1)} pts  95% two-stage bootstrap [${(s.low * 100).toFixed(1)}, ${(s.high * 100).toFixed(1)}]  p=${pl.p.toFixed(3)}`;
  }
  return `  ${s.split}: ${s.n} paired  challenger ${s.challengerCorrect}  incumbent ${s.incumbentCorrect}  (only challenger ${s.challengerOnly}, only incumbent ${s.incumbentOnly})  delta ${(s.delta * 100).toFixed(1)} pts  95% [${(s.low * 100).toFixed(1)}, ${(s.high * 100).toFixed(1)}]`;
}

function costLine(e: ChallengeEvaluation): string {
  const c = e.costPerItem;
  if (c.challenger === null || c.incumbent === null) return `  $/item: ${dim("unpriced")}`;
  return `  $/item: challenger ${usd(c.challenger)}  incumbent ${usd(c.incumbent)}  ratio ${c.ratio === null ? "—" : `${c.ratio.toFixed(2)}×`}`;
}

/** `benchmark eligible [board]`: what would earn a slot now (read-only; files nothing). */
export function renderEligible(db: MarinaDB, board: string | undefined): string {
  const rows = eligiblePromotions(db, board ? { board } : {});
  if (rows.length === 0) {
    return `No configuration to contest a promoted slot${board ? ` on ${board}` : ""}: a slot needs an incumbent and a completed run of another configuration on its benchmark.`;
  }
  const eligible = rows.filter((r) => r.eligible);
  const lines = [
    header(`Eligible to promote (${eligible.length} of ${rows.length})`),
    separator(),
    dim(
      "  Read-only: nothing is filed. Each is judged by the promotion rule on the holdout, with every other candidate read here counted as tried.",
    ),
  ];
  for (const r of eligible) {
    const e = r.evaluation!;
    lines.push(
      `  ${fmtStatus("ELIGIBLE", "done")} ${bold(r.slot)}  ${fmtId(r.runId)} vs ${fmtId(r.incumbentRunId ?? "—")}  delta ${(e.stats.delta * 100).toFixed(1)} pts  95% [${(e.stats.low * 100).toFixed(1)}, ${(e.stats.high * 100).toFixed(1)}]  bar ${((r.chargedMargin ?? e.margin) * 100).toFixed(1)} pts`,
      `    ${dim(`file it: benchmark promote ${r.slot} ${r.runId} (needs role.edit; never by the author of a pooled run)`)}`,
    );
  }
  for (const r of rows.filter((x) => !x.eligible)) {
    lines.push(`  ${dim("not yet")}  ${r.slot}  ${fmtId(r.runId)}  ${dim(r.reasons[0] ?? "")}`);
  }
  return lines.join("\n");
}

/** Dry run: the SELECTION split only — the holdout stays unread until a promotion attempt. */
function renderChallenge(
  db: MarinaDB,
  slot: string,
  runId: string,
  maxCostRatio: number | undefined,
): string {
  const found = lookupChallenge(
    db,
    slot,
    runId,
    "selection",
    maxCostRatio !== undefined ? { maxCostRatio } : {},
  );
  if (found.kind === "error") return found.message;
  if (found.kind === "seed") {
    return `Slot ${slot} has no ${found.invalidIncumbent ? `valid incumbent (${found.invalidIncumbent.id} was invalidated, and no earlier one is valid)` : "incumbent"}: \`benchmark promote ${slot} ${runId}\` seeds it with this run (needs role.edit and enough replicates; it has ${found.replicates}). Its holdout is ${pct(found.holdoutFraction).trim()} of items by item-id hash.`;
  }
  const e = found.evaluation;
  const blockers = e.reasons.filter((r) => !r.startsWith("selection split"));
  return [
    header(`Challenge — ${slot}`),
    separator(),
    `  challenger ${bold(runLabel(found.challenger))} ${fmtId(found.challenger.id)}`,
    `  incumbent  ${bold(runLabel(found.incumbent))} ${fmtId(found.incumbent.id)}`,
    ...(found.invalidIncumbent
      ? [
          `  ${dim(`(${found.invalidIncumbent.id} was invalidated — the challenger must beat the best earlier incumbent still valid)`)}`,
        ]
      : []),
    `  replicates: challenger ${found.replicates.challenger}, incumbent ${found.replicates.incumbent} (promotion needs ≥ ${found.replicates.minimum} of the challenger)`,
    statsLine(e.stats),
    costLine(e),
    `  to promote: holdout interval above 0 and delta ≥ ${(e.margin * 100).toFixed(1)} pts (${e.triedBefore} earlier attempt(s)); the holdout is read only by \`benchmark promote\`, and each attempt raises the bar`,
    ...blockers.map((r) => `  ${fmtStatus("BLOCK", "warn")} ${r}`),
  ].join("\n");
}

/** Seed an empty slot, or promote a challenger that earned it on the holdout. */
function promote(
  db: MarinaDB,
  entity: Entity,
  slot: string,
  runId: string,
  opts: { maxCostRatio?: number; holdout?: string },
): string {
  const gate = checkRoleEdit(db, entity, `benchmark promote ${slot}`);
  if ("reason" in gate) return gate.reason;
  // The history is append-only, so it stores the opaque durable account key —
  // never a display name that account erasure would have to rewrite.
  const filed = fileSlotPromotion(db, {
    slot,
    runId,
    actor: {
      key: db.durableEntityKey(entity.id),
      entityId: entity.id,
      keyOf: (id) => db.durableEntityKey(id),
    },
    ...(opts.maxCostRatio !== undefined ? { maxCostRatio: opts.maxCostRatio } : {}),
    ...(opts.holdout ? { holdout: Number.parseFloat(opts.holdout) } : {}),
  });
  if (filed.kind === "error") return filed.message;
  if (filed.kind === "seeded") {
    gate.record();
    return `${filed.invalidIncumbent ? `Re-seeded ${slot} (its incumbent ${filed.invalidIncumbent.id} was invalidated and no earlier incumbent is valid)` : `Seeded ${slot}`} with ${runLabel(filed.challenger)} (${runId}, ${filed.replicates} replicate(s)); holdout ${pct(filed.holdoutFraction).trim()} of items. Later challengers must earn it.`;
  }
  const e = filed.evaluation;
  const body = [statsLine(e.stats), costLine(e)];
  if (filed.kind === "refused") {
    return [
      filed.invalidIncumbent
        ? `Not promoted — the challenger did not beat ${filed.incumbent.id}, the best earlier incumbent of ${slot} still valid (${filed.invalidIncumbent.id} was invalidated). Recorded as attempt ${e.triedBefore + 1}.`
        : `Not promoted — ${slot} keeps ${filed.incumbent.id}. Recorded as attempt ${e.triedBefore + 1}.`,
      ...body,
      ...e.reasons.map((r) => `  ${fmtStatus("BLOCK", "warn")} ${r}`),
    ].join("\n");
  }
  gate.record();
  return [
    `Promoted ${runLabel(filed.challenger)} (${runId}) to ${slot}, replacing ${filed.invalidIncumbent ? `the invalidated ${filed.invalidIncumbent.id} (beat ${filed.incumbent.id}, the best earlier incumbent still valid)` : filed.incumbent.id}.`,
    ...body,
    `  margin ${(e.margin * 100).toFixed(1)} pts (${e.triedBefore} earlier attempt(s))`,
  ].join("\n");
}

// ─── Replicates ────────────────────────────────────────────────────────────

/** Replicate groups among leaderboard rows with ≥ 2 runs: pooled mean ± between-run SD. */
function pooledLeaderboardLines(db: MarinaDB, rows: readonly BenchmarkRunRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const key = replicateGroupOf(row);
    if (seen.has(key) || key.startsWith("run:")) continue;
    seen.add(key);
    const g = loadReplicateGroup(db, row);
    if (g.replicates.length < 2) continue;
    const s = pooledSummary(g);
    out.push(
      `  ${dim("pooled")}  ${pct(s.meanAccuracy)}  ${dim(`×${s.replicates} replicates on ${s.items} items  ±${(s.betweenSd * 100).toFixed(1)} pts between runs  unanimous ${pct(s.unanimous).trim()}`)}  ${dim(runLabel(row))}  ${fmtId(key)}`,
    );
  }
  return out.length > 0 ? [dim("  ─── replicate groups (pooled) ───"), ...out] : [];
}

/** A comparison's progress and, once its runs are in the ledger, its report. */
export function renderCompareRun(
  id: string,
  job: CompareRunJob | undefined,
  report: CompareRunReport | null,
): string {
  const lines = [
    header(
      `Comparison ${id}${job ? ` — ${job.spec.benchmark}, ${job.spec.arms[0]} vs ${job.spec.arms[1]}` : report?.benchmark ? ` — ${report.benchmark}` : ""}`,
    ),
    separator(),
  ];
  if (job) {
    const started = job.slots.filter((s) => s.runId).length;
    lines.push(
      `  ${fmtStatus(job.status.toUpperCase(), variantFromStatus(job.status))}  ${started}/${job.slots.length} runs started  ${dim(`${formatAge(Date.now() - job.startedAt)} ago`)}`,
    );
    for (const s of job.slots.filter((x) => x.error))
      lines.push(`  ${fmtStatus("FAIL", "fail")} ${s.arm} replicate ${s.replicate}: ${s.error}`);
  }
  if (!report) return lines.join("\n");
  const arm = (tag: string, a: CompareRunReport["a"]) => {
    const bad = a.runs.filter((r) => r.status !== "completed" && r.status !== "running");
    const running = a.runs.filter((r) => r.status === "running").length;
    return [
      `  ${tag} ${bold(a.arm)}  ${a.valid.length} valid run${a.valid.length === 1 ? "" : "s"}${running ? `, ${running} running` : ""}${bad.length ? `, ${bad.length} failed or invalid` : ""}`,
      a.attempts > 0
        ? `     ${pct(a.accuracy).trim()} (${a.successes}/${a.attempts} item-attempts)  Wilson 95% [${pct(a.wilsonLow).trim()}, ${pct(a.wilsonHigh).trim()}]`
        : `     ${dim("no item outcomes yet")}`,
      `     spend ${usd(a.costUsd)}  per success ${a.costPerSuccessUsd === null ? dim(a.costUsd === null ? "unpriced" : "no successes") : usd(a.costPerSuccessUsd)}  ${dim(a.measured.join(", ") || "model@source unknown")}`,
      ...bad.map((r) => `     ${fmtStatus(r.status.toUpperCase(), "warn")} ${fmtId(r.id)}`),
    ];
  };
  lines.push(...arm("A", report.a), ...arm("B", report.b));
  for (const w of report.warnings) lines.push(`  ${fmtStatus("WARN", "warn")} ${w}`);
  const p = report.paired;
  if (p) {
    lines.push(
      `  ${bold("paired")}  A − B ${(p.delta * 100).toFixed(1)} pts  95% two-stage bootstrap [${(p.low * 100).toFixed(1)}, ${(p.high * 100).toFixed(1)}]  p=${p.p.toFixed(3)}  on ${p.items} common items, ×${p.a.replicates} vs ×${p.b.replicates}`,
      `    single-pair McNemar p across ${p.pairP.pairs} replicate pair(s): ${p.pairP.min.toFixed(3)}–${p.pairP.max.toFixed(3)}`,
      `    ${p.low > 0 ? "A is ahead" : p.high < 0 ? "B is ahead" : "no difference shown"} at 95%${p.replicated ? "" : " — not replicated: run-to-run variance is unmeasured"}`,
    );
  }
  lines.push(
    `  ${dim("Wilson intervals pool every replicate's items, so they understate run-to-run variance; the paired interval is the test.")}`,
  );
  return lines.join("\n");
}

/** The pooled comparison of two runs' replicate groups, or the "not replicated" flag. */
export function pooledCompareLines(a: LoadedGroup, b: LoadedGroup): string[] {
  const ka = a.replicates.length;
  const kb = b.replicates.length;
  if (ka < 2 && kb < 2) {
    return [
      `  ${fmtStatus("WARN", "warn")} 1 replicate each — not replicated: this p is one draw. Re-run both (same items and judge, \`--replicates N\`) before drawing a conclusion.`,
    ];
  }
  if (a.group === b.group) {
    return [
      `  ${dim(`A and B are replicates of one group (${ka} runs) — see \`benchmark replicates\``)}`,
    ];
  }
  const c = comparePooledGroups(a, b);
  const lines = [
    `  ${bold("pooled")}  A ×${ka} vs B ×${kb} replicates on ${c.items} items common to every run`,
    `    A ${pct(c.a.meanAccuracy).trim()} (±${(c.a.betweenSd * 100).toFixed(1)} pts between runs, unanimous ${pct(c.a.unanimous).trim()})   B ${pct(c.b.meanAccuracy).trim()} (±${(c.b.betweenSd * 100).toFixed(1)} pts, unanimous ${pct(c.b.unanimous).trim()})`,
    `    delta A − B ${(c.delta * 100).toFixed(1)} pts  95% two-stage bootstrap [${(c.low * 100).toFixed(1)}, ${(c.high * 100).toFixed(1)}]  p=${c.p.toFixed(3)}  (${c.resamples} resamples of runs, then items)`,
    `    single-pair McNemar p across ${c.pairP.pairs} replicate pair(s): ${c.pairP.min.toFixed(3)}–${c.pairP.max.toFixed(3)}`,
  ];
  if (!c.replicated) {
    lines.push(
      `    ${fmtStatus("WARN", "warn")} ${ka < 2 ? "A" : "B"} has 1 replicate — not replicated; its run-to-run variance is unmeasured.`,
    );
  }
  for (const w of [...a.warnings.map((x) => `A: ${x}`), ...b.warnings.map((x) => `B: ${x}`)]) {
    lines.push(`    ${fmtStatus("WARN", "warn")} ${w}`);
  }
  return lines;
}

/** One replicate group: its runs, pooled accuracy, between-run SD and agreement. */
function renderReplicates(g: LoadedGroup): string {
  if (g.runs.length === 0) return "No item outcomes recorded for this run's group.";
  const s = pooledSummary(g);
  const lines = [
    header(`Replicates — ${g.group}`),
    separator(),
    ...g.runs.map(
      (r, i) =>
        `  ${String(i + 1).padStart(2)}.  ${pct(s.replicateAccuracies[i] ?? 0)}  ${fmtId(r.id)}  ${dim(runLabel(r))}  ${dim(`${formatAge(Date.now() - r.started_at)} ago`)}`,
    ),
    `  pooled ${pct(s.meanAccuracy).trim()} (majority ${pct(s.majorityAccuracy).trim()}) on ${s.items} items common to every run`,
    `  between runs: SD ${(s.betweenSd * 100).toFixed(1)} pts; unanimous on ${pct(s.unanimous).trim()} of items; mean pairwise agreement ${pct(s.pairwiseAgreement).trim()}`,
  ];
  if (g.runs.length < 2) {
    lines.push(
      `  ${fmtStatus("WARN", "warn")} 1 replicate — not replicated. Re-run with the same target, items and judge (\`--replicates N\`).`,
    );
  }
  for (const w of g.warnings) lines.push(`  ${fmtStatus("WARN", "warn")} ${w}`);
  return lines.join("\n");
}
