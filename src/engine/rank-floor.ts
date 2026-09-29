// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one shared rank floor for NON-core operations checked inside a command
 * handler (a subcommand stricter than its command's `minRank`). A capability
 * that has a safety gate checks the gate instead; this is for what has none.
 *
 * Posture-aware, like the router's own floor: the operator's LOCAL instance
 * and the `open` posture pass it (rank is descriptive there); otherwise the
 * refusal raises a challenge (src/engine/challenges.ts) so the creator or an
 * admin at that rank can approve the held command, and an approved re-run
 * passes. The destructive core itself — key management, destructive admin,
 * shell execution, unrestricted exec, live trading — is a safety gate, never a
 * rank floor. A floor that guards a path INTO that core (setting ranks, which
 * grants gates; the shell allowlist) passes `{ core: true }`, so `open` does
 * not lift it.
 */

import type { Entity, EntityRank } from "../types";
import { getAutonomyPosture } from "./autonomy";
import { raiseForCommand } from "./challenges";
import { getCurrentCommand, isRankWaivedForRun } from "./gate-context";
import { getRank, rankName } from "./permissions";
import { isLocalUngated } from "./trust-profile";

/**
 * Returns the refusal text (with the challenge note), or undefined to proceed.
 * `message` is the site's own refusal sentence; it defaults to the router's.
 */
export function rankFloorRefusal(
  entity: Pick<Entity, "id" | "properties">,
  min: number,
  message = `You must be at least ${rankName(min as EntityRank)} (rank ${min}) for this.`,
  opts: {
    /**
     * The floor guards a path INTO the open-posture core (setting ranks,
     * which grants gates; editing the shell allowlist): `open` does not lift
     * it. The local profile still does, and a refusal still raises a challenge.
     */
    core?: boolean;
  } = {},
): string | undefined {
  if (getRank(entity as Entity) >= min) return undefined;
  if (isLocalUngated()) return undefined;
  if (!opts.core && getAutonomyPosture() === "open") return undefined;
  if (isRankWaivedForRun(entity.id, min)) return undefined;
  const command = getCurrentCommand(entity.id);
  if (!command) return message;
  return (
    message +
    raiseForCommand({ requesterId: entity.id, command, reason: `rank ${min}`, minRank: min })
  );
}
