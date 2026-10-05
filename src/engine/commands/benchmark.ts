// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parsePartition } from "../../../benchmarks/partition";
import {
  knownReferenceModels,
  REFERENCE_SCORES,
  referenceScoresForBenchmark,
  referenceScoresForModel,
} from "../../../benchmarks/reference-scores";
import { retireLessonsForRun } from "../../learning/intake";
import { bold, category, dim, status as fmtStatus, header, separator } from "../../net/ansi";
import type { BenchmarkRunRow, MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
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
import { type ChallengeEvaluation, lookupChallenge, type SplitStats } from "../benchmark-promotion";
import {
  comparePooledGroups,
  type LoadedGroup,
  loadReplicateGroup,
  pooledSummary,
  replicateGroupOf,
} from "../benchmark-replicates";
import { BENCHMARKS, type BenchmarkRunner, type BenchmarkSubject } from "../benchmark-runner";
import { extractModifiers, resolveMultiWordName } from "../parse-input";
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
  benchmark run <name> [--limit N] [--seed N] [--model M] [--judge M] [--concurrency N] [--partition holdout|tune]
                                                   — kick off one run
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
  benchmark replicates <run>                       — the run's replicate group: each run, pooled
                                                     accuracy, between-run SD, per-item agreement
  benchmark participants <benchmark>               — per agent / per model: items touched,
                                                     accuracy on them, cost
  benchmark reference [model|benchmark]            — show published reference scores
  benchmark defaults                               — promoted defaults: each slot's incumbent run
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

Benchmarks: smoke (15-item prompt A/B, always ready), mmlu-pro, truthfulqa, arc-challenge,
  hellaswag, musr, bbh, gsm8k, math, simple-qa, humaneval, ifeval, frames, aime
  (run "benchmark list" for status)

--model M format: "marina" = the default local endpoint; "marina:<name>" = a named
  orchestration (a model-* channel with a live agent). See "benchmark orchestrations".

Note: "run" and "sweep" need rank 4 — they burn real tokens. Discovery commands
  (list, runs, result, leaderboard, frontier, compare, replicates, participants, reference,
  orchestrations, defaults, challenge) are rank 0. Invalid runs are listed by runs and
  result, marked with their reason; every other reader skips them. A run whose items were
  more than MARINA_BENCHMARK_MAX_FALLBACK_RATE (default 25%) fallbacks — errors, spend-cap
  or provider failures instead of answers — is recorded invalid automatically. Results
  recorded outside the world are imported by the operator with \`bun run benchmark:import\`
  (which also takes --invalidate|--revalidate <run> --reason). Promoted defaults are
  read by worlds (e.g. slot showcase:crew sets the showcase crew's model when
  MARINA_CREW_MODEL is unset); environment variables always win.

Examples:
  benchmark list
  benchmark run aime --limit 10 --model marina:answerer
  benchmark sweep aime --limit 10 --seed 42        # aime × every live marina:<name>
  benchmark sweep all --limit 5 --seed 42          # every bench × every orchestration
  benchmark leaderboard aime
  benchmark reference                              # all models we have numbers for
  benchmark reference anthropic/claude-haiku-4-5-20251001
  benchmark reference mmlu-pro                    # all models' published scores for mmlu-pro`;

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
}): CommandDef {
  const { db, runner, listOrchestrations } = deps;
  return {
    category: "Growth",
    usage: [
      "benchmark challenge <slot> <run> [--max-cost-ratio R]",
      "benchmark compare <runA> <runB>",
      "benchmark defaults",
      "benchmark promote <slot> <run> [--max-cost-ratio R] [--holdout F]",
      "benchmark frontier <benchmark>",
      "benchmark invalidate <run> reason:<text>",
      "benchmark leaderboard <benchmark> [--limit N]",
      "benchmark participants <benchmark>",
      "benchmark replicates <run>",
      "benchmark list",
      "benchmark orchestrations",
      "benchmark reference",
      "benchmark reference benchmark",
      "benchmark reference model",
      "benchmark result <id>",
      "benchmark revalidate <run> reason:<text>",
      "benchmark run <name> [--limit N] [--seed N] [--model M]",
      "benchmark run <name> [--limit N] [--seed N] [--model M] [--judge M] [--concurrency N] [--partition holdout|tune]",
      "benchmark runs [--benchmark X] [--limit N]",
      "benchmark sweep <name|all> [--limit N] [--seed N] [--judge M]",
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
          if ((entity.properties?.rank ?? 0) < 4) {
            ctx.send(
              input.entity,
              "benchmark sweep requires rank 4 (builder). Benchmarks fan out across every live orchestration and burn real tokens — earn the rank via competence.",
            );
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
          const rawArgs = tokens.slice(1 + consumed).join(" ");
          const { modifiers } = extractModifiers(rawArgs, [
            "limit",
            "seed",
            "judge",
            "judge-model",
            "concurrency",
          ]);
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

          const handles: { bench: string; orch: string; id: string; err?: string }[] = [];
          for (const bench of benches) {
            for (const orch of orchs) {
              try {
                const handle = runner.start({
                  benchmark: bench,
                  limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
                  seed: Number.isFinite(seed) ? seed : undefined,
                  model: orch,
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
              "Usage: benchmark run <name> [--limit N] [--seed N] [--model M] [--partition holdout|tune]",
            );
            return;
          }
          if ((entity.properties?.rank ?? 0) < 4) {
            ctx.send(
              input.entity,
              "benchmark run requires rank 4 (builder). Every run burns real tokens — earn the rank via competence.",
            );
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
          const rawArgs = tokens.slice(1 + resolved.consumed).join(" ");
          const { modifiers } = extractModifiers(rawArgs, [
            "limit",
            "seed",
            "judge-model",
            "model",
            "judge",
            "concurrency",
            "partition",
          ]);
          const limit = Number.parseInt(modifiers.limit ?? "", 10);
          const seed = Number.parseInt(modifiers.seed ?? "", 10);
          const concurrency = Number.parseInt(modifiers.concurrency ?? "", 10);
          try {
            const handle = runner.start({
              benchmark: name,
              limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
              seed: Number.isFinite(seed) ? seed : undefined,
              model: modifiers.model,
              ...(parsePartition(modifiers.partition)
                ? { partition: parsePartition(modifiers.partition) }
                : {}),
              ...(modifiers.model
                ? { subjects: deps.describeTarget?.(modifiers.model) ?? [] }
                : {}),
              judgeModel: modifiers.judge ?? modifiers["judge-model"],
              concurrency:
                Number.isFinite(concurrency) && concurrency > 0 ? concurrency : undefined,
              agentId: entity.id,
            });
            ctx.send(
              input.entity,
              `Benchmark run started.\n  ${bold("id")}:       ${fmtId(handle.id)}\n  ${bold("benchmark")}: ${category(name)}\n  ${bold("config")}:    ${handle.configHash}\n\nCheck status with: benchmark result ${handle.id}`,
            );
          } catch (err) {
            ctx.send(
              input.entity,
              `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
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
                  `  ${bold("measured")}:    ${subjects
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
          }
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
                : `No participants recorded on ${items.length} ${category(name)} item outcomes — participant credit needs the agents/models from each item's trace.`,
            );
            return;
          }
          const lines = [
            header(
              `Participants — ${name} (${withParticipants} of ${items.length} items attributed)`,
            ),
            separator(),
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
          if (rows.length === 0) {
            ctx.send(
              input.entity,
              "No promoted defaults yet. Seed a slot with `benchmark promote <slot> <run>`.",
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
          ctx.send(input.entity, lines.join("\n"));
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
  const found = lookupChallenge(
    db,
    slot,
    runId,
    "holdout",
    opts.maxCostRatio !== undefined ? { maxCostRatio: opts.maxCostRatio } : {},
  );
  if (found.kind === "error") return found.message;
  // Self-attestation is always refused: whoever ran the challenger — or ANY
  // replicate pooled with it — cannot promote it. Compared on the durable
  // account key too, so a fresh login is still the same author.
  const me = db.durableEntityKey(entity.id);
  for (const run of found.pooledRuns) {
    const author = run.agent_id;
    if (author && (author === entity.id || db.durableEntityKey(author) === me)) {
      return run.id === runId
        ? `Refused: you ran ${runId}. Someone else must promote it — self-attestation is never accepted.`
        : `Refused: you ran ${run.id}, a replicate pooled with ${runId}. Someone else must promote it — self-attestation is never accepted.`;
    }
  }
  // Invalidating an incumbent and then filling its slot is self-attestation
  // too: neither the promoter nor the author of any pooled challenger run may
  // be the account that invalidated it.
  const by = found.invalidIncumbent?.invalidatedBy;
  if (by) {
    const authoredBy = found.pooledRuns.find(
      (r) => r.agent_id && db.durableEntityKey(r.agent_id) === by,
    );
    if (by === me || authoredBy) {
      return `Refused: ${by === me ? "you" : `the author of ${authoredBy?.id}`} invalidated the incumbent ${found.invalidIncumbent?.id}. Someone else must fill ${slot} — self-attestation is never accepted.`;
    }
  }
  const value = found.challenger.target_json;
  if (!value) {
    return `Run ${runId} records no target configuration (target_json) — nothing to promote as the default.`;
  }
  // The history is append-only, so it stores the opaque durable account key —
  // never a display name that account erasure would have to rewrite.
  const actor = db.durableEntityKey(entity.id);
  const now = Date.now();
  if (found.kind === "seed") {
    if (found.invalidIncumbent && opts.holdout) {
      return "--holdout is fixed once a slot exists (moving it would move items between splits).";
    }
    const fraction = opts.holdout ? Number.parseFloat(opts.holdout) : found.holdoutFraction;
    if (!(fraction > 0 && fraction < 1)) return "--holdout must be between 0 and 1 (exclusive).";
    db.recordBenchmarkPromotion({
      slot,
      outcome: "seeded",
      challenger_run_id: runId,
      incumbent_run_id: null,
      value_json: value,
      actor,
      stats_json: null,
      reason: found.invalidIncumbent
        ? `re-seeded: incumbent ${found.invalidIncumbent.id} was invalidated and no earlier incumbent is valid`
        : "first incumbent",
      holdout_fraction: fraction,
      created_at: now,
    });
    gate.record();
    return `${found.invalidIncumbent ? `Re-seeded ${slot} (its incumbent ${found.invalidIncumbent.id} was invalidated and no earlier incumbent is valid)` : `Seeded ${slot}`} with ${runLabel(found.challenger)} (${runId}, ${found.replicates} replicate(s)); holdout ${pct(fraction).trim()} of items. Later challengers must earn it.`;
  }
  if (opts.holdout) {
    return "--holdout is fixed once a slot exists (moving it would move items between splits).";
  }
  const e = found.evaluation;
  const stats = JSON.stringify({
    ...e.stats,
    replicates: found.replicates,
    margin: e.margin,
    triedBefore: e.triedBefore,
    costPerItem: e.costPerItem,
  });
  db.recordBenchmarkPromotion({
    slot,
    outcome: e.ok ? "promoted" : "refused",
    challenger_run_id: runId,
    incumbent_run_id: found.incumbent.id,
    value_json: value,
    actor,
    stats_json: stats,
    reason: e.ok ? null : e.reasons.join("; "),
    created_at: now,
  });
  const body = [statsLine(e.stats), costLine(e)];
  if (!e.ok) {
    return [
      found.invalidIncumbent
        ? `Not promoted — the challenger did not beat ${found.incumbent.id}, the best earlier incumbent of ${slot} still valid (${found.invalidIncumbent.id} was invalidated). Recorded as attempt ${e.triedBefore + 1}.`
        : `Not promoted — ${slot} keeps ${found.incumbent.id}. Recorded as attempt ${e.triedBefore + 1}.`,
      ...body,
      ...e.reasons.map((r) => `  ${fmtStatus("BLOCK", "warn")} ${r}`),
    ].join("\n");
  }
  gate.record();
  return [
    `Promoted ${runLabel(found.challenger)} (${runId}) to ${slot}, replacing ${found.invalidIncumbent ? `the invalidated ${found.invalidIncumbent.id} (beat ${found.incumbent.id}, the best earlier incumbent still valid)` : found.incumbent.id}.`,
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
