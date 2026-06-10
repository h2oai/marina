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

  // Reads are public: the canvas is an observability surface — the same world
  // content is already streamed to any client over the unauthenticated
  // /dashboard-ws + canvas WS broadcasts, and /who pages are public. A fresh,
  // not-yet-logged-in visitor must be able to view the world canvas instead of
  // getting a 401 (which renders as an empty canvas + raw error). Mutations
  // (POST/PATCH/DELETE) still require a valid session token.
  if (engine && method !== "GET") {
    const auth = authenticateRequest(req, engine);
    if ("error" in auth) return auth.error;
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
        data: body.data ? JSON.stringify(body.data) : undefined,
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
