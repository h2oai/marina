// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Admission ranking for lessons: the `admit` hook of `recordOutcome`
 * (`./outcomes.ts`), built on the general step in `src/memory/admission.ts`.
 * It runs after the judge and before the write, for a lesson and for its
 * `lessons:meta` mirror.
 *
 *   neighbours  the candidate's own pool (`lessons:<domain>`, actionable) plus,
 *               for a producer lesson, a few `lessons:meta` records as context;
 *               never the candidate's own original (a mirror's `lesson:<id>`)
 *   evidence    `E_m` from the lesson's supports and its `bench:` refs on the
 *               ledger (items, interval width, invalidated runs, replicates)
 *   apply (on)  new ⇒ written with its rank; merge ⇒ the neighbour is revised
 *               (support + 1, refs ∪, a `merged` provenance entry) and nothing
 *               new is written; supersede ⇒ the candidate is written (its
 *               `resolvedAt` = the later of the two, so the leakage rule
 *               holds) and the neighbour is retired with `superseded_by`;
 *               contest ⇒ the candidate is written HELD (`contested`, never
 *               served while the trusted lesson it contradicts is current) and
 *               a resolve case is opened; a calibrated judge with an evidence
 *               gap ≥ 0.3 resolves it at once (audited)
 *   observe     the rank and the PROPOSED action are stored on the lesson as
 *               written today; nothing is merged, superseded or held
 *
 * A rejected lesson is written as an audit record, unranked. Any failure in
 * admission leaves the write exactly as it would be with ranking off.
 */

import type { DecisionProvider } from "../decisions/types";
import type { DefaultSlotReader } from "../engine/default-resolution";
import {
  type AdmissionResult,
  admitMemoryWrite,
  hybridNeighbours,
  memoryRankingMode,
  type NeighbourSet,
  rankWeights,
  relationLabel,
} from "../memory/admission";
import {
  type AdmissionNeighbour,
  type EvidenceFacts,
  evidenceStrength,
  type MemoryRankingMode,
  NEIGHBOUR_K,
} from "../memory/admission-policy";
import type { BenchmarkRunRow } from "../persistence/db-benchmarks";
import type {
  Lesson,
  LessonAdmission,
  LessonAdmissionDecision,
  LessonAdmissionStamp,
  LessonSink,
} from "./outcomes";

/** The curator named on admission's retirements and merges (never a login name). */
export const ADMISSION_CURATOR = "marina:lessons-admission";
/** At most this many `lessons:meta` records are shown as context to a producer lesson. */
export const META_CONTEXT = 2;
/** Most refs a merged lesson keeps. */
export const MAX_MERGED_REFS = 12;
/** The weights are re-read (a promotion may land) at most this often. */
const WEIGHTS_TTL_MS = 10 * 60_000;

/** The ledger slice evidence reads (any `MarinaDB`). */
export type LessonEvidenceReader = DefaultSlotReader & {
  getBenchmarkRun?(id: string): BenchmarkRunRow | undefined;
};

/** Mechanical evidence facts for a lesson: its supports and its `bench:` refs on the ledger. */
export function lessonEvidence(
  lesson: Pick<Lesson, "support" | "refs" | "provenance">,
  db?: LessonEvidenceReader,
): { facts: EvidenceFacts; summary: Record<string, number> } {
  const bench = (lesson.refs ?? []).filter((r) => r.startsWith("bench:"));
  let invalid = 0;
  let valid = 0;
  let n: number | undefined;
  let width: number | undefined;
  for (const ref of bench) {
    let run: BenchmarkRunRow | undefined;
    try {
      run = db?.getBenchmarkRun?.(ref.slice("bench:".length));
    } catch {
      run = undefined;
    }
    if (!run) continue;
    if (run.status === "invalid") {
      invalid++;
      continue;
    }
    valid++;
    const items = run.n ?? run.answered;
    if (typeof items === "number" && items > 0) n = Math.max(n ?? 0, items);
    if (typeof run.ci_low === "number" && typeof run.ci_high === "number") {
      const w = Math.max(0, run.ci_high - run.ci_low);
      width = width === undefined ? w : Math.min(width, w);
    }
  }
  const confirmations = Number(lesson.provenance?.confirmations ?? 0);
  const facts: EvidenceFacts = {
    supports: Math.max(1, lesson.support ?? 1),
    replicates: Math.max(0, valid - 1),
    ...(width === undefined ? {} : { intervalWidth: width }),
    ...(n === undefined ? {} : { n }),
    ...(Number.isFinite(confirmations) && confirmations > 0 ? { confirmations } : {}),
    invalidShare: invalid + valid > 0 ? invalid / (invalid + valid) : 0,
  };
  return {
    facts,
    summary: {
      supports: facts.supports,
      refs: lesson.refs?.length ?? 0,
      ledger_runs: valid,
      invalid_runs: invalid,
      ...(n === undefined ? {} : { items: n }),
      ...(width === undefined ? {} : { interval_width: Math.round(width * 1000) / 1000 }),
    },
  };
}

export interface LessonAdmissionOptions {
  /** The decision backend (absent ⇒ no hook: ranking behaves as off). */
  judge?: DecisionProvider;
  env?: NodeJS.ProcessEnv;
  /** The ledger and promoted slots (evidence; `memory-ranking:weights`). */
  db?: LessonEvidenceReader;
  /** Called with every admission result (logging, the rank pass). */
  onResult?: (r: { lesson: Lesson; target: "lesson" | "meta"; result: AdmissionResult }) => void;
  now?: () => number;
}

/** What `admitLesson` saw and decided for one lesson. */
export interface LessonAdmissionRun {
  result: AdmissionResult;
  neighbours: NeighbourSet;
}

const originalOf = (l: Lesson) =>
  (l.refs ?? []).filter((r) => r.startsWith("lesson:")).map((r) => r.slice("lesson:".length));

/**
 * The neighbour set of `lesson` in `sink`: its own pool (actionable), and for
 * a producer lesson up to `META_CONTEXT` meta records as context. `keep`
 * narrows the candidates (the rank pass keeps only lessons written earlier).
 */
export async function lessonNeighbours(
  sink: LessonSink,
  lesson: Lesson,
  opts: { hybrid?: boolean; keep?: (l: Lesson) => boolean; db?: LessonEvidenceReader } = {},
): Promise<NeighbourSet> {
  if (!sink.neighbours) return { neighbours: [], mode: "lexical", degraded: [] };
  const excluded = new Set([...(lesson.id ? [lesson.id] : []), ...originalOf(lesson)]);
  const usable = (l: Lesson) =>
    !!l.id &&
    !excluded.has(l.id) &&
    l.trust !== "rejected" &&
    !(lesson.id && originalOf(l).includes(lesson.id)) &&
    (opts.keep ? opts.keep(l) : true);
  const own = await sink.neighbours(lesson.domain, lesson.text, {
    limit: 50,
    ...(opts.hybrid ? { hybrid: true } : {}),
  });
  const toNeighbour = (l: Lesson, actionable: boolean): AdmissionNeighbour => ({
    id: l.id!,
    ...(l.version === undefined ? {} : { version: l.version }),
    text: l.text,
    trust: l.trust,
    ...(l.scope ? { scope: l.scope } : {}),
    ...(l.families?.length ? { families: l.families } : {}),
    ...(l.rank ? { rank: l.rank.score } : {}),
    evidence: evidenceStrength(lessonEvidence(l, opts.db).facts),
    actionable,
    space: `lessons:${l.domain}`,
    resolvedAt: l.resolvedAt,
  });
  let context: AdmissionNeighbour[] = [];
  const degraded = [...own.degraded];
  if (lesson.domain !== "meta") {
    try {
      const meta = await sink.neighbours("meta", lesson.text, {
        limit: 10,
        ...(opts.hybrid ? { hybrid: true } : {}),
      });
      context = meta.lessons
        .filter(usable)
        .slice(0, META_CONTEXT)
        .map((l) => toNeighbour(l, false));
      degraded.push(...meta.degraded.filter((d) => !degraded.includes(d)));
    } catch {
      context = []; // the meta pool is context only
    }
  }
  const mine = own.lessons
    .filter(usable)
    .slice(0, NEIGHBOUR_K - context.length)
    .map((l) => toNeighbour(l, true));
  return {
    neighbours: [...mine, ...context],
    ...(own.generation === undefined ? {} : { generation: own.generation }),
    mode: own.mode,
    degraded,
  };
}

/** Rank one lesson against its neighbours (no write). Used by the hook and by `lessons rank`. */
export async function admitLesson(
  lesson: Lesson,
  sink: LessonSink,
  opts: LessonAdmissionOptions & {
    keep?: (l: Lesson) => boolean;
    weights?: ReturnType<typeof rankWeights>;
  },
): Promise<LessonAdmissionRun> {
  const env = opts.env ?? process.env;
  const neighbours = await lessonNeighbours(sink, lesson, {
    hybrid: hybridNeighbours(env),
    ...(opts.keep ? { keep: opts.keep } : {}),
    ...(opts.db ? { db: opts.db } : {}),
  });
  const evidence = lessonEvidence(lesson, opts.db);
  const result = await admitMemoryWrite(
    {
      text: lesson.text,
      kind: lesson.domain === "meta" ? "meta" : "lesson",
      trust: lesson.trust,
      ...(lesson.scope ? { scope: lesson.scope } : {}),
      ...(lesson.families?.length ? { families: lesson.families } : {}),
      evidence: evidenceStrength(evidence.facts),
      evidenceSummary: evidence.summary,
    },
    {
      neighbours,
      ...(opts.judge ? { provider: opts.judge } : {}),
      weights: opts.weights ?? rankWeights(opts.db),
      ...(opts.now ? { now: opts.now } : {}),
    },
  );
  return { result, neighbours };
}

function stamp(
  mode: Exclude<MemoryRankingMode, "off">,
  result: AdmissionResult,
  applied: boolean,
): LessonAdmissionStamp {
  const relation = relationLabel(result.relation);
  return {
    mode,
    action: result.action,
    applied,
    ...(result.target ? { target: result.target.id } : {}),
    reason: result.reason,
    ...(result.mechanical ? { mechanical: true } : {}),
    ...(result.similarity === undefined ? {} : { similarity: result.similarity }),
    ...(relation ? { relation } : {}),
    ...(result.skipped ? { skipped: result.skipped } : {}),
  };
}

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * The `admit` hook for `MARINA_MEMORY_RANKING`. Undefined (no hook: today's
 * behaviour) when the mode is off or no decision backend is configured.
 */
export function lessonAdmission(opts: LessonAdmissionOptions): LessonAdmission | undefined {
  const env = opts.env ?? process.env;
  const mode = memoryRankingMode(env);
  if (mode === "off" || !opts.judge) return undefined;
  let weights: { value: ReturnType<typeof rankWeights>; at: number } | undefined;
  const currentWeights = () => {
    const now = Date.now();
    if (!weights || now - weights.at > WEIGHTS_TTL_MS)
      weights = { value: rankWeights(opts.db), at: now };
    return weights.value;
  };
  return async (lesson, ctx): Promise<Lesson | LessonAdmissionDecision> => {
    if (lesson.trust === "rejected") return lesson;
    let run: LessonAdmissionRun;
    try {
      run = await admitLesson(lesson, ctx.sink, { ...opts, env, weights: currentWeights() });
    } catch {
      return lesson; // a neighbour search failure: written as with ranking off
    }
    const { result } = run;
    opts.onResult?.({ lesson, target: ctx.target, result });
    const ranked: Lesson = { ...lesson, ...(result.rank ? { rank: { ...result.rank } } : {}) };
    if (mode === "observe" || result.skipped)
      return { lesson: { ...ranked, admission: stamp(mode, result, false) }, action: "new" };
    const target = result.target;
    const sink = ctx.sink;
    const domain = lesson.domain;
    const asNew = (reason?: string): LessonAdmissionDecision => ({
      lesson: {
        ...ranked,
        admission: {
          ...stamp(mode, result, false),
          ...(reason ? { reason: `${result.reason}; ${reason}` } : {}),
          action: "new",
        },
      },
      action: "new",
    });
    switch (result.action) {
      case "merge": {
        if (!target || !sink.update) return asNew("merge unavailable");
        try {
          await sink.update(domain, target.id, (n) => ({
            ...n,
            support: (n.support ?? 1) + 1,
            refs: [...new Set([...(n.refs ?? []), ...(lesson.refs ?? [])])].slice(
              0,
              MAX_MERGED_REFS,
            ),
            merged: [
              ...(n.merged ?? []),
              {
                source: lesson.source,
                resolved_at: lesson.resolvedAt,
                trust: lesson.trust,
                ...(lesson.judge ? { judge: lesson.judge } : {}),
                ...(lesson.refs?.length ? { refs: lesson.refs.slice(0, 3) } : {}),
              },
            ],
          }));
          return { lesson: null, mergedInto: target.id, action: "merge" };
        } catch {
          return asNew("merge failed");
        }
      }
      case "supersede": {
        if (!target || !sink.retire) return asNew("supersede unavailable");
        return {
          lesson: {
            ...ranked,
            resolvedAt: later(lesson.resolvedAt, target.resolvedAt ?? lesson.resolvedAt),
            admission: stamp(mode, result, true),
          },
          action: "supersede",
          afterWrite: async (id) => {
            await sink.retire!(domain, target.id, {
              reason: `superseded at admission: ${result.reason}`,
              by: ADMISSION_CURATOR,
              supersededBy: id,
            });
          },
        };
      }
      case "contest": {
        if (!target) return asNew("contest without a target");
        const auto = result.autoResolve === true;
        return {
          lesson: {
            ...ranked,
            admission: {
              ...stamp(mode, result, true),
              contests: [target.id],
              ...(auto ? {} : { state: "contested" as const }),
            },
          },
          action: "contest",
          afterWrite: async (id) => {
            const rationale = `admission: ${result.reason} (${relationLabel(result.relation) ?? "contradicts"})`;
            try {
              if (!sink.contest) throw new Error("no resolve cases in this store");
              await sink.contest(domain, id, target.id, { autoResolve: auto, rationale });
            } catch (err) {
              // An auto-resolution still closes the weaker lesson, through the
              // ordinary audited retirement; a held lesson stays held.
              if (auto && sink.retire)
                await sink.retire(domain, target.id, {
                  reason: `contradicted at admission by stronger evidence: ${rationale}`,
                  by: ADMISSION_CURATOR,
                  supersededBy: id,
                });
              else throw err;
            }
          },
        };
      }
      default:
        return { lesson: { ...ranked, admission: stamp(mode, result, true) }, action: "new" };
    }
  };
}
