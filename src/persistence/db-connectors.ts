// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Connectors ────────────────────────────────────────────────────────────

export function createConnector(
  db: Database,
  conn: {
    id: string;
    name: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string;
    createdBy: string;
  },
): void {
  db.run(
    "INSERT INTO connectors (id, name, transport, url, command, args, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      conn.id,
      conn.name,
      conn.transport,
      conn.url ?? null,
      conn.command ?? null,
      conn.args ?? null,
      conn.createdBy,
      Date.now(),
    ],
  );
}

export function getConnector(db: Database, id: string): ConnectorRow | undefined {
  return (
    (db.query("SELECT * FROM connectors WHERE id = ?").get(id) as ConnectorRow | null) ?? undefined
  );
}

export function getConnectorByName(db: Database, name: string): ConnectorRow | undefined {
  return (
    (db.query("SELECT * FROM connectors WHERE name = ?").get(name) as ConnectorRow | null) ??
    undefined
  );
}

export function listConnectors(db: Database, status?: string): ConnectorRow[] {
  if (status) {
    return db
      .query("SELECT * FROM connectors WHERE status = ? ORDER BY name")
      .all(status) as ConnectorRow[];
  }
  return db.query("SELECT * FROM connectors ORDER BY name").all() as ConnectorRow[];
}

export function updateConnectorStatus(db: Database, id: string, status: string): void {
  db.run("UPDATE connectors SET status = ? WHERE id = ?", [status, id]);
}

export function updateConnectorAuth(
  db: Database,
  id: string,
  authType: string,
  authData: string,
): void {
  db.run("UPDATE connectors SET auth_type = ?, auth_data = ? WHERE id = ?", [
    authType,
    authData,
    id,
  ]);
}

export function deleteConnector(db: Database, id: string): void {
  db.run("DELETE FROM connectors WHERE id = ?", [id]);
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface ConnectorRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string | null;
  auth_type: string | null;
  auth_data: string | null;
  lifecycle: string;
  created_by: string;
  created_at: number;
  status: string;
}
