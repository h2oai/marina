// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * BrowseComp-Plus runs: pick queries (seeded), answer each through a Marina
 * endpoint (`agent.ts`), judge with the official grader through Marina, and
 * produce the official artifacts — one `run_<query_id>.json` per query (the
 * format evaluate_run.py reads), per-query evals, and the leaderboard summary
 * — plus a harness-shaped `BenchmarkResult` for Marina's ledger.
 *
 * Query and answer text stay in the operator's output directory; the ledger
 * result carries item ids and outcomes only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetExhausted, isSpendCapRefusal } from "../spend-guard";
import { mulberry32 } from "../stats";
import type { BenchmarkResult, ResultItem } from "../types";
import {
  type AgentOptions,
  type ChatEndpoint,
  type QueryRun,
  runCrew,
  runToolAgent,
  shapeFor,
} from "./agent";
import { type FormationOptions, type FormationSpec, runFormation } from "./formations";
import {
  extractCitations,
  finalResponse,
  graderPrompt,
  OFFICIAL_JUDGE,
  parseJudgeResponse,
  type QueryEval,
  type RunRecord,
  retrievalRecall,
  type SubmissionSummary,
  summarize,
} from "./official";

export const BENCHMARK_NAME = "browsecomp-plus";
/** The retriever label for a submission built on Marina's local corpus index. */
export const RETRIEVER_LABEL = "BM25 (SQLite FTS5, Marina local corpus)";

export interface Query {
  query_id: string;
  query: string;
  answer: string;
}

/** Decrypted queries JSONL (`export.py queries`): `{query_id, query, answer}` per line. */
export function loadQueries(path: string): Query[] {
  const out: Query[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (r.query_id === undefined || typeof r.query !== "string" || typeof r.answer !== "string")
      continue;
    out.push({ query_id: String(r.query_id), query: r.query, answer: r.answer });
  }
  return out;
}

/**
 * A seeded sample: `n` queries starting at `offset` in one fixed shuffle of all
 * queries (all when n is undefined). Disjoint offsets give disjoint splits —
 * e.g. a selection split at offset 0 and a held-out split at offset n.
 */
export function sampleQueries(
  queries: readonly Query[],
  n: number | undefined,
  seed: number,
  offset = 0,
): Query[] {
  const byId = (a: Query, b: Query) =>
    a.query_id.localeCompare(b.query_id, "en", { numeric: true });
  const sorted = [...queries].sort(byId);
  if (n === undefined && offset === 0) return sorted;
  const rand = mulberry32(seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
  }
  return sorted.slice(offset, n === undefined ? undefined : offset + n).sort(byId);
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface JudgeConfig {
  endpoint: ChatEndpoint;
  /** The id Marina serves the official judge under (e.g. `openrouter/qwen/qwen3-32b`). */
  model: string;
  timeoutMs: number;
}

export interface JudgeOutcome {
  prompt: string;
  response: string;
  result: ReturnType<typeof parseJudgeResponse>;
  costUsd: number;
  traceId?: string;
  error?: string;
}

/** The official grader with the official sampling (thinking off), through Marina. */
export async function judgeAnswer(
  cfg: JudgeConfig,
  question: string,
  response: string,
  correctAnswer: string,
): Promise<JudgeOutcome> {
  const prompt = graderPrompt(question, response, correctAnswer);
  const doFetch = cfg.endpoint.fetch ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.endpoint.apiKey) headers.Authorization = `Bearer ${cfg.endpoint.apiKey}`;
  try {
    cfg.endpoint.guard?.check();
    const resp = await doFetch(`${cfg.endpoint.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        temperature: OFFICIAL_JUDGE.temperature,
        top_p: OFFICIAL_JUDGE.top_p,
        top_k: OFFICIAL_JUDGE.top_k,
        max_tokens: OFFICIAL_JUDGE.max_tokens,
        // enable_thinking=False, in both spellings OpenAI-compatible hosts accept.
        reasoning: { enabled: false },
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await resp.text();
    const cost = Number(resp.headers.get("x-marina-cost-usd"));
    cfg.endpoint.guard?.add(cost);
    if (!resp.ok) {
      if (cfg.endpoint.guard && isSpendCapRefusal(resp.status, text)) {
        cfg.endpoint.guard.trip("the server's daily spend cap");
        cfg.endpoint.guard.check();
      }
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = JSON.parse(text) as { choices?: { message?: { content?: string | null } }[] };
    // A thinking block, if a host emits one anyway, is not part of the verdict.
    const content = (data.choices?.[0]?.message?.content ?? "").replace(
      /<think>[\s\S]*?<\/think>/g,
      "",
    );
    return {
      prompt,
      response: content,
      result: parseJudgeResponse(content),
      costUsd: Number.isFinite(cost) ? cost : 0,
      traceId: resp.headers.get("x-request-id") ?? undefined,
    };
  } catch (e) {
    // A budget stop is not a judge error: the caller leaves the query out.
    if (e instanceof BudgetExhausted) throw e;
    return {
      prompt,
      response: "",
      result: { extractedFinalAnswer: null, correct: null, confidence: null, parseError: true },
      costUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface ArmOptions {
  /** The model id the arm asks Marina for (passthru, `marina/verify:…` or `marina:<crew>`). */
  model: string;
  endpoint: ChatEndpoint;
  agent: AgentOptions;
  judge: JudgeConfig;
  concurrency: number;
  /** Evidence qrels (query id → docids) for retrieval recall. */
  qrels?: Map<string, string[]>;
  /** Gold qrels (`qrel_golds.txt`) for gold-document recall (Marina's addition). */
  goldQrels?: Map<string, string[]>;
  /** Directory for this replicate's official artifacts. */
  outDir: string;
  /** A multi-agent research formation (default: the single official loop). */
  formation?: FormationSpec;
  formationOptions?: Omit<FormationOptions, "model">;
  /** Reuse queries already answered and judged in `outDir` (an interrupted or stopped run). */
  resume?: boolean;
  onProgress?: (done: number, total: number, last: QueryEval) => void;
}

export interface ArmItem {
  query: Query;
  run: QueryRun;
  judge: JudgeOutcome | null;
  eval: QueryEval;
}

export interface ArmRun {
  model: string;
  items: ArmItem[];
  startedAt: number;
  finishedAt: number;
  costUsd: number;
  judgeCostUsd: number;
  /** Set when the spend guard stopped the arm: `items` then holds only finished queries. */
  stoppedBy?: string;
  /** Query ids not run because of the stop (never scored, never counted wrong). */
  notRun: string[];
  /** Query ids reused from an earlier run in the same directory (`resume`). */
  resumed: string[];
}

function evalFor(
  q: Query,
  record: RunRecord,
  judge: JudgeOutcome | null,
  qrels?: Map<string, string[]>,
  goldQrels?: Map<string, string[]>,
): QueryEval {
  const response = finalResponse(record);
  return {
    query_id: q.query_id,
    correct: judge?.result.correct === true,
    confidence: judge?.result.confidence ?? null,
    parseError: judge ? judge.result.parseError : true,
    recall: retrievalRecall(record.retrieved_docids, qrels?.get(q.query_id)),
    goldRecall: retrievalRecall(record.retrieved_docids, goldQrels?.get(q.query_id)),
    searchCalls: record.tool_call_counts.search ?? 0,
    toolCallCounts: record.tool_call_counts,
    citedDocids: extractCitations(response),
  };
}

/** A query answered and judged by an earlier run in `outDir`, rebuilt from its files. */
export function priorItem(
  q: Query,
  outDir: string,
  qrels?: Map<string, string[]>,
  goldQrels?: Map<string, string[]>,
): ArmItem | undefined {
  const runFile = join(outDir, "runs", `run_${q.query_id}.json`);
  const evalFile = join(outDir, "evals", `run_${q.query_id}_eval.json`);
  if (!existsSync(runFile) || !existsSync(evalFile)) return undefined;
  try {
    const record = JSON.parse(readFileSync(runFile, "utf8")) as RunRecord;
    const ev = JSON.parse(readFileSync(evalFile, "utf8")) as Record<string, unknown>;
    if (record.metadata?.stopped_by) return undefined;
    const jr = (ev.judge_result ?? {}) as Record<string, unknown>;
    const judge: JudgeOutcome | null =
      typeof ev.judge_response === "string"
        ? {
            prompt: "",
            response: ev.judge_response,
            result: {
              extractedFinalAnswer: (jr.extracted_final_answer as string | null) ?? null,
              correct: (jr.correct as boolean | null) ?? null,
              confidence: (jr.confidence as number | null) ?? null,
              parseError: jr.parse_error === true,
            },
            costUsd: Number(ev.judge_cost_usd) || 0,
            ...(typeof ev.judge_trace_id === "string" ? { traceId: ev.judge_trace_id } : {}),
            ...(typeof jr.error === "string" ? { error: jr.error } : {}),
          }
        : null;
    const usage = record.usage ?? {};
    const run: QueryRun = {
      record,
      costUsd: Number(ev.cost_usd) || 0,
      promptTokens: usage.input_tokens ?? 0,
      completionTokens: usage.output_tokens ?? 0,
      calls: Number(ev.calls) || 0,
      latencyMs: Number(ev.latency_ms) || 0,
      traceIds: Array.isArray(ev.trace_ids) ? (ev.trace_ids as string[]) : [],
    };
    return { query: q, run, judge, eval: evalFor(q, record, judge, qrels, goldQrels) };
  } catch {
    // allow-empty-catch: an unreadable earlier file means the query runs again
    return undefined;
  }
}

/**
 * Answer and judge every query; writes run_<id>.json and <id>_eval.json as it
 * goes. With a spend guard on the endpoint, a query the guard stops is NOT RUN:
 * no file is written, it is left out of `items` and listed in `notRun`.
 */
export async function runArm(queries: readonly Query[], opts: ArmOptions): Promise<ArmRun> {
  const startedAt = Date.now();
  const runsDir = join(opts.outDir, "runs");
  const evalsDir = join(opts.outDir, "evals");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(evalsDir, { recursive: true });
  const guard = opts.endpoint.guard;
  const resumed: string[] = [];
  let done = 0;
  const slots = await pool(queries, opts.concurrency, async (q): Promise<ArmItem | null> => {
    if (opts.resume) {
      const prior = priorItem(q, opts.outDir, opts.qrels, opts.goldQrels);
      if (prior) {
        resumed.push(q.query_id);
        opts.onProgress?.(++done, queries.length, prior.eval);
        return prior;
      }
    }
    if (guard?.stoppedBy) return null;
    const run =
      shapeFor(opts.model) === "crew"
        ? await runCrew(opts.endpoint, opts.model, q.query_id, q.query, opts.agent)
        : opts.formation && opts.formation.kind !== "single"
          ? await runFormation(opts.endpoint, opts.formation, q.query_id, q.query, opts.agent, {
              leadTurns: 12,
              ...opts.formationOptions,
              model: opts.model,
            })
          : await runToolAgent(opts.endpoint, opts.model, q.query_id, q.query, opts.agent);
    if (run.stoppedBy) return null;
    const response = finalResponse(run.record);
    // evaluate_run.py never judges an incomplete or empty run: it counts as wrong.
    let judge: JudgeOutcome | null = null;
    if (run.record.status === "completed" && response) {
      try {
        judge = await judgeAnswer(opts.judge, q.query, response, q.answer);
      } catch (e) {
        if (e instanceof BudgetExhausted) return null;
        throw e;
      }
    }
    writeFileSync(join(runsDir, `run_${q.query_id}.json`), JSON.stringify(run.record, null, 2));
    const ev = evalFor(q, run.record, judge, opts.qrels, opts.goldQrels);
    writeFileSync(
      join(evalsDir, `run_${q.query_id}_eval.json`),
      JSON.stringify(
        {
          query_id: q.query_id,
          is_completed: run.record.status === "completed",
          judge_response: judge?.response ?? null,
          judge_result: judge
            ? {
                extracted_final_answer: judge.result.extractedFinalAnswer,
                correct: judge.result.correct,
                confidence: judge.result.confidence,
                parse_error: judge.result.parseError,
                ...(judge.error ? { error: judge.error } : {}),
              }
            : { parse_error: true, error: run.error ?? "Response incomplete or cannot be parsed" },
          tool_call_counts: run.record.tool_call_counts,
          citations: { cited_docids: ev.citedDocids },
          retrieval: {
            retrieved_docids: run.record.retrieved_docids,
            recall: ev.recall ?? null,
            gold_recall: ev.goldRecall ?? null,
          },
          cost_usd: run.costUsd,
          judge_cost_usd: judge?.costUsd ?? 0,
          calls: run.calls,
          latency_ms: run.latencyMs,
          trace_ids: run.traceIds,
          ...(judge?.traceId ? { judge_trace_id: judge.traceId } : {}),
        },
        null,
        2,
      ),
    );
    opts.onProgress?.(++done, queries.length, ev);
    return { query: q, run, judge, eval: ev };
  });
  const items = slots.filter((s): s is ArmItem => s !== null);
  const notRun = queries.filter((_, i) => slots[i] === null).map((q) => q.query_id);
  return {
    model: opts.model,
    items,
    startedAt,
    finishedAt: Date.now(),
    costUsd: items.reduce((t, i) => t + i.run.costUsd, 0),
    judgeCostUsd: items.reduce((t, i) => t + (i.judge?.costUsd ?? 0), 0),
    ...(notRun.length ? { stoppedBy: guard?.stoppedBy ?? "spend guard" } : {}),
    notRun,
    resumed,
  };
}

/** The leaderboard summary for one replicate. */
export function submissionSummary(
  arm: ArmRun,
  fields: {
    llm: string;
    link: string;
    retriever?: string;
    date?: string;
    extra?: Record<string, unknown>;
  },
): SubmissionSummary {
  return {
    ...summarize(
      arm.items.map((i) => i.eval),
      {
        llm: fields.llm,
        retriever: fields.retriever ?? RETRIEVER_LABEL,
        link: fields.link,
        date: fields.date ?? new Date(arm.finishedAt).toISOString().slice(0, 10),
      },
    ),
    ...(fields.extra ?? {}),
  };
}

/** The ledger-shaped result: ids, outcomes, cost, judge verdicts — no query or answer text. */
export function toBenchmarkResult(
  arm: ArmRun,
  opts: {
    endpoint: string;
    judgeModel: string;
    concurrency: number;
    seed: number;
    limit?: number;
    /** What ran: a model id, or a formation object (recorded as the config's model). */
    target?: unknown;
  },
): BenchmarkResult {
  const items: ResultItem[] = arm.items.map((i) => ({
    id: i.query.query_id,
    question: "",
    expected: "",
    // An errored run is a fallback, not an answer (the ledger counts the rate); no content.
    actual: i.run.record.status === "error" ? "ERROR: run failed" : "",
    correct: i.eval.correct,
    latencyMs: i.run.latencyMs,
    ...(i.run.record.status === "error" ? { category: "error" } : {}),
    usage: {
      calls: i.run.calls,
      promptTokens: i.run.promptTokens,
      completionTokens: i.run.completionTokens,
      costUsd: i.run.costUsd,
    },
    ...(i.judge
      ? {
          judge: i.judge.error ? "error" : i.eval.correct ? "correct" : "incorrect",
          judgeUsage: { calls: 1, costUsd: i.judge.costUsd },
          ...(i.judge.traceId ? { judgeTraceId: i.judge.traceId } : {}),
        }
      : {}),
    ...(i.run.traceIds[0] ? { traceId: i.run.traceIds[0] } : {}),
  }));
  const n = items.length;
  const correct = items.filter((i) => i.correct).length;
  const answered = arm.items.filter((i) => i.run.record.status === "completed").length;
  return {
    config: {
      name: BENCHMARK_NAME,
      dataset: "Tevatron/browsecomp-plus",
      adapter: "free-form",
      scoring: "judge",
      mode: "passthrough",
      model:
        opts.target === undefined || typeof opts.target === "string"
          ? ((opts.target as string | undefined) ?? arm.model)
          : JSON.stringify(opts.target),
      endpoint: opts.endpoint,
      concurrency: opts.concurrency,
      seed: opts.seed,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      judge: { model: opts.judgeModel, endpoint: opts.endpoint },
    },
    timestamp: arm.startedAt,
    duration_ms: arm.finishedAt - arm.startedAt,
    scores: { overall: n ? correct / n : 0, breakdown: {} },
    metadata: {
      total: n,
      answered,
      timeouts: 0,
      errors: arm.items.filter((i) => i.run.record.status === "error").length,
      avgLatencyMs: n ? arm.items.reduce((t, i) => t + i.run.latencyMs, 0) / n : 0,
      usage: {
        items: n,
        calls: arm.items.reduce((t, i) => t + i.run.calls, 0),
        pricedItems: n,
        costUsd: arm.costUsd,
        judgeCostUsd: arm.judgeCostUsd,
      },
    },
    items,
  };
}
