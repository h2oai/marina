// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bringing a winner home (Phase 4): a role that EARNED its win in a child
 * world (accepted run, held-out trial interval above zero, over the fishing
 * margin — `evolve adoption` in the child) becomes available in the parent
 * only through two people and a gate:
 *
 *   world adopt <child> <role> [into:<existing>]   — records a PENDING request
 *                                                    with the child's evidence
 *   world adopt approve <id>                       — someone OTHER than the
 *                                                    requester applies it
 *   world adopt rollback <id>                      — restores what was there
 *
 * Adopting as a new role only creates. Adopting `into` an existing role
 * changes every agent that runs on it, so it takes `role.edit`, is refused
 * for the role the approver runs on, and saves the previous definition first.
 * Running agents pick the change up only through an explicit `role reload`.
 * Records are an append-only log of notes; the latest entry per id is its state.
 */

import {
  decodeRoleBundle,
  encodeRoleBundle,
  exportRoleBundle,
  importRoleBundle,
  type RoleBundle,
} from "../agent/role-bundle";
import { ADOPTION_MARKER, type AdoptionOffer } from "../engine/commands/evolve";
import { checkRoleEdit, refuseOwnRole } from "../engine/role-guard";
import type { MarinaDB } from "../persistence/database";
import type { Entity } from "../types";

export const ADOPTION_OWNER = "world-adoptions";
const NOTE_TYPE = "adoption";

export interface AdoptionRecord {
  id: number;
  status: "pending" | "applied" | "rejected" | "rolled-back";
  child: string;
  role: string;
  into?: string;
  requestedBy: string;
  offer: AdoptionOffer;
  approvedBy?: string;
  /** Encoded bundle of `into` as it was before the adoption (for rollback). */
  previous?: string;
  note?: string;
  at: number;
}

const tag = (id: number) => `[adoption id=${id}]`;

export function adoptionLog(db: MarinaDB): AdoptionRecord[] {
  const latest = new Map<number, AdoptionRecord>();
  for (const n of db.getNotesByType(ADOPTION_OWNER, NOTE_TYPE, 2_000)) {
    const m = /^\[adoption id=(\d+)\] (.*)$/s.exec(n.content);
    if (!m) continue;
    try {
      const r = JSON.parse(m[2]!) as AdoptionRecord;
      const prior = latest.get(r.id);
      // Notes arrive newest first; an older entry must not win an equal-time tie.
      if (!prior || r.at > prior.at) latest.set(r.id, r);
    } catch {
      // Not an adoption record.
    }
  }
  return [...latest.values()].sort((a, b) => b.id - a.id);
}

function append(db: MarinaDB, record: AdoptionRecord): void {
  db.createNote(ADOPTION_OWNER, `${tag(record.id)} ${JSON.stringify(record)}`, undefined, {
    noteType: NOTE_TYPE,
    tier: "process",
    skipDedup: true,
  });
}

/** Parse the offer line `evolve adoption` prints in the child. */
export function parseAdoptionReply(text: string): AdoptionOffer | { reason: string } {
  const line = text.split("\n").find((l) => l.trim().startsWith(ADOPTION_MARKER));
  if (!line) {
    const why = text.split("\n").find((l) => l.includes("Not adoptable"));
    return { reason: why?.trim() ?? "the child returned no adoption offer" };
  }
  try {
    const offer = JSON.parse(
      Buffer.from(line.trim().slice(ADOPTION_MARKER.length), "base64url").toString("utf8"),
    ) as AdoptionOffer;
    if (offer?.v !== 1 || typeof offer.bundle !== "string") return { reason: "malformed offer" };
    return offer;
  } catch {
    return { reason: "malformed offer" };
  }
}

export function requestAdoption(
  db: MarinaDB,
  input: { child: string; role: string; into?: string; requestedBy: string; offer: AdoptionOffer },
): AdoptionRecord | { reason: string } {
  const bundle = decodeRoleBundle(input.offer.bundle);
  if ("error" in bundle) return { reason: bundle.error };
  if (input.into && !db.getRole(input.into))
    return { reason: `Role "${input.into}" does not exist here.` };
  if (!input.into && db.getRole(bundle.role.name)) {
    return {
      reason: `Role "${bundle.role.name}" already exists here — adopt it into:<role> to replace a definition (gated), or rename in the child.`,
    };
  }
  const id = Math.max(0, ...adoptionLog(db).map((r) => r.id)) + 1;
  const record: AdoptionRecord = {
    id,
    status: "pending",
    child: input.child,
    role: input.role,
    ...(input.into ? { into: input.into } : {}),
    requestedBy: input.requestedBy,
    offer: input.offer,
    at: Date.now(),
  };
  append(db, record);
  return record;
}

type Agents = readonly { name: string; role: string }[];

export function approveAdoption(
  db: MarinaDB,
  id: number,
  approver: Entity,
  agents: Agents,
): AdoptionRecord | { reason: string } {
  const r = adoptionLog(db).find((x) => x.id === id);
  if (!r) return { reason: `No adoption #${id}.` };
  if (r.status !== "pending") return { reason: `Adoption #${id} is ${r.status}.` };
  if (r.requestedBy === approver.name) {
    return {
      reason: "The requester cannot approve their own adoption — someone else must review it.",
    };
  }
  const decoded = decodeRoleBundle(r.offer.bundle);
  if ("error" in decoded) return { reason: decoded.error };
  const bundle: RoleBundle = decoded;
  let previous: string | undefined;
  if (r.into) {
    const own = refuseOwnRole(approver, r.into, agents);
    if (own) return { reason: own };
    const gate = checkRoleEdit(db, approver, `adopt #${id} into ${r.into}`);
    if ("reason" in gate) return { reason: gate.reason };
    const before = exportRoleBundle(db, r.into);
    if (!before) return { reason: `Role "${r.into}" no longer exists here.` };
    // Traits the adopted role needs: create missing ones; a same-named trait
    // with different content would change other roles — refuse.
    for (const t of bundle.traits) {
      const existing = db.getTrait(t.name);
      if (existing && existing.prompt !== t.prompt) {
        return {
          reason: `trait "${t.name}" exists here with different content — adopt as a new role instead`,
        };
      }
    }
    for (const t of bundle.traits) {
      if (!db.getTrait(t.name)) db.saveTrait({ ...t, createdBy: approver.name });
    }
    previous = encodeRoleBundle(before);
    db.saveRole({ ...bundle.role, name: r.into, createdBy: approver.name });
    gate.record();
  } else {
    const result = importRoleBundle(db, bundle, approver.name);
    if (!result.ok) return { reason: result.reason };
  }
  const applied: AdoptionRecord = {
    ...r,
    status: "applied",
    approvedBy: approver.name,
    ...(previous ? { previous } : {}),
    at: Date.now(),
  };
  append(db, applied);
  return applied;
}

export function rejectAdoption(
  db: MarinaDB,
  id: number,
  by: Entity,
  reason: string,
): AdoptionRecord | { reason: string } {
  const r = adoptionLog(db).find((x) => x.id === id);
  if (!r) return { reason: `No adoption #${id}.` };
  if (r.status !== "pending") return { reason: `Adoption #${id} is ${r.status}.` };
  const rejected: AdoptionRecord = {
    ...r,
    status: "rejected",
    note: `${by.name}: ${reason}`.slice(0, 300),
    at: Date.now(),
  };
  append(db, rejected);
  return rejected;
}

export function rollbackAdoption(
  db: MarinaDB,
  id: number,
  by: Entity,
  agents: Agents,
): AdoptionRecord | { reason: string } {
  const r = adoptionLog(db).find((x) => x.id === id);
  if (!r) return { reason: `No adoption #${id}.` };
  if (r.status !== "applied")
    return { reason: `Adoption #${id} is ${r.status}; only an applied adoption rolls back.` };
  const target = r.into ?? decodeRoleBundle(r.offer.bundle);
  const roleName =
    typeof target === "string" ? target : "error" in target ? undefined : target.role.name;
  if (!roleName) return { reason: "cannot tell which role to roll back" };
  const own = refuseOwnRole(by, roleName, agents);
  if (own) return { reason: own };
  const gate = checkRoleEdit(db, by, `rollback adoption #${id}`);
  if ("reason" in gate) return { reason: gate.reason };
  if (r.into && r.previous) {
    const prev = decodeRoleBundle(r.previous);
    if ("error" in prev) return { reason: prev.error };
    db.saveRole({ ...prev.role, createdBy: by.name });
  } else {
    db.deleteRole(roleName);
  }
  gate.record();
  const rolled: AdoptionRecord = {
    ...r,
    status: "rolled-back",
    note: `rolled back by ${by.name}`,
    at: Date.now(),
  };
  append(db, rolled);
  return rolled;
}
