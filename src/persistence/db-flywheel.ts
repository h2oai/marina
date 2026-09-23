// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { EntityId } from "../types";
import { liveEntityIdSql } from "./db-entities";

// ─── Flywheel workspace bindings, sandbox projects and services ────────────

export function saveFlywheelBinding(
  db: Database,
  entityKey: string,
  opts: {
    entityId: EntityId;
    sessionId: string;
    sandboxId: string;
    image: string;
    keepAlive: boolean;
    state: FlywheelBindingState;
    lifecycleExpiresAt?: number;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO flywheel_bindings
        (entity_id, session_id, sandbox_id, image, keep_alive, state, created_at, updated_at,
         last_activity_at, lifecycle_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         session_id = excluded.session_id,
         sandbox_id = excluded.sandbox_id,
         image = excluded.image,
         keep_alive = excluded.keep_alive,
         state = excluded.state,
         last_activity_at = excluded.last_activity_at,
         lifecycle_expires_at = excluded.lifecycle_expires_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    [
      entityKey,
      opts.sessionId,
      opts.sandboxId,
      opts.image,
      opts.keepAlive ? 1 : 0,
      opts.state,
      now,
      now,
      now,
      opts.lifecycleExpiresAt ?? null,
    ],
  );
}

// flywheel_bindings / coding_projects / coding_services are keyed by the
// durable account id (migration 117). Reads project the live entity id back
// so `row.entity_id === entity.id` comparisons in callers keep working.
export function listFlywheelBindings(reader: Database): FlywheelBindingRow[] {
  return reader
    .query(
      `SELECT fb.*, ${liveEntityIdSql("fb")} AS entity_id
         FROM flywheel_bindings fb ORDER BY fb.created_at`,
    )
    .all() as FlywheelBindingRow[];
}

/** The binding owned by this entity's account (indexed PK lookup, not a scan). */
export function getFlywheelBinding(
  reader: Database,
  entityKey: string,
): FlywheelBindingRow | undefined {
  return (
    (reader
      .query(
        `SELECT fb.*, ${liveEntityIdSql("fb")} AS entity_id
           FROM flywheel_bindings fb WHERE fb.entity_id = ?`,
      )
      .get(entityKey) as FlywheelBindingRow | null) ?? undefined
  );
}

export function updateFlywheelBinding(
  db: Database,
  entityKey: string,
  fields: {
    state?: FlywheelBindingState;
    publishedUrl?: string | null;
    lastError?: string | null;
    reconciledAt?: number | null;
    activeProjectId?: string | null;
    guestCwd?: string | null;
    networkProfile?: string;
    networkProfileEnforced?: boolean;
    lastActivityAt?: number;
    lifecycleExpiresAt?: number | null;
    hibernatedReason?: string | null;
  },
): void {
  const assignments = ["updated_at = ?"];
  const values: Array<string | number | null> = [Date.now()];
  if (fields.state !== undefined) {
    assignments.push("state = ?");
    values.push(fields.state);
  }
  if (fields.publishedUrl !== undefined) {
    assignments.push("published_url = ?");
    values.push(fields.publishedUrl);
  }
  if (fields.lastError !== undefined) {
    assignments.push("last_error = ?");
    values.push(fields.lastError);
  }
  if (fields.reconciledAt !== undefined) {
    assignments.push("reconciled_at = ?");
    values.push(fields.reconciledAt);
  }
  if (fields.activeProjectId !== undefined) {
    assignments.push("active_project_id = ?");
    values.push(fields.activeProjectId);
  }
  if (fields.guestCwd !== undefined) {
    assignments.push("guest_cwd = ?");
    values.push(fields.guestCwd);
  }
  if (fields.networkProfile !== undefined) {
    assignments.push("network_profile = ?");
    values.push(fields.networkProfile);
  }
  if (fields.networkProfileEnforced !== undefined) {
    assignments.push("network_profile_enforced = ?");
    values.push(fields.networkProfileEnforced ? 1 : 0);
  }
  if (fields.lastActivityAt !== undefined) {
    assignments.push("last_activity_at = ?");
    values.push(fields.lastActivityAt);
  }
  if (fields.lifecycleExpiresAt !== undefined) {
    assignments.push("lifecycle_expires_at = ?");
    values.push(fields.lifecycleExpiresAt);
  }
  if (fields.hibernatedReason !== undefined) {
    assignments.push("hibernated_reason = ?");
    values.push(fields.hibernatedReason);
  }
  values.push(entityKey);
  db.run(`UPDATE flywheel_bindings SET ${assignments.join(", ")} WHERE entity_id = ?`, values);
}

export function deleteFlywheelBinding(db: Database, entityKey: string): void {
  db.run("DELETE FROM flywheel_bindings WHERE entity_id = ?", [entityKey]);
}

export function createCodingProject(
  db: Database,
  reader: Database,
  entityKey: string,
  project: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    name: string;
    sourceType: "empty" | "git" | "archive";
    sourceLocator?: string;
    guestPath: string;
    activeBranch?: string;
    baseRevision?: string;
  },
): CodingProjectRow {
  const now = Date.now();
  db.run(
    `INSERT INTO coding_projects
        (id, entity_id, sandbox_id, name, source_type, source_locator, guest_path,
         active_branch, base_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      project.id,
      entityKey,
      project.sandboxId,
      project.name,
      project.sourceType,
      project.sourceLocator ?? null,
      project.guestPath,
      project.activeBranch ?? null,
      project.baseRevision ?? null,
      now,
      now,
    ],
  );
  return getCodingProject(reader, project.id) as CodingProjectRow;
}

export function getCodingProject(reader: Database, id: string): CodingProjectRow | null {
  return reader
    .query(
      `SELECT cp.*, ${liveEntityIdSql("cp")} AS entity_id
         FROM coding_projects cp WHERE cp.id = ?`,
    )
    .get(id) as CodingProjectRow | null;
}

export function getCodingProjectForEntity(
  reader: Database,
  entityKey: string,
  selector: string,
): CodingProjectRow | null {
  return reader
    .query(
      `SELECT cp.*, ${liveEntityIdSql("cp")} AS entity_id
         FROM coding_projects cp WHERE cp.entity_id = ? AND (cp.id = ? OR cp.name = ?)`,
    )
    .get(entityKey, selector, selector) as CodingProjectRow | null;
}

export function listCodingProjects(reader: Database, entityKey: string): CodingProjectRow[] {
  return reader
    .query(
      `SELECT cp.*, ${liveEntityIdSql("cp")} AS entity_id
         FROM coding_projects cp WHERE cp.entity_id = ? ORDER BY cp.updated_at DESC`,
    )
    .all(entityKey) as CodingProjectRow[];
}

export function deleteCodingProjectsForSandbox(
  db: Database,
  entityKey: string,
  sandboxId: string,
): void {
  db.run("DELETE FROM coding_projects WHERE entity_id = ? AND sandbox_id = ?", [
    entityKey,
    sandboxId,
  ]);
}

export function deleteCodingProject(
  db: Database,
  entityKey: string,
  projectId: string,
  sandboxId: string,
): void {
  db.run("DELETE FROM coding_projects WHERE entity_id = ? AND id = ? AND sandbox_id = ?", [
    entityKey,
    projectId,
    sandboxId,
  ]);
}

export function updateCodingProject(
  db: Database,
  id: string,
  fields: Partial<{
    activeBranch: string | null;
    baseRevision: string | null;
    dirty: boolean;
    hasUnexportedChanges: boolean;
    exportedFingerprint: string | null;
    lastStatusAt: number | null;
    lastExportedAt: number | null;
  }>,
): void {
  const assignments = ["updated_at = ?"];
  const values: Array<string | number | null> = [Date.now()];
  const mapping: Array<[keyof typeof fields, string, (value: unknown) => string | number | null]> =
    [
      ["activeBranch", "active_branch", (value) => value as string | null],
      ["baseRevision", "base_revision", (value) => value as string | null],
      ["dirty", "dirty", (value) => (value ? 1 : 0)],
      ["hasUnexportedChanges", "has_unexported_changes", (value) => (value ? 1 : 0)],
      ["exportedFingerprint", "exported_fingerprint", (value) => value as string | null],
      ["lastStatusAt", "last_status_at", (value) => value as number | null],
      ["lastExportedAt", "last_exported_at", (value) => value as number | null],
    ];
  for (const [key, column, normalize] of mapping) {
    if (fields[key] === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(normalize(fields[key]));
  }
  values.push(id);
  db.run(`UPDATE coding_projects SET ${assignments.join(", ")} WHERE id = ?`, values);
}

export function createCodingService(
  db: Database,
  reader: Database,
  entityKey: string,
  service: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    projectId?: string;
    sessionId: string;
    name: string;
    command: string[];
    guestCwd: string;
    logPath: string;
    pid: number;
    processIdentity: string;
    port?: number;
  },
): CodingServiceRow {
  const now = Date.now();
  db.run(
    `INSERT INTO coding_services
        (id, entity_id, sandbox_id, project_id, session_id, name, command_json,
         guest_cwd, log_path, pid, process_identity, port, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    [
      service.id,
      entityKey,
      service.sandboxId,
      service.projectId ?? null,
      service.sessionId,
      service.name,
      JSON.stringify(service.command),
      service.guestCwd,
      service.logPath,
      service.pid,
      service.processIdentity,
      service.port ?? null,
      now,
      now,
      now,
    ],
  );
  return getCodingService(reader, service.id) as CodingServiceRow;
}

export function getCodingService(reader: Database, id: string): CodingServiceRow | null {
  return reader
    .query(
      `SELECT cs.*, ${liveEntityIdSql("cs")} AS entity_id
         FROM coding_services cs WHERE cs.id = ?`,
    )
    .get(id) as CodingServiceRow | null;
}

export function getCodingServiceForEntity(
  reader: Database,
  entityKey: string,
  selector: string,
): CodingServiceRow | null {
  return reader
    .query(
      `SELECT cs.*, ${liveEntityIdSql("cs")} AS entity_id
         FROM coding_services cs WHERE cs.entity_id = ? AND (cs.id = ? OR cs.name = ?)`,
    )
    .get(entityKey, selector, selector) as CodingServiceRow | null;
}

export function listCodingServices(reader: Database, entityKey: string): CodingServiceRow[] {
  return reader
    .query(
      `SELECT cs.*, ${liveEntityIdSql("cs")} AS entity_id
         FROM coding_services cs WHERE cs.entity_id = ? ORDER BY cs.updated_at DESC`,
    )
    .all(entityKey) as CodingServiceRow[];
}

export function listExpiredCodingServicePublications(
  reader: Database,
  now = Date.now(),
): CodingServiceRow[] {
  return reader
    .query(
      `SELECT cs.*, ${liveEntityIdSql("cs")} AS entity_id FROM coding_services cs
         WHERE cs.published_subdomain IS NOT NULL
           AND cs.publication_expires_at IS NOT NULL
           AND cs.publication_expires_at <= ?
         ORDER BY cs.publication_expires_at`,
    )
    .all(now) as CodingServiceRow[];
}

export function hasRunningCodingServices(
  reader: Database,
  entityKey: string,
  sandboxId: string,
): boolean {
  return (
    reader
      .query(
        "SELECT 1 present FROM coding_services WHERE entity_id = ? AND sandbox_id = ? AND status IN ('running', 'unknown') LIMIT 1",
      )
      .get(entityKey, sandboxId) !== null
  );
}

export function recordFlywheelOperation(
  db: Database,
  operation: {
    entityId?: EntityId;
    operation: string;
    outcome: "success" | "failure" | "blocked";
    durationMs: number;
    byteCount?: number;
    detail?: string;
  },
): void {
  db.run(
    `INSERT INTO flywheel_operations
       (entity_id, operation, outcome, duration_ms, byte_count, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      operation.entityId ?? null,
      operation.operation,
      operation.outcome,
      Math.max(0, Math.trunc(operation.durationMs)),
      operation.byteCount ?? null,
      operation.detail?.slice(0, 500) ?? null,
      Date.now(),
    ],
  );
}

export function pruneFlywheelOperations(db: Database, before: number): number {
  return db.run("DELETE FROM flywheel_operations WHERE created_at < ?", [before]).changes;
}

export function getFlywheelOperationSummary(
  reader: Database,
  since = Date.now() - 24 * 60 * 60 * 1000,
): FlywheelOperationSummary[] {
  return reader
    .query(
      `SELECT operation, outcome, COUNT(*) count,
                CAST(AVG(duration_ms) AS INTEGER) avg_duration_ms,
                COALESCE(SUM(byte_count), 0) byte_count
         FROM flywheel_operations WHERE created_at >= ?
         GROUP BY operation, outcome ORDER BY operation, outcome`,
    )
    .all(since) as FlywheelOperationSummary[];
}

export function updateCodingService(
  db: Database,
  id: string,
  fields: Partial<{
    pid: number | null;
    processIdentity: string | null;
    status: string;
    publishedUrl: string | null;
    publishedSubdomain: string | null;
    publicationExpiresAt: number | null;
    lastError: string | null;
    startedAt: number | null;
    stoppedAt: number | null;
  }>,
): void {
  const assignments = ["updated_at = ?"];
  const values: Array<string | number | null> = [Date.now()];
  const mapping: Array<[keyof typeof fields, string]> = [
    ["pid", "pid"],
    ["processIdentity", "process_identity"],
    ["status", "status"],
    ["publishedUrl", "published_url"],
    ["publishedSubdomain", "published_subdomain"],
    ["publicationExpiresAt", "publication_expires_at"],
    ["lastError", "last_error"],
    ["startedAt", "started_at"],
    ["stoppedAt", "stopped_at"],
  ];
  for (const [key, column] of mapping) {
    if (fields[key] === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(fields[key] as string | number | null);
  }
  values.push(id);
  db.run(`UPDATE coding_services SET ${assignments.join(", ")} WHERE id = ?`, values);
}

export function stopCodingServicesForSandbox(
  db: Database,
  entityKey: string,
  sandboxId: string,
  reason: string,
): void {
  const now = Date.now();
  db.run(
    `UPDATE coding_services
       SET status = 'stopped', pid = NULL, process_identity = NULL, last_error = ?, stopped_at = ?, updated_at = ?
       WHERE entity_id = ? AND sandbox_id = ? AND status = 'running'`,
    [reason, now, now, entityKey, sandboxId],
  );
}

export function markCodingServicesUnknownForSandbox(
  db: Database,
  entityKey: string,
  sandboxId: string,
  reason: string,
): void {
  db.run(
    `UPDATE coding_services
       SET status = 'unknown', last_error = ?, updated_at = ?
       WHERE entity_id = ? AND sandbox_id = ? AND status = 'running'`,
    [reason, Date.now(), entityKey, sandboxId],
  );
}

export function createCodingServiceProbe(
  db: Database,
  probe: {
    serviceId: string;
    entityId: EntityId;
    sandboxId: string;
    path: string;
    httpStatus?: number;
    durationMs: number;
    success: boolean;
    error?: string;
  },
): CodingServiceProbeRow {
  const row: CodingServiceProbeRow = {
    id: `probe_${crypto.randomUUID().slice(0, 12)}`,
    service_id: probe.serviceId,
    entity_id: probe.entityId,
    sandbox_id: probe.sandboxId,
    path: probe.path,
    http_status: probe.httpStatus ?? null,
    duration_ms: probe.durationMs,
    success: probe.success ? 1 : 0,
    error: probe.error ?? null,
    created_at: Date.now(),
  };
  db.run(
    `INSERT INTO coding_service_probes
       (id, service_id, entity_id, sandbox_id, path, http_status, duration_ms, success, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.service_id,
      row.entity_id,
      row.sandbox_id,
      row.path,
      row.http_status,
      row.duration_ms,
      row.success,
      row.error,
      row.created_at,
    ],
  );
  return row;
}

export function listCodingServiceProbes(
  reader: Database,
  serviceId: string,
  limit = 20,
): CodingServiceProbeRow[] {
  return reader
    .query(
      "SELECT * FROM coding_service_probes WHERE service_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(serviceId, Math.max(1, Math.min(100, limit))) as CodingServiceProbeRow[];
}

export function saveFlywheelCredentialBinding(
  db: Database,
  binding: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    profileName: string;
    purpose: string;
    state: string;
    expiresAt?: number;
    lastError?: string;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO flywheel_credential_bindings
       (id, entity_id, sandbox_id, profile_name, purpose, state, expires_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, sandbox_id, profile_name, purpose) DO UPDATE SET
         state = excluded.state, expires_at = excluded.expires_at,
         last_error = excluded.last_error, updated_at = excluded.updated_at`,
    [
      binding.id,
      binding.entityId,
      binding.sandboxId,
      binding.profileName,
      binding.purpose,
      binding.state,
      binding.expiresAt ?? null,
      binding.lastError ?? null,
      now,
      now,
    ],
  );
}

export function listFlywheelCredentialBindings(
  reader: Database,
  entityId: EntityId,
): FlywheelCredentialBindingRow[] {
  return reader
    .query(
      "SELECT * FROM flywheel_credential_bindings WHERE entity_id = ? ORDER BY updated_at DESC",
    )
    .all(entityId) as FlywheelCredentialBindingRow[];
}

// ─── Row types ────────────────────────────────────────────────────────────

export type FlywheelBindingState =
  | "creating"
  | "running"
  | "hibernated"
  | "unavailable"
  | "stopping";

export interface FlywheelBindingRow {
  entity_id: string;
  session_id: string;
  sandbox_id: string;
  image: string;
  keep_alive: number;
  state: FlywheelBindingState;
  published_url: string | null;
  active_project_id: string | null;
  guest_cwd: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  reconciled_at: number | null;
  network_profile: string;
  network_profile_enforced: number;
  last_activity_at: number | null;
  lifecycle_expires_at: number | null;
  hibernated_reason: string | null;
}

export interface FlywheelOperationSummary {
  operation: string;
  outcome: string;
  count: number;
  avg_duration_ms: number;
  byte_count: number;
}

export interface FlywheelCredentialBindingRow {
  id: string;
  entity_id: string;
  sandbox_id: string;
  profile_name: string;
  purpose: string;
  state: string;
  expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CodingProjectRow {
  id: string;
  entity_id: string;
  sandbox_id: string;
  name: string;
  source_type: "empty" | "git" | "archive";
  source_locator: string | null;
  guest_path: string;
  active_branch: string | null;
  base_revision: string | null;
  dirty: number;
  has_unexported_changes: number;
  exported_fingerprint: string | null;
  last_status_at: number | null;
  last_exported_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CodingServiceRow {
  id: string;
  entity_id: string;
  sandbox_id: string;
  project_id: string | null;
  session_id: string;
  name: string;
  command_json: string;
  guest_cwd: string;
  log_path: string;
  pid: number | null;
  process_identity: string | null;
  port: number | null;
  status: string;
  restart_policy: string;
  published_url: string | null;
  published_subdomain: string | null;
  publication_expires_at: number | null;
  last_error: string | null;
  started_at: number | null;
  stopped_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CodingServiceProbeRow {
  id: string;
  service_id: string;
  entity_id: string;
  sandbox_id: string;
  path: string;
  http_status: number | null;
  duration_ms: number;
  success: number;
  error: string | null;
  created_at: number;
}
