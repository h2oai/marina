// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns a canvas, a node on it, or a relationship between its nodes — the
 * ONE definition shared by the in-world `canvas` command and the HTTP canvas
 * API, so both apply the same rule (`src/engine/ownership.ts`).
 */

import type { OwnershipSubject } from "./ownership";

/** The slice of the store an ownership lookup reads. */
export interface CanvasOwnershipStore {
  getAgentConfig(name: string): { spawned_by?: string | null } | undefined;
}

interface CanvasRow {
  scope: string;
  scope_id: string | null;
  creator_name: string;
}

/** An agent's creator may act for the agents it spawned. */
export function agentCreatorOf(
  db: CanvasOwnershipStore,
): (ownerName: string) => string | undefined {
  return (ownerName) => db.getAgentConfig(ownerName)?.spawned_by || undefined;
}

/**
 * Who owns a canvas: an entity-scoped canvas belongs to that entity (whoever
 * lazily created it); every other canvas belongs to its creator. System
 * canvases (creator "system") are admin-only.
 */
export function canvasOwners(db: CanvasOwnershipStore, canvas: CanvasRow): OwnershipSubject {
  return canvas.scope === "entity"
    ? { ownerIds: [canvas.scope_id] }
    : { owners: [canvas.creator_name], creatorOf: agentCreatorOf(db) };
}

/**
 * A node or relationship on a canvas: its author, or the canvas owner, may
 * remove or change it.
 */
export function canvasItemOwners(
  db: CanvasOwnershipStore,
  item: { creator_name: string | null },
  canvas: CanvasRow | undefined,
): OwnershipSubject {
  const canvasSubject = canvas ? canvasOwners(db, canvas) : undefined;
  return {
    owners: [item.creator_name, ...(canvasSubject?.owners ?? [])],
    ownerIds: canvasSubject?.ownerIds ?? [],
    creatorOf: agentCreatorOf(db),
  };
}
