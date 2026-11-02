// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dream pass: a harness-run consolidation over ONE agent's own records,
 * run while the agent is idle, on its own cheap budget.
 *
 *   gather → probe-before → propose (one model call) → check → record
 *
 * `MARINA_DREAMING`:
 *   - `off`: nothing runs, nothing is written.
 *   - `observe` (default): every stage runs; the accepted op set, the
 *     rejected ops with their reasons and the probe set are recorded in
 *     `memory_dreams` and announced by one chronicle event — and NOTHING is
 *     applied. This is the measurement floor: what a dream would do, on
 *     every install, before any dream is allowed to do it.
 *   - `on`: reserved for the apply path (auto-tier ops in one transaction
 *     with rollback, propose-tier ops as adopt jobs). Until it lands, `on`
 *     behaves as `observe` and says so in the dream record's mode.
 *
 * Schedule gates (the `memory-dream` tick job): material (≥ DREAM_MIN_NEW own
 * records since the last dream), quiet (no tool call for DREAM_IDLE_MS),
 * cooldown (≥ DREAM_COOLDOWN_MS since the last dream), budget (the daily cap
 * not reached and under DREAM_WORLD_CAP_SHARE of it spent). `memory dream now`
 * skips material, quiet and cooldown; nothing ever skips budget.
 */

import { createHash } from "node:crypto";
import { roleModel } from "../../config/model-tiers";
import { dailyCapRefusal, dailySpendCapUsd, spentTodayUsd } from "../../engine/spend-ledger";
import { modelComplete } from "../../model/complete";
import type { Complete } from "../../model/reply";
import type { MarinaDB } from "../../persistence/database";
import { checkOps } from "./check";
import { probesBefore } from "./probe";
import { proposeOps } from "./propose";
import { gatherRegion } from "./region";
import type { DreamMode, DreamOp, DreamSummary, DreamTrigger, StoredDreamOp } from "./types";

const HOUR_MS = 60 * 60 * 1000;

export const DREAM_MIN_NEW = 12;
export const DREAM_IDLE_MS = 30 * 60 * 1000;
export const DREAM_COOLDOWN_MS = 8 * HOUR_MS;
/** A dream looks back this far at most when there is no earlier dream. */
export const DREAM_FIRST_WINDOW_MS = 7 * 24 * HOUR_MS;
export const DREAM_WORLD_CAP_SHARE = 0.8;
export const DREAM_MODEL_TIMEOUT_MS = 90_000;
export const DREAM_MAX_OUTPUT_TOKENS = 3000;
/** Entities considered per scheduled run. */
export const DREAM_CANDIDATES_PER_RUN = 20;

export function dreamingMode(env: NodeJS.ProcessEnv = process.env): DreamMode {
  const v = env.MARINA_DREAMING?.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "none") return "off";
  if (v === "on" || v === "true" || v === "1") return "on";
  return "observe";
}

/** Whether this build can apply a dream. The apply path is the next phase. */
export const DREAM_APPLY_SUPPORTED = false;

export interface DreamDeps {
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Injectable model (tests); default `roleModel("dreamer")` through `modelComplete`. */
  complete?: Complete;
  model?: string;
}

function storedOp(op: DreamOp): StoredDreamOp {
  if (op.op !== "supersede") return op;
  return {
    op: "supersede",
    id: op.id,
    textHash: createHash("sha256").update(op.text, "utf8").digest("hex").slice(0, 16),
    textLength: op.text.length,
    refs: op.refs,
    reason: op.reason,
  };
}

/** The agent's last tool call, from the usage ledger; undefined when it never acted. */
export function lastActivityAt(db: MarinaDB, entityName: string): number | undefined {
  const row = db
    .memoryRepository()
    .raw.query<{ at: number | null }, [string]>(
      "SELECT max(created_at) AS at FROM primitive_usage WHERE actor_name = ?",
    )
    .get(entityName);
  return row?.at ?? undefined;
}

/** Own fact-like records written since `since`. */
export function newRecordsSince(db: MarinaDB, entityName: string, since: number): number {
  const row = db
    .memoryRepository()
    .raw.query<{ n: number }, [string, number]>(
      `SELECT count(*) AS n FROM numeric_notes
       WHERE entity_name = ? AND pool_id IS NULL AND created_at > ?
         AND verification_status != 'superseded' AND tier IN ('fact','reflection','skill')`,
    )
    .get(entityName, since);
  return row?.n ?? 0;
}

/** Why the schedule would not dream for this entity now, or undefined when it may. */
export function scheduleGate(
  db: MarinaDB,
  entityName: string,
  now = Date.now(),
): string | undefined {
  const last = db.lastDreamAt(entityName);
  if (last !== undefined && now - last < DREAM_COOLDOWN_MS)
    return `cooldown: last dream ${Math.round((now - last) / 60_000)} min ago`;
  const since = last ?? now - DREAM_FIRST_WINDOW_MS;
  const fresh = newRecordsSince(db, entityName, since);
  if (fresh < DREAM_MIN_NEW)
    return `material: ${fresh} new records since the last dream (needs ${DREAM_MIN_NEW})`;
  const active = lastActivityAt(db, entityName);
  if (active !== undefined && now - active < DREAM_IDLE_MS)
    return `quiet: last tool call ${Math.round((now - active) / 60_000)} min ago`;
  return undefined;
}

/** Why no dream may spend now, or undefined. Never skipped by any trigger. */
export function budgetGate(env: NodeJS.ProcessEnv, now = Date.now()): string | undefined {
  const refusal = dailyCapRefusal(env, now);
  if (refusal) return `budget: ${refusal.split(";")[0]!.trim()}`;
  const cap = dailySpendCapUsd(env);
  if (cap !== undefined && cap > 0 && spentTodayUsd(now) > cap * DREAM_WORLD_CAP_SHARE)
    return `budget: over ${Math.round(DREAM_WORLD_CAP_SHARE * 100)}% of the daily cap is spent`;
  return undefined;
}

/**
 * Entities with own records written in the last day — the schedule's
 * candidates (bounded; the gates decide per entity).
 */
export function dreamCandidates(db: MarinaDB, now = Date.now()): string[] {
  return db
    .memoryRepository()
    .raw.query<{ entity_name: string }, [number, number]>(
      `SELECT entity_name FROM numeric_notes
       WHERE pool_id IS NULL AND created_at > ? AND entity_name NOT LIKE '%:%'
       GROUP BY entity_name ORDER BY max(created_at) DESC LIMIT ?`,
    )
    .all(now - 24 * HOUR_MS, DREAM_CANDIDATES_PER_RUN)
    .map((r) => r.entity_name);
}

/**
 * One dream for one entity. `schedule` honours every gate; `command` skips the
 * schedule gates; `dry-run` also records nothing. Returns what happened —
 * including why nothing did.
 */
export async function runDream(
  db: MarinaDB,
  entityName: string,
  trigger: DreamTrigger,
  deps: DreamDeps = {},
): Promise<DreamSummary> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const mode = dreamingMode(env);
  const base: DreamSummary = { entityName, trigger, mode, state: "skipped", createdAt: now };
  if (mode === "off") return { ...base, skipped: "MARINA_DREAMING=off" };
  if (trigger === "schedule") {
    const gate = scheduleGate(db, entityName, now);
    if (gate) return { ...base, skipped: gate };
  }
  const budget = budgetGate(env, now);
  if (budget) return { ...base, skipped: budget };

  const last = db.lastDreamAt(entityName);
  const since = last ?? now - DREAM_FIRST_WINDOW_MS;
  const region = gatherRegion(db, entityName, since, now);
  if (region.records.length === 0) return { ...base, skipped: "no records in the window" };

  let complete = deps.complete;
  let model = deps.model;
  let usage: { costUsd: number } | undefined;
  if (!complete) {
    const choice = roleModel("dreamer", { env });
    model = choice.model;
    try {
      const made = modelComplete(choice.model, env, {
        purpose: "dream",
        timeoutMs: DREAM_MODEL_TIMEOUT_MS,
        maxTokens: DREAM_MAX_OUTPUT_TOKENS,
        trace: { caller: "memory.dream" },
      });
      complete = made.complete;
      usage = made.usage;
    } catch (err) {
      return { ...base, skipped: `no model: ${(err as Error).message}` };
    }
  }

  let proposed: Awaited<ReturnType<typeof proposeOps>>;
  try {
    proposed = await proposeOps(complete, region);
  } catch (err) {
    return { ...base, skipped: `model: ${(err as Error).message}` };
  }
  const checked = checkOps(proposed.ops, region);
  const rejected = [...proposed.rejected, ...checked.rejected];
  const probes = probesBefore(db, region, checked.accepted);
  const checks = {
    proposed: proposed.ops.length + proposed.rejected.length,
    accepted: checked.accepted.length,
    rejected: rejected.length,
    leaving: checked.leaving,
    regionSize: region.records.length,
    probesBefore: {
      pass: probes.filter((p) => p.before === "pass").length,
      fail: probes.filter((p) => p.before === "fail").length,
    },
  };
  const ops = checked.accepted.map(storedOp);
  const summary: DreamSummary = {
    ...base,
    state: trigger === "dry-run" ? "dry-run" : "observed",
    region: {
      records: region.records.length,
      newRecords: region.newRecords,
      bytes: region.bytes,
      hash: region.hash,
    },
    ops,
    rejected,
    probes,
    checks,
    model,
    spendUsd: usage?.costUsd ?? 0,
  };
  if (trigger === "dry-run") return summary;

  // Observe: recorded and announced, applied nowhere. (`on` lands with the apply path.)
  const id = db.recordDream({
    entityName,
    trigger,
    mode,
    state: "observed",
    regionHash: region.hash,
    regionCount: region.records.length,
    regionNew: region.newRecords,
    regionBytes: region.bytes,
    ops,
    rejected,
    probes,
    checks,
    model: model ?? null,
    spendUsd: usage?.costUsd ?? 0,
    createdAt: now,
  });
  db.appendChronicle({
    kind: "event",
    source: "memory",
    title: "memory.dream",
    body: `${entityName}: ${checks.accepted} op(s) proposed over ${checks.regionSize} record(s), ${checks.rejected} rejected, ${checks.leaving} would leave the active set; observed, nothing applied`,
    participants: [entityName],
    refs: [`dream:${id}`],
  });
  return { ...summary, id };
}

/** The scheduled pass: every candidate through its gates, one dream each at most. */
export async function runDreamSchedule(
  db: MarinaDB,
  deps: DreamDeps = {},
): Promise<DreamSummary[]> {
  const env = deps.env ?? process.env;
  if (dreamingMode(env) === "off") return [];
  const now = deps.now ?? Date.now();
  const out: DreamSummary[] = [];
  for (const entity of dreamCandidates(db, now)) {
    const summary = await runDream(db, entity, "schedule", { ...deps, env, now });
    out.push(summary);
    if (summary.skipped?.startsWith("budget:")) break;
  }
  return out;
}
