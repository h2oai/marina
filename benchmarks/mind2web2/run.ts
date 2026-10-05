// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mind2Web 2 answers from Marina's live-web research agent (`src/research/web-agent.ts`),
 * written in the official submission layout:
 *
 *   <out>/answers/<agent>/<task_id>/answer_<k>.md         the answer (markdown, cited URLs)
 *   <out>/answers/<agent>/<task_id>/answer_<k>.meta.json  { time_seconds }
 *   <out>/runs/<agent>/<task_id>/answer_<k>.json          the run record (cost, turns, audit;
 *                                                          kept out of the submission)
 *   <out>/provenance/<agent>/<task_id>/<k>/               every page the run read
 *
 * An arm is a formation over models. Each run gets its own provenance cache and
 * draws on one spend guard for the whole batch: the guard is checked before
 * every model turn, and a run it stops is recorded as `budget` (not run), never
 * as an answer.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getErrorMessage } from "../../src/engine/errors";
import type { BrowserReader } from "../../src/research/browser-reader";
import { modelTurns } from "../../src/research/model-turn";
import { ProvenanceCache } from "../../src/research/provenance-cache";
import { type Formation, researchEnvironment, runResearch } from "../../src/research/web-agent";
import { BudgetExhausted, type CallSpendGuard } from "../call-spend-guard";
import type { M2W2Task } from "./tasks";

export interface Arm {
  /** The submission's agent name, e.g. `marina-single`. */
  agent: string;
  formation: Formation;
  lead: string;
  researcher?: string;
  verifier?: string;
  maxTurns: number;
  researcherTurns?: number;
}

export const ARMS: Record<string, Arm> = {
  single: {
    agent: "marina-single",
    formation: { kind: "single" },
    lead: "anthropic/claude-opus-5-5",
    maxTurns: 30,
  },
  lead: {
    agent: "marina-lead",
    formation: { kind: "lead", researchers: 3 },
    lead: "anthropic/claude-opus-5-5",
    researcher: "anthropic/claude-opus-5-5",
    verifier: "openai/gpt-6.1-sol",
    maxTurns: 20,
    researcherTurns: 14,
  },
};

/** Never fetched while answering: the benchmark's own tasks, judge scripts and board. */
export const M2W2_DENY = [
  "huggingface.co/datasets/osunlp/mind2web-2",
  "huggingface.co/datasets/osunlp/Mind2Web-2",
  "github.com/osu-nlp-group/mind2web-2",
  "raw.githubusercontent.com/osu-nlp-group/mind2web-2",
  "osu-nlp-group.github.io/mind2web-2",
];

export type RunStatus = "answered" | "empty" | "error" | "budget";

export interface RunRecord {
  task: string;
  agent: string;
  k: number;
  status: RunStatus;
  startedAt: string;
  seconds: number;
  costUsd: number;
  modelUsd: number;
  searchUsd: number;
  models: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; costUsd: number }
  >;
  turns?: number;
  toolCalls?: number;
  budgetForced?: boolean;
  repaired?: boolean;
  audit?: {
    cited: number;
    read: number;
    unread: number;
    failed: number;
    uncitedLines: number;
    substantiveLines: number;
  };
  verification?: { checked: number; problems: number };
  plan?: number;
  reads?: number;
  readFailures?: number;
  searches?: number;
  searchFailures?: number;
  denied?: number;
  /** Pages read through the browser. */
  rendered?: number;
  answerChars?: number;
  error?: string;
}

export interface RunOneOptions {
  arm: Arm;
  task: M2W2Task;
  k: number;
  out: string;
  guard: CallSpendGuard;
  env?: NodeJS.ProcessEnv;
  today?: string;
  log?: (line: string) => void;
  /** Opt-in rendered reads (`src/research/browser-reader.ts`). */
  browser?: BrowserReader;
}

export function answerPath(out: string, agent: string, task: string, k: number): string {
  return join(out, "answers", agent, task, `answer_${k}.md`);
}

export function recordPath(out: string, agent: string, task: string, k: number): string {
  return join(out, "runs", agent, task, `answer_${k}.json`);
}

/** Answer one task once; writes the answer, its meta file and the run record. */
export async function runOne(o: RunOneOptions): Promise<RunRecord> {
  const { arm, task, k, out, guard } = o;
  const env = o.env ?? process.env;
  const log = (l: string) => o.log?.(`${arm.agent}/${task.id}#${k} ${l}`);
  const cache = new ProvenanceCache(join(out, "provenance", arm.agent, task.id, String(k)));
  let searchUsd = 0;
  const research = researchEnvironment({
    cache,
    deny: M2W2_DENY,
    env,
    ...(o.browser ? { browser: o.browser } : {}),
    onSearchSpend: (usd) => {
      searchUsd += usd;
      guard.add(usd);
    },
  });
  const opts = { onCost: (usd: number) => guard.add(usd) };
  const lead = modelTurns(arm.lead, env, opts);
  const researcher =
    arm.researcher && arm.researcher !== arm.lead ? modelTurns(arm.researcher, env, opts) : lead;
  const verifier = arm.verifier ? modelTurns(arm.verifier, env, opts) : undefined;
  const models = () => {
    const m: RunRecord["models"] = {};
    for (const t of [lead, researcher, ...(verifier ? [verifier] : [])]) {
      const prev = m[t.spec];
      if (prev && prev === (t.usage as unknown)) continue;
      m[t.spec] = { ...t.usage };
    }
    return m;
  };
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const base = (status: RunStatus): RunRecord => {
    const ms = models();
    const modelUsd = Object.values(ms).reduce((s, u) => s + u.costUsd, 0);
    return {
      task: task.id,
      agent: arm.agent,
      k,
      status,
      startedAt,
      seconds: Math.round((Date.now() - started) / 1000),
      costUsd: modelUsd + searchUsd,
      modelUsd,
      searchUsd,
      models: ms,
      reads: research.stats.reads,
      readFailures: research.stats.readFailures,
      searches: research.stats.searches,
      searchFailures: research.stats.searchFailures,
      denied: cache.list().filter((p) => p.error === "refused by this run's deny list").length,
      rendered: cache.list().filter((p) => p.via === "browser").length,
    };
  };
  let rec: RunRecord;
  try {
    const result = await runResearch({
      task: task.description,
      env: research,
      lead,
      researcher,
      ...(verifier ? { verifier } : {}),
      formation: arm.formation,
      maxTurns: arm.maxTurns,
      ...(arm.researcherTurns ? { researcherTurns: arm.researcherTurns } : {}),
      ...(o.today ? { today: o.today } : {}),
      beforeTurn: () => guard.check(),
      log,
    });
    rec = {
      ...base(result.answer ? "answered" : "empty"),
      turns: result.turns,
      toolCalls: result.toolCalls,
      budgetForced: result.budgetForced,
      repaired: result.repaired,
      audit: {
        cited: result.audit.cited,
        read: result.audit.read.length,
        unread: result.audit.unread.length,
        failed: result.audit.failed.length,
        uncitedLines: result.audit.uncitedLines,
        substantiveLines: result.audit.substantiveLines,
      },
      ...(result.verification
        ? {
            verification: {
              checked: result.verification.checked,
              problems: result.verification.problems.length,
            },
          }
        : {}),
      ...(result.plan ? { plan: result.plan.length } : {}),
      answerChars: result.answer.length,
    };
    if (result.answer) {
      const p = answerPath(out, arm.agent, task.id, k);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `${result.answer.trim()}\n`);
      writeFileSync(
        p.replace(/\.md$/, ".meta.json"),
        `${JSON.stringify({ time_seconds: rec.seconds })}\n`,
      );
    }
    // The run's tool trail stays next to its provenance (never in the submission).
    writeFileSync(join(cache.dir, "events.json"), JSON.stringify(research.events));
  } catch (e) {
    const budget = e instanceof BudgetExhausted;
    rec = { ...base(budget ? "budget" : "error"), error: getErrorMessage(e).slice(0, 300) };
  }
  const rp = recordPath(out, arm.agent, task.id, k);
  mkdirSync(join(rp, ".."), { recursive: true });
  writeFileSync(rp, `${JSON.stringify(rec, null, 1)}\n`);
  log(
    `${rec.status} $${rec.costUsd.toFixed(3)} ${rec.seconds}s${rec.error ? ` (${rec.error.slice(0, 120)})` : ""}`,
  );
  return rec;
}

/** Run every (task, k) not yet answered, `concurrency` at a time; stops starting new runs once the guard trips. */
export async function runBatch(o: {
  arm: Arm;
  tasks: readonly M2W2Task[];
  runs: readonly number[];
  out: string;
  guard: CallSpendGuard;
  concurrency: number;
  env?: NodeJS.ProcessEnv;
  today?: string;
  log?: (line: string) => void;
  browser?: BrowserReader;
}): Promise<RunRecord[]> {
  const jobs = o.tasks.flatMap((task) =>
    o.runs
      .map((k) => ({ task, k }))
      .filter(({ task, k }) => !existsSync(recordPath(o.out, o.arm.agent, task.id, k))),
  );
  const done: RunRecord[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (o.guard.stoppedBy) return;
      const job = jobs[next++]!;
      done.push(
        await runOne({
          arm: o.arm,
          task: job.task,
          k: job.k,
          out: o.out,
          guard: o.guard,
          ...(o.env ? { env: o.env } : {}),
          ...(o.today ? { today: o.today } : {}),
          ...(o.log ? { log: o.log } : {}),
          ...(o.browser ? { browser: o.browser } : {}),
        }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  return done;
}
