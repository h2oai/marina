// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import * as principalsDb from "./db-principals";

// ─── Users, bans, adapter links ────────────────────────────────────────────

export function createUser(db: Database, user: { id: string; name: string; rank?: number }): void {
  const now = Date.now();
  db.run("INSERT INTO users (id, name, created_at, last_login, rank) VALUES (?, ?, ?, ?, ?)", [
    user.id,
    user.name,
    now,
    now,
    user.rank ?? 0,
  ]);
  principalsDb.ensurePrincipal(db, {
    type: "human",
    displayName: user.name,
    principalId: user.id,
  });
}

export function getUser(db: Database, id: string): UserRow | undefined {
  return (db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null) ?? undefined;
}

export function getUserByName(db: Database, name: string): UserRow | undefined {
  return (db.query("SELECT * FROM users WHERE name = ?").get(name) as UserRow | null) ?? undefined;
}

/** All user rows, name-ordered. For maintenance/admin tooling. */
export function listUsers(db: Database): UserRow[] {
  return db.query("SELECT * FROM users ORDER BY name").all() as UserRow[];
}

export function updateUserLastLogin(db: Database, id: string): void {
  db.run("UPDATE users SET last_login = ? WHERE id = ?", [Date.now(), id]);
}

export function updateUserRank(db: Database, id: string, rank: number): void {
  db.run("UPDATE users SET rank = ? WHERE id = ?", [rank, id]);
}

/** Look up the named user bound to a verified external-identity subject. */
export function getUserByAuthSubject(db: Database, subject: string): UserRow | undefined {
  return (
    (db.query("SELECT * FROM users WHERE auth_subject = ?").get(subject) as UserRow | null) ??
    undefined
  );
}

/** Bind a verified identity (subject + email) to an existing named user. */
export function bindAuthSubject(db: Database, id: string, subject: string, email: string): void {
  db.run("UPDATE users SET auth_subject = ?, auth_email = ? WHERE id = ?", [subject, email, id]);
}

export function updateUserProperties(
  db: Database,
  id: string,
  properties: Record<string, unknown>,
): void {
  db.run("UPDATE users SET properties = ? WHERE id = ?", [JSON.stringify(properties), id]);
}

export function deleteUser(db: Database, id: string): void {
  // The reputation ledgers are keyed by this durable id (migration 109) and
  // would otherwise survive as orphans nothing can resolve. Standing is
  // derivable and the account is gone, so cascade in the same transaction.
  db.transaction(() => {
    db.run("DELETE FROM entity_standing WHERE entity_id = ?", [id]);
    db.run("DELETE FROM entity_standing_cache WHERE entity_id = ?", [id]);
    db.run("DELETE FROM entity_competence WHERE entity_id = ?", [id]);
    db.run("DELETE FROM witness_attestations WHERE entity_id = ?", [id]);
    db.run("DELETE FROM users WHERE id = ?", [id]);
  })();
}

export function addBan(db: Database, name: string, bannedBy: string, reason = ""): void {
  db.run("INSERT OR REPLACE INTO bans (name, reason, banned_by, created_at) VALUES (?, ?, ?, ?)", [
    name.toLowerCase(),
    reason,
    bannedBy,
    Date.now(),
  ]);
}

export function removeBan(db: Database, name: string): boolean {
  const result = db.run("DELETE FROM bans WHERE name = ?", [name.toLowerCase()]);
  return result.changes > 0;
}

export function isBanned(db: Database, name: string): boolean {
  const row = db.query("SELECT 1 FROM bans WHERE name = ?").get(name.toLowerCase());
  return row !== null;
}

export function getBan(db: Database, name: string): BanRow | undefined {
  return (
    (db.query("SELECT * FROM bans WHERE name = ?").get(name.toLowerCase()) as BanRow | null) ??
    undefined
  );
}

export function listBans(db: Database): BanRow[] {
  return db.query("SELECT * FROM bans ORDER BY created_at DESC").all() as BanRow[];
}

export function linkAdapter(
  db: Database,
  adapter: string,
  externalId: string,
  userId: string,
): void {
  db.run(
    "INSERT OR REPLACE INTO adapter_links (adapter, external_id, user_id, created_at) VALUES (?, ?, ?, ?)",
    [adapter, externalId, userId, Date.now()],
  );
}

export function getLinkedUser(
  db: Database,
  adapter: string,
  externalId: string,
): AdapterLinkRow | undefined {
  return (
    (db
      .query("SELECT * FROM adapter_links WHERE adapter = ? AND external_id = ?")
      .get(adapter, externalId) as AdapterLinkRow | null) ?? undefined
  );
}

export function getUserLinks(db: Database, userId: string): AdapterLinkRow[] {
  return db.query("SELECT * FROM adapter_links WHERE user_id = ?").all(userId) as AdapterLinkRow[];
}

export function unlinkAdapter(db: Database, adapter: string, externalId: string): boolean {
  const result = db.run("DELETE FROM adapter_links WHERE adapter = ? AND external_id = ?", [
    adapter,
    externalId,
  ]);
  return result.changes > 0;
}

export function saveAdapterUserMapping(
  db: Database,
  platform: string,
  platformUserId: string,
  entityName: string,
): void {
  db.run(
    `INSERT OR REPLACE INTO adapter_user_mappings (platform, platform_user_id, entity_name, created_at)
       VALUES (?, ?, ?, ?)`,
    [platform, platformUserId, entityName, Date.now()],
  );
}

export function getAdapterUserMapping(
  db: Database,
  platform: string,
  platformUserId: string,
): AdapterUserMappingRow | undefined {
  return (
    (db
      .query("SELECT * FROM adapter_user_mappings WHERE platform = ? AND platform_user_id = ?")
      .get(platform, platformUserId) as AdapterUserMappingRow | null) ?? undefined
  );
}

export function getAdapterUserMappings(db: Database, platform: string): AdapterUserMappingRow[] {
  return db
    .query("SELECT * FROM adapter_user_mappings WHERE platform = ?")
    .all(platform) as AdapterUserMappingRow[];
}

export function deleteAdapterUserMapping(
  db: Database,
  platform: string,
  platformUserId: string,
): boolean {
  const result = db.run(
    "DELETE FROM adapter_user_mappings WHERE platform = ? AND platform_user_id = ?",
    [platform, platformUserId],
  );
  return result.changes > 0;
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  name: string;
  created_at: number;
  last_login: number;
  rank: number;
  properties: string;
  /** better-auth subject bound to this named user (null unless MARINA_AUTH on). */
  auth_subject?: string | null;
  /** Verified email from the bound identity (used for admin-by-email). */
  auth_email?: string | null;
}

export interface BanRow {
  name: string;
  reason: string;
  banned_by: string;
  created_at: number;
}

export interface AdapterLinkRow {
  adapter: string;
  external_id: string;
  user_id: string;
  created_at: number;
}

export interface AdapterUserMappingRow {
  platform: string;
  platform_user_id: string;
  entity_name: string;
  created_at: number;
}
