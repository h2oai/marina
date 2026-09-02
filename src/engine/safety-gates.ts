// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Safety gates — per-operation competence proofs for dangerous capabilities.
 *
 * Replaces the rank-5..9 ladder for code execution, key management, gateway
 * federation, and similar high-blast-radius operations. A gate is unlocked
 * for an entity once they've accumulated enough supervised demonstrations
 * — a witness-able proof that they can do the thing without breaking it.
 *
 * The gate registry below is the source of truth. A command opts in by
 * declaring `gate: '<id>'` on its `CommandDef`; the engine permission
 * check calls `checkGate()` after the standard `minRank` check.
 *
 * Standing is necessary but not sufficient. Even an agent with 1000
 * standing cannot execute shell commands until they've performed N
 * supervised executions and a witness has confirmed each one. After the
 * threshold flips `supervised_only` to 0, unsupervised use is allowed.
 *
 * Witness rules: a witness must themselves have `supervised_only=0` on
 * the same gate. Per the user's locked-in policy: rank-8+ agents can
 * witness once they've demonstrated. Humans (rank 9 sovereigns) bootstrap
 * the chain. New entities can grow the chain organically.
 */

import { getStanding } from "../agent/standing";
import type { MarinaDB } from "../persistence/database";
import { getAutonomyPosture, OPEN_POSTURE_CORE } from "./autonomy";

/**
 * Canonical gate registry. Each entry is the contract for a dangerous
 * capability: minimum standing to attempt, demonstrations needed before
 * unsupervised use, and the description shown when an attempt is denied.
 *
 * Bootstrap: world seeds explicitly call `grant()` on operator entities
 * for the gates they need. There is no rank-based shortcut; capability is
 * earned (standing + demos) or granted (admin override).
 */
export interface GateDef {
  id: string;
  /** Decayed standing required to even attempt the operation. */
  minStanding: number;
  /** Demonstrations needed to flip supervised_only → 0. */
  demoThreshold: number;
  /** What this gate guards, shown in error messages. */
  description: string;
}

export const SAFETY_GATES: Record<string, GateDef> = {
  "shell.exec": {
    id: "shell.exec",
    minStanding: 100,
    demoThreshold: 3,
    description: "execute shell commands",
  },
  "agent.run": {
    id: "agent.run",
    minStanding: 100,
    demoThreshold: 3,
    description: "execute world commands as another entity",
  },
  "code.exec": {
    id: "code.exec",
    // Running or applying code in a workspace can execute arbitrary processes
    // on the host (e.g. `code run bun test <file>` runs that file's JS), so it
    // is a host-execution capability and must be earned — never available to a
    // freshly-spawned, zero-standing (untrusted) agent.
    //
    // THE BAR (post-hardening): minStanding is only the threshold to *attempt*.
    // A standing-only holder is `supervisedOnly` and is REFUSED unattended
    // execution — it can NEVER be self-certified by running the op N times
    // (see `checkUnattendedGate`). Unsupervised code.exec is earned solely by an
    // operator grant, a rank promotion (`grantGatesForRank`), or an externally
    // witnessed demonstration (`recordWitnessedDemonstration`). This mirrors
    // shell.exec's unfarmable behavior; minStanding stays low so a legitimate
    // grant path is cheap, but standing alone can no longer buy host execution.
    minStanding: 5,
    demoThreshold: 3,
    description: "run or apply code in a workspace",
  },
  "agent.spawn": {
    id: "agent.spawn",
    // Deliberately below the rank-4 (standing 100) ceiling: assembling a
    // team is an organizer-level act that should emerge from contribution,
    // not be reserved for the top tier. The supervised-demo requirement is
    // the real guardrail — first spawns are witnessed before going solo.
    minStanding: 40,
    demoThreshold: 3,
    description: "spawn new agents",
  },
  "adapter.enable": {
    id: "adapter.enable",
    minStanding: 150,
    demoThreshold: 2,
    description: "enable platform adapters (Discord, Telegram)",
  },
  "connect.manage": {
    id: "connect.manage",
    minStanding: 150,
    demoThreshold: 2,
    description: "register external MCP/HTTP connectors",
  },
  "gateway.connect": {
    id: "gateway.connect",
    minStanding: 150,
    demoThreshold: 2,
    description: "federate with peer Marinas",
  },
  "key.manage": {
    id: "key.manage",
    minStanding: 200,
    demoThreshold: 2,
    description: "manage LLM provider API keys",
  },
  "admin.destructive": {
    id: "admin.destructive",
    minStanding: 250,
    demoThreshold: 1,
    description: "perform destructive admin operations",
  },
  "code.exec.unrestricted": {
    id: "code.exec.unrestricted",
    // The highest-blast-radius code capability: running ARBITRARY (non-allowlisted)
    // host commands in a workspace. Deliberately above admin.destructive (250) so
    // it sorts last on the ladder and is never reachable by accident. This gate is
    // NEVER added to RANK_GATES — not even a sovereign gets it from rank; it is
    // earned (standing + demonstrations) or granted explicitly, and every use is
    // additionally fenced by the exec-approver chain (interactive or headless).
    minStanding: 251,
    demoThreshold: 5,
    description: "run arbitrary (non-allowlisted) host commands in a workspace",
  },
};

export interface GateCheckResult {
  ok: boolean;
  reason?: string;
  /** True when the entity may attempt the op but needs a supervisor witness. */
  supervisedOnly?: boolean;
}

/**
 * Check whether an entity may exercise a gated capability. Three outcomes:
 * - `{ ok: true }` — go ahead, no supervision needed
 * - `{ ok: true, supervisedOnly: true }` — go ahead, but the call site
 *   should record a demonstration after success and ideally flag it for
 *   witnessing
 * - `{ ok: false, reason }` — refuse and surface the reason to the caller
 *
 * Operators are bootstrapped via `grant()` from the world seed; there is
 * no rank short-circuit. An entity must either have a competence row
 * (supervised or unsupervised) or earn one through standing + demonstrations.
 */
export function checkGate(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  now = Date.now(),
): GateCheckResult {
  const gate = SAFETY_GATES[gateId];
  if (!gate) {
    return { ok: false, reason: `Unknown safety gate: ${gateId}` };
  }

  // Granted competence rows pass without a standing check — operators
  // seeded with grant() don't need to earn what's already authorized.
  const competence = db.getCompetence(entityId, gateId);
  if (competence?.supervised_only === 0) {
    return { ok: true };
  }

  const standing = getStanding(db, entityId, now);
  if (standing < gate.minStanding) {
    return {
      ok: false,
      reason: `Not enough standing to ${gate.description}: ${standing.toFixed(1)} / ${gate.minStanding} required`,
    };
  }

  // Has standing but no row, or row still supervised-only.
  return { ok: true, supervisedOnly: true };
}

/**
 * Stricter sibling of `checkGate` for UNATTENDED enforcement sites — every
 * host-execution / agent-spawn call path where no co-present witness or
 * per-command human approver is in the loop.
 *
 * `checkGate` returns `{ ok: true, supervisedOnly: true }` on standing alone.
 * Historically the call sites treated that as "go ahead, then self-record a
 * demonstration" — which let an entity auto-unlock a dangerous gate by simply
 * running the op N times unwatched (self-certification). That is closed here:
 * a `supervisedOnly` result is downgraded to a refusal. An unattended caller
 * proceeds ONLY when it already holds unsupervised competence — earned by an
 * operator grant, a rank promotion (`grantGatesForRank`), or an externally
 * attested demonstration (`recordWitnessedDemonstration`). Never by self-report.
 *
 * Use this (not `checkGate`) at any site that will EXECUTE the dangerous op
 * without a live witness/approver. `checkGate` remains for read-only progress
 * views and for sites (e.g. the exec-approver) that mint competence from a
 * genuine per-command human approval.
 */
export function checkUnattendedGate(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  now = Date.now(),
): GateCheckResult {
  const result = checkGate(db, entityId, gateId, now);
  if (!result.ok) return result;
  if (result.supervisedOnly) {
    const gate = SAFETY_GATES[gateId];
    return {
      ok: false,
      reason: `Supervised-only: you have the standing to ${gate?.description ?? "use this capability"}, but an unattended run is not permitted. This capability cannot be self-certified — an operator must grant it (or a qualified witness must attest a supervised demonstration) before you can run it solo.`,
    };
  }
  return { ok: true };
}

/** How a gated execution was authorized — recorded so witness review and
 *  audit can distinguish the paths. */
export type GateExecutionMode = "unattended" | "windowed" | "optimistic" | "posture-open";

export interface GateExecutionResult {
  ok: boolean;
  reason?: string;
  mode?: GateExecutionMode;
  /** The witness whose supervision window authorized this run (windowed mode). */
  witnessId?: string;
}

/**
 * Posture-aware authorization for a site that is about to EXECUTE a gated
 * operation. This is the walkable version of the ladder the gate registry
 * always promised. Outcomes, by autonomy posture (src/engine/autonomy.ts):
 *
 * - unsupervised competence → `unattended` (all postures).
 * - `open` posture, gate outside the destructive core → `posture-open`:
 *   standing is descriptive, the gate auto-passes. Core gates fall through
 *   to normal rules even under `open`.
 * - sufficient standing + a live witness-granted supervision window →
 *   `windowed`: run it; the pre-attesting witness gets the demonstration
 *   credit (all postures — the window IS the guarded path).
 * - sufficient standing, no window, `earned` posture → `optimistic`: run it;
 *   the demonstration is recorded as pending and counts toward the flip only
 *   when a qualified witness attests it afterwards.
 * - otherwise → a refusal whose text names the path forward, because a
 *   refusal an agent can't act on is a wall, not a gate.
 *
 * Call `recordGateExecution` with the returned result immediately after a
 * passing check — attempt-based recording, matching the original "first N
 * attempts are supervised" design (a witnessed failure is still a witnessed
 * attempt, and earned-mode attestation reviews outcomes anyway).
 */
export function checkGateForExecution(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  now = Date.now(),
): GateExecutionResult {
  const gate = SAFETY_GATES[gateId];
  if (!gate) return { ok: false, reason: `Unknown safety gate: ${gateId}` };

  const competence = db.getCompetence(entityId, gateId);
  if (competence?.supervised_only === 0) return { ok: true, mode: "unattended" };

  const posture = getAutonomyPosture();
  if (posture === "open" && !OPEN_POSTURE_CORE.has(gateId)) {
    return { ok: true, mode: "posture-open" };
  }

  const standing = getStanding(db, entityId, now);
  if (standing < gate.minStanding) {
    return {
      ok: false,
      reason:
        `Not yet: ${gate.description} needs standing ${gate.minStanding} (you have ${standing.toFixed(1)}). ` +
        `Standing grows from real contribution — completed tasks, pool deposits, helping acts. ` +
        `Check \`standing\` to see your ledger and every gate's path.`,
    };
  }

  const window = db.getOpenSupervisionWindow(entityId, gateId, now);
  if (window) return { ok: true, mode: "windowed", witnessId: window.witness_id ?? undefined };

  if (posture === "earned") return { ok: true, mode: "optimistic" };

  return {
    ok: false,
    reason:
      `You have the standing to ${gate.description} — what's missing is a witness. ` +
      `Run \`witness request ${gateId}\` to ask a qualified holder to supervise a demonstration; ` +
      `${gate.demoThreshold} attested demonstration(s) unlock solo use. ` +
      `(Operators can also grant it directly, or set MARINA_AUTONOMY=earned to let you practice ahead of review.)`,
  };
}

/**
 * Record the competence consequence of a gated execution that
 * `checkGateForExecution` authorized. Windowed runs consume the supervision
 * window and credit the granting witness; optimistic runs land in the witness
 * ledger as pending attestations; unattended and posture-open runs record
 * nothing (the former is already earned, the latter is operator-declared).
 */
export function recordGateExecution(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  result: GateExecutionResult,
  evidence: string,
  now = Date.now(),
): void {
  if (!result.ok || !SAFETY_GATES[gateId]) return;
  if (result.mode === "windowed") {
    const witnessId = db.consumeSupervisionWindow(entityId, gateId, now);
    if (witnessId) recordWitnessedDemonstration(db, entityId, gateId, witnessId, now);
    return;
  }
  if (result.mode === "optimistic") {
    db.createWitnessRow({ entityId, gate: gateId, kind: "pending", evidence, now });
  }
}

/**
 * Determine whether an entity is qualified to witness a supervised
 * demonstration of a particular gate. They must themselves be unsupervised
 * on the same gate (closing the bootstrapping loop). Sovereigns (rank 9)
 * trivially qualify because grandfathering gave them every gate at
 * unsupervised level.
 */
export function canWitness(db: MarinaDB, witnessId: string, gateId: string): boolean {
  const competence = db.getCompetence(witnessId, gateId);
  return Boolean(competence && competence.supervised_only === 0);
}

/**
 * Record a demonstration ONLY when a qualified, external witness attests it.
 * This is the sole path (besides an operator grant / rank promotion) by which a
 * supervised entity advances toward unsupervised competence — replacing the old
 * self-reported `recordDemonstration` calls at the enforcement sites. The
 * witness must be a different entity that is itself unsupervised on the same
 * gate (`canWitness`); self-witnessing and unqualified witnesses are refused.
 * Returns true when a demonstration was recorded.
 */
export function recordWitnessedDemonstration(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  witnessId: string,
  now = Date.now(),
): boolean {
  if (!SAFETY_GATES[gateId]) return false;
  if (!witnessId || witnessId === entityId) return false;
  if (!canWitness(db, witnessId, gateId)) return false;
  recordDemonstration(db, entityId, gateId, now);
  return true;
}

/**
 * Record a successful demonstration. Called by the gated command on
 * success. Increments the count; once it crosses the threshold,
 * supervised_only flips to 0 and future invocations don't need a witness.
 */
export function recordDemonstration(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  now = Date.now(),
): void {
  const gate = SAFETY_GATES[gateId];
  if (!gate) return;
  db.recordDemonstration(entityId, gateId, gate.demoThreshold, now);
}

/** Admin overrides — used by world seeds and explicit grant/revoke commands. */
export function grant(db: MarinaDB, entityId: string, gateId: string): void {
  if (!SAFETY_GATES[gateId]) return;
  db.grantCompetence(entityId, gateId);
}

export function revoke(db: MarinaDB, entityId: string, gateId: string): void {
  if (!SAFETY_GATES[gateId]) return;
  db.revokeCompetence(entityId, gateId);
}

/** All gate ids — used in tests and admin views. */
export function listGates(): string[] {
  return Object.keys(SAFETY_GATES);
}

export interface GateProgress {
  id: string;
  description: string;
  /** unlocked = usable solo; supervised = enough standing, needs demos; locked = needs more standing. */
  status: "unlocked" | "supervised" | "locked";
  standing: number;
  minStanding: number;
  demonstrations: number;
  demoThreshold: number;
}

/**
 * Per-gate advancement view for an entity — the "what's next past rank 4" ladder.
 * Surfaces the otherwise-invisible competence path: how much standing each gate
 * needs and how many supervised demonstrations remain. Ordered by reachability
 * (lowest standing requirement first).
 */
export function getGateProgress(db: MarinaDB, entityId: string, now = Date.now()): GateProgress[] {
  const standing = getStanding(db, entityId, now);
  return Object.values(SAFETY_GATES)
    .map((gate): GateProgress => {
      const comp = db.getCompetence(entityId, gate.id);
      const demonstrations = comp?.demonstrations ?? 0;
      const status: GateProgress["status"] =
        comp?.supervised_only === 0
          ? "unlocked"
          : standing >= gate.minStanding
            ? "supervised"
            : "locked";
      return {
        id: gate.id,
        description: gate.description,
        status,
        standing,
        minStanding: gate.minStanding,
        demonstrations,
        demoThreshold: gate.demoThreshold,
      };
    })
    .sort((a, b) => a.minStanding - b.minStanding);
}

/**
 * Map rank tier to the gates an entity at that rank conventionally needs.
 * Lower tiers in the table also include all higher-tier gates above them
 * (i.e. an admin gets shell + key + everything below). Used by the two
 * paths that legitimately promote to rank ≥ 5: MARINA_ADMINS bootstrap
 * and the `rank set` command.
 *
 * This is NOT grandfathering — it's an explicit, write-time grant policy
 * triggered when an operator is promoted, mirroring the semantic intent
 * of the historical rank ladder without the runtime short-circuit.
 */
const RANK_GATES: Record<number, string[]> = {
  5: ["shell.exec", "agent.spawn", "code.exec"],
  6: ["agent.run"],
  7: ["adapter.enable", "connect.manage", "gateway.connect"],
  8: ["key.manage"],
  9: ["admin.destructive"],
};

/**
 * Grant every gate that conventionally belongs to `rank` and below.
 * Idempotent — calling repeatedly with the same rank is safe (grant uses
 * INSERT OR REPLACE and only ever moves competence forward).
 */
export function grantGatesForRank(db: MarinaDB, entityId: string, rank: number): void {
  for (const [tierStr, gates] of Object.entries(RANK_GATES)) {
    const tier = Number.parseInt(tierStr, 10);
    if (rank < tier) continue;
    for (const gate of gates) grant(db, entityId, gate);
  }
}
