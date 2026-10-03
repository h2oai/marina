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
import { dailyCapRefusal, utcDay } from "../../src/engine/spend-ledger";
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
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PassResult {
  open: number;
  forecast: number;
  skipped: Array<{ questionId: number; reason: string }>;
  failed: Array<{ questionId: number; error: string }>;
  costUsd: number;
  stoppedBy?: string;
}

/** This bot's spend today, from its own records. */
export function spentToday(db: Ledger, now: Date): number {
  const day = utcDay(now.getTime());
  return db
    .listExternalSubmissions(BENCHMARK, 1_000)
    .filter((r) => utcDay(r.created_at) === day)
    .reduce((s, r) => s + (r.cost_usd ?? 0), 0);
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
  let spent = spentToday(opts.db, now());

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
    if (opts.limit !== undefined && result.forecast >= opts.limit) break;
    const worldCap = dailyCapRefusal(opts.env ?? process.env, now().getTime());
    if (worldCap) {
      result.stoppedBy = worldCap;
      break;
    }
    if (spent >= cap) {
      result.stoppedBy = `metaculus daily cap reached ($${spent.toFixed(2)} ≥ $${cap.toFixed(2)})`;
      break;
    }
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
      const answer = await opts.forecast(req);
      spent += answer.costUsd;
      result.costUsd += answer.costUsd;
      const made = payloadFor(q, answer);
      if ("skip" in made) {
        result.failed.push({
          questionId: qid,
          error: `${made.skip}${answer.caveat ? ` (${answer.caveat})` : ""}`,
        });
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
        log(`  q${qid} ${q.type} → ${summary(meta)} · $${answer.costUsd.toFixed(3)}`);
      }
      result.forecast++;
    } catch (err) {
      result.failed.push({ questionId: qid, error: (err as Error).message.slice(0, 300) });
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
  /** Hands each scored outcome to the learning loop (`noteOutcome`). */
  learn?: (o: Outcome) => void;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Score every recorded question that has resolved since; learn from it; record it once. */
export async function resolvePass(
  opts: ResolveOptions,
): Promise<{ checked: number; resolved: number; learned: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const done = new Set(
    opts.db.listExternalSubmissions(OUTCOME_BENCHMARK, 10_000).map((r) => r.file_sha256),
  );
  const out = { checked: 0, resolved: 0, learned: 0, failed: 0 };
  for (const row of opts.db.listExternalSubmissions(BENCHMARK, 10_000)) {
    const meta = row.meta_json ? (JSON.parse(row.meta_json) as ForecastMeta) : undefined;
    if (!meta || done.has(outcomeKey(meta.questionId))) continue;
    out.checked++;
    try {
      const q = (await opts.client.post(meta.postId)).question;
      if (q?.status !== "resolved" || q.resolution == null) continue;
      const score = outcomeScore(meta, q.resolution);
      if (score !== undefined && opts.learn) {
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
      log(`  q${meta.questionId} resolved · score ${score?.toFixed(3) ?? "n/a"}`);
    } catch (err) {
      out.failed++;
      log(`  q${meta.questionId} resolve failed: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return out;
}
