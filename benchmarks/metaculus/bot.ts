// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Metaculus bot loop, one pass at a time (a timer runs a pass every 20
 * minutes):
 *
 *   forecast  every open question in the tournaments that has no forecast of
 *             ours yet: map it, forecast it with the general typed forecaster,
 *             post the forecast AND its reasoning comment, record it in
 *             `external_submissions` (append-only; one row per question, so a
 *             question is never forecast twice);
 *   resolve   every recorded question that has since resolved: score it and
 *             write a lesson to durable memory, so later forecasts recall it;
 *             recorded once per question (`metaculus-outcome`).
 *
 * A dry run forecasts and writes the would-be payload and comment to a local
 * directory, posts nothing and records nothing. Spend is per question
 * (`cost_usd`) and capped per UTC day (`dailyCapUsd`), on top of the world's
 * own `MARINA_DAILY_SPEND_CAP_USD`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpendGuard } from "../../src/engine/spend-guard";
import { utcDay } from "../../src/engine/spend-ledger";
import type { TypedForecastAnswer } from "../../src/forecast/typed";
import type { Outcome } from "../../src/learning/outcomes";
import type { ExternalSubmissionRow } from "../../src/persistence/db-benchmarks";
import type { MarinaStores } from "../../src/persistence/interfaces";
import type { Forecaster } from "../forecasting/configs";
import { ATTRIBUTION } from "../forecasting/shared";
import type { ForecastPayload, MetaculusClient, MetaculusPost, MetaculusQuestion } from "./api";
import { phi } from "./cdf";
import { cdfQuestion, commentFor, numericSd, payloadFor, requestFor } from "./map";

export const BENCHMARK = "metaculus";
export const OUTCOME_BENCHMARK = "metaculus-outcome";

type Ledger = Pick<MarinaStores, "recordExternalSubmission" | "listExternalSubmissions">;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const questionKey = (questionId: number) => sha256(`metaculus:${questionId}`);
const outcomeKey = (questionId: number) => sha256(`metaculus-outcome:${questionId}`);
/**
 * A paid forecast that was not filed (failed, unpostable, or a dry run) — one
 * row per question per UTC day, so its spend counts against the bot's cap and
 * a failed question is not paid for again until the next day.
 */
export const ATTEMPT_BENCHMARK = "metaculus-attempt";
const attemptKey = (questionId: number, day: string) =>
  sha256(`metaculus-attempt:${questionId}:${day}`);

/** What a recorded forecast keeps (numbers only; the question text stays on Metaculus). */
export interface ForecastMeta {
  postId: number;
  questionId: number;
  type: MetaculusQuestion["type"];
  /** binary: P(yes); multiple choice: per option label; numeric: mean and sd. */
  probabilityYes?: number;
  perCategory?: Record<string, number>;
  mean?: number;
  sd?: number;
  cutoff: string;
  runs: number;
  /** The configuration that forecast (label), disclosed in the comment too. */
  config?: string;
  critiqueApplied?: boolean;
  /** The question's scheduled resolve time when it was filed: past it, the resolve pass checks it first. */
  resolvesAt?: string;
}

export interface PassOptions {
  client: MetaculusClient;
  db: Ledger;
  forecast: Forecaster;
  tournaments: Array<string | number>;
  /** The configuration filing (label + one-line description), disclosed with every forecast. */
  config: { label: string; description: string };
  dryRun?: boolean;
  /** Where a dry run writes payloads and comments. */
  outDir?: string;
  /** This bot's own budget per UTC day (default 10). */
  dailyCapUsd?: number;
  /** At most this many new forecasts per pass. */
  limit?: number;
  /**
   * Files each submitted answer through the one outcome path
   * (`src/outcomes/filing.ts`) under `metaculusId(questionId)`.
   */
  file?: (answer: TypedForecastAnswer, externalId: string, sd?: number) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (line: string) => void;
}

/** A Metaculus question's id on the outcome path. */
export const metaculusId = (questionId: number) => `metaculus:q${questionId}`;

/**
 * A Metaculus resolution as a resolution value for the filed answer: yes/no
 * for a binary question, the option for a multiple-choice one, the number
 * for a numeric one. Undefined for annulled or ambiguous.
 */
export function resolutionValue(
  q: Pick<MetaculusQuestion, "type">,
  resolution: string | number,
): unknown {
  const r = String(resolution).trim();
  if (/^(annulled|ambiguous)$/i.test(r)) return undefined;
  if (q.type === "binary") {
    return /^yes$/i.test(r) ? { outcome: "yes" } : /^no$/i.test(r) ? { outcome: "no" } : undefined;
  }
  if (q.type === "multiple_choice") return { option: r };
  const n = Number(r);
  return Number.isFinite(n) ? { value: n } : undefined;
}

export interface PassResult {
  open: number;
  forecast: number;
  skipped: Array<{ questionId: number; reason: string }>;
  failed: Array<{ questionId: number; error: string }>;
  costUsd: number;
  stoppedBy?: string;
}

/** This bot's spend today, from its own records: filed forecasts and paid attempts. */
export function spentToday(db: Ledger, now: Date): number {
  const day = utcDay(now.getTime());
  return [BENCHMARK, ATTEMPT_BENCHMARK]
    .flatMap((b) => db.listExternalSubmissions(b, 1_000))
    .filter((r) => utcDay(r.created_at) === day)
    .reduce((s, r) => s + (r.cost_usd ?? 0), 0);
}

/** Questions that already failed after a paid forecast today (no retry before tomorrow). */
function failedToday(db: Ledger, day: string): Set<string> {
  return new Set(
    db
      .listExternalSubmissions(ATTEMPT_BENCHMARK, 10_000)
      .filter((r) => r.variant !== "dry-run" && utcDay(r.created_at) === day)
      .map((r) => r.file_sha256),
  );
}

function recorded(db: Ledger): Map<string, ExternalSubmissionRow> {
  return new Map(db.listExternalSubmissions(BENCHMARK, 10_000).map((r) => [r.file_sha256, r]));
}

export async function forecastPass(opts: PassOptions): Promise<PassResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const cap = opts.dailyCapUsd ?? 10;
  const result: PassResult = { open: 0, forecast: 0, skipped: [], failed: [], costUsd: 0 };
  const done = recorded(opts.db);
  // The bot's own day budget (filed forecasts + paid attempts, persisted) and the world's caps.
  const guard = new SpendGuard({
    label: "metaculus daily cap",
    budgetUsd: cap,
    spentUsd: spentToday(opts.db, now()),
    reserveFactor: 0,
    env: opts.env ?? process.env,
    now: () => now().getTime(),
  });
  const day = utcDay(now().getTime());
  const failedEarlier = failedToday(opts.db, day);
  /** Record a paid forecast that was not filed: its cost counts, and a failure is not retried today. */
  const attempt = (qid: number, costUsd: number, reason: string, kind: "failed" | "dry-run") => {
    if (costUsd <= 0 && kind === "dry-run") return;
    try {
      opts.db.recordExternalSubmission({
        benchmark: ATTEMPT_BENCHMARK,
        batch_ref: day,
        variant: kind,
        identity_json: JSON.stringify(ATTRIBUTION),
        file_name: `question/${qid}`,
        // A failure is one row per question per day; every dry run counts its own spend.
        file_sha256:
          kind === "failed"
            ? attemptKey(qid, day)
            : sha256(`metaculus-dry-run:${qid}:${now().getTime()}:${Math.random()}`),
        items: 1,
        answered: 0,
        cost_usd: costUsd,
        meta_json: JSON.stringify({ questionId: qid, reason: reason.slice(0, 300) }),
        created_at: now().getTime(),
      });
    } catch (err) {
      log(`  attempt for q${qid} not recorded: ${(err as Error).message.slice(0, 200)}`);
    }
  };

  const candidates: Array<{ post: MetaculusPost; tournament: string | number }> = [];
  for (const t of opts.tournaments) {
    for (const post of await opts.client.posts(t, "open")) {
      if (post.question?.status && post.question.status !== "open") continue;
      if (!post.question) continue; // group posts: not entered
      // A question in two tournaments is forecast once.
      if (candidates.some((c) => c.post.question!.id === post.question!.id)) continue;
      candidates.push({ post, tournament: t });
    }
  }
  result.open = candidates.length;

  for (const { post, tournament } of candidates) {
    const qid = post.question!.id;
    if (done.has(questionKey(qid))) continue;
    if (failedEarlier.has(attemptKey(qid, day))) {
      result.skipped.push({ questionId: qid, reason: "failed earlier today; retried tomorrow" });
      continue;
    }
    if (opts.limit !== undefined && result.forecast >= opts.limit) break;
    const stop = guard.stopReason();
    if (stop) {
      result.stoppedBy = stop;
      break;
    }
    let paid: number | undefined;
    try {
      // The list may omit our own forecasts; the detail never does.
      const detail = await opts.client.post(post.id);
      const q = detail.question ?? post.question!;
      if (q.my_forecasts?.latest) {
        result.skipped.push({ questionId: qid, reason: "already forecast on Metaculus" });
        continue;
      }
      const req = requestFor(q);
      if (!req) {
        result.skipped.push({ questionId: qid, reason: `unsupported ${q.type}` });
        continue;
      }
      paid = 0; // from here on, a failure may have spent money
      const answer = await opts.forecast(req);
      paid = answer.costUsd;
      guard.record(answer.costUsd);
      result.costUsd += answer.costUsd;
      const made = payloadFor(q, answer);
      if ("skip" in made) {
        const error = `${made.skip}${answer.caveat ? ` (${answer.caveat})` : ""}`;
        result.failed.push({ questionId: qid, error });
        attempt(qid, answer.costUsd, error, "failed");
        continue;
      }
      const comment = commentFor(q, answer, made.payload, opts.config.description);
      const meta = { ...metaFor(post.id, q, answer, made.payload), config: opts.config.label };
      if (opts.dryRun) {
        const dir = opts.outDir ?? "data/metaculus/dry-run";
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, `${qid}.json`),
          JSON.stringify(
            { tournament, meta, payload: made.payload, comment, costUsd: answer.costUsd },
            null,
            2,
          ),
        );
        log(`  [dry] q${qid} ${q.type} → ${summary(meta)} · $${answer.costUsd.toFixed(3)}`);
        attempt(qid, answer.costUsd, "dry run", "dry-run");
      } else {
        await opts.client.forecast(made.payload);
        await opts.client.comment(post.id, comment);
        opts.db.recordExternalSubmission({
          benchmark: BENCHMARK,
          batch_ref: String(tournament),
          variant: opts.config.label,
          identity_json: JSON.stringify(ATTRIBUTION),
          file_name: `question/${qid}`,
          file_sha256: questionKey(qid),
          items: 1,
          answered: 1,
          cost_usd: answer.costUsd,
          meta_json: JSON.stringify(meta),
          created_at: now().getTime(),
        });
        opts.file?.(answer, metaculusId(qid), meta.sd);
        log(`  q${qid} ${q.type} → ${summary(meta)} · $${answer.costUsd.toFixed(3)}`);
      }
      result.forecast++;
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      result.failed.push({ questionId: qid, error });
      // A failure after the forecaster ran (it threw, or posting failed) was paid for.
      if (paid !== undefined) attempt(qid, paid, error, "failed");
    }
  }
  return result;
}

function metaFor(
  postId: number,
  q: MetaculusQuestion,
  answer: TypedForecastAnswer,
  payload: ForecastPayload,
): ForecastMeta {
  const meta: ForecastMeta = {
    postId,
    questionId: q.id,
    type: q.type,
    cutoff: answer.cutoff.at,
    runs: answer.runs.length,
    ...(answer.critique?.applied ? { critiqueApplied: true } : {}),
    ...(q.scheduled_resolve_time ? { resolvesAt: q.scheduled_resolve_time } : {}),
  };
  if (payload.probability_yes !== null) meta.probabilityYes = payload.probability_yes;
  if (payload.probability_yes_per_category) meta.perCategory = payload.probability_yes_per_category;
  if (typeof answer.prediction === "number") {
    meta.mean = answer.prediction;
    const c = cdfQuestion(q);
    if (c) meta.sd = numericSd(c, answer.prediction, answer);
  }
  return meta;
}

function summary(m: ForecastMeta): string {
  if (m.probabilityYes !== undefined) return `P(yes) ${m.probabilityYes.toFixed(3)}`;
  if (m.perCategory) {
    const [label, p] = Object.entries(m.perCategory).sort((a, b) => b[1] - a[1])[0]!;
    return `top "${label.slice(0, 40)}" ${p.toFixed(3)}`;
  }
  return `${m.mean} ± ${m.sd?.toPrecision(3)}`;
}

// ─── Outcomes → lessons ─────────────────────────────────────────────────────

/**
 * A 0–1 score of a resolved forecast (higher is better): 1 − Brier for a
 * binary question, 1 − Brier/2 across the options of a multiple-choice one,
 * and for a number how central the outcome fell in the forecast distribution
 * (1 at the median, 0 far in a tail). Undefined for annulled/ambiguous.
 */
export function outcomeScore(meta: ForecastMeta, resolution: string | number): number | undefined {
  const r = String(resolution).trim();
  if (/^(annulled|ambiguous)$/i.test(r)) return undefined;
  if (meta.probabilityYes !== undefined) {
    const y = /^yes$/i.test(r) ? 1 : /^no$/i.test(r) ? 0 : undefined;
    return y === undefined ? undefined : 1 - (meta.probabilityYes - y) ** 2;
  }
  if (meta.perCategory) {
    if (!(r in meta.perCategory)) return undefined;
    const brier = Object.entries(meta.perCategory).reduce(
      (s, [label, p]) => s + (p - (label === r ? 1 : 0)) ** 2,
      0,
    );
    return 1 - brier / 2;
  }
  const t = Number(r);
  if (meta.mean !== undefined && meta.sd && Number.isFinite(t)) {
    const f = phi((t - meta.mean) / meta.sd);
    return 2 * Math.min(f, 1 - f);
  }
  return undefined;
}

/** The general outcome the learning loop judges into a lesson (no question text stored). */
export function outcomeFor(
  meta: ForecastMeta,
  q: MetaculusQuestion,
  score: number,
  resolvedAt: string,
): Outcome {
  const kind =
    q.type === "binary"
      ? "probability forecast of a yes/no question"
      : q.type === "multiple_choice"
        ? `probability forecast over ${q.options?.length ?? "several"} options`
        : `${q.type} forecast as a distribution`;
  const detail =
    meta.probabilityYes !== undefined
      ? `brier ${(1 - score).toFixed(3)} (said ${Math.round(meta.probabilityYes * 100)}% yes, resolved ${String(q.resolution)})`
      : meta.perCategory
        ? `multi-class score ${score.toFixed(3)}`
        : `outcome at the ${(score / 2).toFixed(2)} tail mass of the forecast`;
  return {
    domain: "forecast",
    source: `metaculus:${q.type}`,
    succeeded: score >= 0.75,
    score,
    resolvedAt,
    attempted: `${kind} on Metaculus${meta.config ? ` (${meta.config})` : ""}`,
    detail,
    refs: [`metaculus:q${meta.questionId}`],
    privateContext: [q.title, q.resolution_criteria ?? ""].join("\n"),
  };
}

export interface ResolveOptions {
  client: MetaculusClient;
  db: Ledger;
  /**
   * Resolves the filed answer through the one outcome path (scoring, lessons,
   * history). `unfiled` (a forecast filed before the outcome path) falls back
   * to `learn`.
   */
  resolveFiled?: (externalId: string, value: unknown, resolvedAt: number) => unknown;
  /** Hands each scored outcome of an unfiled forecast to the learning loop (`noteOutcome`). */
  learn?: (o: Outcome) => void;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * At most this many question lookups per pass (default {@link RESOLVE_MAX_CHECKS}). Questions
   * past their scheduled resolve time go first; the rest rotate across passes, so an early
   * resolution is still found without fetching every open question every pass.
   */
  maxChecks?: number;
  /** Pause between lookups (default {@link RESOLVE_PACE_MS}); doubles after a refused question. */
  paceMs?: number;
  /** Retries of one question after a rate-limit refusal (default {@link RESOLVE_RETRIES}). */
  retries?: number;
  /** First backoff before a retry, doubling each time (default {@link RESOLVE_BACKOFF_MS}). */
  backoffMs?: number;
  /**
   * Consecutive questions still refused after their retries before the pass stops
   * (default {@link RESOLVE_MAX_REFUSED}); one refused question never ends it.
   */
  maxRefused?: number;
  /**
   * When each question was last looked up (unresolved). A question checked within
   * {@link RESOLVE_RECHECK_MS} (or {@link RESOLVE_RECHECK_DUE_MS} once due) is not
   * fetched again, so the lookup budget goes to questions not seen lately.
   */
  checks?: ResolveCheckCache;
  /** How long one rotation window lasts (default {@link RESOLVE_ROTATE_MS}). */
  rotateMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Lookups per resolve pass: a pass runs every 20 minutes, so this is ~36 lookups an hour. */
export const RESOLVE_MAX_CHECKS = 12;
export const RESOLVE_PACE_MS = 2_000;
export const RESOLVE_ROTATE_MS = 20 * 60_000;
export const RESOLVE_RETRIES = 2;
export const RESOLVE_BACKOFF_MS = 30_000;
export const RESOLVE_MAX_REFUSED = 3;
/** Ceiling of the adaptive pause after refusals. */
export const RESOLVE_MAX_PACE_MS = 60_000;
/** A not-yet-due question is looked up again only after this long. */
export const RESOLVE_RECHECK_MS = 6 * 60 * 60_000;
/** A due question (scheduled resolve time passed) is looked up again after this long. */
export const RESOLVE_RECHECK_DUE_MS = 60 * 60_000;

/** Last lookup time per question id (an unresolved check). */
export interface ResolveCheckCache {
  get(questionId: number): number | undefined;
  set(questionId: number, at: number): void;
}

/** A rate-limit refusal (HTTP 429, including Cloudflare 1015): back off and retry, then move on. */
export function isRateLimited(err: unknown): boolean {
  return / → 429:|\b1015\b/.test((err as Error)?.message ?? "");
}

/**
 * The rows to look up this pass: due rows (scheduled resolve time passed) oldest first, then a
 * rotating window over the rest, `max` in all.
 */
export function resolveOrder<T extends { resolvesAt?: string }>(
  rows: T[],
  nowMs: number,
  max: number,
  rotateMs: number,
): T[] {
  const due: T[] = [];
  const rest: T[] = [];
  for (const r of rows) {
    const at = r.resolvesAt ? Date.parse(r.resolvesAt) : Number.NaN;
    (Number.isFinite(at) && at <= nowMs ? due : rest).push(r);
  }
  due.sort((a, b) => Date.parse(a.resolvesAt!) - Date.parse(b.resolvesAt!));
  const room = Math.max(0, max - due.length);
  if (room === 0 || rest.length === 0) return due.slice(0, max);
  if (rest.length <= room) return [...due, ...rest];
  const start = (Math.floor(nowMs / rotateMs) * room) % rest.length;
  const window = [...rest.slice(start), ...rest.slice(0, start)].slice(0, room);
  return [...due, ...window];
}

/** Score every recorded question that has resolved since; learn from it; record it once. */
export async function resolvePass(opts: ResolveOptions): Promise<{
  checked: number;
  resolved: number;
  learned: number;
  failed: number;
  pending: number;
  rateLimited: boolean;
  /** Questions still refused after their retries (left for a later pass). */
  refused: number;
  /** Open questions skipped because they were looked up recently. */
  recent: number;
}> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let paceMs = opts.paceMs ?? RESOLVE_PACE_MS;
  const retries = Math.max(0, opts.retries ?? RESOLVE_RETRIES);
  const backoffMs = opts.backoffMs ?? RESOLVE_BACKOFF_MS;
  const maxRefused = Math.max(1, opts.maxRefused ?? RESOLVE_MAX_REFUSED);
  const done = new Set(
    opts.db.listExternalSubmissions(OUTCOME_BENCHMARK, 10_000).map((r) => r.file_sha256),
  );
  const open: Array<{ row: ExternalSubmissionRow; meta: ForecastMeta; resolvesAt?: string }> = [];
  for (const row of opts.db.listExternalSubmissions(BENCHMARK, 10_000)) {
    const meta = row.meta_json ? (JSON.parse(row.meta_json) as ForecastMeta) : undefined;
    if (!meta || done.has(outcomeKey(meta.questionId))) continue;
    open.push({ row, meta, ...(meta.resolvesAt ? { resolvesAt: meta.resolvesAt } : {}) });
  }
  const startMs = now().getTime();
  // A question looked up recently is not fetched again until its recheck interval passes.
  const unseen = open.filter(({ meta, resolvesAt }) => {
    const at = opts.checks?.get(meta.questionId);
    if (at === undefined) return true;
    const due = resolvesAt !== undefined && Date.parse(resolvesAt) <= startMs;
    return startMs - at >= (due ? RESOLVE_RECHECK_DUE_MS : RESOLVE_RECHECK_MS);
  });
  const batch = resolveOrder(
    unseen,
    startMs,
    opts.maxChecks ?? RESOLVE_MAX_CHECKS,
    opts.rotateMs ?? RESOLVE_ROTATE_MS,
  );
  const out = {
    checked: 0,
    resolved: 0,
    learned: 0,
    failed: 0,
    pending: open.length,
    rateLimited: false,
    refused: 0,
    recent: open.length - unseen.length,
  };
  // One question's lookup, retried with doubling backoff while it is refused.
  const lookup = async (postId: number) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await opts.client.post(postId)).question;
      } catch (err) {
        if (!isRateLimited(err) || attempt >= retries) throw err;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  };
  let refusedInARow = 0;
  for (const { row, meta } of batch) {
    if (out.checked > 0 && paceMs > 0) await sleep(paceMs);
    out.checked++;
    try {
      const q = await lookup(meta.postId);
      refusedInARow = 0;
      if (q?.status !== "resolved" || q.resolution == null) {
        opts.checks?.set(meta.questionId, now().getTime());
        continue;
      }
      const score = outcomeScore(meta, q.resolution);
      const value = resolutionValue(q, q.resolution);
      const shared =
        value !== undefined && opts.resolveFiled
          ? opts.resolveFiled(metaculusId(meta.questionId), value, now().getTime())
          : "unfiled";
      if (shared !== "unfiled") {
        if (shared && typeof shared === "object") out.learned++;
      } else if (score !== undefined && opts.learn) {
        opts.learn(outcomeFor(meta, q, score, now().toISOString()));
        out.learned++;
      }
      opts.db.recordExternalSubmission({
        benchmark: OUTCOME_BENCHMARK,
        batch_ref: row.batch_ref,
        variant: row.variant,
        identity_json: row.identity_json,
        file_name: `question/${meta.questionId}`,
        file_sha256: outcomeKey(meta.questionId),
        items: 1,
        answered: score === undefined ? 0 : 1,
        cost_usd: null,
        meta_json: JSON.stringify({ questionId: meta.questionId, score: score ?? null }),
        created_at: now().getTime(),
      });
      out.resolved++;
      out.pending--;
      log(`  q${meta.questionId} resolved · score ${score?.toFixed(3) ?? "n/a"}`);
    } catch (err) {
      if (isRateLimited(err)) {
        // Still refused after its retries: leave this question for a later
        // pass, slow down, and move on — stop only when refusals keep coming.
        out.rateLimited = true;
        out.refused++;
        refusedInARow++;
        paceMs = Math.min(Math.max(paceMs * 2, 1_000), RESOLVE_MAX_PACE_MS);
        if (refusedInARow >= maxRefused) {
          log(
            `  rate limited at q${meta.questionId} (${refusedInARow} in a row); the rest wait for the next pass`,
          );
          break;
        }
        log(`  q${meta.questionId} rate limited after ${retries} retries; pausing ${paceMs} ms`);
        continue;
      }
      out.failed++;
      log(`  q${meta.questionId} resolve failed: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return out;
}
