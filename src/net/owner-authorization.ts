// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-or-privileged check for HTTP mutations of an owned object (an asset, a
 * media job, a project). Posture-aware like the in-world check
 * (`src/engine/ownership.ts`): on a local-ungated instance or under the `open`
 * posture anyone authenticated may act. Otherwise the caller must own the
 * object (by entity name, or as the creator of the owning agent) or pass
 * {@link authorizePrivileged} (operator credential, sovereign, or the gate).
 *
 * Call it AFTER `refuseOpenApiWrite`, which keeps the dev-open sentinel
 * read-only outside the local profile.
 */

import { raiseForCommand } from "../engine/challenges";
import type { Engine } from "../engine/engine";
import {
  isOwner,
  isOwnershipEnforced,
  mayActOn,
  OWNERSHIP_ADMIN_RANK,
  type OwnershipSubject,
} from "../engine/ownership";
import type { MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";
import { isOperatorPrincipal } from "./auth-middleware";
import { authorizePrivileged } from "./dashboard-api/shared";

export function authorizeOwnerOrPrivileged(
  engine: Engine,
  db: MarinaDB | undefined,
  callerId: EntityId,
  /** Owner entity names (and, optionally, exact owner entity ids). */
  owners: ReadonlyArray<string | null | undefined>,
  ownerIds: ReadonlyArray<string | null | undefined> = [],
  gateId = "admin.destructive",
): Response | null {
  if (!isOwnershipEnforced()) return null;
  const caller = engine.entities.get(callerId);
  if (
    caller &&
    isOwner(caller, {
      owners,
      ownerIds,
      creatorOf: (name) => db?.getAgentConfig(name)?.spawned_by || undefined,
    })
  ) {
    return null;
  }
  return authorizePrivileged(engine, db, callerId, gateId);
}

/**
 * The in-world ownership rule (`ownershipRefusal`) for an HTTP mutation: the
 * owner (by id or name, or the creator of an owning agent), an admin
 * (`OWNERSHIP_ADMIN_RANK`), the desktop operator credential or a holder of
 * the privileged gate may act; under an unenforced posture anyone
 * authenticated may. Returns the refusal text, or undefined to proceed.
 *
 * `heldCommand` is the world command that performs the same change (for
 * example `canvas delete <name>`): when given, a refusal raises the same
 * challenge as the in-world path, so the caller's owner or an operator can
 * approve it and the approved command runs in the caller's slot. Nothing
 * waits — the refusal returns at once with the challenge note.
 */
export function httpOwnershipRefusal(
  engine: Engine,
  db: MarinaDB | undefined,
  callerId: EntityId,
  subject: OwnershipSubject,
  message: string,
  heldCommand?: string,
  gateId = "admin.destructive",
): string | undefined {
  if (!isOwnershipEnforced()) return undefined;
  if (isOperatorPrincipal(callerId)) return undefined;
  const caller = engine.entities.get(callerId);
  if (caller && mayActOn(caller, subject)) return undefined;
  if (!authorizePrivileged(engine, db, callerId, gateId)) return undefined;
  if (!caller || !heldCommand) return message;
  return (
    message +
    raiseForCommand({
      requesterId: callerId,
      command: heldCommand,
      reason: `rank ${OWNERSHIP_ADMIN_RANK}`,
      minRank: OWNERSHIP_ADMIN_RANK,
    })
  );
}
