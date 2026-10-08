// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run a clean backtest (see clean.ts) for one or more variants: the same rows
 * for every variant (the most conservative knowledge bound of them all), the
 * chosen retrieval isolation, lessons on or off, N replicates — then score,
 * audit, group by week, compare to reference scores, and file each run into
 * the benchmark ledger under a replicate group.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FilterStats,
  type IsolationLevel,
  isolationOfSpec,
  strictDateFilter,
} from "../../src/arena/research/isolation";
import type { Retriever } from "../../src/arena/research/retrieve";
import { SpendGuard } from "../../src/engine/spend-guard";
import { recordFromAnswer } from "../../src/forecast/adjust";
import { type AnswerSpec, matchOption } from "../../src/forecast/answer-types";
import type { ForecastHistory } from "../../src/forecast/history";
import { typedForecastDeps } from "../../src/forecast/service";
import { forecastLessonsFor } from "../../src/learning/forecast-bridge";
import {
  type LessonWriter,
  memoryLessonSink,
  type Outcome,
  recordOutcome,
} from "../../src/learning/outcomes";
import { BOARD_EXCLUSIONS } from "../forecasting/barred";
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
import { futurexOutcome, futurexResolvedAt } from "./lessons";
import { endTimeIso, parseOptions, requestFor } from "./map";
import { type BatchRun, BatchStopped, type RowResult, runBatch, type Variant } from "./run";
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
  /**
   * With lessons on, each (variant, replicate) learns into its own in-run pool
   * (the general outcome → candidate path of `src/learning`, unjudged so
   * labelled `unverified`) and recalls only from it — an honest ablation.
   * `lessonWriter` writes each candidate's rule.
   */
  lessonWriter?: LessonWriter;
  /**
   * Hand each scored row's outcome to the shared, judged pool (`noteOutcome`)
   * once its run is filed in the ledger and valid; every outcome cites the
   * run (`bench:<id>`), so invalidating the run retires its lessons.
   */
  learn?: (outcome: Outcome) => void;
  /**
   * Resolved forecast history per (variant, replicate): each scored row's
   * record is added after it finishes, so later rows' prior weights, base
   * rates and calibration can learn from it (visible only once resolved).
   */
  history?: (runLabel: string) => Promise<ForecastHistory>;
  reference?: ReferenceScores;
  /** Also grade strings and lists with a model judge, as the official scoring does. */
  judge?: JudgeModel;
  outDir: string;
  /**
   * Continue each replicate from the rows its earlier, stopped run finished
   * (`rows.jsonl` in its output directory), under the same configuration only.
   */
  resume?: boolean;
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

/**
 * A resolved row's outcome in the forecast's own terms: the true option ids of
 * a choice or multi-select (every truth item must name an option), or a
 * number's value. Undefined for rankings, strings and truths that do not map.
 */
export function truthOutcome(
  row: FuturexRow,
  spec: AnswerSpec,
): { options?: string[]; value?: number } | undefined {
  const truth = parseTruth(row.ground_truth);
  if (truth.length === 0) return undefined;
  if (spec.type === "choice" || spec.type === "multi") {
    const ids = truth.map((t) => matchOption(t, spec.options)?.id);
    if (ids.some((id) => id === undefined)) return undefined;
    const unique = [...new Set(ids as string[])];
    return spec.type === "choice" && unique.length !== 1 ? undefined : { options: unique };
  }
  if (spec.type === "number" && truth.length === 1) {
    const v = Number(truth[0]!.replace(/[,\s_$%]/g, ""));
    return Number.isFinite(v) ? { value: v } : undefined;
  }
  return undefined;
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
    horizonDays: opts.horizonDays,
    ...(opts.until ? { until: opts.until } : {}),
  });
  if (rows.length === 0)
    throw new Error(`no resolved rows whose cutoff is clean of the knowledge bound ${after}`);
  log(
    `clean backtest: ${rows.length} rows (knowledge bound ${after}), isolation ${opts.isolation}${opts.isolation === "closed-book" ? "" : ` via ${spec}`}, lessons ${opts.lessons}, cutoff ${opts.horizonDays}d before each end`,
  );
  const summaries: CleanRunSummary[] = [];
  for (const variant of opts.variants) {
    const first = opts.firstReplicate ?? 1;
    for (let rep = first; rep < first + opts.replicates; rep++) {
      const label = `${variant.label}-${opts.isolation}-lessons-${opts.lessons}-r${rep}`;
      const own = opts.lessons === "on" ? memoryLessonSink() : undefined;
      // The in-run pool is recalled whatever MARINA_LESSONS says: `lessons` is explicit here.
      const store = own
        ? forecastLessonsFor(undefined, { sink: own, env: { ...env, MARINA_LESSONS: "on" } })
        : undefined;
      const outcomes: Outcome[] = [];
      const history = opts.history ? await opts.history(label) : undefined;
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
      const out = join(opts.outDir, label);
      /** Score a finished row and learn from it (history only for rows run now). */
      const learnRow = async (row: FuturexRow, r: RowResult, fresh: boolean): Promise<void> => {
        // A fallback is an infrastructure outcome (no run answered), not a
        // forecast to learn from.
        if ((!own && !history && !opts.learn) || r.fallback) return;
        // Known once the event ended, plus the settlement margin (never at
        // the end time itself, which sibling rows share as their cutoff).
        const resolvedAt = futurexResolvedAt(row);
        if (!resolvedAt) return;
        const item = scoreItem(row, r.prediction);
        if (history && fresh) {
          const req = requestFor(row);
          const truth = truthOutcome(row, req.answer);
          const rec = truth
            ? recordFromAnswer({
                id: row.id,
                req: { ...req, id: row.id },
                answer: r.answer,
                truth,
                resolvedAt,
                formation: variant.formation ?? "ensemble",
                score: item.score,
              })
            : undefined;
          if (rec) await history.add(rec);
        }
        const outcome = futurexOutcome({
          row,
          result: r,
          item,
          label: `clean:${variant.label}`,
          resolvedAt,
        });
        if (opts.learn) outcomes.push(outcome);
        if (!own) return;
        try {
          await recordOutcome(
            { sink: own, ...(opts.lessonWriter ? { writer: opts.lessonWriter } : {}) },
            outcome,
          );
          lessonsWritten++;
        } catch (err) {
          // A lost lesson costs later rows a hint; it never voids the run.
          lessonFailures++;
          log(`  lesson write failed for ${row.id}: ${(err as Error).message.slice(0, 120)}`);
        }
      };
      const runPromise: Promise<BatchRun> = runBatch(
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
            ...(variant.budgetMs ? { budgetMs: variant.budgetMs } : {}),
            ...(variant.selection ? { selection: variant.selection } : {}),
            retriever: spec,
            wrapRetriever: cap.wrap,
            exclude: BOARD_EXCLUSIONS.futurex!,
            ...(store ? { lessons: store } : {}),
            ...(history ? { history } : {}),
          });
          if ("error" in made) throw new Error(made.error);
          // Lookups that only know current values are skipped for past cutoffs by the engine.
          return { ...made, evidence: cap.evidence };
        },
        {
          horizonDays: opts.horizonDays,
          concurrency: opts.concurrency,
          // Every finished row lands on disk at once: a cap stop keeps what was paid for.
          journal: {
            path: join(out, "rows.jsonl"),
            config: {
              benchmark: CLEAN_BENCHMARK,
              batchSha: opts.batchSha,
              isolation: opts.isolation,
              retriever: spec,
              lessons: opts.lessons,
              knowledgeBound: after,
              replicate: rep,
            },
            ...(opts.resume ? { resume: true } : {}),
          },
          // Stop while every row in flight can still finish under the tighter of
          // the world's cap and this process's MARINA_SPEND_SCOPE cap.
          shouldStop: () => guard.stopReason(),
          onRow: (r, done, total) =>
            log(
              `  [${label} ${done}/${total}] L${r.level} ${r.spec} → ${(r.prediction || "(empty)").slice(0, 60)} · lessons ${r.answer.lessons?.length ?? 0} · $${r.costUsd.toFixed(3)}`,
            ),
          afterRow: async (row, r) => {
            guard.record(r.costUsd);
            await learnRow(row, r, true);
          },
          // A resumed row's lesson lived only in the stopped process's in-run
          // pool, and its outcome must still reach the shared pool when this run
          // is filed; its history record was already added by that run.
          onResumed: (row, r) => learnRow(row, r, false),
        },
      );
      let run: BatchRun;
      try {
        run = await runPromise;
      } catch (err) {
        if (err instanceof BatchStopped) {
          // A partial run is kept, labelled, and never scored or filed as a complete one.
          writeFileSync(
            join(out, "partial.json"),
            JSON.stringify(
              {
                partial: true,
                reason: err.reason,
                finished: err.partial.results.length,
                total: err.partial.total,
                costUsd: err.partial.costUsd,
                journal: err.journal,
                label,
              },
              null,
              1,
            ),
          );
          log(`  ${label}: PARTIAL — ${err.message} (not filed)`);
        }
        throw err;
      }
      rmSync(join(out, "partial.json"), { force: true });
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
        // Only a newly filed, valid run teaches the shared pool; each lesson cites it.
        if (opts.learn && rec.created && !rec.invalidReason) {
          for (const o of outcomes)
            opts.learn({ ...o, refs: [...(o.refs ?? []), `bench:${rec.id}`] });
        }
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
