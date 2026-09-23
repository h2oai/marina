// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { escapeLike } from "./fts";

// ─── Canvases, nodes, edges and intents ────────────────────────────────────

export function createCanvas(
  db: Database,
  canvas: {
    id: string;
    name: string;
    description?: string;
    scope?: string;
    scopeId?: string;
    creatorName: string;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO canvases (id, name, description, scope, scope_id, creator_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      canvas.id,
      canvas.name,
      canvas.description ?? "",
      canvas.scope ?? "global",
      canvas.scopeId ?? null,
      canvas.creatorName,
      now,
      now,
    ],
  );
}

export function getCanvas(db: Database, id: string): CanvasRow | undefined {
  return (db.query("SELECT * FROM canvases WHERE id = ?").get(id) as CanvasRow | null) ?? undefined;
}

export function getCanvasByName(db: Database, name: string): CanvasRow | undefined {
  return (
    (db.query("SELECT * FROM canvases WHERE name = ?").get(name) as CanvasRow | null) ?? undefined
  );
}

export function listCanvases(db: Database, opts?: { scope?: string; limit?: number }): CanvasRow[] {
  if (opts?.scope) {
    return db
      .query("SELECT * FROM canvases WHERE scope = ? ORDER BY updated_at DESC LIMIT ?")
      .all(opts.scope, opts?.limit ?? 50) as CanvasRow[];
  }
  return db
    .query("SELECT * FROM canvases ORDER BY updated_at DESC LIMIT ?")
    .all(opts?.limit ?? 50) as CanvasRow[];
}

/** Look up the per-entity workspace canvas, if one exists. */
export function getEntityCanvas(db: Database, entityId: string): CanvasRow | undefined {
  return (
    (db
      .query("SELECT * FROM canvases WHERE scope = 'entity' AND scope_id = ? LIMIT 1")
      .get(entityId) as CanvasRow | null) ?? undefined
  );
}

/**
 * Return the entity's canvas, lazily creating it on first access. Canvas
 * names have a UNIQUE constraint, so we try `"{name}'s canvas"` first and
 * fall back to an id-qualified name on collision. Per-entity addressing
 * always goes through scope lookup (`getEntityCanvas`), so the name is
 * mostly a human-readable label shown in the breadcrumb.
 */
export function ensureEntityCanvas(
  db: Database,
  entityId: string,
  entityName: string,
  creatorName: string,
): CanvasRow {
  const existing = getEntityCanvas(db, entityId);
  if (existing) return existing;
  const shortId = entityId.slice(-6);
  const candidates = [
    `${entityName}'s canvas`,
    `${entityName}'s canvas (${shortId})`,
    `canvas-${entityId}`,
  ];
  for (const name of candidates) {
    if (getCanvasByName(db, name)) continue;
    const id = crypto.randomUUID();
    try {
      createCanvas(db, {
        id,
        name,
        description: `${entityName}'s workspace`,
        scope: "entity",
        scopeId: entityId,
        creatorName,
      });
      const row = getCanvas(db, id);
      if (row) return row;
    } catch {
      // Name collided with a row the pre-check missed (race). Try the next.
    }
  }
  throw new Error(`Failed to create entity canvas for ${entityName}`);
}

export function deleteCanvas(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM canvases WHERE id = ?", [id]);
  return result.changes > 0;
}

export function createNode(
  db: Database,
  node: {
    id: string;
    canvasId: string;
    type: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    assetId?: string;
    data?: Record<string, unknown>;
    creatorName: string;
    parentNodeId?: string;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO canvas_nodes (id, canvas_id, type, x, y, width, height, asset_id, data, creator_name, parent_node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      node.id,
      node.canvasId,
      node.type,
      node.x ?? 0,
      node.y ?? 0,
      node.width ?? 300,
      node.height ?? 200,
      node.assetId ?? null,
      JSON.stringify(node.data ?? {}),
      node.creatorName,
      node.parentNodeId ?? null,
      now,
      now,
    ],
  );
  // Touch canvas updated_at
  db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [now, node.canvasId]);
}

export function getNode(db: Database, id: string): CanvasNodeRow | undefined {
  return (
    (db.query("SELECT * FROM canvas_nodes WHERE id = ?").get(id) as CanvasNodeRow | null) ??
    undefined
  );
}

export function getNodesByCanvas(db: Database, canvasId: string): CanvasNodeRow[] {
  return db
    .query("SELECT * FROM canvas_nodes WHERE canvas_id = ? ORDER BY created_at ASC")
    .all(canvasId) as CanvasNodeRow[];
}

/**
 * Delete all but the most recent `max` nodes on a canvas. Returns the
 * number of rows deleted. Used by FeedPublisher to bound the feed canvas
 * (without this, every event adds a permanent node — thousands over a
 * day, enough to hang the dashboard when it loads the canvas).
 */
export function trimCanvasNodes(db: Database, canvasId: string, max: number): number {
  const result = db.run(
    `DELETE FROM canvas_nodes
       WHERE canvas_id = ?
         AND id NOT IN (
           SELECT id FROM canvas_nodes
           WHERE canvas_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )`,
    [canvasId, canvasId, max],
  );
  return result.changes ?? 0;
}

/** Trim old canvas nodes and return their ids so live clients can converge. */
export function trimCanvasNodesWithIds(db: Database, canvasId: string, max: number): string[] {
  const rows = db
    .query(
      `SELECT id FROM canvas_nodes
         WHERE canvas_id = ?
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?`,
    )
    .all(canvasId, max) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  trimCanvasNodes(db, canvasId, max);
  return rows.map((row) => row.id);
}

export function updateNode(
  db: Database,
  id: string,
  updates: { x?: number; y?: number; width?: number; height?: number; data?: string },
): boolean {
  const node = getNode(db, id);
  if (!node) return false;
  const now = Date.now();
  db.run(
    `UPDATE canvas_nodes SET x = ?, y = ?, width = ?, height = ?, data = ?, updated_at = ?
       WHERE id = ?`,
    [
      updates.x ?? node.x,
      updates.y ?? node.y,
      updates.width ?? node.width,
      updates.height ?? node.height,
      updates.data ?? node.data,
      now,
      id,
    ],
  );
  db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [now, node.canvas_id]);
  return true;
}

export function listCanvasIntents(
  db: Database,
  options?: {
    statuses?: CanvasIntentStatus[];
    canvasName?: string;
    limit?: number;
    expireActiveMs?: number;
    now?: number;
  },
): CanvasIntentSummary[] {
  const now = options?.now ?? Date.now();
  if (options?.expireActiveMs) {
    expireCanvasIntentClaims(db, options.expireActiveMs, now);
  }

  const statuses = new Set(options?.statuses ?? ["pending", "active"]);
  const limit = options?.limit ?? 100;
  const rows = options?.canvasName
    ? db
        .query(
          `SELECT n.*, c.name AS canvas_name
             FROM canvas_nodes n
             JOIN canvases c ON c.id = n.canvas_id
             WHERE c.name = ?
             ORDER BY n.created_at ASC`,
        )
        .all(options.canvasName)
    : db
        .query(
          `SELECT n.*, c.name AS canvas_name
             FROM canvas_nodes n
             JOIN canvases c ON c.id = n.canvas_id
             ORDER BY n.created_at ASC`,
        )
        .all();

  const intents: CanvasIntentSummary[] = [];
  for (const row of rows as (CanvasNodeRow & { canvas_name: string })[]) {
    const intent = parseCanvasIntent(row.data);
    if (!intent || !statuses.has(intent.status)) continue;
    intents.push({
      nodeId: row.id,
      canvasId: row.canvas_id,
      canvasName: row.canvas_name,
      type: row.type,
      creatorName: row.creator_name,
      assetId: row.asset_id,
      parentNodeId: row.parent_node_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      intent,
    });
    if (intents.length >= limit) break;
  }
  return intents;
}

export function expireCanvasIntentClaims(
  db: Database,
  timeoutMs: number,
  now = Date.now(),
): number {
  const rows = db
    .query("SELECT * FROM canvas_nodes ORDER BY updated_at ASC")
    .all() as CanvasNodeRow[];
  let expired = 0;
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    const intent = readCanvasIntent(parsed);
    if (intent?.status !== "active") continue;
    const claimedAt = intent.claimedAt ?? row.updated_at;
    if (now - claimedAt <= timeoutMs) continue;

    parsed.intent = {
      ...intent,
      status: "pending",
      claimedBy: undefined,
      claimedAt: undefined,
    };
    if (updateNodeDataIfUnchanged(db, row, JSON.stringify(parsed), now)) expired++;
  }
  return expired;
}

export function claimCanvasIntent(
  db: Database,
  idOrPrefix: string,
  claimantName: string,
  now = Date.now(),
): CanvasIntentClaimResult {
  const node = resolveCanvasNode(db, idOrPrefix);
  if (!node) return { ok: false, reason: "not_found" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(node.data);
  } catch {
    return { ok: false, reason: "no_intent" };
  }

  const intent = readCanvasIntent(parsed);
  if (!intent) return { ok: false, reason: "no_intent" };
  if (intent.status !== "pending") {
    return { ok: false, reason: "not_pending", status: intent.status };
  }

  const claimed: CanvasIntentData = {
    ...intent,
    status: "active",
    claimedBy: claimantName,
    claimedAt: now,
  };
  parsed.intent = claimed;

  if (!updateNodeDataIfUnchanged(db, node, JSON.stringify(parsed), now)) {
    const latest = getNode(db, node.id);
    const latestIntent = latest ? parseCanvasIntent(latest.data) : undefined;
    return {
      ok: false,
      reason: latestIntent ? "not_pending" : "no_intent",
      status: latestIntent?.status,
    };
  }

  const updated = getNode(db, node.id) ?? node;
  return { ok: true, node: updated, intent: claimed };
}

export function completeCanvasIntent(
  db: Database,
  idOrPrefix: string,
  params: {
    result: string;
    resultType?: string;
    resultData?: Record<string, unknown>;
    completerName: string;
    now?: number;
  },
): CanvasIntentCompleteResult {
  const now = params.now ?? Date.now();
  const node = resolveCanvasNode(db, idOrPrefix);
  if (!node) return { ok: false, reason: "not_found" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(node.data);
  } catch {
    return { ok: false, reason: "no_intent" };
  }

  const intent = readCanvasIntent(parsed);
  if (!intent) return { ok: false, reason: "no_intent" };
  if (intent.status !== "active") {
    return { ok: false, reason: "not_active", status: intent.status };
  }

  const resultNodeId = crypto.randomUUID();
  const resultType = params.resultType ?? "text";
  let ok = false;
  try {
    db.transaction(() => {
      const baseResultData = params.resultData ?? { body: params.result };
      const resultData = {
        ...baseResultData,
        author: params.completerName,
        feedType: "intent_result",
        sourceNodeId: node.id,
        sourcePrompt: intent.prompt,
      };
      createNode(db, {
        id: resultNodeId,
        canvasId: node.canvas_id,
        type: resultType,
        data: resultData,
        creatorName: params.completerName,
        parentNodeId: node.id,
      });

      parsed.intent = { ...intent, status: "done", result: params.result, resultNodeId };
      ok = updateNodeDataIfUnchanged(db, node, JSON.stringify(parsed), now);
      if (!ok) {
        throw new Error("canvas_intent_conflict");
      }
    })();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "canvas_intent_conflict") {
      throw error;
    }
  }

  if (!ok) {
    const latest = getNode(db, node.id);
    const latestIntent = latest ? parseCanvasIntent(latest.data) : undefined;
    return {
      ok: false,
      reason: latestIntent ? "not_active" : "no_intent",
      status: latestIntent?.status,
    };
  }

  return {
    ok: true,
    node: getNode(db, node.id) ?? node,
    intent: { ...intent, status: "done", result: params.result, resultNodeId },
    resultNode: getNode(db, resultNodeId)!,
  };
}

export function failCanvasIntent(
  db: Database,
  idOrPrefix: string,
  reason: string,
  now = Date.now(),
): CanvasIntentFailResult {
  const node = resolveCanvasNode(db, idOrPrefix);
  if (!node) return { ok: false, reason: "not_found" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(node.data);
  } catch {
    return { ok: false, reason: "no_intent" };
  }

  const intent = readCanvasIntent(parsed);
  if (!intent) return { ok: false, reason: "no_intent" };
  if (intent.status !== "active") {
    return { ok: false, reason: "not_active", status: intent.status };
  }

  const failed: CanvasIntentData = { ...intent, status: "failed", failReason: reason };
  parsed.intent = failed;
  if (!updateNodeDataIfUnchanged(db, node, JSON.stringify(parsed), now)) {
    const latest = getNode(db, node.id);
    const latestIntent = latest ? parseCanvasIntent(latest.data) : undefined;
    return {
      ok: false,
      reason: latestIntent ? "not_active" : "no_intent",
      status: latestIntent?.status,
    };
  }

  return { ok: true, node: getNode(db, node.id) ?? node, intent: failed };
}

export function resolveCanvasNode(db: Database, idOrPrefix: string): CanvasNodeRow | undefined {
  const node = getNode(db, idOrPrefix);
  if (node) return node;
  if (idOrPrefix.length < 4) return undefined;
  const escapedPrefix = escapeLike(idOrPrefix);
  return (
    (db
      .query(
        "SELECT * FROM canvas_nodes WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at ASC LIMIT 1",
      )
      .get(`${escapedPrefix}%`) as CanvasNodeRow | null) ?? undefined
  );
}

function updateNodeDataIfUnchanged(
  db: Database,
  node: CanvasNodeRow,
  data: string,
  now: number,
): boolean {
  const result = db.run(
    "UPDATE canvas_nodes SET data = ?, updated_at = ? WHERE id = ? AND data = ?",
    [data, now, node.id, node.data],
  );
  if ((result.changes ?? 0) === 0) return false;
  db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [now, node.canvas_id]);
  return true;
}

export function getChildNodes(db: Database, parentNodeId: string): CanvasNodeRow[] {
  return db
    .query("SELECT * FROM canvas_nodes WHERE parent_node_id = ? ORDER BY created_at ASC")
    .all(parentNodeId) as CanvasNodeRow[];
}

export function getRootNodes(db: Database, canvasId: string): CanvasNodeRow[] {
  return db
    .query(
      "SELECT * FROM canvas_nodes WHERE canvas_id = ? AND parent_node_id IS NULL ORDER BY created_at DESC",
    )
    .all(canvasId) as CanvasNodeRow[];
}

export function deleteNode(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM canvas_nodes WHERE id = ?", [id]);
  return result.changes > 0;
}

export function createCanvasEdge(
  db: Database,
  edge: {
    id: string;
    canvasId: string;
    sourceId: string;
    targetId: string;
    relationship: string;
    data?: Record<string, unknown>;
    creatorName: string;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO canvas_edges (id, canvas_id, source_id, target_id, relationship, data, creator_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      edge.id,
      edge.canvasId,
      edge.sourceId,
      edge.targetId,
      edge.relationship,
      edge.data ? JSON.stringify(edge.data) : null,
      edge.creatorName,
      now,
    ],
  );
  db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [now, edge.canvasId]);
}

export function getCanvasEdges(db: Database, canvasId: string): CanvasEdgeRow[] {
  return db
    .query("SELECT * FROM canvas_edges WHERE canvas_id = ? ORDER BY created_at ASC")
    .all(canvasId) as CanvasEdgeRow[];
}

export function getCanvasEdge(db: Database, id: string): CanvasEdgeRow | undefined {
  return (
    (db.query("SELECT * FROM canvas_edges WHERE id = ?").get(id) as CanvasEdgeRow | null) ??
    undefined
  );
}

export function deleteCanvasEdge(db: Database, id: string): boolean {
  const edge = getCanvasEdge(db, id);
  if (!edge) return false;
  db.run("DELETE FROM canvas_edges WHERE id = ?", [id]);
  db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [Date.now(), edge.canvas_id]);
  return true;
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface CanvasRow {
  id: string;
  name: string;
  description: string;
  scope: string;
  scope_id: string | null;
  creator_name: string;
  created_at: number;
  updated_at: number;
}

export interface CanvasNodeRow {
  id: string;
  canvas_id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  asset_id: string | null;
  data: string;
  creator_name: string;
  parent_node_id: string | null;
  created_at: number;
  updated_at: number;
}

export type CanvasIntentStatus = "pending" | "active" | "done" | "failed";

export interface CanvasIntentData {
  prompt: string;
  status: CanvasIntentStatus;
  claimedBy?: string;
  claimedAt?: number;
  result?: string;
  resultNodeId?: string;
  failReason?: string;
}

export interface CanvasIntentSummary {
  nodeId: string;
  canvasId: string;
  canvasName: string;
  type: string;
  creatorName: string;
  assetId: string | null;
  parentNodeId: string | null;
  createdAt: number;
  updatedAt: number;
  intent: CanvasIntentData;
}

export type CanvasIntentClaimResult =
  | { ok: true; node: CanvasNodeRow; intent: CanvasIntentData }
  | {
      ok: false;
      reason: "not_found" | "no_intent" | "not_pending";
      status?: CanvasIntentStatus;
    };

export type CanvasIntentCompleteResult =
  | {
      ok: true;
      node: CanvasNodeRow;
      resultNode: CanvasNodeRow;
      intent: CanvasIntentData;
    }
  | {
      ok: false;
      reason: "not_found" | "no_intent" | "not_active";
      status?: CanvasIntentStatus;
    };

export type CanvasIntentFailResult =
  | { ok: true; node: CanvasNodeRow; intent: CanvasIntentData }
  | {
      ok: false;
      reason: "not_found" | "no_intent" | "not_active";
      status?: CanvasIntentStatus;
    };

export function parseCanvasIntent(data: string): CanvasIntentData | undefined {
  try {
    return readCanvasIntent(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function readCanvasIntent(value: unknown): CanvasIntentData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const intent = (value as { intent?: unknown }).intent;
  if (!intent || typeof intent !== "object") return undefined;
  const raw = intent as Record<string, unknown>;
  if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return undefined;
  if (!["pending", "active", "done", "failed"].includes(String(raw.status))) return undefined;
  return raw as unknown as CanvasIntentData;
}

export interface CanvasEdgeRow {
  id: string;
  canvas_id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  data: string | null;
  creator_name: string;
  created_at: number;
}
