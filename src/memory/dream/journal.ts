// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Episodes are evidence; abstractions are claims. The continuity journal —
 * the agent's own transcript, captured by `DurableResidentMemory` as
 * `journal:` sources in its resident space — is readable by the OWNER's
 * dreamer and by nobody else: never shared `[evidence]`, never another
 * agent's region. The dream sees the newest episodes of its window (byte-
 * capped), can ground a restatement's numbers and names in them
 * (`faithfulTo`), and counts journaled bytes as material for the trigger.
 * Journal text is read here and shown to the model; it is never stored by a
 * dream (the row keeps counts).
 */

import type { MarinaDB } from "../../persistence/database";

/** Journal bytes shown to the model per dream, at most. */
export const DREAM_JOURNAL_MAX_BYTES = 8_000;
/** Journal parts read per dream, at most (newest first). */
export const DREAM_JOURNAL_MAX_PARTS = 200;
/** Characters kept per episode. */
export const EPISODE_MAX_CHARS = 400;
/** Journaled bytes since the last dream that count as material on their own. */
export const DREAM_MIN_JOURNAL_BYTES = 64 * 1024;

export const JOURNAL_SESSION_PREFIX = "journal:";

export interface JournalEpisode {
  at: number;
  role: "user" | "assistant" | "toolResult";
  text: string;
}

/** The owner's resident spaces (owner = its durable principal, name `resident`). */
export function residentSpaceIds(db: MarinaDB, entityName: string): string[] {
  const principalId = db.durableKeyForName(entityName);
  if (!principalId) return [];
  return db
    .memoryRepository()
    .raw.query<{ id: string }, [string]>(
      "SELECT id FROM memory_spaces WHERE owner_id = ? AND name = 'resident' AND status = 'active'",
    )
    .all(principalId)
    .map((r) => r.id);
}

const spaceList = (ids: readonly string[]) => ids.map(() => "?").join(",");

/** Bytes the owner journaled since `since` (the trigger's second material rule). */
export function journalBytesSince(db: MarinaDB, entityName: string, since: number): number {
  const spaces = residentSpaceIds(db, entityName);
  if (!spaces.length) return 0;
  const row = db
    .memoryRepository()
    .raw.query<{ bytes: number | null }, [...string[], number]>(
      `SELECT sum(length(CAST(body AS BLOB))) AS bytes FROM memory_sources
       WHERE space_id IN (${spaceList(spaces)}) AND session_id LIKE '${JOURNAL_SESSION_PREFIX}%'
         AND created_at > ?`,
    )
    .get(...spaces, since);
  return row?.bytes ?? 0;
}

type Part = { type?: string; text?: string; toolName?: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .map((p) => (p && typeof p === "object" && p.type === "text" && p.text ? p.text : ""))
    .filter(Boolean)
    .join(" ");
}

/** One journal part → one episode, or undefined for a bracket, a manifest or a split part. */
export function parseEpisode(text: string, at: number): JournalEpisode | undefined {
  const body = text.startsWith(",") ? text.slice(1) : text;
  if (!body.startsWith("{")) return undefined;
  let message: { role?: string; content?: unknown; toolName?: string };
  try {
    message = JSON.parse(body);
  } catch {
    return undefined;
  }
  const squash = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, EPISODE_MAX_CHARS);
  if (message.role === "user" || message.role === "assistant") {
    const t = squash(textOf(message.content));
    return t ? { at, role: message.role, text: t } : undefined;
  }
  if (message.role === "toolResult") {
    const t = squash(textOf(message.content));
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    return t ? { at, role: "toolResult", text: `${name}: ${t}` } : undefined;
  }
  return undefined;
}

/** The owner's newest episodes in the window, oldest first, within `maxBytes`. */
export function gatherEpisodes(
  db: MarinaDB,
  entityName: string,
  since: number,
  until: number,
  maxBytes = DREAM_JOURNAL_MAX_BYTES,
): { episodes: JournalEpisode[]; bytes: number; parts: number } {
  const spaces = residentSpaceIds(db, entityName);
  if (!spaces.length) return { episodes: [], bytes: 0, parts: 0 };
  const rows = db
    .memoryRepository()
    .raw.query<{ created_at: number; text: string }, [...string[], number, number, number]>(
      `SELECT s.created_at, t.text FROM memory_sources s
       JOIN memory_source_text t ON t.seq = s.seq
       WHERE s.space_id IN (${spaceList(spaces)}) AND s.session_id LIKE '${JOURNAL_SESSION_PREFIX}%'
         AND s.created_at BETWEEN ? AND ?
       ORDER BY s.seq DESC LIMIT ?`,
    )
    .all(...spaces, since, until, DREAM_JOURNAL_MAX_PARTS);
  const episodes: JournalEpisode[] = [];
  let bytes = 0;
  for (const row of rows) {
    const episode = parseEpisode(row.text, row.created_at);
    if (!episode) continue;
    const size = Buffer.byteLength(episode.text, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    episodes.push(episode);
  }
  return { episodes: episodes.reverse(), bytes, parts: rows.length };
}

export function renderEpisodes(episodes: readonly JournalEpisode[]): string[] {
  if (!episodes.length) return [];
  const lines = [
    "Episodes (the agent's own recent journal — evidence for a restatement's numbers and names; never a note to merge, link or decay):",
  ];
  for (const e of episodes)
    lines.push(`[${new Date(e.at).toISOString().slice(11, 16)}] ${e.role}: ${e.text}`);
  return lines;
}
