// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { appendChronicle } from "./db-chronicle";
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

/**
 * Rename an account (and its principal's display name), keeping its id, so
 * everything it owns stays where it is. Maintenance only: used to turn a
 * script-created account into a server-owned name no login can produce.
 * One transaction; false when no account has `id`.
 */
export function renameUser(db: Database, id: string, name: string): boolean {
  return db.transaction(() => {
    const changed = db.run("UPDATE users SET name = ? WHERE id = ?", [name, id]).changes > 0;
    if (changed)
      db.run("UPDATE principals SET display_name = ? WHERE principal_id = ?", [name, id]);
    return changed;
  })();
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

/**
 * Placeholder written over an erased account's durable key (and display name)
 * where the row itself belongs to other people: a task others claimed, a board
 * post others replied to, a group others still belong to.
 */
export const ERASED_ACCOUNT = "[erased]";

/** Rows touched by one account erasure, per table (also the audit body). */
export interface AccountErasure {
  entity_standing: number;
  entity_standing_cache: number;
  entity_competence: number;
  witness_attestations: number;
  group_members: number;
  channel_members: number;
  board_votes: number;
  macros: number;
  adapter_links: number;
  groups_leader: number;
  tasks_creator: number;
  board_posts_author: number;
}

/**
 * Account erasure — the one explicit, audited exception to the append-only
 * ledgers (docs/architecture/persistence.md → "Account erasure"). Everything
 * keyed by the durable account id (migrations 109, 117–119) goes in ONE
 * transaction:
 *
 * - the account's own rows are deleted: standing ledger + cache, competence,
 *   witness attestations, group/channel memberships, board votes, macros,
 *   adapter links;
 * - rows shared with others are anonymized to `ERASED_ACCOUNT`: task creator,
 *   board post author; a led group passes to its highest-ranked remaining
 *   member, else `ERASED_ACCOUNT`;
 * - one `event` chronicle entry records the erasure (account id and per-table
 *   counts only — never the name).
 */
export function deleteUser(db: Database, id: string): AccountErasure {
  return db.transaction(() => {
    // Counted before the write: `changes` also counts FTS trigger writes.
    const count = (table: string, column: string) =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number })
        .n;
    const del = (table: string, column = "entity_id") => {
      const n = count(table, column);
      db.run(`DELETE FROM ${table} WHERE ${column} = ?`, [id]);
      return n;
    };
    const anonymize = (table: string, idColumn: string, nameColumn: string) => {
      const n = count(table, idColumn);
      db.run(`UPDATE ${table} SET ${idColumn} = ?, ${nameColumn} = ? WHERE ${idColumn} = ?`, [
        ERASED_ACCOUNT,
        ERASED_ACCOUNT,
        id,
      ]);
      return n;
    };
    const counts: AccountErasure = {
      entity_standing: del("entity_standing"),
      entity_standing_cache: del("entity_standing_cache"),
      entity_competence: del("entity_competence"),
      witness_attestations: del("witness_attestations"),
      group_members: del("group_members"),
      channel_members: del("channel_members"),
      board_votes: del("board_votes"),
      macros: del("macros", "author_id"),
      adapter_links: del("adapter_links", "user_id"),
      groups_leader: count("groups_", "leader_id"),
      tasks_creator: anonymize("tasks", "creator_id", "creator_name"),
      board_posts_author: anonymize("board_posts", "author_id", "author_name"),
    };
    db.run(
      `UPDATE groups_ SET leader_id = COALESCE(
         (SELECT gm.entity_id FROM group_members gm WHERE gm.group_id = groups_.id
          ORDER BY gm.rank DESC, gm.joined_at ASC LIMIT 1), ?)
       WHERE leader_id = ?`,
      [ERASED_ACCOUNT, id],
    );
    const removed = db.run("DELETE FROM users WHERE id = ?", [id]).changes;
    if (removed > 0) {
      appendChronicle(db, {
        kind: "event",
        source: "account",
        title: "account erased",
        body: JSON.stringify(counts),
        refs: [`user:${id}`],
      });
    }
    return counts;
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
