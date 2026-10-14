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
 * The gate registry below is the source of truth (14 gates). A command opts
 * in by declaring `gate: '<id>'` on its `CommandDef`; the command phase calls
 * `checkGateForExecution()` after the standard `minRank` check and
 * `recordGateExecution()` on a pass. `agent.spawn` and `code.exec` are
 * enforced imperatively inside their commands with the same pair. Under the
 * `local` trust profile (`isLocalUngated()`) every gate auto-passes.
 *
 * APPROVALS ARE THE PROOF (2026-10-14). Two kinds of gate:
 *
 * - Earnable gates: a low standing floor (`minStanding`, reachable through
 *   independently verified work) admits the attempt; a supervised attempt is
 *   held as a challenge (src/engine/challenges.ts) and runs once a person
 *   approves it. An approval from outside the requester's own lineage — an
 *   operator, never the agent's own owner — is one demonstration
 *   (`recordGateExecution`, mode `approved`); `demoThreshold` of them flip
 *   `supervised_only` to 0 and solo use is allowed for as long as standing
 *   stays at or above `minStanding`. Competence is never un-flipped; standing
 *   is the LIVE prerequisite (60-day half-life decay). A flipped holder whose
 *   standing decays below the bar drops back to supervised-only until it
 *   recovers, with no re-demonstration required.
 * - Operator-grant gates (`operatorGrant`, exactly `OPEN_POSTURE_CORE`): no
 *   standing floor, no demonstrations. An operator grants them; an operator
 *   may approve a single held run, which builds nothing.
 *
 * Operator grants (`grant()`, `grantGatesForRank`, `challenge approve …
 * always`) write the `GRANTED_DEMONSTRATIONS` sentinel and are exempt from the
 * standing re-check; `revoke()` is their revocation path. Self-approval is
 * always refused.
 */

import { getStanding } from "../agent/standing";
import type { MarinaDB } from "../persistence/database";
import { isGrantedCompetence } from "../persistence/db-competence";
import { getAutonomyPosture } from "./autonomy";
import { onGateRefused, takeArmedGatePass } from "./gate-context";
import { isLocalUngated } from "./trust-profile";

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
  /**
   * Decayed standing required to attempt the operation (0 for operator-grant
   * gates, which standing never opens).
   */
  minStanding: number;
  /**
   * Approved runs needed to flip supervised_only → 0 (0 for operator-grant
   * gates, which demonstrations never open).
   */
  demoThreshold: number;
  /** What this gate guards, shown in error messages. */
  description: string;
  /**
   * Operator grant only — exactly the open-posture core (`OPEN_POSTURE_CORE`).
   * No standing floor and no demonstrations: an operator grants it
   * (`gate grant`, `challenge approve <token> always`, a world seed or
   * `grantGatesForRank`), and an operator may approve a single held run
   * (`once`), which builds nothing.
   */
  operatorGrant?: true;
}

/**
 * THE FLOORS (2026-10-14, "approvals are the proof"). Standing is earned by
 * independently verified work: an approved task pays its value (default 1,
 * at most 10), a verified Code Mode attempt 1, an experiment 3. With a 60-day
 * half-life, an entity that earns r points a day settles at
 * r × 60 / ln 2 ≈ 86.6 r. The earnable floors sit on that curve:
 *
 * - 3  — `code.exec`: three approved tasks (a first week of real work).
 * - 10 — `agent.spawn`, `role.edit`, `world.lineage`: one verified task
 *   every ~9 days sustained, or one top-value task.
 * - 20 — `agent.run` (acting as another entity): one every ~4 days.
 * - 30 — `decisions.configure`, `adapter.enable`, `connect.manage`,
 *   `gateway.connect` (reaching outside the world or changing what
 *   supervises it): about two verified tasks a week, sustained.
 *
 * The floor only admits the attempt. What makes a gate yours is approvals:
 * each held run a person approves (`challenge approve <token>` — an operator
 * or the requester's owner, see src/engine/challenges.ts) runs it, and an
 * approval from outside the requester's own lineage is one demonstration;
 * `demoThreshold` of them flip the gate to solo use.
 */
/**
 * Whether `standing` meets a gate's floor, read the way `standing` shows it
 * (one decimal). Standing decays continuously, so points earned a moment ago
 * are already a hair below their face value; the floors are counted in whole
 * approved tasks, and three 1-point tasks must meet a floor of 3.
 */
export function meetsStandingFloor(standing: number, floor: number): boolean {
  return Math.round(standing * 10) / 10 >= floor;
}

export const SAFETY_GATES: Record<string, GateDef> = {
  "shell.exec": {
    id: "shell.exec",
    minStanding: 0,
    demoThreshold: 0,
    operatorGrant: true,
    description: "execute shell commands",
  },
  "agent.run": {
    id: "agent.run",
    minStanding: 20,
    demoThreshold: 3,
    description: "execute world commands as another entity",
  },
  "code.exec": {
    id: "code.exec",
    // Running or applying code in a workspace can execute arbitrary processes
    // on the host (e.g. `code run bun test <file>` runs that file's JS), so it
    // is a host-execution capability and must be earned — never available to a
    // freshly-spawned, zero-standing (untrusted) agent. The floor only admits
    // the attempt: a standing-only holder is `supervisedOnly` and is REFUSED
    // unattended execution (`checkUnattendedGate`) — it can never self-certify
    // by running the op N times. Solo use comes from approved runs, an
    // operator grant or a rank promotion (`grantGatesForRank`).
    minStanding: 3,
    demoThreshold: 3,
    description: "run or apply code in a workspace",
  },
  "agent.spawn": {
    id: "agent.spawn",
    // Assembling a team is an organizer-level act that should emerge from
    // contribution, not be reserved for the top tier. The approved first
    // spawns are the real guardrail.
    minStanding: 10,
    demoThreshold: 3,
    description: "spawn new agents",
  },
  "role.edit": {
    id: "role.edit",
    // Changing an EXISTING role or trait changes how every agent running on it
    // behaves (`role edit/delete/reload`, `trait delete`). Creating a new role
    // is not gated: nothing runs on it until `agent spawn` (its own gate)
    // binds an agent to it — that is how an agent improves: by spawning an
    // improved iteration, never by rewriting the role it runs on (refused
    // outright, src/engine/role-guard.ts). The first edits are approved.
    minStanding: 10,
    demoThreshold: 3,
    description: "change an existing role or trait that agents run on",
  },
  "world.lineage": {
    id: "world.lineage",
    // Create, run and adopt from child worlds (`world`, `marina-descend`).
    // This is the self-improvement loop — trials run in a child, winners come
    // home by `world adopt` (which still needs someone else's approval, and
    // `role.edit` to replace an existing role) — not destruction, so it sits
    // beside agent.spawn rather than behind admin.destructive. Each child is
    // its own process with its own daily spend cap
    // (MARINA_CHILD_DAILY_SPEND_CAP_USD); the first launches are approved.
    minStanding: 10,
    demoThreshold: 3,
    description: "create, run and adopt from child worlds",
  },
  "world.code": {
    id: "world.code",
    // Author and hot-reload world room code (`build` code/reload paths). Room
    // code runs inside the engine process behind a static validator, not a
    // process boundary, so it is in the open-posture core: operator grant only.
    minStanding: 0,
    demoThreshold: 0,
    operatorGrant: true,
    description: "author and hot-reload world room code",
  },
  "decisions.configure": {
    id: "decisions.configure",
    // Change the runtime decision settings (src/decisions/settings.ts): the
    // backend, the tool gate, the verifier, engines, calibration and question
    // files — the judgement layer that supervises every agent. People reach it
    // with admin.destructive too; an AGENT reaches it only through this gate:
    // earned (standing + approved runs, never self-approved), granted, or
    // passed by an operator-chosen posture (non-core, so
    // `MARINA_AUTONOMY=open` passes it). Supervision is a default an agent can
    // outgrow by earning trust, never one it can wave away. Environment-locked
    // settings and env-only base URLs / keys stay out of reach regardless.
    minStanding: 30,
    demoThreshold: 2,
    description: "change the decision settings that supervise agents",
  },
  "adapter.enable": {
    id: "adapter.enable",
    minStanding: 30,
    demoThreshold: 2,
    description: "enable platform adapters (Discord, Telegram)",
  },
  "connect.manage": {
    id: "connect.manage",
    minStanding: 30,
    demoThreshold: 2,
    description: "register external MCP/HTTP connectors",
  },
  "gateway.connect": {
    id: "gateway.connect",
    minStanding: 30,
    demoThreshold: 2,
    description: "federate with peer Marinas",
  },
  "key.manage": {
    id: "key.manage",
    minStanding: 0,
    demoThreshold: 0,
    operatorGrant: true,
    description: "manage LLM provider API keys",
  },
  "admin.destructive": {
    id: "admin.destructive",
    minStanding: 0,
    demoThreshold: 0,
    operatorGrant: true,
    description: "perform destructive admin operations",
  },
  "code.exec.unrestricted": {
    id: "code.exec.unrestricted",
    // The highest-blast-radius code capability: running ARBITRARY
    // (non-allowlisted) host commands in a workspace. Operator grant only, and
    // NEVER in RANK_GATES — not even a sovereign gets it from rank; an operator
    // grants it explicitly, and every use is additionally fenced by the
    // exec-approver chain (src/coding/exec-approver.ts).
    minStanding: 0,
    demoThreshold: 0,
    operatorGrant: true,
    description: "run arbitrary (non-allowlisted) host commands in a workspace",
  },
};

/** True for the operator-grant gates (exactly the open-posture core). */
export function isOperatorGrantGate(gateId: string): boolean {
  return SAFETY_GATES[gateId]?.operatorGrant === true;
}

/** The refusal for an operator-grant gate the entity does not hold. */
export function operatorGrantReason(gate: GateDef): string {
  return (
    `Operator grant: ${gate.description} (${gate.id}) is granted by an operator; standing and ` +
    `demonstrations never open it. An operator can approve this one run, or grant it ` +
    `(\`gate grant <name> ${gate.id}\`).`
  );
}

export interface GateCheckResult {
  ok: boolean;
  reason?: string;
  /** True when the entity may attempt the op but needs a supervisor witness. */
  supervisedOnly?: boolean;
  /**
   * True when `supervisedOnly` is the consequence of standing decay on a
   * holder whose competence row is already unsupervised (demonstrated flip):
   * solo use resumes the moment standing recovers, no re-demonstration.
   */
  standingDecayed?: boolean;
}

/**
 * How an unsupervised competence row relates to the live standing bar.
 * - `none`: no row, or the row is still supervised — standing + demos path.
 * - `granted`: operator grant (`GRANTED_DEMONSTRATIONS` sentinel) — exempt
 *   from the standing re-check in every profile. Reason: the two bootstrap
 *   paths that make an instance operable — `grantSovereign` (MARINA_ADMINS /
 *   verified admin email / loopback login) and world-seed operator grants —
 *   produce zero-standing holders by design; re-checking them on a shared or
 *   public instance would lock the operator out of `shell.exec` /
 *   `key.manage` / `admin.destructive` and break the root of the witness
 *   chain. `revoke()` remains the deliberate way to take a grant back.
 * - `demonstrated`: earned flip — must ALSO satisfy `standing >= minStanding`.
 */
type UnsupervisedHolder =
  | { kind: "none" }
  | { kind: "granted" }
  | { kind: "demonstrated"; standing: number; standingOk: boolean };

function unsupervisedHolder(
  db: MarinaDB,
  entityId: string,
  gate: GateDef,
  now: number,
): UnsupervisedHolder {
  const competence = db.getCompetence(entityId, gate.id);
  if (competence?.supervised_only !== 0) return { kind: "none" };
  if (isGrantedCompetence(competence)) return { kind: "granted" };
  // Same cached read (6 h TTL) the supervised path uses — no extra ledger scan.
  const standing = getStanding(db, entityId, now);
  return {
    kind: "demonstrated",
    standing,
    standingOk: meetsStandingFloor(standing, gate.minStanding),
  };
}

function decayedReason(gate: GateDef, standing: number): string {
  return (
    `standing decayed below ${gate.minStanding} (now ${standing.toFixed(1)}) — your ${gate.id} ` +
    `competence is intact; solo use of ${gate.description} resumes when standing recovers, ` +
    `no re-demonstration needed.`
  );
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
 *
 * An unsupervised DEMONSTRATED holder is re-checked against the gate's
 * `minStanding` on every call: below it the result is
 * `{ ok: true, supervisedOnly: true, standingDecayed: true, reason }` — the
 * competence row is left untouched, so recovery is automatic.
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
  // Demonstrated flips pass only while standing still clears the bar.
  const holder = unsupervisedHolder(db, entityId, gate, now);
  if (holder.kind === "granted") return { ok: true };
  if (holder.kind === "demonstrated") {
    if (holder.standingOk) return { ok: true };
    return {
      ok: true,
      supervisedOnly: true,
      standingDecayed: true,
      reason: decayedReason(gate, holder.standing),
    };
  }

  // Operator-grant gates have no standing or demonstration path at all.
  if (gate.operatorGrant) return { ok: false, reason: operatorGrantReason(gate) };

  const standing = getStanding(db, entityId, now);
  if (!meetsStandingFloor(standing, gate.minStanding)) {
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
 * host-execution / agent-spawn call path where no per-command human approver
 * is in the loop.
 *
 * `checkGate` returns `{ ok: true, supervisedOnly: true }` on standing alone.
 * Historically the call sites treated that as "go ahead, then self-record a
 * demonstration" — which let an entity auto-unlock a dangerous gate by simply
 * running the op N times unwatched (self-certification). That is closed here:
 * a `supervisedOnly` result is downgraded to a refusal. An unattended caller
 * proceeds ONLY when it already holds unsupervised competence — an operator
 * grant, a rank promotion (`grantGatesForRank`), or approved runs
 * (`recordApprovedDemonstration`). Never by self-report.
 *
 * Use this (not `checkGate`) at any site that will EXECUTE the dangerous op
 * without a live approver. `checkGate` remains for read-only progress views
 * and the headless exec approver.
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
    if (result.standingDecayed) {
      return { ok: false, standingDecayed: true, reason: `Supervised-only: ${result.reason}` };
    }
    return {
      ok: false,
      reason: `Supervised-only: you have the standing to ${gate?.description ?? "use this capability"}, but an unattended run is not permitted. This capability cannot be self-certified — runs a person approves build it (${gate?.demoThreshold ?? "a few"} unlock solo use), or an operator grants it.`,
    };
  }
  return { ok: true };
}

/** How a gated execution was authorized — recorded so review and audit can
 *  distinguish the paths. */
export type GateExecutionMode =
  | "unattended"
  | "optimistic"
  | "posture-open"
  | "profile-local"
  | "approved";

export interface GateExecutionResult {
  ok: boolean;
  reason?: string;
  mode?: GateExecutionMode;
  /** The approver of an answered challenge (approved mode), when a person. */
  witnessId?: string;
  /** Who answered the challenge that authorized this run (approved mode). */
  approvedBy?: string;
  /**
   * Approved mode: the approval counts as a demonstration toward this gate
   * (decided when the challenge was answered — a person outside the
   * requester's lineage, on an earnable gate).
   */
  demonstrates?: boolean;
  /** Refused because a demonstrated holder's standing decayed below the bar. */
  standingDecayed?: boolean;
}

/**
 * Posture-aware authorization for a site that is about to EXECUTE a gated
 * operation. Outcomes, by autonomy posture (src/engine/autonomy.ts):
 *
 * - unsupervised competence → `unattended` (all postures) — a granted row
 *   always; a demonstrated flip only while standing ≥ `minStanding`. A
 *   decayed holder falls through to the rules below exactly like an entity
 *   that never flipped, and its refusal names the decay (not "not yet").
 * - an answered challenge for THIS run → `approved` (all postures).
 * - the local operator's own instance → `profile-local`.
 * - `open` posture, earnable gate → `posture-open`. Operator-grant gates
 *   (`OPEN_POSTURE_CORE`) fall through even under `open`.
 * - `earned` posture, earnable gate, standing ≥ floor → `optimistic`: run it;
 *   the run lands as a pending demonstration an operator may attest later
 *   (`witness attest`). Operator-grant gates get no optimistic mode.
 * - otherwise → a refusal that names the path forward; inside a command the
 *   refusal raises a challenge (the held run executes once a person approves
 *   it), because a refusal an agent can't act on is a wall, not a gate.
 *
 * Call `recordGateExecution` with the returned result immediately after a
 * passing check.
 */
export function checkGateForExecution(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  now = Date.now(),
): GateExecutionResult {
  const result = evaluateGateForExecution(db, entityId, gateId, now);
  if (result.ok || !result.reason) return result;
  // A refusal inside a command raises a challenge (src/engine/challenges.ts):
  // the owner and operators are asked, the caller is told it will run once
  // approved, and nothing waits — the refusal returns now.
  return { ...result, reason: onGateRefused(entityId, gateId, result.reason) };
}

function evaluateGateForExecution(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  now: number,
): GateExecutionResult {
  const gate = SAFETY_GATES[gateId];
  if (!gate) return { ok: false, reason: `Unknown safety gate: ${gateId}` };

  const holder = unsupervisedHolder(db, entityId, gate, now);
  if (holder.kind === "granted") return { ok: true, mode: "unattended" };
  if (holder.kind === "demonstrated" && holder.standingOk) return { ok: true, mode: "unattended" };

  // An answered challenge: a person approved THIS run.
  const pass = takeArmedGatePass(entityId, gateId);
  if (pass) {
    return {
      ok: true,
      mode: "approved",
      approvedBy: pass.approverName,
      ...(pass.approverId ? { witnessId: pass.approverId } : {}),
      ...(pass.demonstrates ? { demonstrates: true } : {}),
    };
  }

  // LOCAL trust profile: the single operator's own machine, loopback-only
  // (main.ts refuses `local` on any non-loopback bind unless the operator sets
  // MARINA_ALLOW_INSECURE_PUBLIC=true — sign-in alone does not lift that).
  // Every gate — including OPEN_POSTURE_CORE — auto-passes and the
  // caller still records the execution (audit). An admin who wants the gates
  // back on a personal instance sets MARINA_AUTONOMY=guarded explicitly, which
  // makes isLocalUngated() false while local performance defaults stay on.
  if (isLocalUngated()) return { ok: true, mode: "profile-local" };

  // Operator-grant gates: no posture, standing or demonstration opens them.
  if (gate.operatorGrant) return { ok: false, reason: operatorGrantReason(gate) };

  const posture = getAutonomyPosture();
  if (posture === "open") return { ok: true, mode: "posture-open" };

  const standing =
    holder.kind === "demonstrated" ? holder.standing : getStanding(db, entityId, now);
  if (!meetsStandingFloor(standing, gate.minStanding)) {
    if (holder.kind === "demonstrated") {
      return {
        ok: false,
        standingDecayed: true,
        reason: `Not now: ${decayedReason(gate, standing)}`,
      };
    }
    return {
      ok: false,
      reason:
        `Not yet: ${gate.description} needs standing ${gate.minStanding} (you have ${standing.toFixed(1)}); ` +
        `it is earned by independently verified work — approved tasks, verified code, resolved forecasts. ` +
        `A person can still approve this run. \`gate list\` shows every gate's path.`,
    };
  }

  if (posture === "earned") return { ok: true, mode: "optimistic" };

  const have = db.getCompetence(entityId, gateId)?.demonstrations ?? 0;
  return {
    ok: false,
    reason:
      `Approval needed: ${gate.description} runs once a person approves it; ` +
      `${gate.demoThreshold} approved run(s) make it yours to use solo (${Math.min(have, gate.demoThreshold)}/${gate.demoThreshold} so far). ` +
      `An operator can also grant it.`,
  };
}

/**
 * Record the competence consequence of a gated execution that
 * `checkGateForExecution` authorized. An approved run counts as a
 * demonstration when the approval was made to (`demonstrates`); an optimistic
 * run lands as a pending demonstration an operator may attest; unattended,
 * posture-open and profile-local runs record nothing (already earned, or
 * operator-declared).
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
  if (result.mode === "optimistic") {
    db.createWitnessRow({ entityId, gate: gateId, kind: "pending", evidence, now });
    return;
  }
  if (result.mode === "approved" && result.demonstrates && result.witnessId) {
    recordApprovedDemonstration(db, entityId, gateId, result.witnessId, now);
  }
}

/**
 * Record one demonstration because a person approved a supervised run (a
 * challenge answered `once`, or a legacy pending run attested). The caller
 * has already decided the approver may make it count — a person outside the
 * requester's lineage (src/engine/challenges.ts `approvalDemonstrates`). This
 * refuses what no caller may record: an unknown or operator-grant gate, and
 * self-approval. Returns true when a demonstration was recorded.
 */
export function recordApprovedDemonstration(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  approverId: string,
  now = Date.now(),
): boolean {
  const gate = SAFETY_GATES[gateId];
  if (!gate || gate.operatorGrant) return false;
  if (!approverId || approverId === entityId) return false;
  // The same account under another session id is still self-approval.
  if (
    typeof db.durableEntityKey === "function" &&
    db.durableEntityKey(approverId) === db.durableEntityKey(entityId)
  ) {
    return false;
  }
  recordDemonstration(db, entityId, gateId, now);
  return true;
}

/**
 * Record a demonstration. Increments the count; once it crosses the
 * threshold, supervised_only flips to 0. Operator-grant gates have no
 * demonstrations and are never flipped this way.
 */
export function recordDemonstration(
  db: MarinaDB,
  entityId: string,
  gateId: string,
  now = Date.now(),
): void {
  const gate = SAFETY_GATES[gateId];
  if (!gate || gate.operatorGrant) return;
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
  /**
   * unlocked = usable solo; supervised = enough standing, approved runs build
   * it; locked = needs more standing, or (operatorGrant) an operator's grant.
   */
  status: "unlocked" | "supervised" | "locked";
  /** Operator grant only: no standing floor or demonstrations open it. */
  operatorGrant?: true;
  /**
   * The competence row is already unsupervised (demonstrated) but standing has
   * decayed below `minStanding`; `status` is `locked` until it recovers.
   */
  decayed?: boolean;
  standing: number;
  minStanding: number;
  demonstrations: number;
  demoThreshold: number;
}

/**
 * Per-gate advancement view for an entity — the "what's next past rank 4" ladder.
 * Surfaces the otherwise-invisible competence path: how much standing each gate
 * needs and how many approved runs remain. Ordered by reachability (lowest
 * standing requirement first; operator-grant gates last).
 */
export function getGateProgress(db: MarinaDB, entityId: string, now = Date.now()): GateProgress[] {
  const standing = getStanding(db, entityId, now);
  return Object.values(SAFETY_GATES)
    .map((gate): GateProgress => {
      const comp = db.getCompetence(entityId, gate.id);
      const demonstrations = comp?.demonstrations ?? 0;
      const flipped = comp?.supervised_only === 0;
      const decayed =
        flipped && !isGrantedCompetence(comp) && !meetsStandingFloor(standing, gate.minStanding);
      const status: GateProgress["status"] = decayed
        ? "locked"
        : flipped
          ? "unlocked"
          : !gate.operatorGrant && meetsStandingFloor(standing, gate.minStanding)
            ? "supervised"
            : "locked";
      return {
        id: gate.id,
        description: gate.description,
        status,
        ...(gate.operatorGrant ? { operatorGrant: true as const } : {}),
        ...(decayed ? { decayed: true } : {}),
        standing,
        minStanding: gate.minStanding,
        demonstrations,
        demoThreshold: gate.demoThreshold,
      };
    })
    .sort(
      (a, b) =>
        Number(!!a.operatorGrant) - Number(!!b.operatorGrant) || a.minStanding - b.minStanding,
    );
}

/** The next step on one gate, in words — shared by `gate list`, `standing` and `witness`. */
export function gateNextStep(g: GateProgress): string {
  if (g.status === "unlocked") return "yours to use solo";
  if (g.operatorGrant) return "operator grant (an operator may approve a single held run)";
  if (g.decayed) {
    return `standing ${g.standing.toFixed(1)}/${g.minStanding} — competence intact; solo use resumes when standing recovers`;
  }
  if (g.status === "supervised") {
    return `${Math.min(g.demonstrations, g.demoThreshold)}/${g.demoThreshold} approved runs — run it; a person approves the held run`;
  }
  return `standing ${g.standing.toFixed(1)}/${g.minStanding} — earned by verified work; a person can still approve a held run`;
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
  5: ["shell.exec", "agent.spawn", "code.exec", "role.edit", "world.lineage", "world.code"],
  6: ["agent.run"],
  7: ["adapter.enable", "connect.manage", "gateway.connect"],
  8: ["key.manage"],
  9: ["admin.destructive", "decisions.configure"],
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
