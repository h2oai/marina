// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-improvement without self-modification. An agent never rewrites the
 * role it is running on; it improves by spawning a successor: create a new
 * role (a pure definition — nothing runs on it yet), then `agent spawn` an
 * iteration bound to it, which the `agent.spawn` gate already fences. What
 * changes live behavior — editing, deleting or reloading an EXISTING role, or
 * deleting a trait roles are built from — takes the `role.edit` gate, because
 * other agents may be running on it.
 */

import type { MarinaDB } from "../persistence/database";
import type { Entity } from "../types";
import { sanitizeEntityName } from "./entity-name";
import { checkGateForExecution, recordGateExecution } from "./safety-gates";

export const ROLE_EDIT_GATE = "role.edit";

type AgentBinding = { name: string; role: string };

/** The role an entity runs on: its live agent binding, else `properties.role`. */
export function boundRoleOf(
  entity: Pick<Entity, "name" | "properties">,
  agents: readonly AgentBinding[] = [],
): string | undefined {
  const me = sanitizeEntityName(entity.name);
  const bound = agents.find((a) => sanitizeEntityName(a.name) === me)?.role;
  const prop = (entity.properties as { role?: unknown } | undefined)?.role;
  return bound || (typeof prop === "string" && prop ? prop : undefined);
}

/** How to improve instead: the refusal always names the successor path. */
export function successorHint(role: string): string {
  return (
    `To improve on it, create a new role (\`role create ${role}-v2 …\`) and spawn an improved ` +
    `iteration bound to it (\`agent spawn <name> role ${role}-v2\`); trial it before anyone adopts it.`
  );
}

/** Refusal text when `roleName` is the role the caller runs on, else undefined. */
export function refuseOwnRole(
  entity: Pick<Entity, "name" | "properties">,
  roleName: string,
  agents: readonly AgentBinding[] = [],
): string | undefined {
  const mine = boundRoleOf(entity, agents);
  if (!mine || mine.toLowerCase() !== roleName.toLowerCase()) return undefined;
  return `You run on role "${mine}" — no one changes the role they are running on. ${successorHint(mine)}`;
}

/**
 * Check the `role.edit` gate for a change to an existing role or trait.
 * Returns a refusal reason, or a `record` callback to call once the change
 * is made (so a witnessed window is consumed only by a change that happened).
 */
export function checkRoleEdit(
  db: MarinaDB,
  entity: Pick<Entity, "id">,
  what: string,
): { reason: string } | { record: () => void } {
  const result = checkGateForExecution(db, entity.id, ROLE_EDIT_GATE);
  if (!result.ok) return { reason: result.reason ?? `${ROLE_EDIT_GATE} refused` };
  return { record: () => recordGateExecution(db, entity.id, ROLE_EDIT_GATE, result, what) };
}
