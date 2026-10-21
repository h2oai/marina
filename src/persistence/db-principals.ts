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

/**
 * Revoke every live world credential of one principal (a supervised
 * resident's relaunch, renewal or stop keeps at most the newest one live).
 * Returns how many were revoked.
 */
export function revokeWorkloadCredentialsFor(db: Database, principalId: string): number {
  return db.run(
    `UPDATE principal_credentials SET revoked_at=?
      WHERE principal_id=? AND audience='marina:world' AND revoked_at IS NULL`,
    [Date.now(), principalId],
  ).changes;
}

/**
 * A supervision credential: a person's own local supervisor holds it for the
 * routing API only (audience `marina:routing`). It is not a world session, so a
 * later login by the same person never replaces it, and it is accepted nowhere
 * outside `/api/routing/` (no world login, no challenge, no command).
 */
export interface SupervisionCredential {
  credentialId: string;
  principal: PrincipalRow;
  expiresAt: number;
}

export function issueSupervisionCredential(
  db: Database,
  principalId: string,
  ttlMs = 24 * 60 * 60_000,
): IssuedWorkloadCredential {
  const principal = db
    .query("SELECT * FROM principals WHERE principal_id=?")
    .get(principalId) as PrincipalRow | null;
  if (principal?.principal_type !== "human" || principal.status !== "active") {
    throw new Error("An active person principal is required to issue a supervision credential.");
  }
  const now = Date.now();
  const expiresAt = now + Math.min(Math.max(ttlMs, 60_000), 24 * 60 * 60_000);
  const credentialId = randomUUID();
  const token = `marina-routing-${randomBytes(32).toString("base64url")}`;
  db.run(
    `INSERT INTO principal_credentials
     (credential_id,principal_id,token_hash,audience,scopes,issued_at,expires_at,revoked_at)
     VALUES (?,?,?,?,?,?,?,NULL)`,
    [
      credentialId,
      principalId,
      tokenHash(token),
      "marina:routing",
      '["routing:supervise"]',
      now,
      expiresAt,
    ],
  );
  return { credentialId, token, principalId, expiresAt };
}

export function verifySupervisionCredential(
  reader: Database,
  token: string,
): SupervisionCredential | undefined {
  if (!token.startsWith("marina-routing-")) return undefined;
  const row = reader
    .query(
      `SELECT p.*, c.credential_id AS credential_id, c.expires_at AS credential_expires_at
       FROM principal_credentials c
       JOIN principals p ON p.principal_id=c.principal_id
       WHERE c.token_hash=? AND c.audience='marina:routing' AND c.revoked_at IS NULL
         AND c.expires_at>? AND p.status='active' AND p.principal_type='human'`,
    )
    .get(tokenHash(token), Date.now()) as
    | (PrincipalRow & { credential_id: string; credential_expires_at: number })
    | null;
  if (!row) return undefined;
  const { credential_id, credential_expires_at, ...principal } = row;
  return { credentialId: credential_id, principal, expiresAt: credential_expires_at };
}

/** Revoke one supervision credential. Returns whether a live one was revoked. */
export function revokeSupervisionCredential(db: Database, credentialId: string): boolean {
  return (
    db.run(
      `UPDATE principal_credentials SET revoked_at=?
        WHERE credential_id=? AND audience='marina:routing' AND revoked_at IS NULL`,
      [Date.now(), credentialId],
    ).changes > 0
  );
}

export const MEMORY_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:share",
  "memory:export",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export interface MemoryActor {
  principalId: string;
  credentialId: string;
  scopes: MemoryScope[];
}

export function issueMemoryCredential(
  db: Database,
  principalId: string,
  scopes: readonly MemoryScope[] = MEMORY_SCOPES,
  ttlMs = 30 * 86_400_000,
) {
  const principal = db
    .query("SELECT * FROM principals WHERE principal_id=? AND status='active'")
    .get(principalId);
  if (
    !principal ||
    !scopes.length ||
    scopes.some((scope) => !MEMORY_SCOPES.includes(scope)) ||
    !Number.isFinite(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > 30 * 86_400_000
  )
    throw new Error("Invalid memory principal, scopes or credential lifetime");
  const credentialId = randomUUID();
  const token = `marina-memory-${randomBytes(32).toString("base64url")}`;
  const expiresAt = Date.now() + ttlMs;
  db.run(
    "INSERT INTO principal_credentials (credential_id,principal_id,token_hash,audience,scopes,issued_at,expires_at) VALUES (?,?,?,?,?,?,?)",
    [
      credentialId,
      principalId,
      tokenHash(token),
      "marina:memory",
      JSON.stringify(scopes),
      Date.now(),
      expiresAt,
    ],
  );
  return { credentialId, token, principalId, expiresAt };
}

export function verifyMemoryCredential(db: Database, token: string): MemoryActor | undefined {
  const row = db
    .query(`SELECT c.credential_id,c.principal_id,c.scopes FROM principal_credentials c
    JOIN principals p ON p.principal_id=c.principal_id WHERE c.token_hash=? AND c.audience='marina:memory'
    AND c.revoked_at IS NULL AND c.expires_at>? AND p.status='active'`)
    .get(tokenHash(token), Date.now()) as {
    credential_id: string;
    principal_id: string;
    scopes: string;
  } | null;
  return row
    ? {
        principalId: row.principal_id,
        credentialId: row.credential_id,
        scopes: JSON.parse(row.scopes),
      }
    : undefined;
}

/**
 * Whether `principalId` is a person for standing purposes (2026-10-20): a
 * `human` principal, or a world account with no principal row whose name is
 * not an agent account (no agent config, no agent principal). A person's
 * verdict credits any OTHER account, its own agents included; an agent's
 * verdict inside its own party does not (`principalParty`).
 */
export function isPersonPrincipal(db: Database, principalId: string): boolean {
  const row = db
    .query("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: PrincipalType } | null;
  if (row) return row.principal_type === "human";
  const user = db.query("SELECT name FROM users WHERE id = ?").get(principalId) as {
    name: string;
  } | null;
  if (!user) return false;
  const agentConfig = db
    .query("SELECT 1 FROM agent_configs WHERE name = ? COLLATE NOCASE LIMIT 1")
    .get(user.name);
  const agentPrincipal = db
    .query(
      "SELECT 1 FROM principals WHERE principal_type = 'agent' AND display_name = ? COLLATE NOCASE LIMIT 1",
    )
    .get(user.name);
  return !agentConfig && !agentPrincipal;
}

/**
 * The party a principal belongs to for standing purposes: its own id and
 * name, its owner / lineage-parent chain, and the spawn lineage of each name
 * (`spawnLineage`). Two principals whose parties intersect are one party.
 * Memory assistance uses it for an AGENT requester: an agent adopting a
 * proposal from inside its own party credits no one (no grounding signal); a
 * person requester credits any other account (`isPersonPrincipal`).
 */
export function principalParty(
  db: Database,
  principalId: string,
  spawnLineage: (name: string) => string[],
): Set<string> {
  const party = new Set<string>([`id:${principalId}`]);
  const row = db.query(
    "SELECT principal_id, display_name, owner_principal_id, lineage_parent_id FROM principals WHERE principal_id = ?",
  );
  let current: string | null = principalId;
  for (let hop = 0; current && hop < 16; hop++) {
    const found = row.get(current) as {
      display_name: string;
      owner_principal_id: string | null;
      lineage_parent_id: string | null;
    } | null;
    if (!found) {
      // A world account with no principal row: its name still has a lineage.
      const user = db.query("SELECT name FROM users WHERE id = ?").get(current) as {
        name: string;
      } | null;
      if (user) for (const name of spawnLineage(user.name)) party.add(`name:${name}`);
      break;
    }
    for (const name of spawnLineage(found.display_name)) party.add(`name:${name}`);
    const next: string | null = found.owner_principal_id ?? found.lineage_parent_id;
    if (!next || party.has(`id:${next}`)) break;
    party.add(`id:${next}`);
    current = next;
  }
  return party;
}
