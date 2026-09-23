// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Operational alerts ────────────────────────────────────────────────────

export function upsertOperationalAlert(
  db: Database,
  alert: {
    key: string;
    severity: "critical" | "warning" | "info";
    category: string;
    title: string;
    detail: string;
    remedy: string;
    kind?: string;
    sourceEntity?: string;
    targetEntity?: string;
    assignedTo?: string;
    actionLabel?: string;
    actionRef?: string;
    metadata?: Record<string, unknown>;
    deadlineAt?: number;
  },
): OperationalAlertRow {
  const now = Date.now();
  db.run(
    `INSERT INTO operational_alerts
       (alert_key,severity,category,title,detail,remedy,status,first_seen_at,last_seen_at,
        attention_kind,source_entity,target_entity,assigned_to,action_label,action_ref,metadata,deadline_at)
       VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(alert_key) DO UPDATE SET severity=excluded.severity, title=excluded.title,
       detail=excluded.detail, remedy=excluded.remedy, last_seen_at=excluded.last_seen_at,
       attention_kind=excluded.attention_kind, source_entity=excluded.source_entity,
       target_entity=excluded.target_entity, assigned_to=excluded.assigned_to,
       action_label=excluded.action_label, action_ref=excluded.action_ref,
       metadata=excluded.metadata, deadline_at=excluded.deadline_at,
       occurrences=operational_alerts.occurrences+1,
       status=CASE WHEN operational_alerts.status='resolved' THEN 'open' ELSE operational_alerts.status END,
       resolved_at=NULL, snoozed_until=NULL`,
    [
      alert.key,
      alert.severity,
      alert.category,
      alert.title,
      alert.detail,
      alert.remedy,
      now,
      now,
      alert.kind ?? "operational",
      alert.sourceEntity ?? null,
      alert.targetEntity ?? null,
      alert.assignedTo ?? null,
      alert.actionLabel ?? null,
      alert.actionRef ?? null,
      alert.metadata ? JSON.stringify(alert.metadata) : null,
      alert.deadlineAt ?? null,
    ],
  );
  return db
    .query("SELECT * FROM operational_alerts WHERE alert_key=?")
    .get(alert.key) as OperationalAlertRow;
}

export function listOperationalAlerts(
  db: Database,
  status?: "open" | "acknowledged" | "resolved",
  limit = 100,
): OperationalAlertRow[] {
  if (status)
    return db
      .query(
        "SELECT * FROM operational_alerts WHERE status=? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,last_seen_at DESC LIMIT ?",
      )
      .all(status, limit) as OperationalAlertRow[];
  return db
    .query(
      "SELECT * FROM operational_alerts ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,last_seen_at DESC LIMIT ?",
    )
    .all(limit) as OperationalAlertRow[];
}

export function setOperationalAlertStatus(
  db: Database,
  id: number,
  status: "acknowledged" | "resolved",
): boolean {
  const now = Date.now();
  const column = status === "acknowledged" ? "acknowledged_at" : "resolved_at";
  return (
    db.run(`UPDATE operational_alerts SET status=?, ${column}=? WHERE id=?`, [status, now, id])
      .changes > 0
  );
}

export function snoozeOperationalAlert(db: Database, id: number, until: number): boolean {
  return (
    db.run(
      "UPDATE operational_alerts SET snoozed_until=?, status='open' WHERE id=? AND status!='resolved'",
      [until, id],
    ).changes > 0
  );
}

export function resolveOperationalAlertsExcept(
  db: Database,
  category: string,
  activeKeys: string[],
): number {
  const now = Date.now();
  if (activeKeys.length === 0)
    return db.run(
      "UPDATE operational_alerts SET status='resolved',resolved_at=? WHERE category=? AND status!='resolved'",
      [now, category],
    ).changes;
  const placeholders = activeKeys.map(() => "?").join(",");
  return db.run(
    `UPDATE operational_alerts SET status='resolved',resolved_at=? WHERE category=? AND status!='resolved' AND alert_key NOT IN (${placeholders})`,
    [now, category, ...activeKeys],
  ).changes;
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface OperationalAlertRow {
  id: number;
  alert_key: string;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  remedy: string;
  status: "open" | "acknowledged" | "resolved";
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  acknowledged_at: number | null;
  resolved_at: number | null;
  attention_kind: string;
  source_entity: string | null;
  target_entity: string | null;
  assigned_to: string | null;
  action_label: string | null;
  action_ref: string | null;
  metadata: string | null;
  seen_at: number | null;
  snoozed_until: number | null;
  deadline_at: number | null;
}
