// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Gateways ──────────────────────────────────────────────────────────────

export function createGateway(
  db: Database,
  opts: { id: string; name: string; url: string; createdBy: string },
): void {
  db.run("INSERT INTO gateways (id, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?)", [
    opts.id,
    opts.name,
    opts.url,
    opts.createdBy,
    Date.now(),
  ]);
}

export function getGatewayByName(db: Database, name: string): GatewayRow | undefined {
  return (
    (db.query("SELECT * FROM gateways WHERE name = ?").get(name) as GatewayRow | null) ?? undefined
  );
}

export function listGateways(db: Database, status?: string): GatewayRow[] {
  if (status) {
    return db
      .query("SELECT * FROM gateways WHERE status = ? ORDER BY name")
      .all(status) as GatewayRow[];
  }
  return db.query("SELECT * FROM gateways ORDER BY name").all() as GatewayRow[];
}

export function updateGatewayStatus(db: Database, id: string, status: string): void {
  db.run("UPDATE gateways SET status = ? WHERE id = ?", [status, id]);
}

export function deleteGateway(db: Database, id: string): void {
  db.run("DELETE FROM gateways WHERE id = ?", [id]);
}

export function addGatewayBridge(db: Database, gatewayId: string, channel: string): void {
  db.run("INSERT OR IGNORE INTO gateway_bridges (gateway_id, channel) VALUES (?, ?)", [
    gatewayId,
    channel,
  ]);
}

export function removeGatewayBridge(db: Database, gatewayId: string, channel: string): void {
  db.run("DELETE FROM gateway_bridges WHERE gateway_id = ? AND channel = ?", [gatewayId, channel]);
}

export function listGatewayBridges(db: Database, gatewayId: string): string[] {
  return (
    db.query("SELECT channel FROM gateway_bridges WHERE gateway_id = ?").all(gatewayId) as {
      channel: string;
    }[]
  ).map((r) => r.channel);
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface GatewayRow {
  id: string;
  name: string;
  url: string;
  created_by: string;
  created_at: number;
  status: string;
}
