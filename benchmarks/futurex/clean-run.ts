// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run a clean backtest (see clean.ts) for one or more variants: the same rows
 * for every variant (the most conservative knowledge bound of them all), the
 * chosen retrieval isolation, lessons on or off, N replicates — then score,
 * audit, group by week, compare to reference scores, and file each run into
 * the benchmark ledger under a replicate group.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FilterStats,
  type IsolationLevel,
  isolationOfSpec,
  strictDateFilter,
} from "../../src/arena/research/isolation";
import type { Retriever } from "../../src/arena/research/retrieve";
import { SpendGuard } from "../../src/engine/spend-guard";
import { type LessonStore, type LessonWriter, lessonFromOutcome } from "../../src/forecast/lessons";
import { typedForecastDeps } from "../../src/forecast/service";
import {
  auditRow,
  batchWeek,
  knowledgeBound,
  type ReferenceScores,
  type RowAudit,
  selectCleanRows,
  toUnit,
} from "./clean";
import type { FuturexRow } from "./dataset";
import { recordScoredRun } from "./ledger";
import { endTimeIso, parseOptions, requestFor } from "./map";
import { type BatchRun, runBatch, type Variant } from "./run";
import {
  type BatchScore,
  type JudgeModel,
  LEVEL_WEIGHTS,
  parseTruth,
  scoreBatch,
  scoreBatchJudged,
  scoreItem,
} from "./score";

export const CLEAN_BENCHMARK = "futurex-past-clean";

export interface CleanOptions {
  rows: FuturexRow[];
  batchSha: string;
  variants: Variant[];
  /**
   * `contaminated` (an unfiltered engine on past cutoffs) is accepted only as
   * an explicit upper bracket: it can see outcomes, so it is never a headline.
   */
  isolation: IsolationLevel;
  /** Retriever spec for date-filtered / post-filtered runs. */
  retriever?: string;
  after?: string;
  until?: string;
  /**
   * Restrict to these row ids (still subject to the knowledge bound) — to run a
   * new configuration on exactly an earlier run's rows, for a subset-paired
   * comparison.
   */
  onlyIds?: Set<string>;
  limit: number;
  horizonDays: number;
  concurrency: number;
  replicates: number;
  /** Number of the first replicate (default 1) — to add replicates without reusing a label. */
  firstReplicate?: number;
  lessons: "on" | "off";
  /** A fresh lesson store per (variant, replicate) — keeps the ablation honest. */
  lessonStore?: (runLabel: string) => Promise<LessonStore>;
  lessonWriter?: LessonWriter;
  reference?: ReferenceScores;
  /** Also grade strings and lists with a model judge, as the official scoring does. */
  judge?: JudgeModel;
  outDir: string;
  ledger?: Parameters<typeof recordScoredRun>[0];
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface CleanRunSummary {
  variant: string;
  replicate: number;
  isolation: IsolationLevel;
  lessons: "on" | "off";
  rows: number;
  overall: number;
  ci: [number, number];
  byLevel: BatchScore["byLevel"];
  clean: { rows: number; overall: number };
  /** The overall with strings and lists graded by the judge (when one is given). */
  judged?: { overall: number; byLevel: BatchScore["byLevel"]; changed: number };
  audit: {
    suspicious: number;
    laterDate: number;
    truthQuoted: number;
    resultLanguage: number;
    nameMentioned: number;
  };
  lessonsUsed: number;
  lessonsWritten: number;
  lessonFailures: number;
  retrieval: { linesIn: number; linesKept: number };
  weeks: Array<{ week: string; n: number; overall: number; reference?: ReferenceScores[string] }>;
  costUsd: number;
  ledgerId?: string;
  group: string;
}

/** Level-weighted overall (the FutureX aggregate) for a subset of scored items. */
export function weightedOverall(items: Array<{ level: number; score: number }>): number {
  const levels = [1, 2, 3, 4].filter((l) => items.some((i) => i.level === l));
  const w = levels.reduce((s, l) => s + (LEVEL_WEIGHTS[l] ?? 0), 0);
  if (!w) return 0;
  const mean = (l: number) => {
    const at = items.filter((i) => i.level === l);
    return at.reduce((s, i) => s + i.score, 0) / at.length;
  };
  return levels.reduce((s, l) => s + (LEVEL_WEIGHTS[l] ?? 0) * mean(l), 0) / w;
}

/** 95 % bootstrap interval of the weighted overall (rows resampled within each level). */
export function bootstrapOverall(
  items: Array<{ level: number; score: number }>,
  iterations = 2_000,
  seed = 7,
): [number, number] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
  const byLevel = [1, 2, 3, 4].map((l) => items.filter((i) => i.level === l));
  const stats: number[] = [];
  for (let k = 0; k < iterations; k++) {
    const sample = byLevel.flatMap((at) => at.map(() => at[Math.floor(rand() * at.length)]!));
    stats.push(weightedOverall(sample));
  }
  stats.sort((a, b) => a - b);
  const q = (p: number) => stats[Math.min(stats.length - 1, Math.floor(p * stats.length))]!;
  return [round(q(0.025)), round(q(0.975))];
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/** One captured, optionally strict-filtered retriever per row; line counts add into `stats`. */
function rowRetrieval(
  isolation: CleanOptions["isolation"],
  stats: { linesIn: number; linesKept: number },
) {
  const kept: string[] = [];
  const wrap = (inner: Retriever): Retriever => {
    const filtered =
      isolation === "post-filtered"
        ? strictDateFilter(inner, (_b, s: FilterStats) => {
            stats.linesIn += s.linesIn;
            stats.linesKept += s.linesKept;
          })
        : inner;
    return async (brief) => {
      const r = await filtered(brief);
      kept.push(r.report);
      if (isolation !== "post-filtered") {
        const n = r.report.split("\n").filter((l) => l.trim() && !/^#/.test(l.trim())).length;
        stats.linesIn += n;
        stats.linesKept += n;
      }
      return r;
    };
  };
  return { wrap, evidence: () => kept.join("\n") };
}

export async function cleanBacktest(opts: CleanOptions): Promise<CleanRunSummary[]> {
  const log = opts.log ?? console.log;
  const env = opts.env ?? process.env;
  // ── Isolation ──
  let spec: string;
  if (opts.isolation === "closed-book") spec = "closed-book";
  else {
    if (!opts.retriever) throw new Error(`${opts.isolation} needs a retriever spec`);
    spec = opts.retriever;
    const level = isolationOfSpec(spec, opts.isolation === "post-filtered");
    if (opts.isolation === "date-filtered" && level !== "date-filtered") {
      throw new Error(`${spec} is not a date-filtered engine (it would be ${level}); refused`);
    }
    if (opts.isolation === "contaminated") {
      log(
        `CONTAMINATED BRACKET: ${spec} is unfiltered on past cutoffs and can see outcomes — an upper bound, never a headline score.`,
      );
    }
  }
  // ── Rows: one set for every variant (the latest knowledge bound) ──
  const bounds = opts.variants.map((v) => ({ v, b: knowledgeBound(v) }));
  const bad = bounds.find((x) => "error" in x.b);
  if (bad && !opts.after)
    throw new Error(`variant ${bad.v.label}: ${(bad.b as { error: string }).error}`);
  const after =
    opts.after ??
    bounds
      .map((x) => (x.b as { after: string }).after)
      .sort()
      .at(-1)!;
  if (opts.after) {
    const later = bounds.find((x) => "after" in x.b && x.b.after > opts.after!);
    if (later) {
      log(
        `WARNING: --after ${opts.after} is earlier than ${later.v.label}'s model release (${(later.b as { after: string }).after}); rows may predate its knowledge.`,
      );
    }
  }
  const only = opts.onlyIds;
  const rows = selectCleanRows(only ? opts.rows.filter((r) => only.has(r.id)) : opts.rows, {
    after,
    limit: opts.limit,
    ...(opts.until ? { until: opts.until } : {}),
  });
  if (rows.length === 0) throw new Error(`no resolved rows end after ${after} + release lag`);
  log(
    `clean backtest: ${rows.length} rows (knowledge bound ${after}), isolation ${opts.isolation}${opts.isolation === "closed-book" ? "" : ` via ${spec}`}, lessons ${opts.lessons}, cutoff ${opts.horizonDays}d before each end`,
  );
  const summaries: CleanRunSummary[] = [];
  for (const variant of opts.variants) {
    const first = opts.firstReplicate ?? 1;
    for (let rep = first; rep < first + opts.replicates; rep++) {
      const label = `${variant.label}-${opts.isolation}-lessons-${opts.lessons}-r${rep}`;
      const store =
        opts.lessons === "on" && opts.lessonStore ? await opts.lessonStore(label) : undefined;
      const retrieval = { linesIn: 0, linesKept: 0 };
      let lessonsWritten = 0;
      // Only the daily caps bound a backtest; the guard holds a reserve for the rows in flight.
      const guard = new SpendGuard({
        label: "backtest",
        concurrency: opts.concurrency,
        minReserveUsd: 2,
        env,
      });
      let lessonFailures = 0;
      const run: BatchRun = await runBatch(
        rows,
        variant,
        () => {
          const cap = rowRetrieval(opts.isolation, retrieval);
          const made = typedForecastDeps(env, {
            analysts: variant.analysts,
            ...(variant.planner ? { planner: variant.planner } : {}),
            ...(variant.critic ? { critic: variant.critic } : {}),
            ...(variant.verifier ? { verifier: variant.verifier } : {}),
            ...(variant.verify ? { verify: true } : {}),
            ...(variant.runs !== undefined ? { runs: variant.runs } : {}),
            ...(variant.researchRounds !== undefined
              ? { researchRounds: variant.researchRounds }
              : {}),
            ...(variant.critique === false ? { critique: false } : {}),
            retriever: spec,
            wrapRetriever: cap.wrap,
            ...(store ? { lessons: store } : {}),
          });
          if ("error" in made) throw new Error(made.error);
          // Lookups that only know current values are skipped for past cutoffs by the engine.
          return { ...made, evidence: cap.evidence };
        },
        {
          horizonDays: opts.horizonDays,
          concurrency: opts.concurrency,
          // Stop while every row in flight can still finish under the tighter of
          // the world's cap and this process's MARINA_SPEND_SCOPE cap.
          shouldStop: () => guard.stopReason(),
          onRow: (r, done, total) =>
            log(
              `  [${label} ${done}/${total}] L${r.level} ${r.spec} → ${(r.prediction || "(empty)").slice(0, 60)} · lessons ${r.answer.lessons?.length ?? 0} · $${r.costUsd.toFixed(3)}`,
            ),
          afterRow: async (row, r) => {
            guard.record(r.costUsd);
            // A fallback is an infrastructure outcome (no run answered), not a
            // forecast to learn from.
            if (!store || r.fallback) return;
            const end = endTimeIso(row.end_time);
            if (!end) return;
            const item = scoreItem(row, r.prediction);
            const lesson = await lessonFromOutcome(
              {
                question: requestFor(row).question,
                answer: requestFor(row).answer,
                prediction: r.prediction,
                truth: parseTruth(row.ground_truth).join(", "),
                score: item.score,
                // Known once the event ended (a day's margin for settlement).
                resolvedAt: new Date(Date.parse(end) + 86_400_000).toISOString(),
                reasons: r.answer.runs.map((x) => x.reason ?? "").filter(Boolean),
                ...(r.caveat ? { caveat: r.caveat } : {}),
                origin: "backtest",
              },
              opts.lessonWriter,
            );
            try {
              await store.write(lesson);
              lessonsWritten++;
            } catch (err) {
              // A lost lesson costs later rows a hint; it never voids the run.
              lessonFailures++;
              log(`  lesson write failed for ${row.id}: ${(err as Error).message.slice(0, 120)}`);
            }
          },
        },
      );
      const predictions = new Map(run.results.map((r) => [r.id, r.prediction]));
      const score = scoreBatch(rows, predictions);
      const judged = opts.judge ? await scoreBatchJudged(rows, predictions, opts.judge) : undefined;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const audits: RowAudit[] = run.results.map((r) => {
        const row = byId.get(r.id)!;
        return auditRow(
          row,
          r,
          r.evidence ?? "",
          new Set(parseOptions(row.prompt).map((o) => o.id)),
        );
      });
      const suspicious = new Set(audits.filter((a) => a.suspicious).map((a) => a.id));
      const cleanItems = score.items.filter((i) => !suspicious.has(i.id));
      const weeks = new Map<string, typeof score.items>();
      for (const it of score.items) {
        const w = batchWeek(endTimeIso(byId.get(it.id)!.end_time)!);
        weeks.set(w, [...(weeks.get(w) ?? []), it]);
      }
      const group = `futurex-clean:${variant.label}:${opts.isolation}:lessons-${opts.lessons}`;
      const summary: CleanRunSummary = {
        variant: variant.label,
        replicate: rep,
        isolation: opts.isolation,
        lessons: opts.lessons,
        rows: rows.length,
        overall: score.overall,
        ci: bootstrapOverall(score.items),
        byLevel: score.byLevel,
        clean: { rows: cleanItems.length, overall: round(weightedOverall(cleanItems)) },
        ...(judged
          ? {
              judged: { overall: judged.overall, byLevel: judged.byLevel, changed: judged.changed },
            }
          : {}),
        audit: {
          suspicious: suspicious.size,
          laterDate: audits.filter((a) => a.flags.laterDate).length,
          truthQuoted: audits.filter((a) => a.flags.truthQuoted).length,
          resultLanguage: audits.filter((a) => a.flags.resultLanguage).length,
          nameMentioned: audits.filter((a) => a.flags.nameMentioned).length,
        },
        lessonsUsed: run.results.reduce((s, r) => s + (r.answer.lessons?.length ?? 0), 0),
        lessonsWritten,
        lessonFailures,
        retrieval,
        weeks: [...weeks.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([week, items]) => {
            const ref = opts.reference?.[week];
            return {
              week,
              n: items.length,
              overall: round(weightedOverall(items)),
              ...(ref
                ? {
                    reference: {
                      ...(ref.top !== undefined ? { top: toUnit(ref.top) } : {}),
                      ...(ref.median !== undefined ? { median: toUnit(ref.median) } : {}),
                      ...(ref.h2o !== undefined ? { h2o: toUnit(ref.h2o) } : {}),
                    },
                  }
                : {}),
            };
          }),
        costUsd: run.costUsd,
        group,
      };
      const out = join(opts.outDir, label);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "answers.json"), JSON.stringify(run, null, 1));
      writeFileSync(join(out, "score.json"), JSON.stringify(score, null, 1));
      writeFileSync(join(out, "audit.json"), JSON.stringify(audits, null, 1));
      writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
      if (opts.ledger) {
        const rec = recordScoredRun(opts.ledger, {
          benchmark:
            opts.isolation === "contaminated" ? "futurex-past-contaminated" : CLEAN_BENCHMARK,
          batchSha: opts.batchSha,
          variant,
          run,
          score,
          horizonDays: opts.horizonDays,
          replicateGroup: group,
          extra: {
            isolation: opts.isolation,
            lessons: opts.lessons,
            knowledgeBound: after,
            replicate: rep,
          },
        });
        summary.ledgerId = rec.id;
      }
      log(
        `  ${label}: overall ${summary.overall} [${summary.ci.join(", ")}] · clean-only ${summary.clean.overall} (n=${summary.clean.rows}) · ${Object.entries(
          score.byLevel,
        )
          .map(([l, s]) => `L${l} ${s.mean}`)
          .join(
            " ",
          )} · suspicious ${summary.audit.suspicious} · lessons used ${summary.lessonsUsed} · $${run.costUsd.toFixed(2)}`,
      );
      summaries.push(summary);
    }
  }
  return summaries;
}
