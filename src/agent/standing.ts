// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing — the one civic-contribution score, earned by VERIFIED work.
 *
 * A credit lands only when someone OTHER than the worker verified the work:
 * a task's approver, a requester adopting a helper's proposal, an external
 * resolution of a filed forecast, a reviewer approving a Code Mode attempt
 * whose checks passed, a replication of an experiment, the engine checking a
 * quest. Recognition (being chronicled) and volume (pool notes, recalls,
 * self-declared crew stages, self-reported helping acts) earn nothing: those
 * kinds are RETIRED — their historical rows stay in the append-only ledger as
 * history, no new row is written (`record` refuses them), and by default they
 * count toward no standing (`MARINA_STANDING_RETIRED=decay` lets them fade
 * out instead).
 *
 * Contributors earn standing (2026-10-20, `standingVerifierRefusal`): for
 * standing, each account is its own party. Self-verification — the same
 * name or the same durable account — is always refused. A person verifying
 * the work of an agent in its own spawn lineage (an owner approving its
 * agent's task) credits the agent. An AGENT verifying work inside its own
 * lineage (a sibling, a child, its owner) is a reviewer's verdict: it credits
 * only when GROUNDED (the attempt's checks ran and passed), else the old
 * lineage-independence rule applies. Safety gates keep the stricter rule:
 * `independentParties` (a person and its lineage are one party) still decides
 * which approvals demonstrate a gate (`approvalDemonstrates`). Credits key on
 * the durable world account (`accountKey`), so people and external agents
 * earn whether or not they are online.
 *
 * Storage: ledger rows in `entity_standing` (one per event, idempotent on
 * `(entity_id, kind, ref)`), rollup in `entity_standing_cache`. Permission
 * checks hit the cache; the ledger is recomputed periodically by the engine
 * tick, on stale read, or on demand.
 *
 * Decay: exponential with a 60-day half-life. Recent contribution dominates;
 * a quarter of effort persists past six months. Floor at 0 — sustained-
 * penalty entities don't go negative; civic exclusion is a separate
 * procedure, not a sub-zero number.
 */

import type { MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";

/**
 * `STANDING_HALF_LIFE_DAYS`: at least 1; unset or non-numeric is the 60-day
 * default (a NaN half-life would turn every decayed standing into NaN).
 */
export function parseStandingHalfLifeDays(raw: string | undefined): number {
  const days = Number.parseFloat(raw ?? "");
  return Number.isFinite(days) ? Math.max(1, days) : 60;
}

/** Half-life in days. Tunable via STANDING_HALF_LIFE_DAYS env var. */
export const STANDING_HALF_LIFE_DAYS = parseStandingHalfLifeDays(
  process.env.STANDING_HALF_LIFE_DAYS,
);

const HALF_LIFE_MS = STANDING_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

/** Events older than this don't contribute to the rollup (still ledgered). */
const ROLLUP_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/** Cache freshness — beyond this, a read triggers a recompute. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Contribution kinds. Each carries a default amount; the credit table at
 * `STANDING_AMOUNTS` is the source of truth. Add new kinds here + in the
 * amounts table together; consumers stay decoupled from the values.
 */
export type StandingKind =
  | "task_complete"
  | "quest_complete"
  | "code_verified"
  | "forecast_resolved"
  | "experiment_complete"
  | "assistance_adopted"
  | "assistance_abstained_confirmed"
  | "assistance_superseded"
  | "crew_member_stalled"
  // Retired (2026-10): readable in history, never credited again.
  | "pool_note"
  | "reflection_recalled"
  | "chronicled"
  | "crew_complete_member"
  | "crew_complete_lead"
  | "crew_stage_completed"
  | "crew_artifact_deposited"
  | "helping_act";

/**
 * Kinds that no longer earn. Each paid for recognition or volume rather than
 * work someone else verified:
 * - `pool_note`, `reflection_recalled`: writing and being read are volume
 *   (and recall owners were `memory:<uuid>` namespaces that never resolved);
 * - `chronicled`: being named by the Chronicler is recognition — it stays in
 *   the chronicle itself;
 * - `crew_*` (completion, stage, artifact): a crew declares its own result;
 *   crew work earns through tasks an independent creator approves;
 * - `helping_act`: completing a canvas intent is self-reported — the intent's
 *   owner never accepts it.
 * Historical rows stay in the append-only ledger; by default they no longer
 * count (`retiredStandingMode`).
 */
export const RETIRED_STANDING_KINDS: ReadonlySet<StandingKind> = new Set<StandingKind>([
  "pool_note",
  "reflection_recalled",
  "chronicled",
  "crew_complete_member",
  "crew_complete_lead",
  "crew_stage_completed",
  "crew_artifact_deposited",
  "helping_act",
]);

/** Largest standing value one task pays (`task create … standing:N`). */
export const TASK_STANDING_MAX = 10;
/** What a task pays when its creator named no value. */
export const TASK_STANDING_DEFAULT = 1;
/** Most `forecast_resolved` credits one account earns per UTC day. */
export const FORECAST_DAILY_CAP = 1;

/**
 * Default amounts per kind. Callers can override via the `amount` arg to
 * `record()` (tasks pass their capped value, forecasts their skill-scaled
 * value). Negatives are penalties — the rollup floors at 0.
 */
export const STANDING_AMOUNTS: Record<StandingKind, number> = {
  // The task's own value, ≤ TASK_STANDING_MAX, paid when the approver may
  // credit the claimant (`standingVerifierRefusal`: another account; an agent
  // approver inside the claimant's lineage has no grounding signal here).
  task_complete: 0,
  // An onboarding quest the ENGINE checked, once per quest. Kept small: it
  // moves a newcomer toward Citizen (rank 1 = 5) without clearing gates.
  quest_complete: 3,
  // A Code Mode attempt whose checks passed, approved by another account —
  // grounded, so an agent reviewer in the worker's lineage may credit it;
  // once per attempt (`src/outcomes/live.ts`).
  code_verified: 1,
  // A filed forecast an external resolver (or a market resolver who may
  // credit the filer) settled, paid by skill: up to 0.5, at most FORECAST_DAILY_CAP a
  // day, never for an evaluation filing (`src/outcomes/forecast.ts`).
  forecast_resolved: 0.5,
  // A controlled comparison another party replicated (samples on ≥ 2 arms,
  // a recorder who may credit the completer under `standingVerifierRefusal`).
  experiment_complete: 3,
  // A requester ADOPTING another party's cited proposal (a person may adopt
  // its own agent's): the credit
  // lands on the HELPER's durable account, ref `assistance:<jobId>`. Delegated
  // trees split it: root worker 0.6, every other distinct answered worker
  // shares 0.4 evenly (`db-memory-adopt.ts:contributionShares`).
  assistance_adopted: 1,
  // An honest abstention the requester later confirms is worth a quarter of
  // an adoption: saying "I don't know" when that is true is a contribution.
  assistance_abstained_confirmed: 0.25,
  // An adopted record later superseded by `resolve` debits the same helpers.
  assistance_superseded: -0.5,
  // Penalty after repeated stalls (CrewManager decides when to fire).
  crew_member_stalled: -3,
  // Retired — see RETIRED_STANDING_KINDS.
  pool_note: 0,
  reflection_recalled: 0,
  chronicled: 0,
  crew_complete_member: 0,
  crew_complete_lead: 0,
  crew_stage_completed: 0,
  crew_artifact_deposited: 0,
  helping_act: 0,
};

/** The kinds that still earn (or debit), for help text and docs. */
export function liveStandingKinds(): StandingKind[] {
  return (Object.keys(STANDING_AMOUNTS) as StandingKind[]).filter(
    (kind) => !RETIRED_STANDING_KINDS.has(kind),
  );
}

/**
 * Idempotent ledger write. Re-recording the same `(entity_id, kind, ref)`
 * is a no-op (UNIQUE index + ON CONFLICT IGNORE). A retired kind is refused
 * (nothing written). Policy — who may be credited — lives with the callers
 * (`recordVerified`, `TaskManager.approveSubmission`); this is the write.
 */
export function record(
  db: MarinaDB,
  entityId: string,
  entityName: string,
  kind: StandingKind,
  ref: string,
  amount?: number,
  taskId?: number,
): void {
  if (RETIRED_STANDING_KINDS.has(kind)) return;
  const finalAmount = amount ?? STANDING_AMOUNTS[kind];
  if (finalAmount === 0) return;
  db.appendStandingEvent({
    entityId,
    entityName,
    kind,
    ref,
    taskId: taskId ?? null,
    amount: finalAmount,
  });
}

// ─── Independence and durable accounts ──────────────────────────────────────

type LineageReader = Pick<MarinaDB, "spawnLineage">;

/**
 * True when `a` and `b` are different parties: not the same name, and
 * neither's spawn lineage meets the other's (a person and the agents it
 * spawned — children, grandchildren, siblings — are one party). Lineage is
 * read from agent configs and agent principals (`spawnLineage`). This is the
 * GATE rule (`approvalDemonstrates`) and the producer rule for forecasts;
 * standing's verifier rule is `standingVerifierRefusal`.
 */
export function independentParties(db: LineageReader, a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return false;
  const lineageA = new Set(db.spawnLineage(a));
  return !db.spawnLineage(b).some((name) => lineageA.has(name));
}

/**
 * The ledger key for a participant: the durable world account (`users.id`)
 * by name, else the live entity id (which the store resolves to its account
 * when one exists). Undefined when neither is known — nothing to credit.
 */
export function accountKey(
  db: Pick<MarinaDB, "durableKeyForName">,
  name: string,
  entityId?: string,
): string | undefined {
  return db.durableKeyForName(name) ?? entityId;
}

type StandingPartyReader = Pick<
  MarinaDB,
  "spawnLineage" | "durableKeyForName" | "durableEntityKey" | "getAgentConfig" | "getPrincipal"
>;

/** An agent account: an agent config or an agent principal (the challenge rule's signal). */
function isAgentAccountName(db: StandingPartyReader, name: string): boolean {
  return !!db.getAgentConfig(name) || !!db.getPrincipal("agent", name);
}

/**
 * The worker and the verifier are the same account: the same name, or the
 * worker's credit target (its account by name, else its live entity id) is
 * the verifier's account — a claim filed under another name from the
 * verifier's own live entity is still self-verification.
 */
function sameAccount(
  db: StandingPartyReader,
  worker: { name: string; entityId?: string },
  verifier: string,
): boolean {
  if (worker.name.toLowerCase() === verifier.toLowerCase()) return true;
  const verifierKey = db.durableKeyForName(verifier);
  if (!verifierKey) return false;
  const workerKey = accountKey(db, worker.name, worker.entityId);
  return !!workerKey && db.durableEntityKey(workerKey) === verifierKey;
}

/**
 * Standing's party rule (2026-10-20: contributors earn standing). Returns why
 * `verifier`'s verdict on `worker`'s work pays no standing, or undefined when
 * it may:
 * - the same account (name or durable account) is self-verification: refused;
 * - a verifier independent of the worker's spawn lineage (`independentParties`)
 *   pays, as before;
 * - a PERSON inside the lineage (the owner deciding on its agent's work) pays;
 * - an AGENT inside the lineage (sibling, child, or the worker's own agent)
 *   is a reviewer's verdict: it pays only when `grounded` (checks that ran
 *   and passed). With no grounding signal the lineage rule still holds.
 * Gates do not use this: demonstrations keep `independentParties`.
 */
export function standingVerifierRefusal(
  db: StandingPartyReader,
  worker: { name: string; entityId?: string },
  verifier: string,
  opts: { grounded?: boolean } = {},
): string | undefined {
  if (!worker.name || !verifier) return "no verifier";
  if (sameAccount(db, worker, verifier))
    return `${verifier} verified its own work (same account); self-verification earns no standing`;
  if (independentParties(db, worker.name, verifier)) return undefined;
  if (!isAgentAccountName(db, verifier)) return undefined;
  if (opts.grounded) return undefined;
  return `${verifier} is an agent in ${worker.name}'s spawn lineage; its verdict earns standing only when grounded (checks that passed) or when a person decides`;
}

export interface VerifiedCredit {
  credited: boolean;
  amount: number;
  /** Why nothing was paid (agent-facing, one line). */
  reason?: string;
}

/**
 * Credit verified work. `verifier` is the party that verified (a name), or
 * `null` when the verification is mechanical or external (an external market
 * resolution, the engine's own check) — callers decide that, and pass a name
 * whenever a person or agent made the call. `grounded` says the verdict rests
 * on a mechanical signal (checks that ran and passed), which lets an agent
 * reviewer in the worker's lineage credit (`standingVerifierRefusal`).
 * Idempotent per (account, kind, ref).
 */
export function recordVerified(
  db: MarinaDB,
  input: {
    kind: StandingKind;
    ref: string;
    worker: { name: string; entityId?: string };
    verifier: string | null;
    grounded?: boolean;
    amount?: number;
    taskId?: number;
  },
): VerifiedCredit {
  const amount = input.amount ?? STANDING_AMOUNTS[input.kind];
  if (RETIRED_STANDING_KINDS.has(input.kind))
    return { credited: false, amount: 0, reason: `${input.kind} no longer earns standing` };
  if (input.verifier !== null) {
    const refusal = standingVerifierRefusal(db, input.worker, input.verifier, {
      grounded: input.grounded,
    });
    if (refusal) return { credited: false, amount: 0, reason: refusal };
  }
  if (amount <= 0) return { credited: false, amount: 0, reason: "no standing value" };
  const key = accountKey(db, input.worker.name, input.worker.entityId);
  if (!key) return { credited: false, amount: 0, reason: `no account for ${input.worker.name}` };
  record(db, key, input.worker.name, input.kind, input.ref, amount, input.taskId);
  return { credited: true, amount };
}

/** The standing a task pays when approved by another party: its value (unset = default), capped. */
export function taskStandingValue(standing: number | null | undefined): number {
  const value = standing ?? TASK_STANDING_DEFAULT;
  return Math.max(0, Math.min(TASK_STANDING_MAX, value));
}

/**
 * How retired-kind rows count (`MARINA_STANDING_RETIRED`, 2026-10-20):
 * - `exclude` (default): they are history only. The rows stay in the
 *   append-only ledger and every readout can show them, but they count
 *   toward no standing, so no decision (rank derivation, gate standing
 *   floors, low-standing review, shared-retrieval weighting, recruiting,
 *   leaderboards) is made on credit that can no longer be earned.
 * - `decay`: the pre-2026-10-20 behaviour — they count and fade by the
 *   normal half-life.
 * On the live world 97 of 106 ledger rows were `chronicled` / `pool_note`,
 * so under `decay` the "verified work" number was mostly recognition.
 */
export type RetiredStandingMode = "exclude" | "decay";

export function retiredStandingMode(env: NodeJS.ProcessEnv = process.env): RetiredStandingMode {
  return env.MARINA_STANDING_RETIRED?.trim().toLowerCase() === "decay" ? "decay" : "exclude";
}

const RETIRED_KIND_LIST: readonly string[] = [...RETIRED_STANDING_KINDS];

/**
 * Compute the decayed standing for an entity from the ledger. Floors at 0.
 * Retired kinds are left out unless `MARINA_STANDING_RETIRED=decay`.
 */
export function computeFromLedger(db: MarinaDB, entityId: string, now = Date.now()): number {
  const raw = db.computeStanding(
    entityId,
    HALF_LIFE_MS,
    ROLLUP_HORIZON_MS,
    now,
    retiredStandingMode() === "exclude" ? { exclude: RETIRED_KIND_LIST } : {},
  );
  return Math.max(0, raw);
}

/**
 * The decayed value of an entity's retired-kind rows (`chronicled`,
 * `pool_note`, …) — history for readouts, whatever the mode. Under the
 * default `exclude` it is NOT part of `getStanding`.
 */
export function retiredStandingOf(db: MarinaDB, entityId: string, now = Date.now()): number {
  return Math.max(
    0,
    db.computeStanding(entityId, HALF_LIFE_MS, ROLLUP_HORIZON_MS, now, {
      only: RETIRED_KIND_LIST,
    }),
  );
}

/**
 * Read the cached standing, recomputing if stale. This is the hot path for
 * permission checks — call this, not `computeFromLedger`, on every gate.
 */
export function getStanding(db: MarinaDB, entityId: string, now = Date.now()): number {
  const cache = db.getStandingCache(entityId);
  if (cache && now - cache.last_recomputed < CACHE_TTL_MS) {
    return cache.standing;
  }
  const fresh = computeFromLedger(db, entityId, now);
  db.setStandingCache(entityId, fresh, now);
  return fresh;
}

/**
 * Periodic engine-tick recompute pass. Refreshes every cache row.
 */
export function recomputeAll(db: MarinaDB, now = Date.now()): number {
  const entityIds = db.listStandingEntities();
  for (const entityId of entityIds) {
    const fresh = computeFromLedger(db, entityId, now);
    db.setStandingCache(entityId, fresh, now);
  }
  return entityIds.length;
}

/** Top-N leaderboard by current standing. Refreshes stale / just-invalidated
 *  cache rows first so a freshly-earned entity isn't shown as 0 (or dropped
 *  below the cutoff) until the hourly recompute pass. */
export function leaderboard(
  db: MarinaDB,
  limit = 10,
  now = Date.now(),
): { entityId: string; standing: number }[] {
  for (const entityId of db.staleStandingEntities(now - CACHE_TTL_MS)) {
    db.setStandingCache(entityId, computeFromLedger(db, entityId, now), now);
  }
  return db.standingLeaderboard(limit);
}

/**
 * The decayed standing of a participant by durable account — the ONE number
 * every readout shows (`standing`, `task standing`, `standing top`, `/who`),
 * online or not.
 */
export function standingOf(db: MarinaDB, name: string, entityId?: string, now = Date.now()) {
  const key = accountKey(db, name, entityId);
  return key ? getStanding(db, key, now) : 0;
}

/** `leaderboard` with a display name per row (the account's, else the ledger's). */
export function namedLeaderboard(
  db: MarinaDB,
  limit = 10,
  now = Date.now(),
): { entityId: string; name: string; standing: number }[] {
  return leaderboard(db, limit, now).map((row) => ({
    ...row,
    name:
      db.getUser(row.entityId)?.name ??
      db.ledgerForEntity(row.entityId, 1)[0]?.entity_name ??
      row.entityId,
  }));
}

/**
 * Wire from `engine.logEvent` — translate engine events into ledger writes.
 * Idempotent and silent on irrelevant events. Only the crew stall penalty is
 * event-driven now: every credit comes from a verified source
 * (`recordVerified`) at the point of verification.
 */
export function recordFromEvent(
  db: MarinaDB,
  event: EngineEvent,
  lookupId: (agentName: string) => string | undefined = () => undefined,
): void {
  switch (event.type) {
    case "crew_member_stalled": {
      // Only record a penalty after repeated offenses — first stalls are
      // signal, not punishment. The CrewManager hook decides when to fire.
      if (event.offenseCount < 3) return;
      const id = accountKey(db, event.agentName, lookupId(event.agentName));
      if (!id) return;
      record(db, id, event.agentName, "crew_member_stalled", `${event.crew}:${event.timestamp}`);
      return;
    }
    default:
      return;
  }
}

/**
 * Per-entity ledger for introspection (e.g. a future `standing show` cmd).
 * Returns recent rows, newest-first within `limit`.
 */
export function ledgerFor(
  db: MarinaDB,
  entityId: string,
  limit = 50,
): {
  kind: StandingKind;
  ref: string;
  amount: number;
  earnedAt: number;
}[] {
  const rows = db.ledgerForEntity(entityId, limit);
  return rows.map((r) => ({
    kind: r.kind as StandingKind,
    ref: r.ref,
    amount: r.amount,
    earnedAt: r.earned_at,
  }));
}
