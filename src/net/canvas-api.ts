// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { StorageProvider } from "../storage/provider";
import type { EntityId } from "../types";
import { authenticateRequest } from "./auth-middleware";
import type { CanvasBroadcaster } from "./canvas-ws";
import { corsHeaders } from "./cors";

function jsonWithOrigin(origin: string | null) {
  return (data: unknown, status = 200): Response =>
    Response.json(data, { status, headers: corsHeaders(origin) });
}

function resolveNodeUrl(
  node: { asset_id: string | null; data: string },
  db: MarinaDB,
  storage?: StorageProvider,
): string | undefined {
  if (!node.asset_id || !storage) return undefined;
  const asset = db.getAsset(node.asset_id);
  return asset ? storage.resolve(asset.storage_key) : undefined;
}

function encodeNodeDataForUpdate(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (typeof data !== "string") return JSON.stringify(data);
  try {
    JSON.parse(data);
    return data;
  } catch {
    return JSON.stringify({ content: data });
  }
}

function actorNameForRequest(
  body: Record<string, unknown>,
  engine: Engine | undefined,
  entityId: EntityId | undefined,
): string {
  const explicit = body.actorName ?? body.claimantName ?? body.completerName;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (engine && entityId) {
    const entity = engine.entities.get(entityId);
    if (entity) return entity.name;
  }
  return "api";
}

function intentErrorResponse(
  json: (data: unknown, status?: number) => Response,
  result: { reason: string; status?: string },
): Response {
  if (result.reason === "not_found") return json({ error: "Node not found" }, 404);
  if (result.reason === "no_intent") return json({ error: "Node has no intent" }, 400);
  return json({ error: `Intent is ${result.status ?? "not in the required state"}` }, 409);
}

export interface CanvasNodeCreatedEvent {
  nodeId: string;
  canvasId: string;
  type: string;
  creatorName: string;
  parentNodeId: string | null;
  data: Record<string, unknown>;
}

/** Handle REST API requests for /api/canvases. */
export async function handleCanvasApi(
  url: URL,
  method: string,
  req: Request,
  db: MarinaDB,
  storage?: StorageProvider,
  broadcaster?: CanvasBroadcaster,
  engine?: Engine,
  onNodeCreated?: (event: CanvasNodeCreatedEvent) => void,
): Promise<Response> {
  const json = jsonWithOrigin(req.headers.get("Origin"));
  let authenticatedEntityId: EntityId | undefined;

  // Reads are public: the canvas is an observability surface — the same world
  // content is already streamed to any client over the unauthenticated
  // /dashboard-ws + canvas WS broadcasts, and /who pages are public. A fresh,
  // not-yet-logged-in visitor must be able to view the world canvas instead of
  // getting a 401 (which renders as an empty canvas + raw error). Mutations
  // (POST/PATCH/DELETE) still require a valid session token.
  if (engine && method !== "GET") {
    const auth = authenticateRequest(req, engine);
    if ("error" in auth) return auth.error;
    authenticatedEntityId = auth.entityId;
  }

  const intentActionMatch = url.pathname.match(
    /^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)\/intent\/(claim|complete|fail)$/,
  );
  if (intentActionMatch && method === "POST") {
    const canvasId = decodeURIComponent(intentActionMatch[1]!);
    const nodeId = decodeURIComponent(intentActionMatch[2]!);
    const action = intentActionMatch[3]!;
    const node = db.getNode(nodeId);
    if (!node || node.canvas_id !== canvasId) return json({ error: "Node not found" }, 404);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const actorName = actorNameForRequest(body, engine, authenticatedEntityId);

    if (action === "claim") {
      const result = db.claimCanvasIntent(node.id, actorName);
      if (!result.ok) return intentErrorResponse(json, result);
      const parsed = JSON.parse(result.node.data);
      const responseNode = { ...result.node, data: parsed };
      broadcaster?.broadcast({ type: "node_updated", canvasId, nodeId, changes: responseNode });
      engine?.logEvent({
        type: "canvas_intent",
        entity: (authenticatedEntityId ?? result.node.creator_name) as EntityId,
        canvasId,
        nodeId,
        prompt: result.intent.prompt,
        status: "active",
        timestamp: Date.now(),
      });
      return json({ ok: true, node: responseNode, intent: result.intent });
    }

    if (action === "complete") {
      const resultText = typeof body.result === "string" ? body.result.trim() : "";
      if (!resultText) return json({ error: "Missing result" }, 400);
      const resultData =
        body.data && typeof body.data === "object" && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : undefined;
      const result = db.completeCanvasIntent(node.id, {
        result: resultText,
        resultType: typeof body.type === "string" ? body.type : undefined,
        resultData,
        completerName: actorName,
      });
      if (!result.ok) return intentErrorResponse(json, result);
      const responseNode = { ...result.node, data: JSON.parse(result.node.data) };
      const responseResultNode = { ...result.resultNode, data: JSON.parse(result.resultNode.data) };
      broadcaster?.broadcast({ type: "node_updated", canvasId, nodeId, changes: responseNode });
      broadcaster?.broadcast({
        type: "node_added",
        canvasId,
        node: responseResultNode,
      });
      engine?.logEvent({
        type: "canvas_intent",
        entity: (authenticatedEntityId ?? result.node.creator_name) as EntityId,
        canvasId,
        nodeId,
        prompt: result.intent.prompt,
        status: "done",
        timestamp: Date.now(),
      });
      return json({
        ok: true,
        node: responseNode,
        resultNode: responseResultNode,
        intent: result.intent,
      });
    }

    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "No reason given";
    const result = db.failCanvasIntent(node.id, reason);
    if (!result.ok) return intentErrorResponse(json, result);
    const responseNode = { ...result.node, data: JSON.parse(result.node.data) };
    broadcaster?.broadcast({ type: "node_updated", canvasId, nodeId, changes: responseNode });
    engine?.logEvent({
      type: "canvas_intent",
      entity: (authenticatedEntityId ?? result.node.creator_name) as EntityId,
      canvasId,
      nodeId,
      prompt: result.intent.prompt,
      status: "failed",
      timestamp: Date.now(),
    });
    return json({ ok: true, node: responseNode, intent: result.intent });
  }
  // DELETE /api/canvases/:id/nodes/:nodeId
  const nodeMatch = url.pathname.match(/^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)$/);
  if (nodeMatch) {
    const canvasId = decodeURIComponent(nodeMatch[1]!);
    const nodeId = decodeURIComponent(nodeMatch[2]!);

    if (method === "DELETE") {
      // Fetch the node first so we can clean up its asset
      const node = db.getNode(nodeId);
      if (!node) return json({ error: "Node not found" }, 404);
      const deleted = db.deleteNode(nodeId);
      if (!deleted) return json({ error: "Node not found" }, 404);
      // Clean up associated asset file and DB row
      if (node.asset_id && storage) {
        const asset = db.getAsset(node.asset_id);
        if (asset) {
          await storage.delete(asset.storage_key);
          db.deleteAsset(node.asset_id);
        }
      }
      broadcaster?.broadcast({ type: "node_deleted", canvasId, nodeId });
      return json({ ok: true, id: nodeId });
    }

    if (method === "PATCH") {
      const body = (await req.json()) as Record<string, unknown>;
      const updated = db.updateNode(nodeId, {
        x: body.x as number | undefined,
        y: body.y as number | undefined,
        width: body.width as number | undefined,
        height: body.height as number | undefined,
        data: encodeNodeDataForUpdate(body.data),
      });
      if (!updated) return json({ error: "Node not found" }, 404);
      const node = db.getNode(nodeId)!;
      const parsed = JSON.parse(node.data);
      const nodeUrl = resolveNodeUrl(node, db, storage);
      const asset = node.asset_id ? db.getAsset(node.asset_id) : undefined;
      const enriched = {
        ...node,
        data: {
          ...parsed,
          url: nodeUrl,
          filename: asset?.filename ?? parsed.filename,
          mime: asset?.mime_type ?? parsed.mime,
        },
      };
      broadcaster?.broadcast({
        type: "node_updated",
        canvasId,
        nodeId,
        changes: enriched,
      });

      // Emit engine event when an intent is set or updated
      if (engine && parsed.intent && typeof parsed.intent.prompt === "string") {
        const intentStatus = parsed.intent.status as string;
        if (["pending", "active", "done", "failed"].includes(intentStatus)) {
          engine.logEvent({
            type: "canvas_intent",
            entity: (parsed.intent.claimedBy ?? node.creator_name) as EntityId,
            canvasId,
            nodeId,
            prompt: parsed.intent.prompt,
            status: intentStatus as "pending" | "active" | "done" | "failed",
            timestamp: Date.now(),
          });
        }
      }

      return json(enriched);
    }

    // GET single node
    if (method === "GET") {
      const node = db.getNode(nodeId);
      if (!node || node.canvas_id !== canvasId) return json({ error: "Node not found" }, 404);
      const parsed = JSON.parse(node.data);
      const nodeUrl = resolveNodeUrl(node, db, storage);
      const asset = node.asset_id ? db.getAsset(node.asset_id) : undefined;
      return json({
        ...node,
        data: {
          ...parsed,
          url: nodeUrl,
          filename: asset?.filename ?? parsed.filename,
          mime: asset?.mime_type ?? parsed.mime,
        },
      });
    }
  }

  // POST /api/canvases/:id/nodes — add node
  const nodesMatch = url.pathname.match(/^\/api\/canvases\/([^/]+)\/nodes$/);
  if (nodesMatch && method === "POST") {
    const canvasId = decodeURIComponent(nodesMatch[1]!);
    const canvas = db.getCanvas(canvasId);
    if (!canvas) return json({ error: "Canvas not found" }, 404);

    const body = (await req.json()) as Record<string, unknown>;
    const id = crypto.randomUUID();
    db.createNode({
      id,
      canvasId,
      type: (body.type as string) ?? "text",
      x: body.x as number | undefined,
      y: body.y as number | undefined,
      width: body.width as number | undefined,
      height: body.height as number | undefined,
      assetId: body.asset_id as string | undefined,
      data: body.data as Record<string, unknown> | undefined,
      creatorName: (body.creator_name as string) ?? "api",
      parentNodeId: body.parent_node_id as string | undefined,
    });

    const node = db.getNode(id)!;
    const parsed = JSON.parse(node.data);
    const url = resolveNodeUrl(node, db, storage);
    const asset = node.asset_id ? db.getAsset(node.asset_id) : undefined;
    const enriched = {
      ...node,
      data: {
        ...parsed,
        url,
        filename: asset?.filename ?? parsed.filename,
        mime: asset?.mime_type ?? parsed.mime,
      },
    };
    broadcaster?.broadcast({ type: "node_added", canvasId, node: enriched });
    onNodeCreated?.({
      nodeId: id,
      canvasId,
      type: (body.type as string) ?? "text",
      creatorName: (body.creator_name as string) ?? "api",
      parentNodeId: (body.parent_node_id as string) ?? null,
      data: parsed,
    });
    if (
      engine &&
      parsed.intent &&
      typeof parsed.intent === "object" &&
      typeof parsed.intent.prompt === "string" &&
      parsed.intent.status === "pending"
    ) {
      engine.logEvent({
        type: "canvas_intent",
        entity: node.creator_name as EntityId,
        canvasId,
        nodeId: id,
        prompt: parsed.intent.prompt,
        status: "pending",
        timestamp: Date.now(),
      });
    }
    return json(enriched, 201);
  }

  // Canvas detail + delete
  const canvasMatch = url.pathname.match(/^\/api\/canvases\/([^/]+)$/);
  if (canvasMatch) {
    const id = decodeURIComponent(canvasMatch[1]!);

    if (method === "DELETE") {
      const deleted = db.deleteCanvas(id);
      if (!deleted) return json({ error: "Canvas not found" }, 404);
      return json({ ok: true, id });
    }

    // GET canvas detail with nodes + first-class edges
    if (method === "GET") {
      const canvas = db.getCanvas(id);
      if (!canvas) return json({ error: "Canvas not found" }, 404);
      const nodes = db.getNodesByCanvas(id).map((n) => {
        const parsed = JSON.parse(n.data);
        const url = resolveNodeUrl(n, db, storage);
        const asset = n.asset_id ? db.getAsset(n.asset_id) : undefined;
        return {
          ...n,
          data: {
            ...parsed,
            url,
            filename: asset?.filename ?? parsed.filename,
            mime: asset?.mime_type ?? parsed.mime,
          },
        };
      });
      const edges = db.getCanvasEdges(id).map((e) => ({
        id: e.id,
        sourceId: e.source_id,
        targetId: e.target_id,
        relationship: e.relationship,
        data: e.data ? JSON.parse(e.data) : null,
        creatorName: e.creator_name,
        createdAt: e.created_at,
      }));
      return json({ ...canvas, nodes, edges });
    }
  }

  // POST /api/canvases — create canvas
  if (url.pathname === "/api/canvases" && method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const name = body.name as string;
    if (!name) return json({ error: "Name is required" }, 400);

    const existing = db.getCanvasByName(name);
    if (existing) return json({ error: "Canvas name already exists" }, 409);

    const id = crypto.randomUUID();
    db.createCanvas({
      id,
      name,
      description: (body.description as string) ?? "",
      scope: (body.scope as string) ?? "global",
      scopeId: body.scope_id as string | undefined,
      creatorName: (body.creator_name as string) ?? "api",
    });

    return json(db.getCanvas(id), 201);
  }

  // GET /api/canvases — list canvases
  if (url.pathname === "/api/canvases" && method === "GET") {
    const scope = url.searchParams.get("scope") ?? undefined;
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const canvases = db.listCanvases({ scope, limit });
    return json(canvases);
  }

  return json({ error: "Not found" }, 404);
}
