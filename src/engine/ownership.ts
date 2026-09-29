// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Object ownership for in-world mutations (a canvas, an asset, a task's
 * progress): the owner or an admin may act on it.
 *
 * Posture-aware, like the rank floor: on the operator's own instance
 * (`isLocalUngated()`) and under `MARINA_AUTONOMY=open` anyone may act — work
 * gets done however it can. On a shared or public instance a non-owner is
 * refused through {@link rankFloorRefusal} at the admin rank, so the refusal
 * raises a challenge an admin can approve and an approved re-run passes.
 * An agent's creator may act for the agents it spawned.
 */

import type { Entity } from "../types";
import { getAutonomyPosture } from "./autonomy";
import { sanitizeEntityName } from "./entity-name";
import { getRank } from "./permissions";
import { rankFloorRefusal } from "./rank-floor";
import { isLocalUngated } from "./trust-profile";

/** Rank that may act on any object (sovereign). */
export const OWNERSHIP_ADMIN_RANK = 9;

const norm = (name: string) => sanitizeEntityName(name).toLowerCase();

/** False on local-ungated instances and under the `open` posture. */
export function isOwnershipEnforced(): boolean {
  return !isLocalUngated() && getAutonomyPosture() !== "open";
}

export interface OwnershipSubject {
  /** Owner entity NAMES (compared normalized). Empty values are ignored. */
  owners?: ReadonlyArray<string | null | undefined>;
  /** Owner entity IDS (compared exactly — never against names). */
  ownerIds?: ReadonlyArray<string | null | undefined>;
  /** Name of the principal that spawned an owner agent, when known. */
  creatorOf?: (ownerName: string) => string | undefined;
}

/** Whether `entity` owns the subject (by id or name), or created the agent that does. */
export function isOwner(entity: Pick<Entity, "id" | "name">, subject: OwnershipSubject): boolean {
  if (subject.ownerIds?.some((id) => !!id && id === entity.id)) return true;
  const me = norm(entity.name);
  if (!me) return false;
  for (const owner of subject.owners ?? []) {
    if (!owner) continue;
    if (norm(owner) === me) return true;
    const creator = subject.creatorOf?.(owner);
    if (creator && norm(creator) === me) return true;
  }
  return false;
}

/** Owner, admin, or an unenforced posture. No challenge — for read-style decisions. */
export function mayActOn(
  entity: Pick<Entity, "id" | "name" | "properties">,
  subject: OwnershipSubject,
): boolean {
  if (!isOwnershipEnforced()) return true;
  if (getRank(entity as Entity) >= OWNERSHIP_ADMIN_RANK) return true;
  return isOwner(entity, subject);
}

/**
 * Returns the refusal text (with the challenge note), or undefined to proceed.
 */
export function ownershipRefusal(
  entity: Pick<Entity, "id" | "name" | "properties">,
  subject: OwnershipSubject,
  message: string,
): string | undefined {
  if (!isOwnershipEnforced()) return undefined;
  if (isOwner(entity, subject)) return undefined;
  return rankFloorRefusal(entity, OWNERSHIP_ADMIN_RANK, message);
}
