// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

/**
 * Chronicle — the canonical, append-only record of the Marina.
 * See docs/chronicle.md for the design.
 *
 * Three writers in practice:
 *   - Engine (kind='event')      — auto-emitted on canonical happenings, no LLM
 *   - Chronicler agent (kind='narrative' | 'digest')  — synthesizes, must cite refs
 *   - Anyone via correction      — supersedes a prior id, never mutates it
 */

export type ChronicleKind = "event" | "narrative" | "digest" | "correction";

export interface ChronicleRow {
  id: number;
  created_at: number;
  kind: ChronicleKind;
  source: string;
  title: string;
  body: string;
  participants: string; // JSON array of entity names
  refs: string; // JSON array of provenance ids
  period: string | null;
  supersedes: number | null;
}

export interface ChronicleEntry {
  id: number;
  created_at: number;
  kind: ChronicleKind;
  source: string;
  title: string;
  body: string;
  participants: string[];
  refs: string[];
  period: string | null;
  supersedes: number | null;
}

export interface InsertChronicle {
  kind: ChronicleKind;
  source: string;
  title: string;
  body?: string;
  participants?: string[];
  refs?: string[];
  period?: string;
  supersedes?: number;
}

function parseRow(row: ChronicleRow): ChronicleEntry {
  return {
    id: row.id,
    created_at: row.created_at,
    kind: row.kind,
    source: row.source,
    title: row.title,
    body: row.body,
    participants: safeJsonArray(row.participants),
    refs: safeJsonArray(row.refs),
    period: row.period,
    supersedes: row.supersedes,
  };
}

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Append a chronicle entry. Returns the new id. */
export function appendChronicle(db: Database, entry: InsertChronicle): number {
  if (entry.kind === "correction" && entry.supersedes === undefined) {
    throw new Error("chronicle: correction entries must set supersedes");
  }
  const result = db.run(
    `INSERT INTO chronicle (created_at, kind, source, title, body, participants, refs, period, supersedes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      entry.kind,
      entry.source,
      entry.title,
      entry.body ?? "",
      JSON.stringify(entry.participants ?? []),
      JSON.stringify(entry.refs ?? []),
      entry.period ?? null,
      entry.supersedes ?? null,
    ],
  );
  return Number(result.lastInsertRowid);
}

export interface ChronicleQuery {
  /** Inclusive lower bound on created_at (ms since epoch). */
  since?: number;
  /** Inclusive upper bound on created_at (ms since epoch). */
  until?: number;
  /** Filter by kind. */
  kind?: ChronicleKind;
  /** Filter by source (the originating event kind or 'chronicler'). */
  source?: string;
  /** Filter by entity name appearing in participants. */
  participant?: string;
  /** Filter by digest period token (e.g. 'day:2026-05-18'). */
  period?: string;
  /**
   * Substring match against title OR body (case-insensitive). Used by ask/recap
   * for topic relevance. Cheap — no FTS5 yet (the chronicle is small).
   */
  like?: string;
  /** Default 20, max 200. */
  limit?: number;
}

export function queryChronicle(db: Database, q: ChronicleQuery = {}): ChronicleEntry[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (q.since !== undefined) {
    clauses.push("created_at >= ?");
    args.push(q.since);
  }
  if (q.until !== undefined) {
    clauses.push("created_at <= ?");
    args.push(q.until);
  }
  if (q.kind) {
    clauses.push("kind = ?");
    args.push(q.kind);
  }
  if (q.source) {
    clauses.push("source = ?");
    args.push(q.source);
  }
  if (q.period) {
    clauses.push("period = ?");
    args.push(q.period);
  }
  if (q.participant) {
    // JSON contains-by-string match. Works because participant names are JSON-escaped
    // identical to their natural form, and we wrap the search in quotes to avoid
    // substring collisions (e.g. searching "bob" should not match "boba").
    clauses.push("participants LIKE ?");
    args.push(`%"${q.participant}"%`);
  }
  if (q.like) {
    // Topic match against title OR body. Escape SQL LIKE wildcards so an
    // injected `%` or `_` in the query doesn't broaden the match.
    const escaped = q.like.replace(/[\\%_]/g, "\\$&");
    clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    args.push(`%${escaped}%`, `%${escaped}%`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
  args.push(limit);
  const rows = db
    .query(`SELECT * FROM chronicle ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args) as ChronicleRow[];
  return rows.map(parseRow);
}

export function getChronicleEntry(db: Database, id: number): ChronicleEntry | undefined {
  const row = db.query("SELECT * FROM chronicle WHERE id = ?").get(id) as ChronicleRow | undefined;
  return row ? parseRow(row) : undefined;
}

/**
 * Walk the supersession chain forward — given an entry id, return every
 * correction that supersedes it (directly or transitively), newest first.
 * Useful for `chronicle show <id>` to display "this entry has been revised."
 */
export function getCorrectionsFor(db: Database, id: number): ChronicleEntry[] {
  const rows = db
    .query(
      `WITH RECURSIVE chain(id) AS (
         SELECT id FROM chronicle WHERE supersedes = ?
         UNION
         SELECT c.id FROM chronicle c JOIN chain ON c.supersedes = chain.id
       )
       SELECT * FROM chronicle WHERE id IN chain ORDER BY created_at DESC, id DESC`,
    )
    .all(id) as ChronicleRow[];
  return rows.map(parseRow);
}

export function getChronicleCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) as count FROM chronicle").get() as { count: number };
  return row.count;
}
