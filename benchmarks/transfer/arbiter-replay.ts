// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline Arbiter replay: NO model calls, no network, nothing written.
 *
 * Reads stored per-item results and asks two questions of them:
 *
 *   1. How many items would reach the Arbiter? Contested is decided by the
 *      core's free signals (`detectDisagreement`, src/orchestration/arbiter.ts):
 *      independent plain runs that disagree, or a verify arm whose answer
 *      dissents from the plain majority; then the cap (`selectForArbiter`).
 *   2. How often did the always-on verifier overrule a CORRECT majority, and
 *      how often did it fix a wrong one? The verify arm's answer is compared
 *      with the majority of independent unverified runs of the same model on
 *      the same item (the counterfactual draft), each judged by the benchmark.
 *
 * Sources (any mix, each repeatable):
 *   --plain <dir>    a BrowseComp-Plus replicate dir (evals/run_<id>_eval.json):
 *                    an unverified run of the model
 *   --verify <dir>   the same, from a `marina/verify:` arm
 *   --ledger <db> --plain-run <id> --verify-run <id>
 *                    benchmark ledger runs (benchmark_items: answer_hash, correct)
 *   --typed <answers.json>
 *                    typed-forecast results ({results:[{answer:TypedForecastAnswer}]}):
 *                    drafts, verifier corrections and critic revisions (no gold:
 *                    reach counts only)
 *   --cap N          the Arbiter cap for the reach count (default MARINA_ARBITER_CAP's default)
 *   --json           print the summary as JSON
 *
 * Prints counts and item ids only — never question or answer text.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type ArbiterAnswerType,
  DEFAULT_ARBITER_POLICY,
  type Disagreement,
  detectDisagreement,
  foldText,
  sameAnswer,
  selectForArbiter,
} from "../../src/orchestration/arbiter";

/** The key of a run that ended without an answer. */
export const NO_ANSWER = "(none)";

/** One stored answer to one item. */
export interface ReplayAnswer {
  key: string;
  correct?: boolean;
}

/** One item: unverified runs and verify-arm answers of the same model. */
export interface ReplayItem {
  id: string;
  plain: ReplayAnswer[];
  verify: ReplayAnswer[];
}

export interface ReplayCounts {
  items: number;
  /** Items with at least one plain and one verify answer. */
  paired: number;
  contested: number;
  /** Contested only because plain runs disagree. */
  contestedByRuns: number;
  /** Contested by the verify arm's dissent (plain runs unanimous or a majority). */
  contestedByDissent: number;
  reachUnderCap: number;
  capped: number;
  cap: number;
  /** Plain majority (> half) exists. */
  withMajority: number;
  majorityCorrect: number;
  /** Verify answer differs from a plain majority. */
  verifyDissents: number;
  /** …and the majority was right while the verify answer was wrong. */
  overruledCorrectMajority: number;
  /** …of those, the verify arm ended with no answer at all (an incomplete run). */
  overruledByNoAnswer: number;
  /** …and the majority was wrong while the verify answer was right. */
  fixedWrongMajority: number;
  /** …both wrong, or both right in different words. */
  otherDissent: number;
  /** Paired accuracy: plain majority vs verify. */
  majorityAccuracy: number;
  verifyAccuracy: number;
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0);

/** Majority among answers by key (text folded upstream); undefined without > half. */
function majorityOf(answers: ReplayAnswer[]): { key: string; correct?: boolean } | undefined {
  const by = new Map<string, ReplayAnswer[]>();
  for (const a of answers) by.set(a.key, [...(by.get(a.key) ?? []), a]);
  const top = [...by.entries()].sort((x, y) => y[1].length - x[1].length)[0];
  if (!top || top[1].length * 2 <= answers.length) return undefined;
  const judged = top[1].filter((a) => a.correct !== undefined);
  const right = judged.filter((a) => a.correct).length;
  return {
    key: top[0],
    ...(judged.length ? { correct: right * 2 > judged.length } : {}),
  };
}

/** The counts for a set of items (pure; exported for tests). */
export function replayCounts(items: ReplayItem[], cap = DEFAULT_ARBITER_POLICY.cap): ReplayCounts {
  const type: ArbiterAnswerType = "text";
  const decided = items.map((it) => {
    const d: Disagreement = detectDisagreement({
      type,
      runs: it.plain.map((a) => ({ answer: a.key })),
      dissent: it.verify.map((v) => ({ by: "verify arm", answer: v.key })),
    });
    return { id: it.id, it, disagreement: d };
  });
  const sel = selectForArbiter(decided, cap);
  const c: ReplayCounts = {
    items: items.length,
    paired: 0,
    contested: sel.selected.length + sel.capped.length,
    contestedByRuns: 0,
    contestedByDissent: 0,
    reachUnderCap: sel.selected.length,
    capped: sel.capped.length,
    cap,
    withMajority: 0,
    majorityCorrect: 0,
    verifyDissents: 0,
    overruledCorrectMajority: 0,
    overruledByNoAnswer: 0,
    fixedWrongMajority: 0,
    otherDissent: 0,
    majorityAccuracy: 0,
    verifyAccuracy: 0,
  };
  let pairedMajority = 0;
  let pairedMajorityRight = 0;
  let pairedVerifyRight = 0;
  for (const { it, disagreement: d } of decided) {
    if (d.reasons.includes("runs-disagree")) c.contestedByRuns++;
    else if (d.reasons.includes("dissent")) c.contestedByDissent++;
    if (it.plain.length === 0 || it.verify.length === 0) continue;
    c.paired++;
    const m = majorityOf(it.plain);
    if (!m) continue;
    c.withMajority++;
    if (m.correct) c.majorityCorrect++;
    for (const v of it.verify) {
      if (m.correct !== undefined && v.correct !== undefined) {
        pairedMajority++;
        if (m.correct) pairedMajorityRight++;
        if (v.correct) pairedVerifyRight++;
      }
      if (v.key === m.key) continue;
      c.verifyDissents++;
      if (m.correct === true && v.correct === false) {
        c.overruledCorrectMajority++;
        if (v.key === NO_ANSWER) c.overruledByNoAnswer++;
      } else if (m.correct === false && v.correct === true) c.fixedWrongMajority++;
      else c.otherDissent++;
    }
  }
  c.majorityAccuracy = ratio(pairedMajorityRight, pairedMajority);
  c.verifyAccuracy = ratio(pairedVerifyRight, pairedMajority);
  return c;
}

// ─── Readers ────────────────────────────────────────────────────────────────

/** A BrowseComp-Plus replicate dir: query id → the judged final answer. */
export function readBrowsecompDir(dir: string): Map<string, ReplayAnswer> {
  const evals = existsSync(join(dir, "evals")) ? join(dir, "evals") : dir;
  const out = new Map<string, ReplayAnswer>();
  for (const f of readdirSync(evals)) {
    const m = /^run_(.+)_eval\.json$/.exec(f);
    if (!m) continue;
    try {
      const j = JSON.parse(readFileSync(join(evals, f), "utf8")) as {
        query_id?: string;
        is_completed?: boolean;
        judge_result?: { extracted_final_answer?: string; correct?: boolean | null };
      };
      // An incomplete run has no answer and scores as wrong (the official accuracy).
      const answer = j.is_completed === false ? "" : (j.judge_result?.extracted_final_answer ?? "");
      out.set(String(j.query_id ?? m[1]), {
        key: foldText(answer) || NO_ANSWER,
        correct: j.judge_result?.correct === true,
      });
    } catch {
      // allow-empty-catch: an unreadable eval file is skipped (counted as absent)
    }
  }
  return out;
}

/** Ledger runs: item id → answer hash and correctness. */
export function readLedgerRun(dbPath: string, runId: string): Map<string, ReplayAnswer> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT item_id, correct, answer_hash FROM benchmark_items WHERE run_id = ? AND answer_hash IS NOT NULL",
      )
      .all(runId) as Array<{ item_id: string; correct: number; answer_hash: string }>;
    return new Map(rows.map((r) => [r.item_id, { key: r.answer_hash, correct: r.correct === 1 }]));
  } finally {
    db.close();
  }
}

/** Join per-run answer maps into items. */
export function joinRuns(
  plain: Map<string, ReplayAnswer>[],
  verify: Map<string, ReplayAnswer>[],
): ReplayItem[] {
  const ids = new Set<string>();
  for (const m of [...plain, ...verify]) for (const id of m.keys()) ids.add(id);
  return [...ids].sort().map((id) => ({
    id,
    plain: plain.flatMap((m) => (m.has(id) ? [m.get(id)!] : [])),
    verify: verify.flatMap((m) => (m.has(id) ? [m.get(id)!] : [])),
  }));
}

export interface TypedReplayCounts {
  items: number;
  withRuns: number;
  /** Drafts disagree. */
  runsDisagree: number;
  /** The verifier corrected at least one draft. */
  verifierDissent: number;
  /** The critic proposed a revision. */
  criticDissent: number;
  contested: number;
  reachUnderCap: number;
  /** Items where the verifier changed a draft that agreed with a unanimous draft majority. */
  verifierBrokeUnanimity: number;
  /** Items where a correction changed the final answer away from the drafts' majority. */
  verifierFlippedMajority: number;
  /** The critic's revision was applied. */
  criticApplied: number;
}

interface StoredTyped {
  answer?: { type?: ArbiterAnswerType };
  runs?: Array<{
    formatted?: string;
    weight?: number;
    verified?: { verdict?: string; draft?: string };
  }>;
  critique?: { verdict?: string; proposed?: string; applied?: boolean };
  formatted?: string;
}

/** Typed-forecast results: reach counts from drafts, verifier and critic (no gold). */
export function typedReplay(answers: StoredTyped[], cap: number): TypedReplayCounts {
  const c: TypedReplayCounts = {
    items: answers.length,
    withRuns: 0,
    runsDisagree: 0,
    verifierDissent: 0,
    criticDissent: 0,
    contested: 0,
    reachUnderCap: 0,
    verifierBrokeUnanimity: 0,
    verifierFlippedMajority: 0,
    criticApplied: 0,
  };
  const decided: Array<{ id: string; disagreement: Disagreement }> = [];
  answers.forEach((a, i) => {
    const runs = (a.runs ?? []).filter((r) => r.formatted !== undefined && (r.weight ?? 1) > 0);
    if (!runs.length) return;
    c.withRuns++;
    const type: ArbiterAnswerType = a.answer?.type === "number" ? "number" : "text";
    const norm = (s: string): string | number =>
      type === "number" ? Number(s.replace(/[,\s_]/g, "")) : foldText(s);
    const draft = (r: (typeof runs)[number]) =>
      r.verified?.verdict === "correct" && r.verified.draft !== undefined
        ? r.verified.draft
        : r.formatted!;
    const drafts = runs.map((r) => ({ answer: norm(draft(r)) }));
    const dissent = [
      ...runs
        .filter((r) => r.verified?.verdict === "correct")
        .map((r) => ({ by: "verifier", answer: norm(r.formatted!) })),
      ...(a.critique?.verdict === "revise" && a.critique.proposed !== undefined
        ? [{ by: "critic", answer: norm(a.critique.proposed) }]
        : []),
    ];
    const d = detectDisagreement({ type, runs: drafts, dissent });
    decided.push({ id: String(i), disagreement: d });
    if (d.reasons.includes("runs-disagree")) c.runsDisagree++;
    if (runs.some((r) => r.verified?.verdict === "correct")) c.verifierDissent++;
    if (a.critique?.verdict === "revise") c.criticDissent++;
    if (a.critique?.applied) c.criticApplied++;
    const unanimous = d.agreement === 1;
    if (unanimous && runs.some((r) => r.verified?.verdict === "correct"))
      c.verifierBrokeUnanimity++;
    const final = a.formatted !== undefined ? norm(a.formatted) : undefined;
    if (
      d.hasMajority &&
      final !== undefined &&
      d.majority !== undefined &&
      !sameAnswer(type, final, d.majority) &&
      !a.critique?.applied &&
      runs.some((r) => r.verified?.verdict === "correct")
    )
      c.verifierFlippedMajority++;
  });
  const sel = selectForArbiter(decided, cap);
  c.contested = sel.selected.length + sel.capped.length;
  c.reachUnderCap = sel.selected.length;
  return c;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      plain: { type: "string", multiple: true },
      verify: { type: "string", multiple: true },
      ledger: { type: "string" },
      "plain-run": { type: "string", multiple: true },
      "verify-run": { type: "string", multiple: true },
      typed: { type: "string", multiple: true },
      cap: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const cap = values.cap !== undefined ? Number(values.cap) : DEFAULT_ARBITER_POLICY.cap;
  const summary: Record<string, unknown> = {};
  if (values.plain?.length || values.verify?.length) {
    const items = joinRuns(
      (values.plain ?? []).map(readBrowsecompDir),
      (values.verify ?? []).map(readBrowsecompDir),
    );
    summary.results = replayCounts(items, cap);
  }
  if (values.ledger) {
    const items = joinRuns(
      (values["plain-run"] ?? []).map((r) => readLedgerRun(values.ledger!, r)),
      (values["verify-run"] ?? []).map((r) => readLedgerRun(values.ledger!, r)),
    );
    summary.ledger = replayCounts(items, cap);
  }
  if (values.typed?.length) {
    const all: StoredTyped[] = [];
    for (const f of values.typed) {
      const j = JSON.parse(readFileSync(f, "utf8")) as {
        results?: Array<{ answer?: StoredTyped }>;
      };
      for (const r of j.results ?? []) if (r.answer) all.push(r.answer);
    }
    summary.typed = typedReplay(all, cap);
  }
  if (values.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else
    for (const [k, v] of Object.entries(summary)) {
      process.stdout.write(`## ${k}\n`);
      for (const [f, n] of Object.entries(v as Record<string, unknown>))
        process.stdout.write(`  ${f}: ${n}\n`);
    }
}
