// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type PrincipalType = "human" | "agent" | "service" | "system";
export type PrincipalStatus = "active" | "suspended" | "disabled";

export interface PrincipalRow {
  principal_id: string;
  principal_type: PrincipalType;
  display_name: string;
  home_world: string;
  owner_principal_id: string | null;
  lineage_parent_id: string | null;
  status: PrincipalStatus;
  created_at: number;
  disabled_at: number | null;
}

export interface IssuedWorkloadCredential {
  credentialId: string;
  token: string;
  principalId: string;
  expiresAt: number;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function ensurePrincipal(
  db: Database,
  input: {
    type: PrincipalType;
    displayName: string;
    principalId?: string;
    homeWorld?: string;
    ownerPrincipalId?: string | null;
    lineageParentId?: string | null;
  },
): PrincipalRow {
  const homeWorld = input.homeWorld ?? "local";
  const existing = db
    .query(
      "SELECT * FROM principals WHERE principal_type=? AND display_name=? COLLATE NOCASE AND home_world=?",
    )
    .get(input.type, input.displayName, homeWorld) as PrincipalRow | null;
  if (existing) return existing;
  const row: PrincipalRow = {
    principal_id: input.principalId ?? randomUUID(),
    principal_type: input.type,
    display_name: input.displayName,
    home_world: homeWorld,
    owner_principal_id: input.ownerPrincipalId ?? null,
    lineage_parent_id: input.lineageParentId ?? null,
    status: "active",
    created_at: Date.now(),
    disabled_at: null,
  };
  db.run(
    `INSERT INTO principals
     (principal_id,principal_type,display_name,home_world,owner_principal_id,lineage_parent_id,status,created_at,disabled_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      row.principal_id,
      row.principal_type,
      row.display_name,
      row.home_world,
      row.owner_principal_id,
      row.lineage_parent_id,
      row.status,
      row.created_at,
      row.disabled_at,
    ],
  );
  return row;
}

export function getPrincipal(
  reader: Database,
  type: PrincipalType,
  displayName: string,
  homeWorld = "local",
): PrincipalRow | undefined {
  return (
    (reader
      .query(
        "SELECT * FROM principals WHERE principal_type=? AND display_name=? COLLATE NOCASE AND home_world=?",
      )
      .get(type, displayName, homeWorld) as PrincipalRow | null) ?? undefined
  );
}

export function listPrincipals(reader: Database): PrincipalRow[] {
  return reader
    .query("SELECT * FROM principals ORDER BY created_at, principal_id")
    .all() as PrincipalRow[];
}

export function setPrincipalStatus(
  db: Database,
  principalId: string,
  status: PrincipalStatus,
): boolean {
  const result = db.run("UPDATE principals SET status=?, disabled_at=? WHERE principal_id=?", [
    status,
    status === "active" ? null : Date.now(),
    principalId,
  ]);
  return result.changes > 0;
}

export function issueWorkloadCredential(
  db: Database,
  principalId: string,
  ttlMs = 24 * 60 * 60_000,
): IssuedWorkloadCredential {
  const principal = db
    .query("SELECT * FROM principals WHERE principal_id=?")
    .get(principalId) as PrincipalRow | null;
  if (principal?.principal_type !== "agent" || principal.status !== "active") {
    throw new Error("An active agent principal is required to issue a workload credential.");
  }
  const now = Date.now();
  const expiresAt = now + Math.min(Math.max(ttlMs, 60_000), 24 * 60 * 60_000);
  const credentialId = randomUUID();
  const token = `marina-agent-${randomBytes(32).toString("base64url")}`;
  db.run(
    `INSERT INTO principal_credentials
     (credential_id,principal_id,token_hash,audience,scopes,issued_at,expires_at,revoked_at)
     VALUES (?,?,?,?,?,?,?,NULL)`,
    [
      credentialId,
      principalId,
      tokenHash(token),
      "marina:world",
      '["world:connect"]',
      now,
      expiresAt,
    ],
  );
  return { credentialId, token, principalId, expiresAt };
}

export function verifyWorkloadCredential(
  reader: Database,
  token: string,
): PrincipalRow | undefined {
  const row = reader
    .query(
      `SELECT p.* FROM principal_credentials c
       JOIN principals p ON p.principal_id=c.principal_id
       WHERE c.token_hash=? AND c.audience='marina:world' AND c.revoked_at IS NULL
         AND c.expires_at>? AND p.status='active'`,
    )
    .get(tokenHash(token), Date.now()) as PrincipalRow | null;
  return row ?? undefined;
}

export function revokeWorkloadCredential(db: Database, credentialId: string): boolean {
  const result = db.run(
    "UPDATE principal_credentials SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL",
    [Date.now(), credentialId],
  );
  return result.changes > 0;
}
