// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { StorageProvider } from "../storage/provider";
import type { EntityId } from "../types";
import { authenticateRequest } from "./auth-middleware";
import { buildCanvasPrincipal, resolveCanvasHttpPrincipal } from "./canvas-principal";
import { authorizeCanvasSubscription, type CanvasBroadcaster } from "./canvas-ws";
import { corsHeaders } from "./cors";

const CANVAS_NODE_TYPES = new Set([
  "image",
  "video",
  "pdf",
  "audio",
  "document",
  "text",
  "embed",
  "frame",
  "a2ui",
]);

const CANVAS_EDGE_RELATIONSHIPS = new Set([
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "relates_to",
  "supersedes",
  "derived_from",
  "part_of",
]);

function jsonWithOrigin(origin: string | null) {
  return (data: unknown, status = 200): Response =>
    Response.json(data, { status, headers: corsHeaders(origin) });
}

export function resolveNodeUrl(
  node: { asset_id: string | null; data: string },
  db: MarinaDB,
  storage?: StorageProvider,
): string | undefined {
  if (!node.asset_id || !storage) return undefined;
  const asset = db.getAsset(node.asset_id);
  return asset ? storage.resolve(asset.storage_key) : undefined;
}

/**
 * Canonical node-data enrichment for every node leaving the server: asset-backed
 * nodes get a resolvable `url` plus filename/mime fallbacks from the asset row.
 * Shared by the HTTP responses here and FeedPublisher's live WS broadcasts, so a
 * broadcast snapshot matches what a REST fetch of the same node would return.
 */
export function enrichNodeData(
  node: { asset_id: string | null; data: string },
  parsed: Record<string, unknown>,
  db: MarinaDB,
  storage?: StorageProvider,
): Record<string, unknown> {
  const asset = node.asset_id ? db.getAsset(node.asset_id) : undefined;
  return {
    ...parsed,
    url: resolveNodeUrl(node, db, storage),
    filename: asset?.filename ?? parsed.filename,
    mime: asset?.mime_type ?? parsed.mime,
  };
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
  if (engine && entityId) {
    const entity = engine.entities.get(entityId);
    if (entity) return entity.name;
  }
  const explicit = body.actorName ?? body.claimantName ?? body.completerName;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
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
  peerIp?: string,
): Promise<Response> {
  const json = jsonWithOrigin(req.headers.get("Origin"));
  let authenticatedEntityId: EntityId | undefined;

  // Reads of PUBLIC/SHARED canvases are open: the canvas is an observability
  // surface — the same world content is already streamed to any client over the
  // unauthenticated /dashboard-ws + canvas WS broadcasts, and /who pages are
  // public. A fresh, not-yet-logged-in visitor must be able to view the world
  // canvas instead of getting a 401. Mutations (POST/PATCH/DELETE) still require
  // a valid session token.
  //
  // BUT per-entity PRIVATE canvases (`scope === "entity"`) must NOT be readable
  // OR mutable over unauthenticated / non-owner HTTP — that would enumerate/read
  // private workspaces and let a non-owner create/update/delete nodes, delete the
  // canvas, or drive its intent lifecycle, bypassing the WS owner-scoping. We
  // resolve the caller principal once and apply the SAME rule
  // (`authorizeCanvasSubscription` via `buildCanvasPrincipal`) that the WS
  // subscription gate uses to EVERY canvas route — read and mutation alike — so
  // no path is left open (`canAccessCanvas`).
  if (engine && method !== "GET") {
    const auth = authenticateRequest(req, engine);
    if ("error" in auth) return auth.error;
    authenticatedEntityId = auth.entityId;
  }

  // Single owner/operator predicate for ALL private-canvas access (read AND
  // mutation). Loopback desktop reader → operator-equivalent (zero-config
  // preserved). Anonymous / non-owner remote caller → {} (public/shared allowed,
  // private denied). Public/shared canvases stay open to reads; their write
  // policy is unchanged — a valid session token is already required above for any
  // non-GET method, and `authorizeCanvasSubscription` returns true for them.
  const canvasPrincipal = engine
    ? buildCanvasPrincipal(resolveCanvasHttpPrincipal(req, engine, peerIp), engine, db)
    : { isOperator: true };
  const canAccessCanvas = (canvasId: string): boolean =>
    authorizeCanvasSubscription(db, canvasId, canvasPrincipal);

  const intentActionMatch = url.pathname.match(
    /^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)\/intent\/(claim|complete|fail)$/,
  );

  // Typed relationships are first-class Canvas data, not a dashboard-only
  // overlay. Keep HTTP mutations on the same DB + EngineEvent path used by
  // `canvas connect` so command, agent, and clickable workflows converge.
  const edgeMatch = url.pathname.match(/^\/api\/canvases\/([^/]+)\/edges(?:\/([^/]+))?$/);
  if (edgeMatch) {
    const canvasId = decodeURIComponent(edgeMatch[1]!);
    const edgeId = edgeMatch[2] ? decodeURIComponent(edgeMatch[2]) : undefined;
    if (!canAccessCanvas(canvasId)) return json({ error: "Canvas not found" }, 404);
    const canvas = db.getCanvas(canvasId);
    if (!canvas) return json({ error: "Canvas not found" }, 404);

    if (method === "POST" && !edgeId) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
      const targetId = typeof body.targetId === "string" ? body.targetId : "";
      const relationship =
        typeof body.relationship === "string" ? body.relationship.trim().toLowerCase() : "";
      if (!sourceId || !targetId || !relationship) {
        return json({ error: "sourceId, targetId, and relationship are required" }, 400);
      }
      if (sourceId === targetId) return json({ error: "A node cannot relate to itself" }, 400);
      if (!CANVAS_EDGE_RELATIONSHIPS.has(relationship)) {
        return json({ error: "Unsupported relationship" }, 400);
      }
      const source = db.getNode(sourceId);
      const target = db.getNode(targetId);
      if (!source || !target || source.canvas_id !== canvasId || target.canvas_id !== canvasId) {
        return json({ error: "Both nodes must belong to this canvas" }, 400);
      }
      const id = crypto.randomUUID();
      const creatorName = actorNameForRequest(body, engine, authenticatedEntityId);
      const data =
        body.data && typeof body.data === "object" && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : undefined;
      try {
        db.createCanvasEdge({
          id,
          canvasId,
          sourceId,
          targetId,
          relationship,
          data,
          creatorName,
        });
      } catch {
        return json({ error: "That relationship already exists" }, 409);
      }
      const row = db.getCanvasEdge(id)!;
      engine?.logEvent({
        type: "canvas_edge_created",
        entity: (authenticatedEntityId ?? creatorName) as EntityId,
        canvasId,
        edgeId: id,
        sourceId,
        targetId,
        relationship,
        timestamp: row.created_at,
      });
      return json(
        {
          id,
          sourceId,
          targetId,
          relationship,
          data: row.data ? JSON.parse(row.data) : null,
          creatorName,
          createdAt: row.created_at,
        },
        201,
      );
    }

    if (method === "DELETE" && edgeId) {
      const edge = db.getCanvasEdge(edgeId);
      if (!edge || edge.canvas_id !== canvasId)
        return json({ error: "Relationship not found" }, 404);
      db.deleteCanvasEdge(edgeId);
      engine?.logEvent({
        type: "canvas_edge_deleted",
        entity: (authenticatedEntityId ?? edge.creator_name) as EntityId,
        canvasId,
        edgeId,
        timestamp: Date.now(),
      });
      return json({ ok: true, id: edgeId });
    }
  }
  if (intentActionMatch && method === "POST") {
    const canvasId = decodeURIComponent(intentActionMatch[1]!);
    const nodeId = decodeURIComponent(intentActionMatch[2]!);
    const action = intentActionMatch[3]!;
    // Private per-entity canvas: the intent lifecycle both leaks node data and
    // mutates state, so it is owner/operator-only. 404 (not 403) so a private
    // node's existence isn't confirmable.
    if (!canAccessCanvas(canvasId)) return json({ error: "Node not found" }, 404);
    const node = db.getNode(nodeId);
    if (!node || node.canvas_id !== canvasId) return json({ error: "Node not found" }, 404);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const actorName = actorNameForRequest(body, engine, authenticatedEntityId);

    if (action === "claim") {
      const result = db.claimCanvasIntent(node.id, actorName);
      if (!result.ok) return intentErrorResponse(json, result);
      const parsed = JSON.parse(result.node.data);
      const responseNode = { ...result.node, data: parsed };
      // No direct broadcast here: the canvas_intent engine event below reaches
      // FeedPublisher synchronously, which broadcasts an asset-enriched
      // node_updated snapshot. Broadcasting the unenriched node too would just
      // duplicate it.
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
      // No direct broadcasts: FeedPublisher handles the canvas_intent event
      // below and broadcasts both the enriched node_updated and the result
      // node_added (it reads resultNodeId from the intent data).
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
    // No direct broadcast — see the claim handler above.
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
    // Owner/operator gate for EVERY node method (GET read + DELETE/PATCH
    // mutation) on a private per-entity canvas. 404 so existence isn't leaked.
    if (!canAccessCanvas(canvasId)) return json({ error: "Node not found" }, 404);

    if (method === "DELETE") {
      // Fetch the node first so we can clean up its asset
      const node = db.getNode(nodeId);
      if (!node || node.canvas_id !== canvasId) return json({ error: "Node not found" }, 404);
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
      const existingNode = db.getNode(nodeId);
      if (!existingNode || existingNode.canvas_id !== canvasId) {
        return json({ error: "Node not found" }, 404);
      }
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
      const enriched = { ...node, data: enrichNodeData(node, parsed, db, storage) };
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

    // GET single node (private-canvas access already gated at the top).
    if (method === "GET") {
      const node = db.getNode(nodeId);
      if (!node || node.canvas_id !== canvasId) return json({ error: "Node not found" }, 404);
      const parsed = JSON.parse(node.data);
      return json({ ...node, data: enrichNodeData(node, parsed, db, storage) });
    }
  }

  // POST /api/canvases/:id/nodes — add node
  const nodesMatch = url.pathname.match(/^\/api\/canvases\/([^/]+)\/nodes$/);
  if (nodesMatch && method === "POST") {
    const canvasId = decodeURIComponent(nodesMatch[1]!);
    const canvas = db.getCanvas(canvasId);
    if (!canvas) return json({ error: "Canvas not found" }, 404);
    // A non-owner may not create nodes on a private per-entity canvas.
    if (!canAccessCanvas(canvasId)) return json({ error: "Canvas not found" }, 404);

    const body = (await req.json()) as Record<string, unknown>;
    const requestedType = typeof body.type === "string" ? body.type : "text";
    if (!CANVAS_NODE_TYPES.has(requestedType)) {
      return json({ error: `Unsupported canvas node type: ${requestedType}` }, 400);
    }
    const parentNodeId = typeof body.parent_node_id === "string" ? body.parent_node_id : undefined;
    if (parentNodeId) {
      const parent = db.getNode(parentNodeId);
      if (!parent || parent.canvas_id !== canvasId) {
        return json({ error: "Parent node not found on this canvas" }, 400);
      }
    }
    const id = crypto.randomUUID();
    db.createNode({
      id,
      canvasId,
      type: requestedType,
      x: body.x as number | undefined,
      y: body.y as number | undefined,
      width: body.width as number | undefined,
      height: body.height as number | undefined,
      assetId: body.asset_id as string | undefined,
      data: body.data as Record<string, unknown> | undefined,
      creatorName: actorNameForRequest(body, engine, authenticatedEntityId),
      parentNodeId,
    });

    const node = db.getNode(id)!;
    const parsed = JSON.parse(node.data);
    const enriched = { ...node, data: enrichNodeData(node, parsed, db, storage) };
    broadcaster?.broadcast({ type: "node_added", canvasId, node: enriched });
    onNodeCreated?.({
      nodeId: id,
      canvasId,
      type: requestedType,
      creatorName: actorNameForRequest(body, engine, authenticatedEntityId),
      parentNodeId: parentNodeId ?? null,
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
    // Owner/operator gate for canvas detail (GET) and canvas delete (DELETE) on a
    // private per-entity canvas. 404 so a private canvas id isn't confirmable.
    if (!canAccessCanvas(id)) return json({ error: "Canvas not found" }, 404);

    if (method === "DELETE") {
      const deleted = db.deleteCanvas(id);
      if (!deleted) return json({ error: "Canvas not found" }, 404);
      return json({ ok: true, id });
    }

    // GET canvas detail with nodes + first-class edges (access gated above).
    if (method === "GET") {
      const canvas = db.getCanvas(id);
      if (!canvas) return json({ error: "Canvas not found" }, 404);
      const nodes = db.getNodesByCanvas(id).map((n) => ({
        ...n,
        data: enrichNodeData(n, JSON.parse(n.data), db, storage),
      }));
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

    const requestedScope = (body.scope as string) ?? "global";
    let scopeId = body.scope_id as string | undefined;
    // A private per-entity canvas (`scope === "entity"`) is OWNED by its
    // `scope_id`, and that ownership is what `authorizeCanvasSubscription` reads
    // to decide who may access it. A caller must therefore only be able to
    // create one scoped to ITSELF — otherwise it could create
    // scope:"entity", scope_id:<victim> and own/poison the victim's de-facto
    // private workspace before the victim ever visits it. Non-operator callers
    // are forced to their own entity id and a mismatched foreign target is
    // rejected; a trusted operator (desktop credential / sovereign / operator
    // gate → `canvasPrincipal.isOperator`) may still create on another entity's
    // behalf.
    if (requestedScope === "entity" && !canvasPrincipal.isOperator) {
      if (!authenticatedEntityId) return json({ error: "Authentication required" }, 401);
      if (scopeId && scopeId !== authenticatedEntityId) {
        return json({ error: "Cannot create an entity-scoped canvas for another entity" }, 403);
      }
      scopeId = authenticatedEntityId;
    }

    const id = crypto.randomUUID();
    db.createCanvas({
      id,
      name,
      description: (body.description as string) ?? "",
      scope: requestedScope,
      scopeId,
      creatorName: actorNameForRequest(body, engine, authenticatedEntityId),
    });

    return json(db.getCanvas(id), 201);
  }

  // GET /api/canvases — list canvases. Private per-entity canvases are filtered
  // to those the caller may read (own workspace / operator / loopback desktop),
  // so `?scope=entity` can't enumerate every entity's private workspace. Public
  // and shared scopes stay listable by anyone.
  if (url.pathname === "/api/canvases" && method === "GET") {
    const scope = url.searchParams.get("scope") ?? undefined;
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const canvases = db
      .listCanvases({ scope, limit })
      .filter((c) => c.scope !== "entity" || canAccessCanvas(c.id));
    return json(canvases);
  }

  return json({ error: "Not found" }, 404);
}
