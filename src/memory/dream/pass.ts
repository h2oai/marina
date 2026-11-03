// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dream pass: a harness-run consolidation over ONE agent's own records,
 * run while the agent is idle, on its own cheap budget.
 *
 *   gather → probe-before → propose (one model call) → check →
 *   apply on a dry view → probe-after → record (→ keep, in `on`)
 *
 * `MARINA_DREAMING`:
 *   - `off`: nothing runs, nothing is written.
 *   - `observe` (default): every stage runs — the accepted ops are applied
 *     inside a transaction that is always rolled back, the probes are re-run
 *     on that view, and the op set, rejections and both probe passes are
 *     recorded in `memory_dreams` and announced by one chronicle event. NOTHING
 *     stays applied. This is the measurement floor: what a dream would do, on
 *     every install, before any dream is allowed to do it.
 *   - `on`: auto-tier ops (merge, link, decay) stay applied when every probe
 *     that passed before still passes after; a lost probe rejects the whole
 *     set. Supersedes and skill drafts are filed as proposals for the owner
 *     (`memory dream adopt`). `memory dream rollback <id>` reverses an
 *     applied dream. A POOL dream (`pool:<name>`, `scope.ts`) files EVERY
 *     op for a ratifier (`pool <name> dream ratify`).
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
import { type ApplyResult, applyOps, fileProposals } from "./apply";
import { checkOps, opIds } from "./check";
import { guardTripped } from "./guard";
import { dreamJudgeApplies, recordDreamOpinions } from "./judge";
import { probePlan } from "./probe";
import { proposeOps } from "./propose";
import { gatherRegion } from "./region";
import { poolScopeName, scopeOf } from "./scope";
import type {
  DreamChecks,
  DreamMode,
  DreamOp,
  DreamRegion,
  DreamSummary,
  DreamTrigger,
  StoredDreamOp,
} from "./types";

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

export interface DreamDeps {
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Injectable model (tests); default `roleModel("dreamer")` through `modelComplete`. */
  complete?: Complete;
  model?: string;
}

const textHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/** The op without its text: hashes and lengths in place of what the model wrote. */
function storedOp(op: DreamOp, region: DreamRegion): StoredDreamOp {
  if (op.op === "supersede")
    return {
      op: "supersede",
      id: op.id,
      textHash: textHash(op.text),
      textLength: op.text.length,
      refs: op.refs,
      reason: op.reason,
    };
  if (op.op === "propose-skill") {
    const candidate = region.procedures.find((p) => p.key === op.procedure);
    const text = `${op.name}\n${op.description}`;
    return {
      op: "propose-skill",
      procedure: op.procedure,
      steps: candidate?.steps.length ?? 0,
      tasks: candidate?.tasks ?? [],
      textHash: textHash(text),
      textLength: text.length,
      reason: op.reason,
    };
  }
  return op;
}

/** Filed for an owner or a ratifier (a propose-tier op; every op of a pool dream). */
const isProposal = (op: StoredDreamOp) => op.proposal !== undefined;

/** The agent's last tool call, from the usage ledger (a pool: its last write); undefined when never. */
export function lastActivityAt(db: MarinaDB, entityName: string): number | undefined {
  const scope = scopeOf(db, entityName);
  const raw = db.memoryRepository().raw;
  const row =
    scope?.kind === "pool"
      ? raw
          .query<{ at: number | null }, [string]>(
            "SELECT max(created_at) AS at FROM numeric_notes WHERE pool_id = ?",
          )
          .get(scope.poolId)
      : raw
          .query<{ at: number | null }, [string]>(
            "SELECT max(created_at) AS at FROM primitive_usage WHERE actor_name = ?",
          )
          .get(entityName);
  return row?.at ?? undefined;
}

/** Fact-like records written since `since`: the owner's own, or the pool's. */
export function newRecordsSince(db: MarinaDB, entityName: string, since: number): number {
  const scope = scopeOf(db, entityName);
  const raw = db.memoryRepository().raw;
  const row =
    scope?.kind === "pool"
      ? raw
          .query<{ n: number }, [string, number]>(
            `SELECT count(*) AS n FROM numeric_notes
             WHERE pool_id = ? AND created_at > ?
               AND verification_status != 'superseded' AND tier IN ('fact','reflection','skill')`,
          )
          .get(scope.poolId, since)
      : raw
          .query<{ n: number }, [string, number]>(
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

/** Pools written to in the last day, as dream names (`pool:<name>`); the gates decide per pool. */
export function poolDreamCandidates(db: MarinaDB, now = Date.now()): string[] {
  return db
    .memoryRepository()
    .raw.query<{ pool_id: string }, [number, number]>(
      `SELECT pool_id FROM numeric_notes
       WHERE pool_id IS NOT NULL AND created_at > ?
       GROUP BY pool_id ORDER BY max(created_at) DESC LIMIT ?`,
    )
    .all(now - 24 * HOUR_MS, DREAM_CANDIDATES_PER_RUN)
    .map((r) => db.getMemoryPoolById(r.pool_id)?.name)
    .filter((name): name is string => !!name)
    .map(poolScopeName);
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

  const scope = scopeOf(db, entityName);
  if (!scope) return { ...base, skipped: "no such pool" };
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
  const plan = probePlan(db, region, checked.accepted);
  // The utility-curve guard (guard.ts) holds a tripped agent at observe.
  const guarded = mode === "on" && scope.kind === "entity" && guardTripped(db, entityName);
  const commit = mode === "on" && trigger !== "dry-run" && !guarded;
  // A pool dream never applies: every op is filed for a ratifier (scope.ts).
  const proposeAll = scope.kind === "pool";
  // An earned dreamer (judge.ts, MARINA_DREAM_JUDGE=on) applies restatements
  // at once, or stores skill drafts at once — per op kind.
  const applySupersedes = commit && !proposeAll && dreamJudgeApplies(db, model, "supersede", env);
  const applySkills = commit && !proposeAll && dreamJudgeApplies(db, model, "propose-skill", env);
  let accepted = checked.accepted;
  let stored: StoredDreamOp[] = accepted.map((op) => storedOp(op, region));
  let view: ApplyResult | undefined;
  let id: number | undefined;
  let proposals = 0;
  const spendUsd = usage?.costUsd ?? 0;
  const finish = () => {
    // Apply (or dry-apply) the set and re-run the probes on the result. A set
    // that loses a probe is rejected whole — fail closed — whatever the mode.
    if (accepted.length) {
      view = applyOps(db, entityName, accepted, stored, plan, {
        commit,
        applySupersedes,
        applySkills,
        procedures: region.procedures,
        proposeAll,
      });
      if (view.lost.length) {
        const lost = `probe-after: #${view.lost.join(", #")} no longer retrievable once the set is applied`;
        for (const op of accepted) rejected.push({ op: op.op, ids: opIds(op), reason: lost });
        accepted = [];
        stored = [];
      } else {
        // What the store refused on contact leaves the accepted set with its reason.
        const drop = new Set(view.skipped.map((s) => s.n));
        for (const s of view.skipped) rejected.push(s.rejected);
        accepted = accepted.filter((_, n) => !drop.has(n));
        stored = view.ops.filter((_, n) => !drop.has(n));
      }
    }
    const probes = view?.probes ?? plan.probes;
    const applied = commit && stored.some((o) => o.applied || isProposal(o));
    const checks: DreamChecks = {
      proposed: proposed.ops.length + proposed.rejected.length,
      accepted: accepted.length,
      rejected: rejected.length,
      leaving: accepted.length ? checked.leaving : 0,
      regionSize: region.records.length,
      probesBefore: {
        pass: plan.probes.filter((p) => p.before === "pass").length,
        fail: plan.probes.filter((p) => p.before === "fail").length,
      },
      probesAfter: view?.probesAfter ?? null,
    };
    const summary: DreamSummary = {
      ...base,
      state: trigger === "dry-run" ? "dry-run" : applied ? "applied" : "observed",
      region: {
        records: region.records.length,
        newRecords: region.newRecords,
        bytes: region.bytes,
        hash: region.hash,
      },
      ops: stored,
      rejected,
      probes,
      checks,
      model,
      spendUsd,
    };
    if (trigger === "dry-run") return summary;
    id = db.recordDream({
      entityName,
      trigger,
      mode,
      state: applied ? "applied" : "observed",
      regionHash: region.hash,
      regionCount: region.records.length,
      regionNew: region.newRecords,
      regionBytes: region.bytes,
      ops: stored,
      rejected,
      probes,
      checks,
      model: model ?? null,
      spendUsd,
      createdAt: now,
    });
    if (applied) {
      db.updateDream(id, { appliedAt: now });
      if (view)
        proposals = fileProposals(db, entityName, id, view.proposals, now, region.procedures);
      recordDreamOpinions(db, id, model, stored, now);
    }
    const appliedCount = stored.filter((o) => o.applied).length;
    db.appendChronicle({
      kind: "event",
      source: "memory",
      title: "memory.dream",
      body: applied
        ? scope.kind === "pool"
          ? `${entityName}: ${proposals} op(s) proposed over ${checks.regionSize} shared record(s), ${checks.rejected} rejected; nothing applied until ratified (pool ${scope.name} dream proposals)`
          : `${entityName}: ${appliedCount} op(s) applied over ${checks.regionSize} record(s), ${proposals} proposal(s) filed, ${checks.rejected} rejected, ${checks.leaving} left the active set; memory dream rollback ${id} reverses it`
        : `${entityName}: ${checks.accepted} op(s) proposed over ${checks.regionSize} record(s), ${checks.rejected} rejected, ${checks.leaving} would leave the active set; observed, nothing applied${guarded ? " (guard: dreaming paused for this agent)" : ""}`,
      participants: [entityName],
      refs: [`dream:${id}`],
    });
    return { ...summary, id, proposals };
  };
  // One transaction around apply, record and proposals: a dream is either
  // wholly on disk or not at all. (A dry view rolls its savepoint back inside.)
  return commit ? db.transaction(finish) : finish();
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
  for (const entity of [...dreamCandidates(db, now), ...poolDreamCandidates(db, now)]) {
    const summary = await runDream(db, entity, "schedule", { ...deps, env, now });
    out.push(summary);
    if (summary.skipped?.startsWith("budget:")) break;
  }
  return out;
}
