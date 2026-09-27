// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { MemoryError } from "../memory/service-types";
import { createMemorySpace } from "./db-memory-service";
import {
  ensurePrincipal,
  issueMemoryCredential,
  MEMORY_SCOPES,
  type MemoryActor,
} from "./db-principals";

/** Trusted in-process writers still use the repository's credential and space
 * checks. A server namespace without an account gets a distinct system owner;
 * registering a human with that name cannot claim its durable space. */
export function numericMemoryBinding(
  db: Database,
  name: string,
): { actor: MemoryActor; space: string } {
  const user = db
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE name=? COLLATE NOCASE")
    .get(name);
  const principal = user
    ? db
        .query<{ principal_id: string; status: string }, [string]>(
          "SELECT principal_id,status FROM principals WHERE principal_id=?",
        )
        .get(user.id)
    : ensurePrincipal(db, { type: "system", displayName: name, homeWorld: "numeric-memory" });
  if (principal?.status !== "active")
    throw new MemoryError(401, "world_identity_required", "An active memory owner is required");
  // SQLite is authoritative, including after an outer transaction rolls back.
  let credential = db
    .query<
      { credential_id: string },
      [string, number, string]
    >(`SELECT credential_id FROM principal_credentials
    WHERE principal_id=? AND audience='marina:memory' AND revoked_at IS NULL AND expires_at>?
    AND scopes=? ORDER BY expires_at DESC LIMIT 1`)
    .get(principal.principal_id, Date.now() + 60_000, JSON.stringify(MEMORY_SCOPES));
  if (!credential)
    credential = { credential_id: issueMemoryCredential(db, principal.principal_id).credentialId };
  const actor: MemoryActor = {
    principalId: principal.principal_id,
    credentialId: credential.credential_id,
    scopes: [...MEMORY_SCOPES],
  };
  const spaceName = user ? "resident" : "world-notes";
  const existing = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM memory_spaces WHERE owner_id=? AND name=? AND status='active' ORDER BY created_at,id LIMIT 1",
    )
    .get(principal.principal_id, spaceName);
  const space =
    existing?.id ??
    createMemorySpace(db, actor, spaceName, `${spaceName}:${principal.principal_id}`).id;
  return { actor, space };
}
