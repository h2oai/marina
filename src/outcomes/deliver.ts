// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Delivering recorded outcomes to the consumers that learn from them, from
 * durable per-consumer state (`outcome_deliveries`):
 *
 *   lessons  a judged lesson through the armed learner (`armedLearner`),
 *            within the shared hourly budget. Over budget, or no verdict
 *            reached, the outcome waits for a later pass — never dropped.
 *            With no model provider it waits without spending an attempt.
 *            Forecasts, arena rounds and research asks wait for their group
 *            and teach in aggregate (`AGGREGATE_MIN_OUTCOMES`).
 *   history  one record in MARINA_FORECAST_HISTORY (recalibration, prior
 *            shrink, routing), from the answer's pre-adjustment forecast.
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

import { Logger } from "../engine/logger";
import { noteResolvedForecast, noteResolvedRecord } from "../forecast/adjust";
import { typedFormation } from "../forecast/formations";
import { type ForecastHistory, historyFromEnv, resolvedRecord } from "../forecast/history";
import { SHADOW_OWNER } from "../forecast/routing-refs";
import type { TypedForecastAnswer } from "../forecast/typed";
import { EVAL_REF_PREFIX, sourceNamesBoard } from "../learning/eval-context";
import { familiesForSource } from "../learning/families";
import { lessonsMode } from "../learning/modes";
import {
  type LessonSink,
  type Outcome,
  type OutcomeDomain,
  recordOutcome,
} from "../learning/outcomes";
import { armedLearner, canHoldOwnLessons, ownerLessonSink } from "../learning/service";
import { workScopeFor } from "../learning/work";
import type { MarinaDB } from "../persistence/database";
import type { ForecastAnswerRow } from "../persistence/db-markets";
import { AGGREGATING_REASON, type OutcomeRow } from "../persistence/db-outcomes";

const logger = new Logger();

/** Attempts before a delivery that keeps failing (or never gets a verdict) ends `failed`. */
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
 * The formation that produced a saved answer (a typed answer's `formation`, or
 * the typed run behind a plain answer) and the outcome's score (0–1, higher is
 * better) — what `MARINA_FORECAST_ROUTE` compares formations on.
 */
function routingEvidence(
  row: ForecastAnswerRow,
  o: OutcomeRow,
): { formation?: string; score?: number } {
  const a = parse(row.answer_json) as
    | { formation?: { pattern?: unknown }; typed?: { formation?: { pattern?: unknown } } }
    | undefined;
  const formation = typedFormation(
    String(a?.formation?.pattern ?? a?.typed?.formation?.pattern ?? ""),
  );
  return {
    ...(formation ? { formation } : {}),
    ...(o.quality !== null && Number.isFinite(o.quality) ? { score: o.quality } : {}),
  };
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

const sinkFor = (db: MarinaDB, t: { shared: true } | { owner: string }, shared: LessonSink) =>
  "owner" in t ? ownerLessonSink(db, t.owner) : shared;

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

/** One outcome from many of one kind: cross-outcome statistics, never one item's text. */
export function aggregateOutcome(db: MarinaDB, rows: readonly OutcomeRow[]): Outcome {
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

/** Learn every group of held outcomes that reached AGGREGATE_MIN_OUTCOMES. */
async function deliverAggregates(
  db: MarinaDB,
  learner: Learner,
  tally: () => DeliveryReport,
): Promise<void> {
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
    if (g.rows.length < AGGREGATE_MIN_OUTCOMES) continue;
    const t = tally();
    const held = `${AGGREGATING_REASON}: ${key}`;
    if (learner.unavailable) {
      for (const o of g.rows)
        db.waitOutcomeDelivery(o.id, "lessons", `${held}; ${learner.unavailable}`);
      t.waiting += g.rows.length;
      continue;
    }
    // One unit of the shared hourly budget per aggregate lesson; over it, wait.
    if (learner.take(1) === 0) {
      t.waiting += g.rows.length;
      continue;
    }
    const rows = g.rows.slice(0, AGGREGATE_MAX_OUTCOMES);
    // A retry keeps the aggregating reason, so the outcome stays in its group.
    const retry = (reason: string) => {
      for (const o of rows) t[retryOrFail(db, o, "lessons", `${held}; ${reason}`)]++;
    };
    try {
      const r = await recordOutcome(
        { ...learner.deps, sink: sinkFor(db, g.target, learner.deps.sink), deferUnjudged: true },
        aggregateOutcome(db, rows),
      );
      if (r.deferred) retry(`no verdict: ${r.reason}`);
      else
        for (const o of rows) {
          db.setOutcomeDelivery(o.id, "lessons", "done", `aggregate of ${rows.length}: ${r.trust}`);
          t.done++;
        }
    } catch (err) {
      retry(String(err));
    }
  }
}

/**
 * One delivery pass over pending outcomes (at most `max` per consumer).
 * Safe to run concurrently with producers; each delivery settles once.
 */
export async function deliverOutcomes(
  db: MarinaDB,
  opts: { env?: NodeJS.ProcessEnv; max?: number } = {},
): Promise<Record<string, DeliveryReport>> {
  const env = opts.env ?? process.env;
  const max = Math.max(1, opts.max ?? 50);
  const report: Record<string, DeliveryReport> = {};
  const tally = (consumer: string) =>
    (report[consumer] ??= { done: 0, skipped: 0, failed: 0, waiting: 0 });

  // History: no history configured ⇒ nothing to write (skipped, with the reason).
  const history = historyFromEnv(env);
  for (const o of db.pendingOutcomes("history", max)) {
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
      db.setOutcomeDelivery(
        o.id,
        "history",
        state,
        state === "skipped" ? "no raw forecast to record" : undefined,
      );
      t[state]++;
    } catch (err) {
      t[retryOrFail(db, o, "history", String(err))]++;
    }
  }

  // Lessons: off ⇒ skipped; not armed (a script that never armed it) ⇒ wait.
  const lessonsOff = lessonsMode(env) === "off";
  const learner = lessonsOff ? undefined : armedLearner(db, env);
  // Held-for-aggregation outcomes are scanned separately (`deliverAggregates`),
  // so they never crowd single outcomes out of a pass.
  const pending = db.pendingOutcomes("lessons", max, lessonsOff ? {} : { aggregating: false });
  for (const o of pending) {
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
    // No model provider: no rule can be written, so wait — no attempt spent.
    if (learner.unavailable) {
      db.waitOutcomeDelivery(o.id, "lessons", `waiting: ${learner.unavailable}`);
      t.waiting++;
      continue;
    }
    // One unit of the shared hourly budget per judged lesson; over it, wait.
    if (learner.take(1) === 0) {
      t.waiting++;
      continue;
    }
    try {
      const r = await recordOutcome(
        { ...learner.deps, sink: sinkFor(db, target, learner.deps.sink), deferUnjudged: true },
        lessonOutcome(db, o),
      );
      if (r.deferred) t[retryOrFail(db, o, "lessons", `no verdict: ${r.reason}`)]++;
      else {
        db.setOutcomeDelivery(o.id, "lessons", "done", r.trust);
        t.done++;
      }
    } catch (err) {
      t[retryOrFail(db, o, "lessons", String(err))]++;
    }
  }
  if (learner) await deliverAggregates(db, learner, () => tally("lessons"));
  if (report.lessons?.failed || report.history?.failed)
    logger.warn("main", "some outcome deliveries failed", { report });
  return report;
}
