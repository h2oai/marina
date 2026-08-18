// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { DAY_MS } from "../engine/constants";

// ─── Channel Persistence ──────────────────────────────────────────────────

export function createChannel(
  db: Database,
  channel: {
    id: string;
    type: string;
    name: string;
    ownerId?: string;
    persistence?: string;
    retentionHours?: number;
  },
): void {
  db.run(
    `INSERT INTO channels (id, type, name, owner_id, persistence, retention_hours, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      channel.id,
      channel.type,
      channel.name,
      channel.ownerId ?? null,
      channel.persistence ?? "permanent",
      channel.retentionHours ?? null,
      Date.now(),
    ],
  );
}

export function getChannel(db: Database, id: string): ChannelRow | undefined {
  return (
    (db.query("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | null) ?? undefined
  );
}

export function getChannelByName(db: Database, name: string): ChannelRow | undefined {
  return (
    (db.query("SELECT * FROM channels WHERE name = ?").get(name) as ChannelRow | null) ?? undefined
  );
}

export function getAllChannels(db: Database): ChannelRow[] {
  return db.query("SELECT * FROM channels ORDER BY name").all() as ChannelRow[];
}

export function deleteChannel(db: Database, id: string): void {
  db.run("DELETE FROM channels WHERE id = ?", [id]);
}

export function addChannelMember(
  db: Database,
  channelId: string,
  entityId: string,
  canRead = true,
  canWrite = true,
): void {
  db.run(
    `INSERT OR REPLACE INTO channel_members (channel_id, entity_id, can_read, can_write, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
    [channelId, entityId, canRead ? 1 : 0, canWrite ? 1 : 0, Date.now()],
  );
}

export function removeChannelMember(db: Database, channelId: string, entityId: string): void {
  db.run("DELETE FROM channel_members WHERE channel_id = ? AND entity_id = ?", [
    channelId,
    entityId,
  ]);
}

export function getChannelMembers(db: Database, channelId: string): ChannelMemberRow[] {
  return db
    .query("SELECT * FROM channel_members WHERE channel_id = ?")
    .all(channelId) as ChannelMemberRow[];
}

export function getEntityChannels(db: Database, entityId: string): ChannelRow[] {
  return db
    .query(
      `SELECT c.* FROM channels c
       JOIN channel_members cm ON c.id = cm.channel_id
       WHERE cm.entity_id = ?
       ORDER BY c.name`,
    )
    .all(entityId) as ChannelRow[];
}

export function isChannelMember(db: Database, channelId: string, entityId: string): boolean {
  const row = db
    .query("SELECT 1 FROM channel_members WHERE channel_id = ? AND entity_id = ?")
    .get(channelId, entityId);
  return row !== null;
}

export function addChannelMessage(
  db: Database,
  channelId: string,
  senderId: string,
  senderName: string,
  content: string,
): number {
  const result = db.run(
    `INSERT INTO channel_messages (channel_id, sender_id, sender_name, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [channelId, senderId, senderName, content, Date.now()],
  );
  return Number(result.lastInsertRowid);
}

export function getChannelHistory(
  db: Database,
  channelId: string,
  limit = 20,
): ChannelMessageRow[] {
  return db
    .query("SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?")
    .all(channelId, limit) as ChannelMessageRow[];
}

export function countChannelMessages(db: Database, channelId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ?")
    .get(channelId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function countBoardPosts(db: Database, boardId: string, archived = false): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM board_posts WHERE board_id = ? AND archived = ?")
    .get(boardId, archived ? 1 : 0) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function pruneExpiredMessages(db: Database, now: number): number {
  const result = db.run(
    `DELETE FROM channel_messages WHERE channel_id IN (
      SELECT id FROM channels WHERE retention_hours IS NOT NULL
    ) AND created_at < ?`,
    [now],
  );
  return result.changes;
}

// ─── Board Persistence ────────────────────────────────────────────────────

export function createBoard(
  db: Database,
  board: {
    id: string;
    name: string;
    scopeType?: string;
    scopeId?: string;
    readRank?: number;
    writeRank?: number;
    pinRank?: number;
  },
): void {
  db.run(
    `INSERT INTO boards (id, name, scope_type, scope_id, read_rank, write_rank, pin_rank, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      board.id,
      board.name,
      board.scopeType ?? "global",
      board.scopeId ?? null,
      board.readRank ?? 0,
      board.writeRank ?? 0,
      board.pinRank ?? 3,
      Date.now(),
    ],
  );
}

export function getBoard(db: Database, id: string): BoardRow | undefined {
  return (db.query("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | null) ?? undefined;
}

export function getBoardByName(db: Database, name: string): BoardRow | undefined {
  return (
    (db.query("SELECT * FROM boards WHERE name = ?").get(name) as BoardRow | null) ?? undefined
  );
}

export function getBoardsForScope(db: Database, scopeType: string, scopeId: string): BoardRow[] {
  return db
    .query("SELECT * FROM boards WHERE scope_type = ? AND scope_id = ?")
    .all(scopeType, scopeId) as BoardRow[];
}

export function getAllBoards(db: Database): BoardRow[] {
  return db.query("SELECT * FROM boards ORDER BY name").all() as BoardRow[];
}

export function deleteBoard(db: Database, id: string): void {
  db.run("DELETE FROM boards WHERE id = ?", [id]);
}

export function createBoardPost(
  db: Database,
  post: {
    boardId: string;
    parentId?: number;
    authorId: string;
    authorName: string;
    title?: string;
    body: string;
    tags?: string[];
  },
): number {
  const now = Date.now();
  const result = db.run(
    `INSERT INTO board_posts (board_id, parent_id, author_id, author_name, title, body, tags, pinned, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    [
      post.boardId,
      post.parentId ?? null,
      post.authorId,
      post.authorName,
      post.title ?? "",
      post.body,
      JSON.stringify(post.tags ?? []),
      now,
      now,
    ],
  );
  return Number(result.lastInsertRowid);
}

export function getBoardPost(db: Database, id: number): BoardPostRow | undefined {
  return (
    (db.query("SELECT * FROM board_posts WHERE id = ?").get(id) as BoardPostRow | null) ?? undefined
  );
}

export function listBoardPosts(
  db: Database,
  boardId: string,
  opts?: { offset?: number; limit?: number; archived?: boolean },
): BoardPostRow[] {
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 20;
  const archived = opts?.archived ?? false;
  return db
    .query(
      `SELECT * FROM board_posts WHERE board_id = ? AND archived = ?
       ORDER BY pinned DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(boardId, archived ? 1 : 0, limit, offset) as BoardPostRow[];
}

export function searchBoardPosts(db: Database, boardId: string, query: string): BoardPostRow[] {
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return [];
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" ");
  return db
    .query(
      `SELECT bp.* FROM board_posts bp
       JOIN board_posts_fts fts ON bp.id = fts.rowid
       WHERE bp.board_id = ? AND board_posts_fts MATCH ?
       ORDER BY fts.rank
       LIMIT 20`,
    )
    .all(boardId, ftsQuery) as BoardPostRow[];
}

export function rebuildBoardSearchIndex(db: Database): void {
  db.run("INSERT INTO board_posts_fts(board_posts_fts) VALUES('rebuild')");
}

export function pinBoardPost(db: Database, postId: number): void {
  db.run("UPDATE board_posts SET pinned = 1, updated_at = ? WHERE id = ?", [Date.now(), postId]);
}

export function unpinBoardPost(db: Database, postId: number): void {
  db.run("UPDATE board_posts SET pinned = 0, updated_at = ? WHERE id = ?", [Date.now(), postId]);
}

export function archiveBoardPost(db: Database, postId: number): void {
  db.run("UPDATE board_posts SET archived = 1, updated_at = ? WHERE id = ?", [Date.now(), postId]);
}

export function voteBoardPost(
  db: Database,
  postId: number,
  entityId: string,
  value: number,
  score = 0,
): void {
  db.run(
    `INSERT OR REPLACE INTO board_votes (post_id, entity_id, value, score, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [postId, entityId, value, score, Date.now()],
  );
}

export function getBoardPostVoteCount(db: Database, postId: number): number {
  const row = db
    .query("SELECT COALESCE(SUM(value), 0) as total FROM board_votes WHERE post_id = ?")
    .get(postId) as { total: number };
  return row.total;
}

export function autoArchiveBoardPosts(db: Database, daysOld: number, minVotes: number): number {
  const cutoff = Date.now() - daysOld * DAY_MS;
  const result = db.run(
    `UPDATE board_posts SET archived = 1, updated_at = ?
     WHERE archived = 0 AND created_at < ? AND id NOT IN (
       SELECT post_id FROM board_votes GROUP BY post_id HAVING SUM(value) >= ?
     )`,
    [Date.now(), cutoff, minVotes],
  );
  return result.changes;
}

export function getBoardPostScores(db: Database, postId: number): BoardVoteRow[] {
  return db
    .query("SELECT entity_id, value, score FROM board_votes WHERE post_id = ?")
    .all(postId) as BoardVoteRow[];
}

export function getScoreMatrix(db: Database, boardId: string): BoardVoteRow[] {
  return db
    .query(
      `SELECT bv.post_id, bv.entity_id, bv.score FROM board_votes bv
       JOIN board_posts bp ON bv.post_id = bp.id
       WHERE bp.board_id = ? AND bv.score > 0`,
    )
    .all(boardId) as BoardVoteRow[];
}

// ─── Group Persistence ────────────────────────────────────────────────────

export function createGroup(
  db: Database,
  group: {
    id: string;
    name: string;
    description?: string;
    leaderId: string;
    channelId?: string;
    boardId?: string;
  },
): void {
  db.run(
    `INSERT INTO groups_ (id, name, description, leader_id, channel_id, board_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      group.id,
      group.name,
      group.description ?? "",
      group.leaderId,
      group.channelId ?? null,
      group.boardId ?? null,
      Date.now(),
    ],
  );
}

export function getGroup(db: Database, id: string): GroupRow | undefined {
  return (db.query("SELECT * FROM groups_ WHERE id = ?").get(id) as GroupRow | null) ?? undefined;
}

export function getGroupByName(db: Database, name: string): GroupRow | undefined {
  return (
    (db.query("SELECT * FROM groups_ WHERE name = ?").get(name) as GroupRow | null) ?? undefined
  );
}

export function getAllGroups(db: Database): GroupRow[] {
  return db.query("SELECT * FROM groups_ ORDER BY name").all() as GroupRow[];
}

export function deleteGroup(db: Database, id: string): void {
  db.run("DELETE FROM groups_ WHERE id = ?", [id]);
}

export function updateGroupChannelAndBoard(
  db: Database,
  groupId: string,
  channelId: string,
  boardId: string,
): void {
  db.run("UPDATE groups_ SET channel_id = ?, board_id = ? WHERE id = ?", [
    channelId,
    boardId,
    groupId,
  ]);
}

export function addGroupMember(db: Database, groupId: string, entityId: string, rank = 0): void {
  db.run(
    `INSERT OR REPLACE INTO group_members (group_id, entity_id, rank, joined_at)
     VALUES (?, ?, ?, ?)`,
    [groupId, entityId, rank, Date.now()],
  );
}

export function removeGroupMember(db: Database, groupId: string, entityId: string): void {
  db.run("DELETE FROM group_members WHERE group_id = ? AND entity_id = ?", [groupId, entityId]);
}

export function getGroupMembers(db: Database, groupId: string): GroupMemberRow[] {
  return db
    .query("SELECT * FROM group_members WHERE group_id = ?")
    .all(groupId) as GroupMemberRow[];
}

export function getGroupMember(
  db: Database,
  groupId: string,
  entityId: string,
): GroupMemberRow | undefined {
  return (
    (db
      .query("SELECT * FROM group_members WHERE group_id = ? AND entity_id = ?")
      .get(groupId, entityId) as GroupMemberRow | null) ?? undefined
  );
}

export function getEntityGroups(db: Database, entityId: string): GroupRow[] {
  return db
    .query(
      `SELECT g.* FROM groups_ g
       JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.entity_id = ?
       ORDER BY g.name`,
    )
    .all(entityId) as GroupRow[];
}

export function updateGroupMemberRank(
  db: Database,
  groupId: string,
  entityId: string,
  rank: number,
): void {
  db.run("UPDATE group_members SET rank = ? WHERE group_id = ? AND entity_id = ?", [
    rank,
    groupId,
    entityId,
  ]);
}

// ─── Global Search ────────────────────────────────────────────────────

export function globalSearch(db: Database, query: string): GlobalSearchResult[] {
  const results: GlobalSearchResult[] = [];
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return results;

  // Search board posts via FTS5
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" ");
  try {
    const boardResults = db
      .query(
        `SELECT bp.id, bp.board_id, bp.title, bp.body, bp.author_name
         FROM board_posts bp
         JOIN board_posts_fts fts ON bp.id = fts.rowid
         WHERE board_posts_fts MATCH ?
         ORDER BY fts.rank LIMIT 10`,
      )
      .all(ftsQuery) as {
      id: number;
      board_id: string;
      title: string;
      body: string;
      author_name: string;
    }[];
    for (const r of boardResults) {
      results.push({
        type: "board_post",
        id: String(r.id),
        title: r.title || r.body.slice(0, 60),
        context: r.board_id,
      });
    }
  } catch (err) {
    console.warn("[db] search board FTS5 query failed:", (err as Error).message);
  }

  // Search channel messages via LIKE
  const likePattern = `%${safeQuery}%`;
  try {
    const msgResults = db
      .query(
        `SELECT id, channel_id, sender_name, content
         FROM channel_messages
         WHERE content LIKE ?
         ORDER BY id DESC LIMIT 10`,
      )
      .all(likePattern) as {
      id: number;
      channel_id: string;
      sender_name: string;
      content: string;
    }[];
    for (const r of msgResults) {
      results.push({
        type: "channel_message",
        id: String(r.id),
        title: `${r.sender_name}: ${r.content.slice(0, 60)}`,
        context: r.channel_id,
      });
    }
  } catch (err) {
    console.warn("[db] search channel LIKE query failed:", (err as Error).message);
  }

  return results;
}

// ─── Row Types ──────────────────────────────────────────────────────────

export interface ChannelRow {
  id: string;
  type: string;
  name: string;
  owner_id: string | null;
  persistence: string;
  retention_hours: number | null;
  created_at: number;
}

export interface ChannelMessageRow {
  id: number;
  channel_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  created_at: number;
}

export interface ChannelMemberRow {
  channel_id: string;
  entity_id: string;
  can_read: number;
  can_write: number;
  joined_at: number;
}

export interface BoardRow {
  id: string;
  name: string;
  scope_type: string;
  scope_id: string | null;
  read_rank: number;
  write_rank: number;
  pin_rank: number;
  created_at: number;
}

export interface BoardPostRow {
  id: number;
  board_id: string;
  parent_id: number | null;
  author_id: string;
  author_name: string;
  title: string;
  body: string;
  tags: string;
  pinned: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string;
  leader_id: string;
  channel_id: string | null;
  board_id: string | null;
  created_at: number;
}

export interface GroupMemberRow {
  group_id: string;
  entity_id: string;
  rank: number;
  joined_at: number;
}

export interface BoardVoteRow {
  post_id?: number;
  entity_id: string;
  value?: number;
  score: number;
}

export interface GlobalSearchResult {
  type: "board_post" | "channel_message" | "room";
  id: string;
  title: string;
  context: string;
}
