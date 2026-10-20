// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `gate audit` / `gate reset` — find and undo operator-grant rows that no
 * operator meant to give (2026-10-20).
 *
 * Before #439 (2026-10-13) the `local` profile made EVERY loopback login
 * sovereign, the agents it ran included, and `grantSovereign` writes every
 * safety gate at the `GRANTED_DEMONSTRATIONS` sentinel (999). Until
 * 2026-10-20 a loopback MCP or SDK-agent login still got the same. The live
 * world therefore held 13 gates × 10 accounts at 999 — every resident and
 * helper — so no gate could bite once the profile changed. New logins no
 * longer seed this (auth-coordinator `isAgentLogin`).
 *
 * Existing databases are NOT changed automatically: resetting would change
 * live autonomy the moment a server restarted. Instead:
 *   - `gate audit` lists every sentinel row by holder, flagging agent accounts
 *     (an agent config or agent principal) — read-only;
 *   - `gate reset <entity|agents> [gate|all]` prints what it would revoke
 *     (dry run, the default) and `… apply` revokes it (operator only). Only
 *     sentinel rows are touched — demonstrated competence stays — and each
 *     revoke is an immutable chronicle event, so `gate grant` restores any of
 *     them. A revoked gate starts from the same baseline a new account has.
 */

import type { MarinaDB } from "../persistence/database";
import { SAFETY_GATES } from "./safety-gates";

export interface GrantHolder {
  /** Durable account id (the competence key). */
  accountId: string;
  name: string;
  /** `agent` = agent config or agent principal; `person` otherwise; `unknown` = no account. */
  kind: "agent" | "person" | "unknown";
  /** Stored account rank. */
  rank: number | null;
  gates: string[];
}

export interface GateAudit {
  holders: GrantHolder[];
  /** Sentinel rows held by agent accounts. */
  agentRows: number;
  totalRows: number;
}

function isAgentAccount(db: MarinaDB, name: string): boolean {
  return !!db.getAgentConfig(name) || !!db.getPrincipal("agent", name);
}

/** Every operator-grant (sentinel) competence row, grouped by holder. Read-only. */
export function auditGateGrants(db: MarinaDB): GateAudit {
  const byAccount = new Map<string, GrantHolder>();
  for (const row of db.listGrantedCompetence()) {
    let holder = byAccount.get(row.entity_id);
    if (!holder) {
      const user = db.getUser(row.entity_id);
      const name = user?.name ?? row.entity_id;
      holder = {
        accountId: row.entity_id,
        name,
        kind: !user ? "unknown" : isAgentAccount(db, user.name) ? "agent" : "person",
        rank: user?.rank ?? null,
        gates: [],
      };
      byAccount.set(row.entity_id, holder);
    }
    holder.gates.push(row.gate);
  }
  const holders = [...byAccount.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "agent" ? -1 : 1,
  );
  return {
    holders,
    agentRows: holders.filter((h) => h.kind === "agent").reduce((n, h) => n + h.gates.length, 0),
    totalRows: holders.reduce((n, h) => n + h.gates.length, 0),
  };
}

export interface GateResetPlan {
  target: string;
  gate: string;
  rows: { accountId: string; name: string; gate: string }[];
  error?: string;
}

/**
 * What `gate reset <target> [gate|all]` would revoke. `target` is an account
 * name or `agents` (every agent account holding sentinel rows). Pure read.
 */
export function planGateReset(db: MarinaDB, target: string, gate = "all"): GateResetPlan {
  const plan: GateResetPlan = { target, gate, rows: [] };
  if (gate !== "all" && !SAFETY_GATES[gate]) {
    plan.error = `Unknown gate "${gate}". Gates: ${Object.keys(SAFETY_GATES).join(", ")}`;
    return plan;
  }
  const audit = auditGateGrants(db);
  const wanted = target.toLowerCase();
  const holders =
    wanted === "agents"
      ? audit.holders.filter((h) => h.kind === "agent")
      : audit.holders.filter((h) => h.name.toLowerCase() === wanted);
  if (wanted !== "agents" && holders.length === 0 && !db.getUserByName(target)) {
    plan.error = `No account named "${target}".`;
    return plan;
  }
  for (const holder of holders)
    for (const g of holder.gates)
      if (gate === "all" || g === gate)
        plan.rows.push({ accountId: holder.accountId, name: holder.name, gate: g });
  return plan;
}

/**
 * Revoke a plan's rows (sentinel rows only — re-checked per row, so a gate
 * earned by demonstration since the plan was printed is left alone) and
 * chronicle each one. Returns the rows revoked.
 */
export function applyGateReset(
  db: MarinaDB,
  plan: GateResetPlan,
  actorName: string,
): GateResetPlan["rows"] {
  const granted = new Set(db.listGrantedCompetence().map((r) => `${r.entity_id}\u0000${r.gate}`));
  const done: GateResetPlan["rows"] = [];
  const byHolder = new Map<string, string[]>();
  for (const row of plan.rows) {
    if (!granted.has(`${row.accountId}\u0000${row.gate}`)) continue;
    db.revokeCompetence(row.accountId, row.gate);
    done.push(row);
    byHolder.set(row.name, [...(byHolder.get(row.name) ?? []), row.gate]);
  }
  // One immutable chronicle event per holder: who reset which gates, so any
  // of them can be put back with `gate grant`.
  for (const [name, gates] of byHolder)
    db.appendChronicle({
      kind: "event",
      source: "gate",
      title: `${actorName} reset ${gates.length} operator-grant gate(s) for ${name}: ${gates.join(", ")}`,
      participants: [actorName, name],
      refs: gates.map((g) => `gate:${g}`),
    });
  return done;
}
