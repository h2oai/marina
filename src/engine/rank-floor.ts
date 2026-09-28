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
 * passes. Never use it for the destructive core — key management, destructive
 * admin, shell execution, unrestricted exec, live trading keep their own
 * checks in every posture.
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
): string | undefined {
  if (getRank(entity as Entity) >= min) return undefined;
  if (isLocalUngated() || getAutonomyPosture() === "open") return undefined;
  if (isRankWaivedForRun(entity.id, min)) return undefined;
  const command = getCurrentCommand(entity.id);
  if (!command) return message;
  return (
    message +
    raiseForCommand({ requesterId: entity.id, command, reason: `rank ${min}`, minRank: min })
  );
}
