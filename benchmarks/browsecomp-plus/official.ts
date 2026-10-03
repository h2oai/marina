// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * BrowseComp-Plus — the official prompts, judge parsing and metrics, ported
 * from the benchmark's MIT-licensed repository (texttron/BrowseComp-Plus:
 * `search_agent/prompts.py`, `scripts_evaluation/evaluate_run.py`,
 * `search_agent/utils.py`). Pure functions; no I/O. Keep these byte-faithful:
 * a submission is only comparable when the prompt, judge and metrics match.
 */

/** The agent prompt (QUERY_TEMPLATE, with the search and get_document tools). */
export const QUERY_TEMPLATE = `You are a deep research agent. You need to answer the given question by interacting with a search engine, using the search and get_document tools provided. Please perform reasoning and use the tools step by step, in an interleaved manner. You may use the search and get_document tools multiple times.

Question: {Question}

Your response should be in the following format:
Explanation: {your explanation for your final answer. For this explanation section only, you should cite your evidence documents inline by enclosing their docids in square brackets [] at the end of sentences. For example, [20].}
Exact Answer: {your succinct, final answer}
Confidence: {your confidence score between 0% and 100% for your answer}`;

/** The judge prompt used by `evaluate_run.py` (semantic-equivalence grader). */
export const GRADER_TEMPLATE = `Judge whether the following [response] to [question] is correct or not based on the precise and unambiguous [correct_answer] below.

[question]: {question}

[response]: {response}

[correct_answer]: {correct_answer}

Your judgement must be in the format and criteria specified below:

extracted_final_answer: The final exact answer extracted from the [response].

[correct_answer]: Repeat the [correct_answer] given above.

reasoning: Explain why the extracted_final_answer is correct or incorrect based on [correct_answer], in the context of this [question]. You should judge whether the extracted_final_answer is semantically equivalent to [correct_answer], allowing the extracted_final_answer to be string variations of [correct_answer]. You should also allow the extracted_final_answer to be more precise or verbose than [correct_answer], as long as its additional details are correct. Do not comment on any background to the problem, do not attempt to solve the problem, do not argue for any answer different than [correct_answer], focus only on whether the answers are semantically equivalent.

correct: Answer 'yes' if extracted_final_answer matches the [correct_answer] given above, or is within a small margin of error for numerical problems. Answer 'no' otherwise, i.e. if there if there is any inconsistency, ambiguity, non-equivalency, or if the extracted answer is incorrect.


confidence: The extracted confidence score between 0|\\%| and 100|\\%| from [response]. Put 100 if there is no confidence score available.`;

/** The official judge and its sampling (evaluate_run.py defaults). */
export const OFFICIAL_JUDGE = {
  model: "Qwen/Qwen3-32B",
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  max_tokens: 4096,
  enableThinking: false,
} as const;

/** Tool descriptions as the official searcher registers them. */
export function searchToolDescription(k: number): string {
  return `Perform a search on a knowledge source. Returns top-${k} hits with docid, score, and snippet. The snippet contains the document's contents (may be truncated based on token limits).`;
}
export const GET_DOCUMENT_DESCRIPTION = "Retrieve a full document by its docid.";

export function queryPrompt(question: string): string {
  return QUERY_TEMPLATE.replace("{Question}", question);
}

export function graderPrompt(question: string, response: string, correctAnswer: string): string {
  return GRADER_TEMPLATE.replace("{question}", question)
    .replace("{response}", response)
    .replace("{correct_answer}", correctAnswer);
}

export interface JudgeResult {
  extractedFinalAnswer: string | null;
  correct: boolean | null;
  confidence: number | null;
  parseError: boolean;
}

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m;
  }
  return null;
}

/** `parse_judge_response`: bold or plain `correct: yes|no` and `confidence: N%`. */
export function parseJudgeResponse(text: string): JudgeResult {
  const extracted = firstMatch(text, [
    /\*\*extracted_final_answer:\*\*\s*(.*?)(?=\n|$)/i,
    /\*\*extracted_final_answer\*\*:\s*(.*?)(?=\n|$)/i,
    /extracted_final_answer:\s*(.*?)(?=\n|$)/i,
  ]);
  const correct = firstMatch(text, [
    /\*\*correct:\*\*\s*(yes|no)/i,
    /\*\*correct\*\*:\s*(yes|no)/i,
    /correct:\s*(yes|no)/i,
  ]);
  const confidence = firstMatch(text, [
    /\*\*confidence:\*\*\s*(\d+(?:\.\d+)?)\s*%?/i,
    /\*\*confidence\*\*:\s*(\d+(?:\.\d+)?)\s*%?/i,
    /confidence:\s*(\d+(?:\.\d+)?)\s*%?/i,
  ]);
  const isCorrect = correct ? correct[1]!.toLowerCase() === "yes" : null;
  return {
    extractedFinalAnswer: extracted ? extracted[1]!.trim() : null,
    correct: isCorrect,
    confidence: confidence ? Math.min(100, Number(confidence[1])) : null,
    parseError: isCorrect === null,
  };
}

/** `extract_citations_from_response`: `[12]`, `[12, 34]` and full-width `【12】`. */
export function extractCitations(response: string): string[] {
  if (!response) return [];
  const ids = new Set<string>();
  const singles = new Set<string>();
  for (const m of response.matchAll(/\[(\d+)\]/g)) singles.add(m[1]!);
  for (const m of response.matchAll(/【(\d+)】/g)) singles.add(m[1]!);
  for (const id of singles) ids.add(id);
  for (const m of [
    ...response.matchAll(/\[([^[\]]*?)\]/g),
    ...response.matchAll(/【([^【】]*?)】/g),
  ]) {
    if (singles.has(m[1]!)) continue;
    for (const d of m[1]!.matchAll(/\d+/g)) ids.add(d[0]);
  }
  return [...ids];
}

/** `qrel_evidence.txt` / `qrel_golds.txt` (TREC: `qid Q0 docid rel`) → qid → docids. */
export function parseQrels(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || Number(parts[3]) <= 0) continue;
    const list = out.get(parts[0]!) ?? [];
    list.push(parts[2]!);
    out.set(parts[0]!, list);
  }
  return out;
}

/** Retrieval recall: |retrieved ∩ evidence| / |evidence| (undefined without qrels). */
export function retrievalRecall(
  retrieved: Iterable<string>,
  evidence: readonly string[] | undefined,
): number | undefined {
  if (!evidence || evidence.length === 0) return undefined;
  const got = new Set(retrieved);
  return evidence.filter((d) => got.has(d)).length / evidence.length;
}

/**
 * `calib_err` (p = 2, β = 100) on confidences in [0, 1] — the RMS calibration
 * error over adaptive bins of β examples. Note the official quirk: the last bin
 * is skipped (`range(len(bins) - 1)`), so fewer than 2β examples give 0.
 */
export function calibrationError(confidences: number[], correct: boolean[], beta = 100): number {
  if (confidences.length !== correct.length || confidences.length < beta) return 0;
  const order = confidences.map((c, i) => [c, correct[i] ? 1 : 0] as const);
  // np.argsort is a quicksort (unstable); ties only reorder equal confidences,
  // which can move items across a bin edge — negligible, and stable here.
  order.sort((a, b) => a[0] - b[0]);
  const nBins = Math.floor(order.length / beta);
  const bins: [number, number][] = [];
  for (let i = 0; i < nBins; i++) bins.push([i * beta, (i + 1) * beta]);
  bins[bins.length - 1] = [bins[bins.length - 1]![0], order.length];
  let cerr = 0;
  for (let i = 0; i < bins.length - 1; i++) {
    const [lo, hi] = bins[i]!;
    const slice = order.slice(lo, hi);
    if (slice.length === 0) continue;
    const meanConf = slice.reduce((t, x) => t + x[0], 0) / slice.length;
    const meanCorrect = slice.reduce((t, x) => t + x[1], 0) / slice.length;
    cerr += (slice.length / order.length) * (meanConf - meanCorrect) ** 2;
  }
  return Math.sqrt(cerr);
}

/** One official per-query run file (`run_*.json`, consumed by evaluate_run.py). */
export interface RunRecordItem {
  type: "tool_call" | "reasoning" | "output_text";
  tool_name: string | null;
  arguments: string | null;
  output: unknown;
  /** Which agent of a multi-agent formation made this step (Marina's addition; ignored by evaluate_run.py). */
  agent?: string;
}

export interface RunRecord {
  metadata: { model: string; [k: string]: unknown };
  query_id: string;
  tool_call_counts: Record<string, number>;
  usage: Record<string, number>;
  status: "completed" | "incomplete" | "error";
  retrieved_docids: string[];
  result: RunRecordItem[];
}

/** `extract_retrieved_docids_from_result`: docids returned by search-like tool calls. */
export function retrievedDocids(result: readonly RunRecordItem[]): string[] {
  const ids = new Set<string>();
  for (const item of result) {
    if (item.type !== "tool_call") continue;
    const name = String(item.tool_name ?? "").toLowerCase();
    if (!name.includes("search") && !name.includes("retrieval")) continue;
    let parsed: unknown = item.output;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = undefined;
        for (const m of String(item.output).matchAll(/"docid"\s*:\s*"?([^",}\s]+)"?/g))
          ids.add(m[1]!);
      }
    }
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e && typeof e === "object" && "docid" in e) ids.add(String(e.docid));
      }
    }
  }
  return [...ids];
}

/** The final answer text, as evaluate_run.py reads it (the last item, if output_text). */
export function finalResponse(record: RunRecord): string {
  const last = record.result.at(-1);
  return last?.type === "output_text" ? String(last.output ?? "") : "";
}

export interface QueryEval {
  query_id: string;
  correct: boolean;
  /** Judge confidence (the response's own stated confidence, 0–100), when parsed. */
  confidence: number | null;
  parseError: boolean;
  /** Retrieval recall in [0, 1]; undefined when the query has no evidence qrels. */
  recall?: number;
  /** The same recall against the gold (answer-bearing) documents, when gold qrels are given. */
  goldRecall?: number;
  searchCalls: number;
  toolCallCounts: Record<string, number>;
  citedDocids: string[];
}

/** The leaderboard submission (the evaluation_summary.json fields, filled in). */
export interface SubmissionSummary {
  LLM: string;
  Retriever: string;
  "Accuracy (%)": number;
  "Recall (%)": number | null;
  "Search Calls": number;
  "Calibration Error (%)": number | null;
  Link: string;
  "Evaluation Date": string;
  per_query_metrics: { query_id: string; correct: boolean; recall: number | null }[];
  [k: string]: unknown;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Aggregate per-query evaluations exactly as evaluate_run.py does. */
export function summarize(
  evals: readonly QueryEval[],
  fields: { llm: string; retriever: string; link: string; date: string },
): SubmissionSummary {
  const total = evals.length;
  const correct = evals.filter((e) => e.correct).length;
  const recalls = evals.map((e) => e.recall).filter((r): r is number => typeof r === "number");
  const conf: number[] = [];
  const corr: boolean[] = [];
  for (const e of evals) {
    if (!e.parseError && e.confidence !== null) {
      conf.push(e.confidence / 100);
      corr.push(e.correct);
    }
  }
  const calib = conf.length >= 100 ? calibrationError(conf, corr) * 100 : 0;
  const searchCalls = total ? evals.reduce((t, e) => t + e.searchCalls, 0) / total : 0;
  return {
    LLM: fields.llm,
    Retriever: fields.retriever,
    "Accuracy (%)": total ? round2((correct / total) * 100) : 0,
    "Recall (%)": recalls.length
      ? round2((recalls.reduce((t, r) => t + r, 0) / recalls.length) * 100)
      : null,
    "Search Calls": round2(searchCalls),
    "Calibration Error (%)": round2(calib),
    Link: fields.link,
    "Evaluation Date": fields.date,
    per_query_metrics: evals.map((e) => ({
      query_id: e.query_id,
      correct: e.correct,
      recall: typeof e.recall === "number" ? round2(e.recall * 100) : null,
    })),
  };
}
