// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate DeepResearch Bench reports with Marina's general research-report
 * pipeline (`src/research/report.ts`) — the adapter adds nothing to the
 * method: a task is its prompt, its language and its barred sources.
 *
 * Every finished task is written to `<out>/<label>/tasks/<id>.json` the moment
 * it lands (the report, its evidence and the audit trail), so a run stopped by
 * a spend cap keeps what was paid for, and `resume` skips finished tasks. A
 * task whose pipeline throws is recorded as failed (never as a report).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { modelComplete } from "../../src/arena/model-backend";
import type { Retriever } from "../../src/arena/research/retrieve";
import { getErrorMessage } from "../../src/engine/errors";
import type { SpendGuard } from "../../src/engine/spend-guard";
import {
  FileResearchCheckpoint,
  ResearchInterrupted,
  researchFingerprint,
} from "../../src/research/checkpoint";
import { type FactPassAudit, factCheckReport } from "../../src/research/fact-pass";
import { type ResearchReportResult, writeResearchReport } from "../../src/research/report";
import type { BenchTask } from "./dataset";

export interface RunConfig {
  label: string;
  /** `provider/model` for plan, gap queries and writing. */
  lead: string;
  maxSections?: number;
  queriesPerSection?: number;
  gapRound?: boolean;
  evidenceChars?: number;
  /** Lessons block shown to the planner (recalled by the caller), or none. */
  lessons?: (task: BenchTask) => Promise<string | undefined>;
  /** Retrieval recipe/version; changed recipes must use a new label. */
  retrievalIdentity?: unknown;
}

export interface TaskRecord {
  id: string;
  board: string;
  language: string;
  label: string;
  lead: string;
  /** Set on a fact-checked copy: the label it was made from, and the checker. */
  from?: string;
  checker?: string;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  cost: {
    leadUsd: number;
    checkerUsd: number;
    searchUsd: number;
    /** Retrieval add-ons the retriever meters itself (read-swarm readers). */
    retrievalExtraUsd?: number;
    totalUsd: number;
  };
  /** Lessons injected into the plan (count only). */
  lessons: number;
  /** What the retrieval add-ons did for this task (counts and labels only). */
  retrieval?: Record<string, number | string>;
  report?: ResearchReportResult;
  factPass?: FactPassAudit;
  error?: string;
  configFingerprint?: string;
}

/**
 * A task's retriever. Add-ons that meter their own spend (the read swarm's
 * readers) report it through `extraUsd`, counted once per task, and summarise
 * what they did through `summary`.
 */
export type TaskRetriever = Retriever & {
  extraUsd?: () => number;
  summary?: () => Record<string, number | string>;
};

export function taskPath(outDir: string, label: string, id: string): string {
  return join(outDir, label, "tasks", `${id}.json`);
}

export function loadRecords(outDir: string, label: string): TaskRecord[] {
  const dir = join(outDir, label, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskRecord);
}

/** Includes interrupted tasks; a checkpoint and its final record count once. */
export function generationSpend(outDir: string, label: string): number {
  const costs = new Map(loadRecords(outDir, label).map((r) => [r.id, r.cost.totalUsd]));
  const directory = join(outDir, label, "checkpoints");
  if (existsSync(directory))
    for (const file of readdirSync(directory).filter((f) => f.endsWith(".json"))) {
      const saved = JSON.parse(readFileSync(join(directory, file), "utf8")) as {
        accounting: Record<string, number>;
      };
      const usd = Object.values(saved.accounting).reduce((sum, n) => sum + n, 0);
      const id = file.slice(0, -5);
      costs.set(id, Math.max(costs.get(id) ?? 0, usd));
    }
  return [...costs.values()].reduce((sum, n) => sum + n, 0);
}

function save(outDir: string, rec: TaskRecord): void {
  const p = taskPath(outDir, rec.label, rec.id);
  mkdirSync(join(outDir, rec.label, "tasks"), { recursive: true });
  const temp = `${p}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(temp, p);
}

async function pool<T>(items: T[], n: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(1, n), queue.length) }, async () => {
      for (let it = queue.shift(); !failed && it !== undefined; it = queue.shift()) {
        try {
          await run(it);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

/**
 * Generate reports for `tasks` under `config`. Finished tasks (a record with
 * a report) are skipped; failed ones are retried. Stops starting tasks when
 * `guard` says so (the records written so far stay).
 */
export async function generateReports(input: {
  tasks: BenchTask[];
  config: RunConfig;
  retriever: () => TaskRetriever;
  outDir: string;
  concurrency: number;
  guard: SpendGuard;
  env?: NodeJS.ProcessEnv;
  /** Dependency injection for deterministic offline qualification. */
  makeLead?: typeof modelComplete;
  log: (line: string) => void;
}): Promise<{ done: number; failed: number; skipped: number; stopped?: string }> {
  const { config, outDir, log } = input;
  const env = input.env ?? process.env;
  const recipe = {
    version: 2,
    lead: config.lead,
    maxSections: config.maxSections ?? 8,
    queriesPerSection: config.queriesPerSection ?? 6,
    gapRound: config.gapRound !== false,
    evidenceChars: config.evidenceChars ?? 12000,
    lessons: !!config.lessons,
    retrieval: config.retrievalIdentity ?? "caller-default",
  };
  const recipePath = join(outDir, config.label, "configuration.json");
  if (!existsSync(recipePath) && loadRecords(outDir, config.label).length)
    throw new Error(
      "This label predates configuration checkpoints; use a new run label to preserve its frozen results",
    );
  await new FileResearchCheckpoint(recipePath, recipe).run(
    "configuration",
    recipe,
    async () => true,
  );
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let stopped: string | undefined;
  await pool(input.tasks, input.concurrency, async (task) => {
    if (stopped) return;
    const p = taskPath(outDir, config.label, task.id);
    const previous = existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as TaskRecord)
      : undefined;
    const lessons = config.lessons ? await config.lessons(task) : undefined;
    const identity = { recipe, task, lessons: lessons ?? "" };
    const fingerprint = researchFingerprint(identity);
    if (previous?.configFingerprint && previous.configFingerprint !== fingerprint)
      throw new Error(`Task ${task.id}: configuration changed; use a new run label`);
    if (
      previous?.report &&
      previous.report.status !== "partial" &&
      !previous.report.sections.some((s) => s.failed || s.evidence === 0)
    ) {
      skipped++;
      return;
    }
    const why = input.guard.stopReason();
    if (why) {
      stopped ??= why;
      return;
    }
    const started = Date.now();
    const lead = (input.makeLead ?? modelComplete)(config.lead, env, {
      maxTokens: 16_000,
      timeoutMs: 600_000,
    });
    const rec: TaskRecord = {
      id: task.id,
      board: task.board,
      language: task.language,
      label: config.label,
      lead: config.lead,
      startedAt: new Date(started).toISOString(),
      finishedAt: "",
      latencyMs: 0,
      cost: { leadUsd: 0, checkerUsd: 0, searchUsd: 0, totalUsd: 0 },
      lessons: lessons ? lessons.split("\n").filter(Boolean).length : 0,
      configFingerprint: fingerprint,
    };
    const retriever = input.retriever();
    let searchUsd = 0;
    let metered = 0;
    let prior: Readonly<Record<string, number>> = {};
    const cost = () => ({
      leadUsd: (prior.leadUsd ?? 0) + lead.usage.costUsd,
      searchUsd: (prior.searchUsd ?? 0) + searchUsd,
      retrievalExtraUsd: (prior.retrievalExtraUsd ?? 0) + (retriever.extraUsd?.() ?? 0),
    });
    const checkpoint = new FileResearchCheckpoint(
      join(outDir, config.label, "checkpoints", `${task.id}.json`),
      identity,
      () => {
        const incurred = lead.usage.costUsd + searchUsd + (retriever.extraUsd?.() ?? 0);
        if (incurred > metered) input.guard.record(incurred - metered);
        metered = incurred;
        return cost();
      },
    );
    prior = Object.keys(checkpoint.costs).length
      ? checkpoint.costs
      : {
          leadUsd: previous?.cost.leadUsd ?? 0,
          searchUsd: previous?.cost.searchUsd ?? 0,
          retrievalExtraUsd: previous?.cost.retrievalExtraUsd ?? 0,
        };
    const trackedRetriever: Retriever = async (brief) => {
      const report = await retriever(brief);
      searchUsd += report.costUsd;
      return report;
    };
    try {
      rec.report = await writeResearchReport(
        { prompt: task.prompt, language: task.language, exclude: task.exclude },
        {
          lead: { name: config.lead, complete: lead.complete },
          retriever: trackedRetriever,
          checkpoint,
          stopReason: () => input.guard.stopReason(),
          ...(config.maxSections ? { maxSections: config.maxSections } : {}),
          ...(config.queriesPerSection ? { queriesPerSection: config.queriesPerSection } : {}),
          ...(config.gapRound === false ? { gapRound: false } : {}),
          ...(config.evidenceChars ? { evidenceChars: config.evidenceChars } : {}),
          ...(lessons ? { lessons } : {}),
          log: (line) => log(`  [${task.id}] ${line}`),
        },
      );
      if (rec.report.status === "partial") {
        rec.error = "partial report: one or more sections did not complete";
        failed++;
      } else done++;
    } catch (err) {
      rec.error = getErrorMessage(err).slice(0, 500);
      if (err instanceof ResearchInterrupted) stopped ??= rec.error;
      failed++;
    }
    rec.finishedAt = new Date().toISOString();
    rec.latencyMs = Date.now() - started;
    Object.assign(rec.cost, cost());
    rec.cost.totalUsd = rec.cost.leadUsd + rec.cost.searchUsd + (rec.cost.retrievalExtraUsd ?? 0);
    const summary = retriever.summary?.();
    if (summary) rec.retrieval = summary;
    const remainingCost = lead.usage.costUsd + searchUsd + (retriever.extraUsd?.() ?? 0) - metered;
    if (remainingCost > 0) input.guard.record(remainingCost);
    save(outDir, rec);
    const c = rec.report?.citations;
    log(
      `${task.board} ${task.id} (${task.language}) ${rec.error ? `FAILED: ${rec.error.slice(0, 120)}` : `${rec.report?.markdown.length ?? 0} chars · ${rec.report?.sources.length ?? 0} sources · figure precision ${c?.figurePrecision?.toFixed(2) ?? "-"}`} · $${rec.cost.totalUsd.toFixed(2)} · ${Math.round(rec.latencyMs / 1000)}s`,
    );
  });
  return { done, failed, skipped, ...(stopped ? { stopped } : {}) };
}

/**
 * Apply the cross-model fact pass to every finished report of `from`, writing
 * a new label: the same research and draft, checked by `checker`.
 */
export async function factCheckRun(input: {
  from: string;
  label: string;
  checker: string;
  outDir: string;
  concurrency: number;
  guard: SpendGuard;
  ids?: Set<string>;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
}): Promise<{ done: number; failed: number; skipped: number; stopped?: string }> {
  const env = input.env ?? process.env;
  const sources = loadRecords(input.outDir, input.from).filter(
    (r) => r.report && (!input.ids || input.ids.has(r.id)),
  );
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let stopped: string | undefined;
  await pool(sources, input.concurrency, async (src) => {
    const p = taskPath(input.outDir, input.label, src.id);
    if (existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as TaskRecord).report) {
      skipped++;
      return;
    }
    const why = input.guard.stopReason();
    if (why) {
      stopped ??= why;
      return;
    }
    const started = Date.now();
    const checker = modelComplete(input.checker, env, { maxTokens: 8_000, timeoutMs: 600_000 });
    const rec: TaskRecord = {
      ...src,
      label: input.label,
      from: input.from,
      checker: input.checker,
      startedAt: new Date(started).toISOString(),
    };
    try {
      const checked = await factCheckReport(
        src.report!,
        { name: input.checker, complete: checker.complete },
        { log: (line) => input.log(`  [${src.id}] ${line}`) },
      );
      rec.report = checked.report;
      rec.factPass = checked.audit;
      done++;
    } catch (err) {
      rec.error = (err as Error).message.slice(0, 500);
      delete rec.report;
      failed++;
    }
    rec.finishedAt = new Date().toISOString();
    // Latency and cost add the pass to the draft it was applied to.
    rec.latencyMs = src.latencyMs + (Date.now() - started);
    rec.cost = {
      ...src.cost,
      checkerUsd: checker.usage.costUsd,
      totalUsd: src.cost.totalUsd + checker.usage.costUsd,
    };
    input.guard.record(checker.usage.costUsd);
    save(input.outDir, rec);
    const a = rec.factPass;
    input.log(
      `${src.board} ${src.id} checked: ${a ? `${a.applied}/${a.proposed} edits applied` : `FAILED ${rec.error}`} · figure precision ${src.report?.citations.figurePrecision?.toFixed(2) ?? "-"} → ${rec.report?.citations.figurePrecision?.toFixed(2) ?? "-"} · $${checker.usage.costUsd.toFixed(3)}`,
    );
  });
  return { done, failed, skipped, ...(stopped ? { stopped } : {}) };
}
