// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `benchmark compare-run`: a paired comparison of two arms as one command.
 *
 * Each replicate runs both arms at the same time (same items, seed, judge,
 * model and server code), so a provider's bad patch lands on both; replicates
 * run one after another. Every run files into the ledger under its arm's
 * replicate group (`cmp:<id>:<arm>`), so the report is rebuilt from the ledger
 * alone and `benchmark replicates` / `compare` read the same runs.
 *
 * The report gives, per arm: pooled accuracy with a Wilson interval, spend and
 * cost per success, and the model and source revision measured
 * (`model@source`); then the paired two-stage bootstrap of the difference. A
 * comparison whose arms ran different models or code is flagged as unpaired.
 */

import { wilsonInterval } from "../../benchmarks/stats";
import type { BenchmarkRunRow, MarinaDB } from "../persistence/database";
import { comparePooledGroups, type LoadedGroup, loadReplicateGroup } from "./benchmark-replicates";
import { armStack, type BenchmarkRunner } from "./benchmark-runner";
import { getErrorMessage } from "./errors";

/** Replicates per arm unless asked otherwise: one run cannot separate a small effect. */
export const DEFAULT_COMPARE_REPLICATES = 2;
export const MAX_COMPARE_REPLICATES = 10;

export interface CompareRunSpec {
  benchmark: string;
  /** Two distinct arms (`bare`, `on`, `full`, or a member list joined by `,`). */
  arms: [string, string];
  replicates: number;
  /** Spend cap for the whole comparison, USD; each run gets an equal share. */
  capUsd: number;
  limit?: number;
  seed?: number;
  model?: string;
  judgeModel?: string;
  concurrency?: number;
  partition?: "holdout" | "tune";
  owner: string;
}

export interface CompareRunSlot {
  arm: string;
  replicate: number;
  runId?: string;
  error?: string;
}

export interface CompareRunJob {
  id: string;
  spec: CompareRunSpec;
  slots: CompareRunSlot[];
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
}

/**
 * Parse `arms:<a>,<b>`. Inside one arm, members are joined by `+`
 * (`bare,lessons+obligations`). Returns the two arms or an error.
 */
export function parseArms(raw: string | undefined): [string, string] | { error: string } {
  if (!raw) return { error: "arms:<a>,<b> is required (for example arms:bare,on)" };
  const parts = raw
    .split(",")
    .map((a) => a.trim().toLowerCase().replaceAll("+", ","))
    .filter(Boolean);
  if (parts.length !== 2) return { error: "arms: names exactly two arms (arms:bare,on)" };
  const [a, b] = parts as [string, string];
  for (const arm of [a, b]) {
    const s = armStack(arm);
    if ("error" in s) return { error: `arm ${arm}: ${s.error}` };
  }
  if (a === b) return { error: "the two arms are the same" };
  return [a, b];
}

/** The replicate group an arm's runs file under. */
export function compareGroup(jobId: string, arm: string): string {
  return `cmp:${jobId}:${arm.replace(/[^A-Za-z0-9._-]+/g, "+")}`;
}

const jobs = new Map<string, CompareRunJob>();

export function getCompareRun(id: string): CompareRunJob | undefined {
  return jobs.get(id);
}

export function listCompareRuns(): CompareRunJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Test seam. */
export function resetCompareRunsForTests(): void {
  jobs.clear();
}

/**
 * Start a comparison in the background and return its job at once. `onExit`
 * fires once when every run has finished (or the comparison stopped).
 */
export function startCompareRun(
  runner: Pick<BenchmarkRunner, "start" | "done">,
  spec: CompareRunSpec,
  onExit?: (job: CompareRunJob) => void,
  now = Date.now(),
): CompareRunJob {
  const id = `cmp_${now.toString(36)}`;
  const job: CompareRunJob = {
    id,
    spec,
    slots: [],
    status: "running",
    startedAt: now,
  };
  for (let r = 1; r <= spec.replicates; r++)
    for (const arm of spec.arms) job.slots.push({ arm, replicate: r });
  jobs.set(id, job);
  const perRunCap = spec.capUsd / job.slots.length;

  void (async () => {
    for (let r = 1; r <= spec.replicates; r++) {
      const slots = job.slots.filter((s) => s.replicate === r);
      for (const slot of slots) {
        try {
          slot.runId = runner.start({
            benchmark: spec.benchmark,
            ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
            ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
            ...(spec.model ? { model: spec.model } : {}),
            ...(spec.judgeModel ? { judgeModel: spec.judgeModel } : {}),
            ...(spec.concurrency !== undefined ? { concurrency: spec.concurrency } : {}),
            ...(spec.partition ? { partition: spec.partition } : {}),
            agentId: spec.owner,
            arm: slot.arm,
            capUsd: perRunCap,
            replicateGroup: compareGroup(id, slot.arm),
          }).id;
        } catch (err) {
          slot.error = getErrorMessage(err);
        }
      }
      // A run that cannot start (no dataset, a bad option) fails every replicate alike.
      if (slots.every((s) => s.error)) {
        job.status = "failed";
        break;
      }
      await Promise.all(slots.map((s) => (s.runId ? runner.done(s.runId) : undefined)));
    }
    if (job.status === "running") job.status = "completed";
    job.finishedAt = Date.now();
    onExit?.(job);
  })();
  return job;
}

// ─── Report ────────────────────────────────────────────────────────────────

export interface ArmSummary {
  arm: string;
  group: string;
  runs: BenchmarkRunRow[];
  /** Completed (valid) runs with item outcomes. */
  valid: BenchmarkRunRow[];
  attempts: number;
  successes: number;
  accuracy: number;
  wilsonLow: number;
  wilsonHigh: number;
  /** Total spend of the valid runs; null when none was priced. */
  costUsd: number | null;
  costPerSuccessUsd: number | null;
  /** `model@source` of each distinct target among the valid runs. */
  measured: string[];
}

/** `model@source` for one run's target (source = the server's code revision). */
export function modelAtSource(run: BenchmarkRunRow): string {
  try {
    const t = JSON.parse(run.target_json ?? "null") as { model?: unknown; source?: unknown };
    const model = typeof t?.model === "string" ? t.model : "?";
    const source = typeof t?.source === "string" ? t.source : "unknown";
    return `${model}@${source}`;
  } catch {
    return "?@unknown";
  }
}

/** Every run filed under one comparison, oldest first. */
export function compareRunRows(db: MarinaDB, id: string, benchmark?: string): BenchmarkRunRow[] {
  const prefix = `cmp:${id}:`;
  return db
    .queryBenchmarkRuns({ ...(benchmark ? { benchmark } : {}), limit: 500 })
    .filter((r) => r.replicate_group?.startsWith(prefix))
    .sort((a, b) => a.started_at - b.started_at);
}

export function summarizeArm(
  db: MarinaDB,
  arm: string,
  group: string,
  runs: BenchmarkRunRow[],
): ArmSummary {
  const valid = runs.filter((r) => r.status === "completed");
  let attempts = 0;
  let successes = 0;
  let cost = 0;
  let priced = false;
  for (const run of valid) {
    const items = db.getBenchmarkItems(run.id);
    attempts += items.length;
    successes += items.filter((i) => i.correct === 1).length;
    if (typeof run.cost_usd === "number") {
      cost += run.cost_usd;
      priced = true;
    }
  }
  const ci = wilsonInterval(successes, attempts);
  return {
    arm,
    group,
    runs,
    valid,
    attempts,
    successes,
    accuracy: attempts > 0 ? successes / attempts : 0,
    wilsonLow: ci.low,
    wilsonHigh: ci.high,
    costUsd: priced ? cost : null,
    costPerSuccessUsd: priced && successes > 0 ? cost / successes : null,
    measured: [...new Set(valid.map(modelAtSource))],
  };
}

/** Why two arms are not a clean pair (different model, code, items or judge), if they are not. */
export function pairingWarnings(a: ArmSummary, b: ArmSummary): string[] {
  const out: string[] = [];
  const all = [...a.measured, ...b.measured];
  if (new Set(all).size > 1)
    out.push(
      `not paired on model@source: A ran ${a.measured.join(", ")}; B ran ${b.measured.join(", ")}`,
    );
  const slices = new Set([...a.valid, ...b.valid].map((r) => r.slice_hash ?? ""));
  if (slices.size > 1) out.push("the runs answered different item slices");
  const judges = new Set([...a.valid, ...b.valid].map((r) => r.judge ?? ""));
  if (judges.size > 1) out.push("the runs were graded by different judges");
  return out;
}

export interface CompareRunReport {
  id: string;
  benchmark: string | null;
  a: ArmSummary;
  b: ArmSummary;
  warnings: string[];
  /** The paired comparison (A − B), when both arms have a valid run. */
  paired: ReturnType<typeof comparePooledGroups> | null;
}

/** Build a comparison's report from the ledger (arms in the order given, else group order). */
export function compareRunReport(
  db: MarinaDB,
  id: string,
  arms?: readonly [string, string],
): CompareRunReport | null {
  const rows = compareRunRows(db, id);
  if (rows.length === 0 && !arms) return null;
  const groups = arms
    ? arms.map((arm) => compareGroup(id, arm))
    : [...new Set(rows.map((r) => r.replicate_group as string))];
  if (groups.length !== 2) return null;
  const armOf = (g: string) => g.slice(`cmp:${id}:`.length).replaceAll("+", ",");
  const [ga, gb] = groups as [string, string];
  const a = summarizeArm(
    db,
    arms?.[0] ?? armOf(ga),
    ga,
    rows.filter((r) => r.replicate_group === ga),
  );
  const b = summarizeArm(
    db,
    arms?.[1] ?? armOf(gb),
    gb,
    rows.filter((r) => r.replicate_group === gb),
  );
  const load = (s: ArmSummary): LoadedGroup | null =>
    s.valid[0] ? loadReplicateGroup(db, s.valid[0]) : null;
  const la = load(a);
  const lb = load(b);
  const paired =
    la && lb && la.replicates.length > 0 && lb.replicates.length > 0
      ? comparePooledGroups(la, lb)
      : null;
  return {
    id,
    benchmark: rows[0]?.benchmark ?? null,
    a,
    b,
    warnings: pairingWarnings(a, b),
    paired,
  };
}
