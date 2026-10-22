// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may read an entity's private view on the dashboard: its raw command
 * input, its full property bag and its core memory. One rule for the REST
 * entity detail, the live snapshot and the name-scoped memory routes: a
 * privileged reader, the entity itself, or the PERSON who owns it (the first
 * person up its spawn chain — a person and its agents are one party). An
 * agent never gains another agent's private view this way. Everyone else gets
 * the public property allowlist and activity as type, time and the command
 * verb, never arguments. Individual notes keep the memory system's own
 * owner/pool ACL (`memoryObserver().read`); this rule does not widen it.
 */

import { personOwner, principalKind } from "../engine/challenges";
import type { Entity } from "../types";

/** Entity properties any dashboard viewer may read; every other key is private. */
export const PUBLIC_ENTITY_PROPERTIES = ["rank", "role"] as const;

export function publicEntityProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_ENTITY_PROPERTIES) out[key] = properties[key];
  return out;
}

/** The viewer side of the rule (a `memoryObserver` satisfies it). */
export interface EntityViewer {
  privilegedRead: boolean;
  entity?: Entity;
}

/** The person who owns `name` (first person up its spawn chain), if any. */
export function entityOwner(name: string): string | undefined {
  return personOwner({ name });
}

/** Whether `viewer` is a person and `owner` (from `entityOwner`) names it. */
export function isOwningPerson(viewer: Entity | undefined, owner: string | undefined): boolean {
  return (
    !!viewer &&
    !!owner &&
    viewer.name.toLowerCase() === owner.toLowerCase() &&
    principalKind(viewer) === "person"
  );
}

/**
 * Whether `viewer` sees the private view of `target`. `target.owner` is the
 * precomputed `entityOwner(target.name)` (snapshots compute it once per
 * entity, not per viewer).
 */
export function seesEntityPrivate(
  viewer: EntityViewer,
  target: { id: string; owner?: string },
): boolean {
  if (viewer.privilegedRead) return true;
  if ((viewer.entity?.id as string | undefined) === target.id) return true;
  return isOwningPerson(viewer.entity, target.owner);
}

export interface ActivityRow {
  type: string;
  input?: string;
  timestamp: number;
}

/**
 * Activity for a viewer without the private view: the raw input is dropped;
 * `verb` is kept only when the input's first word is a registered command
 * (so free text never leaks through it).
 */
export function publicActivity(
  rows: readonly ActivityRow[],
  commandName: (verb: string) => string | undefined,
): { type: string; timestamp: number; verb?: string }[] {
  return rows.map((row) => {
    const first = row.input?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    const verb = /^[a-z][a-z0-9_-]{0,31}$/.test(first) ? commandName(first) : undefined;
    return { type: row.type, timestamp: row.timestamp, ...(verb ? { verb } : {}) };
  });
}
