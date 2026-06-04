import type { Database } from "bun:sqlite";

// ─── Task Persistence ─────────────────────────────────────────────────────

export function createTask(
  db: Database,
  task: {
    groupId?: string;
    title: string;
    description?: string;
    creatorId: string;
    creatorName: string;
    validationMode?: string;
    standing?: number;
    parentTaskId?: number;
    priority?: number;
  },
): number {
  const now = Date.now();
  const result = db.run(
    `INSERT INTO tasks (group_id, title, description, creator_id, creator_name, validation_mode, status, standing, parent_task_id, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    [
      task.groupId ?? null,
      task.title,
      task.description ?? "",
      task.creatorId,
      task.creatorName,
      task.validationMode ?? "creator",
      task.standing ?? 0,
      task.parentTaskId ?? null,
      task.priority ?? 0,
      now,
      now,
    ],
  );
  return Number(result.lastInsertRowid);
}

export function updateTaskProgress(db: Database, id: number, progress: number): void {
  const clamped = Math.max(0, Math.min(100, progress));
  db.run("UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?", [clamped, Date.now(), id]);
  if (clamped >= 100) {
    updateTaskStatus(db, id, "completed");
  }
}

export function updateTaskPriority(db: Database, id: number, priority: number): void {
  db.run("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?", [priority, Date.now(), id]);
}

export function getTask(db: Database, id: number): TaskRow | undefined {
  return (db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null) ?? undefined;
}

export function listTasks(
  db: Database,
  opts?: {
    status?: string;
    groupId?: string;
    parentId?: number;
    limit?: number;
    orderByStanding?: boolean;
  },
): TaskRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.groupId) {
    conditions.push("group_id = ?");
    params.push(opts.groupId);
  }
  if (opts?.parentId !== undefined) {
    conditions.push("parent_task_id = ?");
    params.push(opts.parentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = opts?.orderByStanding ? "ORDER BY standing DESC, id DESC" : "ORDER BY id DESC";
  const limit = opts?.limit ?? 20;
  params.push(limit);

  return db.query(`SELECT * FROM tasks ${where} ${order} LIMIT ?`).all(...params) as TaskRow[];
}

export function updateTaskStatus(db: Database, id: number, status: string): void {
  db.run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [status, Date.now(), id]);
}

export function createTaskClaim(
  db: Database,
  taskId: number,
  entityId: string,
  entityName: string,
): void {
  db.run(
    `INSERT INTO task_claims (task_id, entity_id, entity_name, status, claimed_at)
     VALUES (?, ?, ?, 'claimed', ?)`,
    [taskId, entityId, entityName, Date.now()],
  );
}

export function getTaskClaim(
  db: Database,
  taskId: number,
  entityId: string,
): TaskClaimRow | undefined {
  return (
    (db
      .query("SELECT * FROM task_claims WHERE task_id = ? AND entity_id = ?")
      .get(taskId, entityId) as TaskClaimRow | null) ?? undefined
  );
}

export function listTasksClaimedBy(db: Database, entityId: string): TaskRow[] {
  return db
    .query(
      `SELECT t.* FROM tasks t
       JOIN task_claims c ON t.id = c.task_id
       WHERE c.entity_id = ? AND c.status = 'claimed' AND t.status != 'completed' AND t.status != 'cancelled'
       ORDER BY t.priority DESC, t.id DESC`,
    )
    .all(entityId) as TaskRow[];
}

export function getTaskClaims(db: Database, taskId: number): TaskClaimRow[] {
  return db.query("SELECT * FROM task_claims WHERE task_id = ?").all(taskId) as TaskClaimRow[];
}

export function updateTaskClaimStatus(
  db: Database,
  taskId: number,
  entityId: string,
  status: string,
  submissionText?: string,
): void {
  const now = Date.now();
  if (status === "submitted") {
    db.run(
      "UPDATE task_claims SET status = ?, submission_text = ?, submitted_at = ? WHERE task_id = ? AND entity_id = ?",
      [status, submissionText ?? null, now, taskId, entityId],
    );
  } else {
    db.run(
      "UPDATE task_claims SET status = ?, resolved_at = ? WHERE task_id = ? AND entity_id = ?",
      [status, now, taskId, entityId],
    );
  }
}

export function getChildTaskCount(
  db: Database,
  parentId: number,
): { total: number; completed: number } {
  const row = db
    .query(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed FROM tasks WHERE parent_task_id = ?",
    )
    .get(parentId) as { total: number; completed: number | null };
  return { total: row.total, completed: row.completed ?? 0 };
}

export function setTaskParent(db: Database, taskId: number, parentTaskId: number): void {
  db.run("UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ?", [
    parentTaskId,
    Date.now(),
    taskId,
  ]);
}

export function searchTasks(
  db: Database,
  query: string,
  opts?: { status?: string; limit?: number },
): (TaskRow & { score: number })[] {
  const conditions = ["tasks_fts MATCH ?"];
  const params: (string | number)[] = [query];

  if (opts?.status) {
    conditions.push("t.status = ?");
    params.push(opts.status);
  }

  const limit = opts?.limit ?? 10;
  params.push(limit);

  const where = conditions.join(" AND ");
  return db
    .query(
      `SELECT t.*, rank * -1 AS score
       FROM tasks t
       JOIN tasks_fts fts ON t.id = fts.rowid
       WHERE ${where}
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(...params) as (TaskRow & { score: number })[];
}

/**
 * Append a task-completion event to the standing ledger. Idempotent on
 * `(entity_id, kind='task_complete', ref=taskId)` — re-recording the same
 * (entity, task) is a no-op. Cache invalidated so the next read recomputes.
 *
 * Migration 39 reshaped the underlying table from a task-only PK to a
 * generic event ledger; this function preserves the public API but writes
 * the new schema. For non-task contributions, use `Standing.record` in
 * `src/agent/standing.ts`.
 */
export function recordStandingEarned(
  db: Database,
  entityId: string,
  entityName: string,
  taskId: number,
  amount: number,
): void {
  db.run(
    `INSERT INTO entity_standing
       (entity_id, entity_name, kind, ref, task_id, amount, decay_class, earned_at)
     VALUES (?, ?, 'task_complete', ?, ?, ?, 'standard', ?)
     ON CONFLICT(entity_id, kind, ref) DO NOTHING`,
    [entityId, entityName, String(taskId), taskId, amount, Date.now()],
  );
  // Invalidate the rollup cache for this entity so the next standing read
  // sees the new contribution.
  db.run(
    `INSERT INTO entity_standing_cache (entity_id, standing, last_recomputed)
     VALUES (?, 0, 0)
     ON CONFLICT(entity_id) DO UPDATE SET last_recomputed = 0`,
    [entityId],
  );
}

/**
 * Raw lifetime-sum of standing for an entity, undecayed. Kept for the
 * leaderboard/orient callers that want the cumulative ledger view; the
 * decayed civic-standing value lives in `src/agent/standing.ts` via
 * `Standing.getStanding()`.
 */
export function getEntityStanding(db: Database, entityId: string): number {
  const row = db
    .query("SELECT COALESCE(SUM(amount), 0) AS total FROM entity_standing WHERE entity_id = ?")
    .get(entityId) as { total: number };
  return row.total;
}

export function getStandingLeaderboard(
  db: Database,
  limit = 10,
): { entityName: string; total: number; taskCount: number }[] {
  // Filter to task_complete so the existing leaderboard semantics (count of
  // completed tasks, sum of task standing) stay intact. The civic-standing
  // leaderboard from Standing.leaderboard() is separate by design.
  return db
    .query(
      `SELECT entity_name AS entityName, SUM(amount) AS total, COUNT(*) AS taskCount
       FROM entity_standing
       WHERE kind = 'task_complete'
       GROUP BY entity_id
       ORDER BY total DESC
       LIMIT ?`,
    )
    .all(limit) as { entityName: string; total: number; taskCount: number }[];
}

export function rejectAllOtherClaims(db: Database, taskId: number, winnerEntityId: string): void {
  const now = Date.now();
  db.run(
    `UPDATE task_claims SET status = 'rejected', resolved_at = ?
     WHERE task_id = ? AND entity_id != ? AND status IN ('claimed', 'submitted')`,
    [now, taskId, winnerEntityId],
  );
}

export function countCompletedTasks(db: Database, entityName: string): number {
  return (
    db
      .query("SELECT COUNT(*) as c FROM tasks WHERE creator_name = ? AND status = 'completed'")
      .get(entityName) as { c: number }
  ).c;
}

// ─── Project Persistence ──────────────────────────────────────────────

export function createProject(
  db: Database,
  project: {
    id: string;
    name: string;
    description?: string;
    bundleId?: number;
    poolId?: string;
    groupId?: string;
    orchestration?: string;
    memoryArch?: string;
    createdBy: string;
  },
): void {
  db.run(
    `INSERT INTO projects (id, name, description, bundle_id, pool_id, group_id, orchestration, memory_arch, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      project.id,
      project.name,
      project.description ?? "",
      project.bundleId ?? null,
      project.poolId ?? null,
      project.groupId ?? null,
      project.orchestration ?? "custom",
      project.memoryArch ?? "custom",
      project.createdBy,
      Date.now(),
    ],
  );
}

export function getProject(db: Database, id: string): ProjectRow | undefined {
  return (
    (db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null) ?? undefined
  );
}

export function getProjectByName(db: Database, name: string): ProjectRow | undefined {
  return (
    (db.query("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRow | null) ?? undefined
  );
}

export function listProjects(db: Database, status?: string): ProjectRow[] {
  if (status) {
    return db
      .query("SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC")
      .all(status) as ProjectRow[];
  }
  return db.query("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRow[];
}

export function updateProjectStatus(db: Database, id: string, status: string): void {
  db.run("UPDATE projects SET status = ? WHERE id = ?", [status, id]);
}

export function updateProjectOrchestration(db: Database, id: string, orchestration: string): void {
  db.run("UPDATE projects SET orchestration = ? WHERE id = ?", [orchestration, id]);
}

export function updateProjectMemoryArch(db: Database, id: string, memoryArch: string): void {
  db.run("UPDATE projects SET memory_arch = ? WHERE id = ?", [memoryArch, id]);
}

// ─── Row Types ──────────────────────────────────────────────────────────

export interface TaskRow {
  id: number;
  board_id: string | null;
  group_id: string | null;
  title: string;
  description: string;
  prerequisites: string;
  deliverables: string;
  status: string;
  validation_mode: string;
  creator_id: string;
  creator_name: string;
  standing: number;
  parent_task_id: number | null;
  priority: number;
  progress: number;
  created_at: number;
  updated_at: number;
}

export interface TaskClaimRow {
  task_id: number;
  entity_id: string;
  entity_name: string;
  status: string;
  submission_text: string | null;
  claimed_at: number;
  submitted_at: number | null;
  resolved_at: number | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  bundle_id: number | null;
  pool_id: string | null;
  group_id: string | null;
  orchestration: string;
  memory_arch: string;
  status: string;
  created_by: string;
  created_at: number;
}
