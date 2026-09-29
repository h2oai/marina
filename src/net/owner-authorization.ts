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

import type { Engine } from "../engine/engine";
import { isOwner, isOwnershipEnforced } from "../engine/ownership";
import type { MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";
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
