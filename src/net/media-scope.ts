// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whose media a dashboard caller may list, resolved SERVER-SIDE from the
 * authenticated session — never from names the client sends.
 *
 * - `self`: the caller's own entity name.
 * - `owned`: the caller plus every agent it owns down its spawn lineage
 *   (`spawnDescendants`: agent configs' `spawned_by`, then agent principals'
 *   owners — a person and its agents are one party, as for gate demonstrations).
 * - `chat`: `owned` plus the agents taking part in the caller's current
 *   conversation (the agents in its room). Media of those participants is
 *   still read-checked per viewer: library rows by `mayReadAsset`, jobs by
 *   {@link mayReadMediaJob} (a participant's job only once its result asset
 *   is readable — prompts of work in progress stay with its owner).
 *
 * An operator (the desktop operator credential, a rank-9 person, or a holder
 * of the unattended `admin.destructive` gate) and an unenforced posture
 * (local-ungated, `open`) may list anyone's jobs.
 */

import { principalKind } from "../engine/challenges";
import type { Engine } from "../engine/engine";
import { isOwnershipEnforced, OWNERSHIP_ADMIN_RANK } from "../engine/ownership";
import { getRank } from "../engine/permissions";
import { checkUnattendedGate } from "../engine/safety-gates";
import type { MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";
import { isSentinelPrincipal } from "./auth-middleware";

export type MediaScopeName = "self" | "owned" | "chat";

export interface MediaScope {
  /** The caller's entity name (undefined for a sentinel or a stale session). */
  viewer?: string;
  /** Lower-cased names the caller OWNS (itself and its agents). */
  owned: Set<string>;
  /** Lower-cased names in scope (owned plus, for `chat`, conversation agents). */
  names: string[];
}

/**
 * Whether the caller may read every entity's media jobs. Mirrors the
 * cross-entity read rule of `authorizeEntityRead` (sentinels and the
 * operator gate) plus a rank-9 person, and lifts under an unenforced posture.
 */
export function isMediaOperator(engine: Engine, db: MarinaDB | undefined, callerId: EntityId) {
  if (!isOwnershipEnforced()) return true;
  if (isSentinelPrincipal(callerId)) return true;
  const caller = engine.entities.get(callerId);
  if (caller && getRank(caller) >= OWNERSHIP_ADMIN_RANK && principalKind(caller) === "person")
    return true;
  return !!db && checkUnattendedGate(db, callerId, "admin.destructive").ok;
}

/** The agents in the caller's current room (its conversation), lower-cased, excluding itself. */
export function conversationAgents(engine: Engine, callerId: EntityId): string[] {
  const caller = engine.entities.get(callerId);
  if (!caller?.room) return [];
  const out: string[] = [];
  for (const entity of engine.entities.inRoom(caller.room)) {
    if (entity.id === caller.id) continue;
    if (principalKind(entity) !== "agent") continue;
    out.push(entity.name.toLowerCase());
  }
  return out;
}

/** Resolve a named scope for the authenticated caller. */
export function resolveMediaScope(
  engine: Engine,
  db: MarinaDB | undefined,
  callerId: EntityId,
  scope: MediaScopeName,
): MediaScope {
  const viewer = engine.entities.get(callerId)?.name;
  if (!viewer) return { owned: new Set(), names: [] };
  const self = viewer.toLowerCase();
  const owned = new Set([self]);
  if (scope !== "self" && db) for (const agent of db.spawnDescendants(viewer)) owned.add(agent);
  const names = new Set(owned);
  if (scope === "chat") for (const agent of conversationAgents(engine, callerId)) names.add(agent);
  return { viewer, owned, names: [...names] };
}

/**
 * Whether a caller holding `scope` may see this job: one it (or an agent it
 * owns) requested, or — for a conversation participant's job — only a
 * finished one whose result asset the caller may read.
 */
export function mayReadMediaJob(
  scope: MediaScope,
  job: { entity_name: string; status: string; asset_id: string | null },
  assetReadable: (assetId: string) => boolean,
): boolean {
  if (scope.owned.has(job.entity_name.toLowerCase())) return true;
  return job.status === "succeeded" && !!job.asset_id && assetReadable(job.asset_id);
}
