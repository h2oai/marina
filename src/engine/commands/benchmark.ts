// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  knownReferenceModels,
  REFERENCE_SCORES,
  referenceScoresForBenchmark,
  referenceScoresForModel,
} from "../../../benchmarks/reference-scores";
import { bold, category, dim, status as fmtStatus, header, separator } from "../../net/ansi";
import type { BenchmarkRunRow, MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { BENCHMARKS, type BenchmarkRunner } from "../benchmark-runner";
import { extractModifiers, resolveMultiWordName } from "../parse-input";

/** Render an id-shaped string with dim styling (ansi.id is numeric-only). */
function fmtId(s: string): string {
  return dim(s);
}

function variantFromStatus(s: string): "active" | "done" | "fail" | "info" | "warn" {
  if (s === "completed") return "done";
  if (s === "failed") return "fail";
  if (s === "running") return "active";
  return "info";
}

const HELP = `Run, track, and rank benchmark evaluations from inside the world.
Usage:
  benchmark list                                   — show available benchmarks + cache status
  benchmark orchestrations                         — show live marina:<name> endpoints
  benchmark run <name> [--limit N] [--seed N] [--model M] [--judge M] [--concurrency N]
                                                   — kick off one run
  benchmark sweep <name|all> [--limit N] [--seed N] [--judge M]
                                                   — fan out across every live orchestration
  benchmark result <id>                            — show a single run's score + breakdown
  benchmark runs [--benchmark X] [--limit N]      — list recent runs
  benchmark leaderboard <benchmark> [--limit N]   — top scoring configs for a benchmark
                                                     (interleaves reference-model scores)
  benchmark reference [model|benchmark]            — show published reference scores

Benchmarks: mmlu-pro, truthfulqa, arc-challenge, hellaswag, musr, bbh, gsm8k,
  math, simple-qa, humaneval, ifeval, frames, aime  (run "benchmark list" for status)

--model M format: "marina" = the default local endpoint; "marina:<name>" = a named
  orchestration (a model-* channel with a live agent). See "benchmark orchestrations".

Note: "run" and "sweep" need rank 4 — they burn real tokens. Discovery commands
  (list, runs, result, leaderboard, reference, orchestrations) are rank 0.

Examples:
  benchmark list
  benchmark run aime --limit 10 --model marina:answerer
  benchmark sweep aime --limit 10 --seed 42        # aime × every live marina:<name>
  benchmark sweep all --limit 5 --seed 42          # every bench × every orchestration
  benchmark leaderboard aime
  benchmark reference                              # all models we have numbers for
  benchmark reference anthropic/claude-haiku-4-5-20251001
  benchmark reference mmlu-pro                    # all models' published scores for mmlu-pro`;

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function formatRunLine(row: BenchmarkRunRow): string {
  const score =
    row.score === null || row.score === undefined
      ? fmtStatus(row.status.padEnd(10), variantFromStatus(row.status))
      : `${(row.score * 100).toFixed(1)}%`.padStart(6);
  const age = dim(formatAge(Date.now() - row.started_at).padStart(8));
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
}): CommandDef {
  const { db, runner, listOrchestrations } = deps;
  return {
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
              "Usage: benchmark run <name> [--limit N] [--seed N] [--model M]",
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
            "model",
            "judge",
            "judge-model",
            "concurrency",
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
            `  ${bold("started")}:     ${new Date(row.started_at).toISOString()} (${formatAge(Date.now() - row.started_at)})`,
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
          if (row.config_json) {
            try {
              const config = JSON.parse(row.config_json) as Record<string, unknown>;
              const entries = Object.entries(config)
                .filter(([, v]) => v !== undefined && v !== null)
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
            ...rows.map(formatRunLine),
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
            lines.push(
              `  ${rank}  ${score}  ${hash}  ${ans}  ${agent.padEnd(36)}  ${fmtId(row.id)}`,
            );
          });
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

        default:
          ctx.send(input.entity, HELP);
      }
    },
  };
}
