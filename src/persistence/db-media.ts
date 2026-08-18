// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

export type MediaJobStatus = "pending" | "running" | "succeeded" | "failed" | "blocked";
export type MediaJobType = "image" | "video";

export interface MediaJobRow {
  id: string;
  type: MediaJobType;
  status: MediaJobStatus;
  entity_name: string;
  entity_id: string | null;
  provider: string;
  model: string;
  prompt: string;
  options: string;
  error: string | null;
  asset_id: string | null;
  cost_estimate: number | null;
  provider_job_id: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export function insertMediaJob(
  db: Database,
  job: {
    id: string;
    type: MediaJobType;
    entityName: string;
    entityId: string | null;
    provider: string;
    model: string;
    prompt: string;
    options: Record<string, unknown>;
    costEstimate?: number | null;
    providerJobId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO media_jobs
      (id, type, status, entity_name, entity_id, provider, model, prompt, options, error, asset_id,
       cost_estimate, provider_job_id, metadata, created_at, updated_at, completed_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
    [
      job.id,
      job.type,
      job.entityName,
      job.entityId,
      job.provider,
      job.model,
      job.prompt,
      JSON.stringify(job.options ?? {}),
      job.costEstimate ?? null,
      job.providerJobId ?? null,
      job.metadata ? JSON.stringify(job.metadata) : null,
      now,
      now,
    ],
  );
}

export function updateMediaJob(
  db: Database,
  id: string,
  patch: Partial<{
    status: MediaJobStatus;
    assetId: string | null;
    error: string | null;
    costEstimate: number | null;
    providerJobId: string | null;
    metadata: Record<string, unknown> | null;
    options: Record<string, unknown>;
    completedAt: number | null;
  }>,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.assetId !== undefined) {
    fields.push("asset_id = ?");
    values.push(patch.assetId);
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (patch.costEstimate !== undefined) {
    fields.push("cost_estimate = ?");
    values.push(patch.costEstimate);
  }
  if (patch.providerJobId !== undefined) {
    fields.push("provider_job_id = ?");
    values.push(patch.providerJobId);
  }
  if (patch.metadata !== undefined) {
    fields.push("metadata = ?");
    values.push(patch.metadata ? JSON.stringify(patch.metadata) : null);
  }
  if (patch.options !== undefined) {
    fields.push("options = ?");
    values.push(JSON.stringify(patch.options));
  }
  if (patch.completedAt !== undefined) {
    fields.push("completed_at = ?");
    values.push(patch.completedAt);
  }
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  const sql = `UPDATE media_jobs SET ${fields.join(", ")} WHERE id = ?`;
  db.run(sql, values);
}

export function getMediaJob(db: Database, id: string): MediaJobRow | undefined {
  return (
    (db.query("SELECT * FROM media_jobs WHERE id = ?").get(id) as MediaJobRow | null) ?? undefined
  );
}

export function listMediaJobs(
  db: Database,
  opts: { limit?: number; entityName?: string } = {},
): MediaJobRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.entityName) {
    return db
      .query("SELECT * FROM media_jobs WHERE entity_name = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.entityName, limit) as MediaJobRow[];
  }
  return db
    .query("SELECT * FROM media_jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as MediaJobRow[];
}

export function countMediaJobsSince(
  db: Database,
  opts: { entityName?: string; type?: MediaJobType; since: number },
): number {
  const clauses = ["created_at >= ?"];
  const params: (string | number | null)[] = [opts.since];
  if (opts.entityName) {
    clauses.push("entity_name = ?");
    params.push(opts.entityName);
  }
  if (opts.type) {
    clauses.push("type = ?");
    params.push(opts.type);
  }
  const sql = `SELECT COUNT(*) as count FROM media_jobs WHERE ${clauses.join(" AND ")}`;
  const row = db.query(sql).get(...params) as { count: number } | null;
  return row?.count ?? 0;
}
