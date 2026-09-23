// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Coding sessions, events and artifacts ─────────────────────────────────

export function createCodingSession(
  db: Database,
  session: {
    id: string;
    title: string;
    workspaceRoot: string;
    status?: string;
    mode?: string;
    createdBy: string;
  },
): CodingSessionRow {
  const now = Date.now();
  const row: CodingSessionRow = {
    id: session.id,
    title: session.title,
    workspace_root: session.workspaceRoot,
    status: session.status ?? "active",
    mode: session.mode ?? "ask",
    created_by: session.createdBy,
    created_at: now,
    updated_at: now,
    writer: null,
    agent: null,
    driver: null,
    execution_target: "local",
    worktree_path: null,
    worktree_branch: null,
  };
  db.run(
    `INSERT INTO coding_sessions
        (id, title, workspace_root, status, mode, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.title,
      row.workspace_root,
      row.status,
      row.mode,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
  return row;
}

export function getCodingSession(db: Database, id: string): CodingSessionRow | null {
  return db.query("SELECT * FROM coding_sessions WHERE id = ?").get(id) as CodingSessionRow | null;
}

export function listCodingSessions(
  db: Database,
  createdBy?: string,
  limit = 10,
): CodingSessionRow[] {
  if (createdBy) {
    return db
      .query("SELECT * FROM coding_sessions WHERE created_by = ? ORDER BY updated_at DESC LIMIT ?")
      .all(createdBy, limit) as CodingSessionRow[];
  }
  return db
    .query("SELECT * FROM coding_sessions ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as CodingSessionRow[];
}

export function updateCodingSession(
  db: Database,
  id: string,
  patch: Partial<{
    status: string;
    mode: string;
    title: string;
    writer: string | null;
    agent: string | null;
    driver: string | null;
    executionTarget: "local" | "flywheel";
    worktreePath: string | null;
    worktreeBranch: string | null;
  }>,
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.agent !== undefined) {
    sets.push("agent = ?");
    values.push(patch.agent);
  }
  if (patch.driver !== undefined) {
    sets.push("driver = ?");
    values.push(patch.driver);
  }
  if (patch.executionTarget !== undefined) {
    sets.push("execution_target = ?");
    values.push(patch.executionTarget);
  }
  if (patch.mode !== undefined) {
    sets.push("mode = ?");
    values.push(patch.mode);
  }
  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
  }
  if (patch.writer !== undefined) {
    sets.push("writer = ?");
    values.push(patch.writer);
  }
  if (patch.worktreePath !== undefined) {
    sets.push("worktree_path = ?");
    values.push(patch.worktreePath);
  }
  if (patch.worktreeBranch !== undefined) {
    sets.push("worktree_branch = ?");
    values.push(patch.worktreeBranch);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(Date.now(), id);
  db.run(`UPDATE coding_sessions SET ${sets.join(", ")} WHERE id = ?`, values);
}

export function createCodingEvent(
  db: Database,
  event: { id?: string; sessionId: string; actor: string; kind: string; payload: unknown },
): CodingEventRow {
  const row: CodingEventRow = {
    id: event.id ?? crypto.randomUUID(),
    session_id: event.sessionId,
    actor: event.actor,
    kind: event.kind,
    payload_json: JSON.stringify(event.payload ?? {}),
    created_at: Date.now(),
  };
  db.run(
    `INSERT INTO coding_events
        (id, session_id, actor, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.session_id, row.actor, row.kind, row.payload_json, row.created_at],
  );
  db.run("UPDATE coding_sessions SET updated_at = ? WHERE id = ?", [
    row.created_at,
    row.session_id,
  ]);
  return row;
}

export function listCodingEvents(db: Database, sessionId: string, limit = 50): CodingEventRow[] {
  return db
    .query(
      `SELECT * FROM (
         SELECT * FROM coding_events
         WHERE session_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )
         ORDER BY created_at ASC`,
    )
    .all(sessionId, limit) as CodingEventRow[];
}

export function createCodingArtifact(
  db: Database,
  artifact: {
    id?: string;
    sessionId: string;
    kind: string;
    title: string;
    status?: string;
    contentText: string;
    metadata?: unknown;
    createdBy: string;
  },
): CodingArtifactRow {
  const now = Date.now();
  const idPrefix = artifact.kind === "patch" ? "patch" : artifact.kind.replace(/[^a-z0-9]+/gi, "_");
  const row: CodingArtifactRow = {
    id: artifact.id ?? `${idPrefix}_${crypto.randomUUID().slice(0, 12)}`,
    session_id: artifact.sessionId,
    kind: artifact.kind,
    title: artifact.title,
    status: artifact.status ?? "pending",
    content_text: artifact.contentText,
    metadata_json: JSON.stringify(artifact.metadata ?? {}),
    created_by: artifact.createdBy,
    applied_by: null,
    created_at: now,
    updated_at: now,
    applied_at: null,
  };
  db.run(
    `INSERT INTO coding_artifacts
        (id, session_id, kind, title, status, content_text, metadata_json, created_by,
         applied_by, created_at, updated_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.session_id,
      row.kind,
      row.title,
      row.status,
      row.content_text,
      row.metadata_json,
      row.created_by,
      row.applied_by,
      row.created_at,
      row.updated_at,
      row.applied_at,
    ],
  );
  db.run("UPDATE coding_sessions SET updated_at = ? WHERE id = ?", [now, row.session_id]);
  return row;
}

export function getCodingArtifact(db: Database, id: string): CodingArtifactRow | null {
  return db
    .query("SELECT * FROM coding_artifacts WHERE id = ?")
    .get(id) as CodingArtifactRow | null;
}

export function listCodingArtifacts(
  db: Database,
  sessionId: string,
  limit = 20,
): CodingArtifactRow[] {
  return db
    .query("SELECT * FROM coding_artifacts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(sessionId, limit) as CodingArtifactRow[];
}

export function updateCodingArtifact(
  db: Database,
  id: string,
  patch: Partial<{
    appliedAt: number | null;
    appliedBy: string | null;
    metadata: unknown;
    status: string;
  }>,
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.appliedBy !== undefined) {
    sets.push("applied_by = ?");
    values.push(patch.appliedBy);
  }
  if (patch.appliedAt !== undefined) {
    sets.push("applied_at = ?");
    values.push(patch.appliedAt);
  }
  if (patch.metadata !== undefined) {
    sets.push("metadata_json = ?");
    values.push(JSON.stringify(patch.metadata));
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(Date.now(), id);
  db.run(`UPDATE coding_artifacts SET ${sets.join(", ")} WHERE id = ?`, values);
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface CodingSessionRow {
  id: string;
  title: string;
  workspace_root: string;
  status: string;
  mode: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  writer: string | null;
  /** The autonomous coding agent bound to this session (single-agent driver). */
  agent: string | null;
  /** Dispatch strategy: "single" (default) | "crew" | future multi-agent. */
  driver: string | null;
  /** Explicit execution provider. Existing sessions default to trusted local mode. */
  execution_target: "local" | "flywheel";
  /**
   * Marina-managed git worktree bound to this session (opt-in). NULL means the
   * session works directly in workspace_root (default, byte-identical to legacy).
   */
  worktree_path: string | null;
  /** The marina/session-<id> branch backing worktree_path, or NULL when off. */
  worktree_branch: string | null;
}

export interface CodingEventRow {
  id: string;
  session_id: string;
  actor: string;
  kind: string;
  payload_json: string;
  created_at: number;
}

export interface CodingArtifactRow {
  id: string;
  session_id: string;
  kind: string;
  title: string;
  status: string;
  content_text: string;
  metadata_json: string;
  created_by: string;
  applied_by: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}
