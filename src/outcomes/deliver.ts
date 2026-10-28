// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Delivering recorded outcomes to the consumers that learn from them, from
 * durable per-consumer state (`outcome_deliveries`):
 *
 *   lessons  a judged lesson through the armed learner (`armedLearner`),
 *            within the shared hourly budget. Over budget, the outcome waits
 *            for a later pass — never dropped. With no model provider, or
 *            the daily spend cap reached, it waits without spending an
 *            attempt or a budget unit. When the writer or the judge gives no
 *            answer for a TRANSIENT cause (`src/learning/unavailable.ts`:
 *            spend cap, throttling, 5xx, timeout, transport), the outcome
 *            waits without spending an attempt and the rest of the pass waits
 *            too (no further model calls); only a cause that repeats for the
 *            same input (no rule written, a refusal, a malformed reply)
 *            spends an attempt toward `failed`. Each pass re-opens a bounded
 *            number of `failed` deliveries whose recorded reason was such a
 *            transient cause (`reopenTransientFailures`).
 *            Forecasts, arena rounds and research asks wait for their group
 *            and teach in aggregate (`AGGREGATE_MIN_OUTCOMES`, or fewer once
 *            stale), each group claimed by one pass.
 *   history  one record in MARINA_FORECAST_HISTORY (recalibration, prior
 *            shrink, routing), from the answer's pre-adjustment forecast,
 *            naming its formation when the outcome's `method:` ref does.
 *
 * Each pass first backfills delivery rows an outcome is missing
 * (`backfillOutcomeDeliveries`).
 *
 * One rule set for every producer. A measurement run (`eval_mode = measure`)
 * teaches like any other outcome when its board is named (its source or an
 * `eval:<board>` ref; leakage rule 2 keeps the lesson out of that board's own
 * measurements) and is skipped otherwise; it never writes history, which tunes
 * the very forecasts the board measures (`skipped: measurement`). A shadow
 * challenger (`src/forecast/shadow.ts`) teaches but never writes history: its
 * question is already recorded by its live answer (`skipped: shadow challenger`). Private context
 * (the question) is read back from the subject row, never stored on the
 * outcome. A delivery that keeps failing ends `failed`, with its reason.
 */

import { recordJudgeOpinion } from "../decisions/judges";
import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { noteResolvedForecast, noteResolvedRecord } from "../forecast/adjust";
import { arbiterHistory } from "../forecast/arbiter";
import { typedFormation } from "../forecast/formations";
import { type ForecastHistory, historyFromEnv, resolvedRecord } from "../forecast/history";
import { recipeCard, recipeKey } from "../forecast/method-cards";
import { SHADOW_OWNER } from "../forecast/routing-refs";
import type { TypedForecastAnswer } from "../forecast/typed";
import { EVAL_REF_PREFIX, sourceNamesBoard } from "../learning/eval-context";
import { familiesForSource } from "../learning/families";
import { lessonsMode } from "../learning/modes";
import {
  type Outcome,
  type OutcomeDomain,
  type OutcomeLearnerDeps,
  recordOutcome,
} from "../learning/outcomes";
import { armedLearner, canHoldOwnLessons, ownerLessonSink } from "../learning/service";
import { transientFailureReason } from "../learning/unavailable";
import { workScopeFor } from "../learning/work";
import type { MarinaDB } from "../persistence/database";
import type { ForecastAnswerRow } from "../persistence/db-markets";
import { AGGREGATING_REASON, type OutcomeRow } from "../persistence/db-outcomes";
import { outcomeLearningJournal } from "./journal";
import { consumersFor, OUTCOME_CONSUMERS } from "./record";

const logger = new Logger();

/**
 * Attempts before a delivery that keeps failing (or never gets a verdict for a
 * cause that is not transient) ends `failed`.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface DeliveryReport {
  done: number;
  skipped: number;
  failed: number;
  /** Left pending for a later pass (budget, no verdict, not armed). */
  waiting: number;
}

const forecastId = (subject: string) =>
  subject.startsWith("forecast:") ? Number(subject.slice("forecast:".length)) : undefined;

function answerFor(db: MarinaDB, o: OutcomeRow): ForecastAnswerRow | undefined {
  const id = forecastId(o.subject);
  return id !== undefined && Number.isSafeInteger(id) ? db.getForecastAnswer(id) : undefined;
}

function typedOf(row: ForecastAnswerRow): TypedForecastAnswer | undefined {
  try {
    const a = JSON.parse(row.answer_json) as Partial<TypedForecastAnswer>;
    return a?.answer?.type === row.kind ? (a as TypedForecastAnswer) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A measurement outcome teaches only when its board is named — by its source
 * (`futurex:…`) or an `eval:<board>` ref — so leakage rule 2 can keep the
 * lesson out of that board's own measurements.
 */
function measuredBoardNamed(o: OutcomeRow): boolean {
  if (sourceNamesBoard(o.source)) return true;
  const refs = (parse(o.refs_json) as string[] | undefined) ?? [];
  return refs.some((r) => typeof r === "string" && r.startsWith(EVAL_REF_PREFIX));
}

const parse = (s: string | null) => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
};

/** What a forecast lesson says it attempted, by the answer's kind. */
export function attemptedFor(kind: string): string {
  if (kind === "probability") return "probability forecast of a yes/no question";
  if (kind === "number") return "numeric forecast with an uncertainty band";
  return `${kind} forecast`;
}

function retryOrFail(
  db: MarinaDB,
  o: OutcomeRow,
  consumer: string,
  reason: string,
): "failed" | "waiting" {
  const attempts = db.outcomeDeliveries(o.id).find((d) => d.consumer === consumer)?.attempts ?? 0;
  const state = attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending";
  db.setOutcomeDelivery(o.id, consumer, state, reason);
  return state === "failed" ? "failed" : "waiting";
}

/**
 * The history `formation` an outcome's `method:` ref names, when it names a
 * typed recipe card (`src/forecast/method-cards.ts`): a plain card
 * (`method:formation:delphi`, as the arena and typed card routing both tag it)
 * → the bare formation (`delphi`), which formation routing reads; a variant
 * card (`method:formation:delphi+closed-book`) → its card id, which card
 * routing reads and formation routing ignores (a variant is not the plain
 * formation). Any other method (`nowcast`, `research`, `model:…`) → none.
 */
export function formationFromMethodRef(refs: readonly string[]): string | undefined {
  const method = refs.find((r) => r.startsWith("method:"))?.slice("method:".length);
  const card = method?.startsWith("formation:") ? recipeCard(method) : undefined;
  if (!card?.formation) return undefined;
  return card.id === recipeKey(card.formation) ? card.formation : card.id;
}

/**
 * The formation that produced a saved answer (its outcome's `method:` card,
 * else a typed answer's `formation`, or the typed run behind a plain answer)
 * and the outcome's score (0–1, higher is better) — what
 * `MARINA_FORECAST_ROUTE` compares formations on. Absent when nothing names one.
 */
function routingEvidence(
  row: ForecastAnswerRow,
  o: OutcomeRow,
): { formation?: string; score?: number } {
  const a = parse(row.answer_json) as
    | { formation?: { pattern?: unknown }; typed?: { formation?: { pattern?: unknown } } }
    | undefined;
  const formation =
    formationFromMethodRef(refsOf(o)) ??
    typedFormation(String(a?.formation?.pattern ?? a?.typed?.formation?.pattern ?? ""));
  return {
    ...(formation ? { formation } : {}),
    ...(o.quality !== null && Number.isFinite(o.quality) ? { score: o.quality } : {}),
  };
}

/**
 * The Arbiter's overrule on a resolved answer, scored by the truth (right =
 * it beat the majority), in the one judge ledger (`arbiter` surface). For the
 * readout only: the Arbiter's earned trust stays its own bar, read from
 * as-of-fenced forecast history, which this writes beside.
 */
export function noteArbiterOverrule(
  db: MarinaDB,
  subject: string,
  answer: Pick<TypedForecastAnswer, "answer" | "arbiter">,
  truth: { options?: string[]; value?: unknown },
  at: number,
): void {
  const arbiter = arbiterHistory(answer, truth);
  if (!arbiter?.overruled || arbiter.right === undefined) return;
  recordJudgeOpinion(db, {
    surface: "arbiter",
    judge: arbiter.evaluator,
    subject,
    opinion: "pass",
    truth: arbiter.right ? "pass" : "fail",
    opinedAt: at,
  });
}

/**
 * The history record for a resolved forecast: a typed answer through
 * `noteResolvedForecast` (its pre-adjustment forecast and prior); a plain
 * probability or number from its saved values (that path has no adjustment
 * stage). Undefined when there is nothing to record (a number with no sd).
 */
async function deliverHistory(
  db: MarinaDB,
  o: OutcomeRow,
  history: ForecastHistory,
): Promise<"done" | "skipped"> {
  // No saved answer: nothing to record. Arena profile and ranking rounds land
  // here on purpose: a history record is a raw forecast of one answer shape
  // (choice, multi, number…) that recalibration and prior shrink replay, and
  // a profile or a ranking has neither the shape nor a raw forecast to give.
  const row = answerFor(db, o);
  if (!row) return "skipped";
  const truth = parse(o.truth_json) as { options?: string[]; value?: number } | undefined;
  if (!truth) return "skipped";
  const resolvedAt = new Date(o.resolved_at).toISOString();
  // Routing evidence: which formation answered, and how well (numbers only).
  const routed = routingEvidence(row, o);
  const typed = typedOf(row);
  if (typed) {
    const wrote = await noteResolvedForecast(history, {
      id: o.subject,
      req: { question: typed.question, answer: typed.answer },
      answer: typed,
      truth,
      resolvedAt,
      ...routed,
    });
    if (wrote) noteArbiterOverrule(db, o.subject, typed, truth, o.resolved_at);
    return wrote || (await history.all()).some((r) => r.id === o.subject) ? "done" : "skipped";
  }
  if (row.kind === "number" && row.mean !== null && row.sd !== null && row.sd > 0) {
    if (truth.value === undefined) return "skipped";
    await noteResolvedRecord(
      history,
      resolvedRecord({
        id: o.subject,
        spec: { type: "number" },
        resolvedAt,
        numbers: { value: row.mean, sd: row.sd },
        truth,
        ...routed,
      }),
    );
    return "done";
  }
  if (row.kind === "probability" && row.probability !== null && truth.options?.length) {
    await noteResolvedRecord(
      history,
      resolvedRecord({
        id: o.subject,
        spec: {
          type: "choice",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
        resolvedAt,
        numbers: { distribution: { yes: row.probability, no: 1 - row.probability } },
        truth,
        ...routed,
      }),
    );
    return "done";
  }
  return "skipped";
}

/** The lesson loop's view of an outcome, with private context read back from its subject. */
/**
 * What the work was and its private context, read back from the subject:
 * a forecast's question, a task's title and description, a verification's
 * failing output. Never stored on the outcome.
 */
function subjectContext(
  db: MarinaDB,
  o: OutcomeRow,
): { attempted: string; privateContext?: string; signals?: string[] } {
  if (o.kind === "forecast") {
    const row = answerFor(db, o);
    return row
      ? {
          attempted: attemptedFor(row.kind),
          privateContext: `${row.question}\n${o.truth_json ?? ""}\n${row.prediction ?? ""}`,
        }
      : { attempted: `forecast (${o.source})` };
  }
  // A judged outcome's work is its subject without the `judged:` prefix.
  const subject = o.subject.startsWith("judged:") ? o.subject.slice("judged:".length) : o.subject;
  if (subject.startsWith("task:")) {
    const task = db.getTask(Number(subject.split(":")[1]));
    return {
      attempted: "complete a posted task to its creator's satisfaction",
      ...(task
        ? {
            privateContext: [task.title, task.description ?? "", task.deliverables ?? ""]
              .filter(Boolean)
              .join("\n")
              .slice(0, 2_000),
          }
        : {}),
    };
  }
  if (o.subject.startsWith("artifact:")) {
    const artifact = db.getCodingArtifact(o.subject.slice("artifact:".length));
    const meta = (parse(artifact?.metadata_json ?? null) ?? {}) as {
      commands?: string[][];
      artifactIds?: string[];
      stoppedAt?: string[];
    };
    const commands = meta.commands ?? [];
    // The failing step's output (the last step that ran) is what a failure teaches from.
    const lastId = o.succeeded ? undefined : meta.artifactIds?.at(-1);
    const output = lastId ? db.getCodingArtifact(lastId)?.content_text : undefined;
    return {
      attempted: `verify a change with ${commands.map((c) => c[0]).join(", ") || "checks"}`,
      signals: commands.map((c) => c.join(" ")),
      ...(output ? { privateContext: output.slice(-1_200) } : {}),
    };
  }
  return { attempted: `${o.kind} ${o.source}` };
}

function lessonOutcome(db: MarinaDB, o: OutcomeRow): Outcome {
  const refs = (parse(o.refs_json) as string[] | undefined) ?? [];
  const context = subjectContext(db, o);
  return {
    domain: o.domain as OutcomeDomain,
    source: o.source,
    succeeded: o.succeeded === 1,
    ...(o.quality !== null ? { score: o.quality } : {}),
    resolvedAt: new Date(o.resolved_at).toISOString(),
    attempted: context.attempted,
    ...(context.signals?.length ? { signals: context.signals } : {}),
    ...(o.detail ? { detail: o.detail } : {}),
    ...(refs.length ? { refs } : {}),
    ...(o.basis === "judged"
      ? { provenance: { basis: "judged", judge: o.judge ?? "unknown" } }
      : {}),
    ...(context.privateContext ? { privateContext: context.privateContext } : {}),
    ...(o.eval_mode === "measure" ? { measured: true } : {}),
  };
}

/** Where a lesson from an outcome goes: the shared pool, or one owner's own spaces. */
type LessonTarget = { shared: true } | { owner: string } | { skip: string };

/**
 * Where a lesson from this outcome may be written. Forecasts teach the shared
 * pool (as they always have). Live work follows whose work it was
 * (`workScopeFor`): a world agent's work teaches the shared pool, a person's
 * (or the agents it spawned) only that person's own lesson spaces, and work
 * whose scope cannot be resolved teaches nothing.
 */
function lessonTarget(db: MarinaDB, o: OutcomeRow): LessonTarget {
  if (o.kind === "forecast") return { shared: true };
  if (!o.owner) return { skip: "no owner" };
  const scope = workScopeFor(db, o.owner);
  if (!scope) return { skip: "owner scope unresolved" };
  if (scope.kind === "shared") return { shared: true };
  return canHoldOwnLessons(db, scope.owner)
    ? { owner: scope.owner }
    : { skip: "owner cannot hold lessons" };
}

/**
 * The learner deps for a target: a person's lessons go to its own spaces, and
 * its private work never confirms or retires the world's imported lessons.
 */
const depsFor = (
  db: MarinaDB,
  t: { shared: true } | { owner: string },
  deps: OutcomeLearnerDeps,
): OutcomeLearnerDeps => {
  if (!("owner" in t)) return deps;
  const { imported: _imported, ...rest } = deps;
  return { ...rest, sink: ownerLessonSink(db, t.owner) };
};

// ─── Aggregate lessons ──────────────────────────────────────────────────────
//
// Outcomes that arrive one per round or item (forecasts, arena rounds,
// research asks) teach in aggregate: a single round cannot show a general
// rule, and single rounds contradict each other. Each waits, still `pending`
// with an `aggregating: <key>` reason and no attempt spent (durable across
// restarts), until AGGREGATE_MIN_OUTCOMES of the same scope, source shape,
// family and measurement board are waiting; then ONE lesson is written from
// their statistics with the aggregate writer prompt. Task verdicts and code
// checks keep the per-outcome path.

/** Single outcomes of one kind learned together once this many wait. */
export const AGGREGATE_MIN_OUTCOMES = 5;
/** At most this many single outcomes summarised by one aggregate lesson. */
export const AGGREGATE_MAX_OUTCOMES = 50;
/**
 * A group still short of AGGREGATE_MIN_OUTCOMES is learned anyway once its
 * oldest outcome has waited this long (a slow family, such as a monthly
 * series, would otherwise never learn)…
 */
export const AGGREGATE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** …provided it has at least this many outcomes; smaller groups keep waiting. */
export const AGGREGATE_STALE_MIN_OUTCOMES = 3;
/** A claim older than this belongs to a pass that died: it is released. */
export const AGGREGATE_CLAIM_TTL_MS = 60 * 60 * 1000;
/** Held outcomes scanned per pass for groups that are ready. */
const AGGREGATE_SCAN = 2_000;

/** Outcomes that arrive one per round or item and teach only in aggregate. */
export function aggregatesLessons(o: Pick<OutcomeRow, "kind" | "source">): boolean {
  return o.kind === "forecast" || o.source === "research:ask";
}

const refsOf = (o: OutcomeRow) =>
  ((parse(o.refs_json) as unknown[] | undefined) ?? []).filter(
    (r): r is string => typeof r === "string",
  );

/** The family or tracker an outcome's work belongs to (its first `family:` ref), or "". */
const familyOf = (o: OutcomeRow) =>
  refsOf(o)
    .find((r) => r.startsWith("family:"))
    ?.slice("family:".length) ?? "";

/** The group an outcome is learned with: scope, source shape, family, measured board. */
function aggregateKey(o: OutcomeRow, t: { shared: true } | { owner: string }): string {
  const refs = refsOf(o);
  const family = familyOf(o);
  const boards =
    o.eval_mode === "measure"
      ? `measure:${refs
          .filter((r) => r.startsWith(EVAL_REF_PREFIX))
          .sort()
          .join(",")}`
      : "live";
  return [
    "owner" in t ? `owner:${t.owner}` : "shared",
    o.owner === SHADOW_OWNER ? "shadow" : "",
    o.domain,
    o.source,
    family,
    boards,
  ].join("|");
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * One outcome from many of one kind: cross-outcome statistics, never one
 * item's text. `stale`: a group learned below AGGREGATE_MIN_OUTCOMES after
 * waiting AGGREGATE_STALE_MS; the detail says so, beside the true N.
 */
export function aggregateOutcome(
  db: MarinaDB,
  rows: readonly OutcomeRow[],
  opts: { stale?: boolean } = {},
): Outcome {
  const first = rows[0]!;
  const n = rows.length;
  const wins = rows.filter((r) => r.succeeded === 1).length;
  const finite = (xs: Array<number | null>) =>
    xs.filter((x): x is number => x !== null && Number.isFinite(x));
  const qualities = finite(rows.map((r) => r.quality));
  const losses = finite(rows.map((r) => r.loss));
  // Success per method and per family: what the writer can compare.
  const tally = new Map<string, { n: number; s: number }>();
  for (const r of rows)
    for (const ref of new Set(refsOf(r)))
      if (ref.startsWith("method:") || ref.startsWith("family:")) {
        const c = tally.get(ref) ?? { n: 0, s: 0 };
        c.n++;
        c.s += r.succeeded;
        tally.set(ref, c);
      }
  const signals = [...tally]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 8)
    .map(([k, c]) => `${k}: ${c.s} of ${c.n} succeeded`);
  // The board refs first (leakage rule 2), then families and methods.
  const all = [...new Set(rows.flatMap(refsOf))];
  const refs = [
    ...all.filter((r) => r.startsWith(EVAL_REF_PREFIX)),
    ...all.filter((r) => r.startsWith("family:") || r.startsWith("method:")),
  ];
  const context = subjectContext(db, first);
  const privateContext = rows
    .map((r) => subjectContext(db, r).privateContext)
    .filter(Boolean)
    .join("\n")
    .slice(0, 8_000);
  const families = familiesForSource(first.source);
  // The group's family: the lesson is judged general within it and served only to it.
  const family = familyOf(first);
  return {
    domain: first.domain as OutcomeDomain,
    source: first.source,
    succeeded: wins * 2 >= n,
    ...(qualities.length ? { score: mean(qualities) } : {}),
    resolvedAt: new Date(Math.max(...rows.map((r) => r.resolved_at))).toISOString(),
    attempted: `${context.attempted} (${n} outcomes of the same kind)`,
    detail: [
      `${wins} of ${n} succeeded`,
      qualities.length ? `mean quality ${mean(qualities).toFixed(3)}` : "",
      losses.length
        ? `mean ${first.metric ?? "loss"} ${mean(losses).toFixed(3)} (range ${Math.min(...losses).toFixed(3)}–${Math.max(...losses).toFixed(3)})`
        : "",
      opts.stale
        ? `only ${n} outcomes (fewer than the usual ${AGGREGATE_MIN_OUTCOMES}; learned after waiting ${Math.round(AGGREGATE_STALE_MS / 86_400_000)} days)`
        : "",
    ]
      .filter(Boolean)
      .join("; "),
    ...(signals.length ? { signals } : {}),
    ...(refs.length ? { refs } : {}),
    scope: "method",
    ...(family ? { scopeFamily: family } : {}),
    ...(families.length ? { families } : {}),
    ...(privateContext ? { privateContext } : {}),
    ...(first.eval_mode === "measure" ? { measured: true } : {}),
    aggregateOf: n,
    provenance: {
      learner: "outcome-aggregate",
      aggregate: String(n),
      ...(first.basis === "judged" ? { basis: "judged" } : {}),
    },
  };
}

type Learner = NonNullable<ReturnType<typeof armedLearner>>;

/**
 * Whether a waiting group is learned now: it reached AGGREGATE_MIN_OUTCOMES,
 * or it has AGGREGATE_STALE_MIN_OUTCOMES and its oldest outcome was recorded
 * at least AGGREGATE_STALE_MS ago. Undefined: it keeps waiting.
 */
export function aggregateReady(
  rows: ReadonlyArray<Pick<OutcomeRow, "created_at">>,
  now: number,
): "full" | "stale" | undefined {
  if (rows.length >= AGGREGATE_MIN_OUTCOMES) return "full";
  if (rows.length < AGGREGATE_STALE_MIN_OUTCOMES) return undefined;
  const oldest = Math.min(...rows.map((r) => r.created_at));
  return now - oldest >= AGGREGATE_STALE_MS ? "stale" : undefined;
}

let claimSeq = 0;
/** A claim token unique to this pass (no `|`, see `claimOutcomeDeliveries`). */
const claimToken = () =>
  `${process.pid.toString(36)}.${Date.now().toString(36)}.${(++claimSeq).toString(36)}.${Math.random().toString(36).slice(2, 8)}`;

/**
 * Learn every group of held outcomes that is ready (`aggregateReady`). A
 * group is claimed atomically before its model call, so two passes running at
 * once (the background pass and the tick job) never learn it twice; the claim
 * is released when the lesson is not written.
 */
async function deliverAggregates(
  db: MarinaDB,
  learner: Learner,
  tally: () => DeliveryReport,
  now: number,
  pass: PassState,
  signal: AbortSignal,
): Promise<void> {
  db.releaseStaleOutcomeClaims("lessons", now - AGGREGATE_CLAIM_TTL_MS, now);
  const groups = new Map<
    string,
    { target: { shared: true } | { owner: string }; rows: OutcomeRow[] }
  >();
  for (const o of db.pendingOutcomes("lessons", AGGREGATE_SCAN, { aggregating: true })) {
    const target = lessonTarget(db, o);
    if ("skip" in target) {
      db.setOutcomeDelivery(o.id, "lessons", "skipped", target.skip);
      tally().skipped++;
      continue;
    }
    const key = aggregateKey(o, target);
    const g = groups.get(key) ?? { target, rows: [] };
    g.rows.push(o);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    if (signal.aborted) break;
    const ready = aggregateReady(g.rows, now);
    if (!ready) continue;
    const t = tally();
    const held = `${AGGREGATING_REASON}: ${key}`;
    if (pass.pause) {
      for (const o of g.rows) db.waitOutcomeDelivery(o.id, "lessons", `${held}; ${pass.pause}`);
      t.waiting += g.rows.length;
      continue;
    }
    const rows = g.rows.slice(0, AGGREGATE_MAX_OUTCOMES);
    // Claim the group (all or none): another pass that got there first owns it.
    const token = claimToken();
    if (
      !db.claimOutcomeDeliveries(
        rows.map((o) => o.id),
        "lessons",
        held,
        token,
        now,
      )
    )
      continue;
    try {
      // One unit of the shared hourly budget per aggregate lesson; over it, wait.
      if (learner.take(1) === 0) {
        t.waiting += g.rows.length;
        continue;
      }
      // A retry keeps the aggregating reason, so the outcome stays in its group.
      const retry = (reason: string) => {
        for (const o of rows) t[retryOrFail(db, o, "lessons", `${held}; ${reason}`)]++;
      };
      try {
        const r = await recordOutcome(
          { ...depsFor(db, g.target, learner.deps), deferUnjudged: true, signal },
          aggregateOutcome(db, rows, ready === "stale" ? { stale: true } : {}),
        );
        if (signal.aborted) break;
        if (r.deferred && r.unavailable?.transient) {
          // An outage: the group waits (claims replaced), no attempt spent,
          // and the rest of the pass makes no further model calls.
          pass.pause = `waiting: no verdict: ${r.reason}`;
          for (const o of rows) db.waitOutcomeDelivery(o.id, "lessons", `${held}; ${pass.pause}`);
          t.waiting += rows.length;
        } else if (r.deferred) retry(`no verdict: ${r.reason}`);
        else
          for (const o of rows) {
            db.setOutcomeDelivery(
              o.id,
              "lessons",
              "done",
              `aggregate of ${rows.length}: ${r.trust}`,
            );
            t.done++;
          }
      } catch (err) {
        if (signal.aborted) break;
        retry(String(err));
      }
    } finally {
      // Anything still claimed (over budget, an unexpected throw) waits in its group again.
      db.releaseOutcomeClaims("lessons", token);
    }
  }
}

// ─── Backfill ───────────────────────────────────────────────────────────────

/** Outcomes scanned per backfill step. */
export const BACKFILL_SCAN = 500;
/** How far each database's backfill has scanned (process-local; a restart rescans, cheaply). */
const backfilled = new WeakMap<MarinaDB, number>();

/**
 * Give outcomes recorded without some consumer's delivery row (recorded
 * before that consumer existed, or before deliveries were kept) the rows
 * `consumersFor` gives them today, as `pending`; the delivery pass then
 * applies every rule as for any outcome (a measurement teaches only with its
 * board named and never writes history; a benchmark run, a reported request
 * and an unearned judged outcome get no consumer at all). A row that exists,
 * in any state, is never touched, so nothing is delivered twice, and running
 * it again changes nothing. At most `scan` outcomes per call; no model needed.
 */
export function backfillOutcomeDeliveries(
  db: MarinaDB,
  opts: { now?: number; scan?: number } = {},
): { scanned: number; added: number } {
  const after = backfilled.get(db) ?? 0;
  const rows = db.outcomesMissingDeliveries(OUTCOME_CONSUMERS, after, opts.scan ?? BACKFILL_SCAN);
  let added = 0;
  for (const o of rows) {
    const consumers = consumersFor(o.kind, o.basis, { source: o.source });
    if (consumers.length) added += db.addMissingOutcomeDeliveries(o.id, consumers, opts.now);
  }
  // A full window resumes after its last row; a short one covered everything
  // recorded so far (synchronously: nothing was recorded meanwhile), so the
  // next call starts after the newest outcome.
  const last = rows.at(-1)?.id ?? after;
  const full = rows.length >= (opts.scan ?? BACKFILL_SCAN);
  backfilled.set(db, full ? last : Math.max(last, db.listOutcomes({ limit: 1 })[0]?.id ?? after));
  return { scanned: rows.length, added };
}

// ─── Outages ────────────────────────────────────────────────────────────────

/** Why the rest of this pass's lessons wait (no model provider, spend cap, an outage). */
interface PassState {
  pause?: string;
}

/** `failed` lessons deliveries read per re-open scan, at most. */
export const REOPEN_SCAN = 200;
/** How far each database's re-open scan has read (process-local; a restart rescans, cheaply). */
const reopened = new WeakMap<MarinaDB, number>();
/**
 * Reasons a pass may have ended a lessons delivery `failed` with while an
 * outage should have kept it waiting (before outages waited): the judge's
 * kind-less `decision backend unavailable`, and the writer's
 * `writer unavailable: <message>` (today's reasons name a kind in parentheses).
 */
const REOPEN_LIKE = ["%no verdict: decision backend unavailable", "%writer unavailable: %"];

/**
 * Re-open `failed` lessons deliveries whose recorded reason was a transient
 * cause (`transientFailureReason`): back to `pending`, attempts reset, so the
 * outcome teaches after all. At most `scan` rows read per call, resuming
 * after the last one read; only a `failed` row changes, so re-running is a
 * no-op. A re-opened delivery that fails again records today's reason (with
 * its kind), which is never re-opened: a transient kind waits instead of
 * failing.
 */
export function reopenTransientFailures(
  db: MarinaDB,
  opts: { now?: number; scan?: number } = {},
): number {
  const scan = opts.scan ?? REOPEN_SCAN;
  const after = reopened.get(db) ?? 0;
  const rows = db.failedOutcomeDeliveries("lessons", REOPEN_LIKE, after, scan);
  let n = 0;
  for (const row of rows) {
    if (!transientFailureReason(row.reason)) continue;
    const reason = `reopened after an outage: ${(row.reason ?? "").slice(0, 200)}`;
    if (db.reopenOutcomeDelivery(row.outcome_id, "lessons", reason, opts.now)) n++;
  }
  // A full window resumes after its last row; a short one read everything, so
  // the next call starts over (a delivery failed later is found then).
  reopened.set(db, rows.length >= scan ? (rows.at(-1)?.outcome_id ?? after) : 0);
  if (n) logger.info("main", "re-opened lesson deliveries that failed during an outage", { n });
  return n;
}

/** The daily spend cap's refusal, shortened to its first clause for a reason. */
const capReason = (refusal: string) => refusal.split(";")[0]!.trim();

/**
 * One delivery pass over pending outcomes (at most `max` per consumer).
 * Safe to run concurrently with producers; each delivery settles once.
 */
const deliveryControllers = new WeakMap<MarinaDB, AbortController>();

/** Stop queued work and cancel between learner stages during bounded shutdown. */
export function abortDelivery(db: MarinaDB): void {
  deliveryControllers.get(db)?.abort();
}

const deliveryPasses = new WeakMap<MarinaDB, Promise<Record<string, DeliveryReport>>>();

export function deliverOutcomes(
  db: MarinaDB,
  opts: { env?: NodeJS.ProcessEnv; max?: number; now?: number } = {},
): Promise<Record<string, DeliveryReport>> {
  // Producers, periodic jobs and explicit retries share this serialization.
  // Each queued pass reads pending rows only after its predecessor settles.
  const previous = deliveryPasses.get(db);
  const ready = previous
    ? previous.then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
  const run = ready.then(() => deliverPass(db, opts));
  deliveryPasses.set(db, run);
  const clear = () => {
    if (deliveryPasses.get(db) === run) deliveryPasses.delete(db);
  };
  void run.then(clear, clear);
  return run;
}

/** Wait for every producer, tick and explicit delivery already queued for this database. */
export async function settleDeliveryPasses(db: MarinaDB): Promise<void> {
  for (let run = deliveryPasses.get(db); run; run = deliveryPasses.get(db)) await run;
}

export function deliveryPending(db: MarinaDB): boolean {
  return deliveryPasses.has(db);
}

async function deliverPass(
  db: MarinaDB,
  opts: { env?: NodeJS.ProcessEnv; max?: number; now?: number } = {},
): Promise<Record<string, DeliveryReport>> {
  let controller = deliveryControllers.get(db);
  if (!controller) {
    controller = new AbortController();
    deliveryControllers.set(db, controller);
  }
  const signal = controller.signal;
  if (signal.aborted) return {};
  const env = opts.env ?? process.env;
  const max = Math.max(1, opts.max ?? 50);
  const now = opts.now ?? Date.now();
  const report: Record<string, DeliveryReport> = {};
  const tally = (consumer: string) =>
    (report[consumer] ??= { done: 0, skipped: 0, failed: 0, waiting: 0 });

  // Outcomes recorded without some consumer's row get it first (bounded per pass).
  backfillOutcomeDeliveries(db, { now });

  // History: no history configured ⇒ nothing to write (skipped, with the reason).
  const history = historyFromEnv(env);
  for (const o of db.pendingOutcomes("history", max)) {
    if (signal.aborted) break;
    const t = tally("history");
    if (o.kind === "forecast" && db.isPrivateForecast(forecastId(o.subject) ?? -1)) {
      db.setOutcomeDelivery(o.id, "history", "skipped", "private investigation");
      t.skipped++;
      continue;
    }
    if (o.eval_mode === "measure") {
      db.setOutcomeDelivery(o.id, "history", "skipped", "measurement");
      t.skipped++;
      continue;
    }
    // A shadow challenger answered a question the live answer already records:
    // a second history record would be a correlated extra for prior shrink and
    // recalibration. Its paired evidence lives on its outcome row; it still teaches.
    if (o.owner === SHADOW_OWNER) {
      db.setOutcomeDelivery(o.id, "history", "skipped", "shadow challenger");
      t.skipped++;
      continue;
    }
    if (!history) {
      db.setOutcomeDelivery(o.id, "history", "skipped", "no history configured");
      t.skipped++;
      continue;
    }
    try {
      const state = await deliverHistory(db, o, history);
      if (signal.aborted) break;
      db.setOutcomeDelivery(
        o.id,
        "history",
        state,
        state === "skipped" ? "no raw forecast to record" : undefined,
      );
      t[state]++;
    } catch (err) {
      if (signal.aborted) break;
      t[retryOrFail(db, o, "history", String(err))]++;
    }
  }

  // Lessons: off ⇒ skipped; not armed (a script that never armed it) ⇒ wait.
  const lessonsOff = lessonsMode(env) === "off";
  const learner = lessonsOff ? undefined : armedLearner(db, env);
  if (signal.aborted) return report;
  // Deliveries a past outage ended `failed` get another chance first.
  if (learner) reopenTransientFailures(db, { now });
  // Nothing can be learned this pass: no model provider, or the daily spend
  // cap is reached (every writer and judge call would be refused). Each
  // outcome waits — no attempt, no budget unit, no model call.
  const capped = learner ? dailyCapRefusal(env, now) : undefined;
  const pass: PassState = learner?.unavailable
    ? { pause: `waiting: ${learner.unavailable}` }
    : capped
      ? { pause: `waiting: ${capReason(capped)}` }
      : {};
  // Held-for-aggregation outcomes are scanned separately (`deliverAggregates`),
  // so they never crowd single outcomes out of a pass.
  const pending = db.pendingOutcomes("lessons", max, lessonsOff ? {} : { aggregating: false });
  for (const o of pending) {
    if (signal.aborted) break;
    const t = tally("lessons");
    if (o.kind === "forecast" && db.isPrivateForecast(forecastId(o.subject) ?? -1)) {
      db.setOutcomeDelivery(o.id, "lessons", "skipped", "private investigation");
      t.skipped++;
      continue;
    }
    const unnamed = o.eval_mode === "measure" && !measuredBoardNamed(o);
    if (unnamed || lessonsOff) {
      db.setOutcomeDelivery(
        o.id,
        "lessons",
        "skipped",
        lessonsOff ? "lessons off" : "measurement without a board",
      );
      t.skipped++;
      continue;
    }
    const target = lessonTarget(db, o);
    if ("skip" in target) {
      db.setOutcomeDelivery(o.id, "lessons", "skipped", target.skip);
      t.skipped++;
      continue;
    }
    // One round or item teaches nothing alone: it waits for its group.
    if (aggregatesLessons(o)) {
      db.waitOutcomeDelivery(o.id, "lessons", `${AGGREGATING_REASON}: ${aggregateKey(o, target)}`);
      t.waiting++;
      continue;
    }
    if (!learner) {
      t.waiting++;
      continue;
    }
    // No model provider, the spend cap, or an outage this pass: wait — no attempt spent.
    if (pass.pause) {
      db.waitOutcomeDelivery(o.id, "lessons", pass.pause);
      t.waiting++;
      continue;
    }
    try {
      const deps = depsFor(db, target, learner.deps);
      const journal = deps.sink.withJournal ? outcomeLearningJournal(db, o.id) : undefined;
      const judged = journal?.has("verdict") || journal?.has("complete");
      if (!learner.deps.judge && !judged) {
        db.setOutcomeDelivery(
          o.id,
          "lessons",
          "pending",
          "no verdict: no decision backend",
          undefined,
          false,
        );
        t.waiting++;
        continue;
      }
      // One unit of the shared hourly budget per judged lesson; over it, wait.
      if (!judged && learner.take(1) === 0) {
        t.waiting++;
        continue;
      }
      const r = await recordOutcome(
        { ...deps, deferUnjudged: true, signal, ...(journal ? { journal } : {}) },
        lessonOutcome(db, o),
      );
      if (signal.aborted) break;
      if (r.deferred && r.unavailable?.transient) {
        // An outage, not this outcome's fault: wait without spending an
        // attempt, and make no further model calls this pass.
        pass.pause = `waiting: no verdict: ${r.reason}`;
        db.waitOutcomeDelivery(o.id, "lessons", pass.pause);
        t.waiting++;
      } else if (r.deferred) t[retryOrFail(db, o, "lessons", `no verdict: ${r.reason}`)]++;
      else {
        db.setOutcomeDelivery(o.id, "lessons", "done", r.trust);
        t.done++;
      }
    } catch (err) {
      if (signal.aborted) break;
      if ((err as { code?: string })?.code === "version_conflict") {
        db.setOutcomeDelivery(
          o.id,
          "lessons",
          "failed",
          "needs review: admission target changed after the durable plan; no automatic rebase",
        );
        t.failed++;
        continue;
      }
      t[retryOrFail(db, o, "lessons", String(err))]++;
    }
  }
  if (learner && !signal.aborted)
    await deliverAggregates(db, learner, () => tally("lessons"), now, pass, signal);
  if (report.lessons?.failed || report.history?.failed)
    logger.warn("main", "some outcome deliveries failed", { report });
  return report;
}
