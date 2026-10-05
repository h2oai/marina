// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The benchmark ledger's pure half: turning a harness result into a ledger
 * run + item outcomes, and ranking what the ledger holds — paired comparison
 * on shared items (exact McNemar), the accuracy/cost Pareto frontier, and
 * per-participant credit from the agents and models recorded on each item.
 *
 * No I/O. Persistence lives in `src/persistence/db-benchmarks.ts`; the
 * operator import is `scripts/benchmark-import.ts`; the read commands are
 * `benchmark compare|leaderboard|participants` (`commands/benchmark.ts`).
 * Case content (questions, answers, responses) never enters the ledger —
 * item ids only.
 */

import { createHash } from "node:crypto";
import { mcnemarExact, wilsonInterval } from "../../benchmarks/stats";
import {
  BENCHMARK_VERIFICATION_STATES,
  type BenchmarkItemInput,
  type BenchmarkItemRow,
  type BenchmarkLedgerRunInput,
  type BenchmarkRunRow,
  type BenchmarkTargetKind,
  type BenchmarkVerification,
} from "../persistence/db-benchmarks";
import type { BenchmarksStore } from "../persistence/interfaces/benchmarks-store";

export const TARGET_KINDS: readonly BenchmarkTargetKind[] = ["model", "crew", "population"];

/**
 * A stable hash of the item ids a run answered, order-free (concurrent runs
 * finish items in any order) — equal ⇒ the same slice.
 */
export function sliceHash(itemIds: readonly string[]): string {
  return createHash("sha256")
    .update([...itemIds].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export interface ItemSummary {
  n: number;
  correct: number;
  accuracy: number;
  ciLow: number;
  ciHigh: number;
  costUsd: number | null;
  costPerItemUsd: number | null;
}

/** Accuracy with its Wilson 95 % interval and (when every item is priced) cost. */
export function summarizeItems(
  items: readonly { correct: boolean | 0 | 1; cost_usd?: number | null }[],
  runCostUsd?: number | null,
): ItemSummary {
  const n = items.length;
  const correct = items.filter((i) => Boolean(i.correct)).length;
  const ci = wilsonInterval(correct, n);
  const priced = items.filter((i) => typeof i.cost_usd === "number");
  const itemCost =
    priced.length === n && n > 0 ? priced.reduce((s, i) => s + (i.cost_usd as number), 0) : null;
  const costUsd = runCostUsd ?? itemCost;
  return {
    n,
    correct,
    accuracy: n > 0 ? correct / n : 0,
    ciLow: ci.low,
    ciHigh: ci.high,
    costUsd,
    costPerItemUsd: costUsd !== null && n > 0 ? costUsd / n : null,
  };
}

// ─── Paired comparison ─────────────────────────────────────────────────────

export interface RunComparison {
  shared: number;
  onlyA: number;
  onlyB: number;
  /** A right, B wrong. */
  aWins: number;
  /** A wrong, B right. */
  bWins: number;
  p: number;
  a: ItemSummary;
  b: ItemSummary;
  /** B's cost per shared item minus A's (null unless both are priced). */
  costDeltaPerItemUsd: number | null;
  /** Reasons the pairing is not like-for-like (different benchmark, slice or judge). */
  warnings: string[];
}

/** Compare two runs paired on the item ids both answered. */
export function compareRuns(
  runA: BenchmarkRunRow,
  itemsA: readonly BenchmarkItemRow[],
  runB: BenchmarkRunRow,
  itemsB: readonly BenchmarkItemRow[],
): RunComparison {
  const mapB = new Map(itemsB.map((i) => [i.item_id, i]));
  const setA = new Set(itemsA.map((i) => i.item_id));
  const sharedA = itemsA.filter((i) => mapB.has(i.item_id));
  const sharedB = sharedA.map((i) => mapB.get(i.item_id) as BenchmarkItemRow);
  let aWins = 0;
  let bWins = 0;
  for (const a of sharedA) {
    const b = mapB.get(a.item_id) as BenchmarkItemRow;
    if (a.correct && !b.correct) aWins++;
    else if (!a.correct && b.correct) bWins++;
  }
  const warnings: string[] = [];
  if (runA.benchmark !== runB.benchmark) {
    warnings.push(`different benchmarks (${runA.benchmark} vs ${runB.benchmark})`);
  }
  if (runA.slice_hash && runB.slice_hash && runA.slice_hash !== runB.slice_hash) {
    warnings.push("different item slices — compared on shared items only");
  }
  if ((runA.judge ?? null) !== (runB.judge ?? null)) {
    warnings.push(
      `different judges (${runA.judge ?? "unrecorded"} vs ${runB.judge ?? "unrecorded"})`,
    );
  }
  if (sharedA.length === 0) warnings.push("no shared items");
  const a = summarizeItems(sharedA);
  const b = summarizeItems(sharedB);
  const perItem = (run: BenchmarkRunRow, all: number, shared: ItemSummary): number | null => {
    if (shared.costPerItemUsd !== null) return shared.costPerItemUsd;
    return typeof run.cost_usd === "number" && all > 0 ? run.cost_usd / all : null;
  };
  const ca = perItem(runA, itemsA.length, a);
  const cb = perItem(runB, itemsB.length, b);
  return {
    shared: sharedA.length,
    onlyA: itemsA.length - sharedA.length,
    onlyB: itemsB.filter((i) => !setA.has(i.item_id)).length,
    aWins,
    bWins,
    p: mcnemarExact(aWins, bWins).p,
    a,
    b,
    costDeltaPerItemUsd: ca !== null && cb !== null ? cb - ca : null,
    warnings,
  };
}

// ─── Pareto frontier ───────────────────────────────────────────────────────

export interface FrontierPoint {
  id: string;
  accuracy: number;
  costPerItemUsd: number;
}

/**
 * The runs no other run beats on BOTH accuracy (higher) and cost per item
 * (lower), cheapest first. Unpriced runs cannot be placed and are excluded.
 */
export function paretoFrontier<T extends FrontierPoint>(points: readonly T[]): T[] {
  const frontier = points.filter(
    (p) =>
      !points.some(
        (q) =>
          q !== p &&
          q.accuracy >= p.accuracy &&
          q.costPerItemUsd <= p.costPerItemUsd &&
          (q.accuracy > p.accuracy || q.costPerItemUsd < p.costPerItemUsd),
      ),
  );
  return [...frontier].sort((x, y) => x.costPerItemUsd - y.costPerItemUsd);
}

// ─── Participant credit ────────────────────────────────────────────────────

/** One participant recorded on an item: an agent, the model it ran on, or both. */
export interface ItemParticipant {
  agent?: string;
  model?: string;
}

export function parseParticipants(json: string | null): ItemParticipant[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (p): p is ItemParticipant =>
        typeof p === "object" &&
        p !== null &&
        (typeof (p as ItemParticipant).agent === "string" ||
          typeof (p as ItemParticipant).model === "string"),
    );
  } catch {
    return [];
  }
}

export interface ParticipantCredit {
  kind: "agent" | "model";
  name: string;
  items: number;
  correct: number;
  accuracy: number;
  costUsd: number | null;
}

/**
 * Per agent and per model: items touched, accuracy on those items and the
 * cost of those items. An item counts once per distinct participant on it.
 */
export function participantCredit(items: readonly BenchmarkItemRow[]): {
  credit: ParticipantCredit[];
  withParticipants: number;
} {
  const acc = new Map<string, { items: number; correct: number; cost: number; priced: number }>();
  let withParticipants = 0;
  for (const item of items) {
    const ps = parseParticipants(item.participants_json);
    if (ps.length === 0) continue;
    withParticipants++;
    const keys = new Set<string>();
    for (const p of ps) {
      if (p.agent) keys.add(`agent\u0000${p.agent}`);
      if (p.model) keys.add(`model\u0000${p.model}`);
    }
    for (const k of keys) {
      const e = acc.get(k) ?? { items: 0, correct: 0, cost: 0, priced: 0 };
      e.items++;
      if (item.correct) e.correct++;
      if (typeof item.cost_usd === "number") {
        e.cost += item.cost_usd;
        e.priced++;
      }
      acc.set(k, e);
    }
  }
  const credit = [...acc.entries()].map(([k, e]) => {
    const [kind, name] = k.split("\u0000") as ["agent" | "model", string];
    return {
      kind,
      name,
      items: e.items,
      correct: e.correct,
      accuracy: e.items > 0 ? e.correct / e.items : 0,
      costUsd: e.priced === e.items ? e.cost : null,
    };
  });
  credit.sort((x, y) => y.accuracy - x.accuracy || y.items - x.items);
  return { credit, withParticipants };
}

// ─── Answer identity (migration 157) ───────────────────────────────────────

/**
 * An answer reduced to what makes two answers the same: NFKC, lower case,
 * TeX wrappers (`\boxed{}`, `\text{}`, `$`) dropped, whitespace collapsed,
 * surrounding quotes and punctuation trimmed, a list's items trimmed, and a
 * plain number written canonically (`1,234.50` → `1234.5`). Empty ⇒ no answer.
 */
export function normalizeAnswerForHash(answer: string): string {
  const s = answer
    .normalize("NFKC")
    .replace(/\\boxed\{([^{}]*)\}/g, "$1")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\[()[\]]/g, "")
    .replace(/\$/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`.,;:!?()[\]*]+|[\s"'`.,;:!?()[\]*]+$/g, "");
  const num = s.replace(/[,_\s]/g, "").replace(/^−/, "-");
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(num)) {
    const n = Number(num);
    if (Number.isFinite(n)) return String(n);
  }
  return s
    .split(/\s*,\s*/)
    .map((x) => x.trim())
    .join(",");
}

/**
 * The digest a harness sends for one item's answer: sha256 of the normalised
 * answer, or undefined for an empty answer or an `ERROR:` marker. The ledger
 * never stores it — only a hash keyed per ledger (`keyedAnswerHash`), so
 * answers compare across runs without the answer being recoverable.
 */
export function answerDigest(answer: string | undefined | null): string | undefined {
  if (typeof answer !== "string" || answer.startsWith("ERROR:")) return undefined;
  const normal = normalizeAnswerForHash(answer);
  return normal ? createHash("sha256").update(normal).digest("hex") : undefined;
}

/** Verification states across a run's items: a check that never ran is not a failure. */
export interface VerificationCounts {
  passed: number;
  failed: number;
  notRun: number;
  /** Items with no verification reported. */
  unreported: number;
}

export function verificationCounts(
  items: readonly { verification?: string | null }[],
): VerificationCounts {
  const out: VerificationCounts = { passed: 0, failed: 0, notRun: 0, unreported: 0 };
  for (const it of items) {
    if (it.verification === "passed") out.passed++;
    else if (it.verification === "failed") out.failed++;
    else if (it.verification === "not_run") out.notRun++;
    else out.unreported++;
  }
  return out;
}

/** One line for a run's verification states, or undefined when none were reported. */
export function formatVerificationCounts(c: VerificationCounts): string | undefined {
  if (c.passed + c.failed + c.notRun === 0) return undefined;
  return `verification: ${c.passed} passed · ${c.failed} failed · ${c.notRun} not run${c.unreported ? ` · ${c.unreported} unreported` : ""}`;
}

// ─── Harness result → ledger ───────────────────────────────────────────────

/** The subset of a `benchmarks/harness.ts` result file the ledger reads. */
export interface HarnessResultFile {
  config?: Record<string, unknown> & {
    dataset?: string;
    name?: string;
    model?: string;
    seed?: number;
    /** `measure` (same-board lessons excluded, `x-marina-eval`) or `live`. */
    lessons_mode?: string;
    judge?: { model?: string; endpoint?: string };
  };
  timestamp?: number;
  duration_ms?: number;
  metadata?: { usage?: { costUsd?: number } };
  items?: {
    id?: string;
    correct?: boolean;
    score?: number;
    latencyMs?: number;
    usage?: { costUsd?: number };
    judge?: string;
    traceId?: string;
    participants?: ItemParticipant[];
    /**
     * True when the item is a fallback rather than a real answer (spend cap,
     * provider outage, an unparseable reply replaced by a default). Read only
     * for the run's fallback rate; never stored per item.
     */
    fallback?: boolean;
    /**
     * The harness's response text — read only to spot its `ERROR:` marker and
     * to derive the answer digest when none is given; never stored.
     */
    actual?: string;
    /** `answerDigest` of the item's answer (preferred over deriving it from `actual`). */
    answerDigest?: string;
    /** The answer was forced at a turn, step or time budget. */
    budgetForced?: boolean;
    /** `passed` | `failed` | `not_run` — checks that never ran are not failures. */
    verification?: string;
    /** Judged lesson ids the item was served (`x-marina-lessons`); ids only. */
    lessons?: string[];
    /** Lesson ids recalled for the item but not shown (observe mode). */
    lessonsObserved?: string[];
  }[];
}

// ─── Fallback rate → invalid run ───────────────────────────────────────────

/**
 * Default share of items that may be fallbacks before a run is recorded
 * `invalid` (`MARINA_BENCHMARK_MAX_FALLBACK_RATE`). Conservative on purpose:
 * an ordinary run has a few timeouts or unparseable replies, which are the
 * target's own failures and stay scored; a run where more than a quarter of
 * the items never reached a real answer measured the infrastructure.
 */
export const DEFAULT_MAX_FALLBACK_RATE = 0.25;

/**
 * `MARINA_BENCHMARK_MAX_FALLBACK_RATE`: a share in [0, 1); `off` / `none` / `1`
 * disables the check (null). Unset, blank or junk is the default — a typo never
 * turns the check off.
 */
export function benchmarkMaxFallbackRate(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.MARINA_BENCHMARK_MAX_FALLBACK_RATE?.trim().toLowerCase();
  if (!raw) return DEFAULT_MAX_FALLBACK_RATE;
  if (raw === "off" || raw === "none") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_MAX_FALLBACK_RATE;
  return n === 1 ? null : n;
}

/** Whether a harness result item is a fallback: flagged, or the harness's `ERROR:` marker. */
export function isFallbackItem(item: { fallback?: unknown; actual?: unknown }): boolean {
  return (
    item.fallback === true || (typeof item.actual === "string" && item.actual.startsWith("ERROR:"))
  );
}

/**
 * The invalidation reason when more than `maxRate` of `n` items were fallbacks,
 * else undefined (and always undefined when the check is off or `n` is 0).
 */
export function fallbackInvalidReason(
  n: number,
  fallbacks: number,
  maxRate: number | null = benchmarkMaxFallbackRate(),
): string | undefined {
  if (maxRate === null || n <= 0) return undefined;
  const rate = fallbacks / n;
  if (rate <= maxRate) return undefined;
  const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
  return `fallback rate ${pct(rate)} exceeds threshold ${pct(maxRate)} (${fallbacks} of ${n} items were fallbacks, not answers)`;
}

/** Config keys never written to the ledger (credentials, endpoints with tokens). */
const CONFIG_REDACT = new Set(["apiKey", "api_key", "key", "token", "authorization"]);

/** The harness config with credentials removed — what `config_json` stores. */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (CONFIG_REDACT.has(k)) continue;
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? redactConfig(v as Record<string, unknown>)
        : v;
  }
  return out;
}

export interface LedgerImportOptions {
  targetKind: BenchmarkTargetKind;
  /** Model id, `{crew, formation, roles}` or a population spec. */
  target: unknown;
  label?: string;
  /** Overrides the judge recorded in the result file (model + route). */
  judge?: string;
  /** Total target spend when the result file has none (e.g. a crew's `spend_daily`). */
  costUsd?: number;
  /** Explicit replicate group (migration 148); omitted ⇒ grouped by target/slice/judge. */
  replicateGroup?: string;
  /**
   * Fallback share above which the run is recorded `invalid`; null disables
   * the check. Default: `MARINA_BENCHMARK_MAX_FALLBACK_RATE` (0.25).
   */
  maxFallbackRate?: number | null;
  /** Raw file bytes, hashed over their stable fields for idempotent re-import (`stableResultHash`). */
  raw: string;
  /** Fresh run id (the caller supplies it so this stays pure). */
  id: string;
  now: number;
}

/** JSON with object keys sorted, so equal values serialize equally whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Wall-clock fields of a result document: when it was filed, not what it measured. */
const VOLATILE_RESULT_FIELDS = ["timestamp", "duration_ms"] as const;

/**
 * The content hash of a result document over its STABLE fields only — the
 * config, metadata and every item outcome, in canonical key order, without the
 * wall-clock `timestamp` / `duration_ms` — so re-filing the same run (a resumed
 * harness, a repeated `file` step) is a no-op instead of a second replicate.
 * Items that carry no per-item measurement (no latency, no trace id) cannot
 * tell two genuine replicates apart, so their timestamp stays in the hash.
 * A body that is not a JSON object hashes as its raw bytes.
 */
export function stableResultHash(raw: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    // allow-empty-catch: a non-JSON body hashes as its raw bytes below
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return createHash("sha256").update(raw).digest("hex");
  }
  const o = { ...(doc as Record<string, unknown>) };
  const items = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : [];
  const measured = items.some(
    (it) =>
      it && (typeof it.latencyMs === "number" || (typeof it.traceId === "string" && it.traceId)),
  );
  for (const k of VOLATILE_RESULT_FIELDS) {
    if (k === "timestamp" && !measured) continue;
    delete o[k];
  }
  return createHash("sha256")
    .update(`stable:v1\n${canonicalJson(o)}`)
    .digest("hex");
}

/** Build the ledger run + item rows for one harness result file. */
export function ledgerFromHarnessResult(
  file: HarnessResultFile,
  opts: LedgerImportOptions,
): { run: BenchmarkLedgerRunInput; items: BenchmarkItemInput[] } {
  const config = file.config ?? {};
  const benchmark = config.dataset ?? config.name;
  if (!benchmark) throw new Error("result file has no config.dataset / config.name");
  const raw = (file.items ?? []).filter((it) => typeof it.id === "string" && it.id.length > 0);
  const fallbacks = raw.filter(isFallbackItem).length;
  const regime =
    config.lessons_mode === "measure" || config.lessons_mode === "live"
      ? config.lessons_mode
      : null;
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const items: BenchmarkItemInput[] = raw.map((it) => ({
    item_id: it.id as string,
    correct: it.correct === true,
    score: typeof it.score === "number" ? it.score : null,
    latency_ms: typeof it.latencyMs === "number" ? it.latencyMs : null,
    cost_usd: typeof it.usage?.costUsd === "number" ? it.usage.costUsd : null,
    trace_id: typeof it.traceId === "string" ? it.traceId : null,
    participants_json:
      Array.isArray(it.participants) && it.participants.length > 0
        ? JSON.stringify(it.participants)
        : null,
    judge_verdict: typeof it.judge === "string" ? it.judge : null,
    answer_digest:
      typeof it.answerDigest === "string" && /^[0-9a-f]{64}$/.test(it.answerDigest)
        ? it.answerDigest
        : (answerDigest(it.actual) ?? null),
    budget_forced: typeof it.budgetForced === "boolean" ? it.budgetForced : null,
    verification: BENCHMARK_VERIFICATION_STATES.includes(it.verification as BenchmarkVerification)
      ? (it.verification as BenchmarkVerification)
      : null,
    lessons:
      ids(it.lessons).length || ids(it.lessonsObserved).length
        ? { served: ids(it.lessons), observed: ids(it.lessonsObserved), regime }
        : null,
  }));
  if (items.length === 0) throw new Error("result file has no items with ids");
  const runCost =
    opts.costUsd ??
    (typeof file.metadata?.usage?.costUsd === "number" ? file.metadata.usage.costUsd : null);
  const summary = summarizeItems(items, runCost);
  const safeConfig = redactConfig(config);
  const judge =
    opts.judge ??
    (config.judge?.model
      ? `${config.judge.model}${config.judge.endpoint ? ` @ ${config.judge.endpoint}` : ""}`
      : null);
  const finished = typeof file.timestamp === "number" ? file.timestamp : opts.now;
  const duration = typeof file.duration_ms === "number" ? Math.round(file.duration_ms) : null;
  const configJson = JSON.stringify(safeConfig);
  return {
    run: {
      id: opts.id,
      benchmark,
      config_hash: createHash("sha256").update(configJson).digest("hex").slice(0, 12),
      config_json: configJson,
      agent_id: null,
      started_at: duration !== null ? finished - duration : finished,
      completed_at: finished,
      duration_ms: duration,
      score: summary.accuracy,
      answered: items.length,
      total: items.length,
      cost_usd: summary.costUsd,
      n: summary.n,
      ci_low: summary.ciLow,
      ci_high: summary.ciHigh,
      seed: typeof config.seed === "number" ? config.seed : null,
      slice_hash: sliceHash(items.map((i) => i.item_id)),
      judge,
      target_kind: opts.targetKind,
      target_json: JSON.stringify(opts.target ?? null),
      label: opts.label ?? null,
      source: "import",
      content_hash: stableResultHash(opts.raw),
      // Runs filed before the stable hash were keyed by the raw bytes: still a match.
      legacy_content_hash: createHash("sha256").update(opts.raw).digest("hex"),
      replicate_group: opts.replicateGroup ?? null,
      invalid_reason:
        fallbackInvalidReason(
          items.length,
          fallbacks,
          opts.maxFallbackRate === undefined ? benchmarkMaxFallbackRate() : opts.maxFallbackRate,
        ) ?? null,
    },
    items,
  };
}

/** A short human label for a run: its label, else its target, else its config hash. */
export function runLabel(run: BenchmarkRunRow): string {
  if (run.label) return run.label;
  if (run.target_json) {
    try {
      const t = JSON.parse(run.target_json) as unknown;
      if (typeof t === "string") return t;
      if (t && typeof t === "object") {
        const o = t as Record<string, unknown>;
        const name = o.model ?? o.crew ?? o.name;
        if (typeof name === "string") return o.formation ? `${name}/${o.formation}` : name;
      }
    } catch {
      return run.agent_id ?? run.config_hash; // a malformed target falls back
    }
  }
  return run.agent_id ?? run.config_hash;
}

// ─── Validity ──────────────────────────────────────────────────────────────

/** Longest reason an invalidate / revalidate records. */
export const MAX_VALIDITY_REASON = 500;

/** The reason a run is invalid (its latest invalidation), or undefined for a run that is not. */
export function invalidReason(
  db: Pick<BenchmarksStore, "listBenchmarkRunValidity">,
  run: Pick<BenchmarkRunRow, "id" | "status">,
): string | undefined {
  if (run.status !== "invalid") return undefined;
  const last = db
    .listBenchmarkRunValidity(run.id)
    .filter((r) => r.action === "invalidate")
    .at(-1);
  return last?.reason ?? "no reason recorded";
}
