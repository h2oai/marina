// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { record as recordStanding } from "../../agent/standing";
import { header, separator } from "../../net/ansi";
import { guardedFetch } from "../../net/url-guard";
import type { CanvasIntentData, MarinaDB } from "../../persistence/database";
import { parseCanvasIntent } from "../../persistence/database";
import type { StorageProvider } from "../../storage/provider";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getErrorMessage } from "../errors";

const HELP =
  "Canvas management. Subcommands: canvas create <name> [desc] | canvas list | canvas info <name> | canvas visit <self|entity|name> | canvas post [on:<canvas>] [reply:<node_id>] <text> | canvas publish <type> <asset_id> [canvas] [reply:<node_id>] | canvas nodes <name> | canvas edges <name> | canvas layout <grid|timeline|feed> <name> | canvas delete <name> | canvas asset upload|list|info|delete | canvas intent list [canvas] | canvas intent claim <node_id> | canvas intent fail <node_id> [reason] | canvas intent complete <node_id> [--type <type>] <result> | canvas intent complete-rich <node_id> <json> | canvas connect <src_node_id> <tgt_node_id> <relationship> [canvas] | canvas disconnect <edge_id>";

export function canvasCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  findEntityGlobal?: (name: string) => Entity | undefined;
  db?: MarinaDB;
  storage?: StorageProvider;
  logEvent?: (event: { type: string; entity: EntityId; [k: string]: unknown }) => void;
  scratchRoot?: string;
}): CommandDef {
  return {
    name: "canvas",
    aliases: ["cv"],
    help: HELP,
    // Rank 0: posting to a canvas (publish, intents, asset upload, connect) is a
    // basic capability like board/say/share — newly spawned agents need it to
    // populate content. The one destructive op, `delete`, is gated in-handler.
    minRank: 0,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Canvas requires database support.");
        return;
      }
      const db = deps.db;
      const eid = input.entity;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(eid, HELP);
        return;
      }

      switch (sub) {
        case "asset":
          await handleAsset(ctx, eid, entity, db, deps.storage, tokens.slice(1), deps.scratchRoot);
          return;
        case "create":
          handleCreate(ctx, eid, entity, db, tokens.slice(1));
          return;
        case "list":
          handleList(ctx, eid, db);
          return;
        case "info":
          handleInfo(ctx, eid, db, tokens.slice(1));
          return;
        case "publish":
          handlePublish(ctx, eid, entity, db, deps.storage, deps.logEvent, tokens.slice(1));
          return;
        case "post":
          handlePost(ctx, eid, entity, db, deps.logEvent, tokens.slice(1));
          return;
        case "nodes":
          handleNodes(ctx, eid, db, tokens.slice(1));
          return;
        case "layout":
          handleLayout(ctx, eid, db, tokens.slice(1), deps.logEvent);
          return;
        case "delete": {
          // Deleting a whole canvas (and its nodes) is destructive and shared —
          // gate it above newcomer rank while leaving posting open to all.
          const rank = (entity.properties.rank as number) ?? 0;
          if (rank < 1) {
            ctx.send(
              eid,
              "Deleting a canvas requires rank 1+. Create, publish, and post are open to all.",
            );
            return;
          }
          handleDelete(ctx, eid, db, deps.logEvent, tokens.slice(1));
          return;
        }
        case "intent":
          await handleIntent(ctx, eid, entity, db, deps.storage, deps.logEvent, tokens.slice(1));
          return;
        case "connect":
          handleConnect(ctx, eid, entity, db, deps.logEvent, tokens.slice(1));
          return;
        case "disconnect":
          handleDisconnect(ctx, eid, entity, db, deps.logEvent, tokens.slice(1));
          return;
        case "edges":
          handleEdges(ctx, eid, db, tokens.slice(1));
          return;
        case "visit":
          handleVisit(ctx, eid, entity, db, deps.findEntityGlobal, tokens.slice(1));
          return;
        default:
          ctx.send(eid, HELP);
      }
    },
  };
}

// ─── Canvas Edges ────────────────────────────────────────────────────────

const VALID_EDGE_RELATIONSHIPS = new Set([
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "relates_to",
  "supersedes",
  "derived_from",
  "part_of",
]);

function _findCanvasForNodes(
  db: MarinaDB,
  sourceId: string,
  targetId: string,
): { canvasId: string } | undefined {
  const source = db.getNode(sourceId);
  const target = db.getNode(targetId);
  if (!source || !target) return undefined;
  if (source.canvas_id !== target.canvas_id) return undefined;
  return { canvasId: source.canvas_id };
}

function handleConnect(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
): void {
  const sourceIdPrefix = tokens[0];
  const targetIdPrefix = tokens[1];
  const relationship = tokens[2]?.toLowerCase();
  if (!sourceIdPrefix || !targetIdPrefix || !relationship) {
    ctx.send(eid, "Usage: canvas connect <src_node_id> <tgt_node_id> <relationship>");
    return;
  }
  if (!VALID_EDGE_RELATIONSHIPS.has(relationship)) {
    ctx.send(
      eid,
      `Unknown relationship "${relationship}". Valid: ${[...VALID_EDGE_RELATIONSHIPS].join(", ")}`,
    );
    return;
  }
  // Resolve prefixes to full node ids
  const sourceNode = db.getNode(sourceIdPrefix) ?? resolveNodePrefix(db, sourceIdPrefix);
  const targetNode = db.getNode(targetIdPrefix) ?? resolveNodePrefix(db, targetIdPrefix);
  if (!sourceNode || !targetNode) {
    ctx.send(eid, "Source or target node not found.");
    return;
  }
  if (sourceNode.canvas_id !== targetNode.canvas_id) {
    ctx.send(eid, "Source and target must live on the same canvas.");
    return;
  }
  const edgeId = crypto.randomUUID();
  try {
    db.createCanvasEdge({
      id: edgeId,
      canvasId: sourceNode.canvas_id,
      sourceId: sourceNode.id,
      targetId: targetNode.id,
      relationship,
      creatorName: entity.name,
    });
  } catch {
    ctx.send(eid, "That connection already exists.");
    return;
  }
  logEvent?.({
    type: "canvas_edge_created",
    entity: eid,
    canvasId: sourceNode.canvas_id,
    edgeId,
    sourceId: sourceNode.id,
    targetId: targetNode.id,
    relationship,
    timestamp: Date.now(),
  });
  ctx.send(
    eid,
    `Connected ${sourceNode.id.slice(0, 8)} → ${targetNode.id.slice(0, 8)} (${relationship}). Edge ${edgeId.slice(0, 8)}.`,
  );
}

function handleDisconnect(
  ctx: RoomContext,
  eid: EntityId,
  _entity: Entity,
  db: MarinaDB,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
): void {
  const edgeIdPrefix = tokens[0];
  if (!edgeIdPrefix) {
    ctx.send(eid, "Usage: canvas disconnect <edge_id>");
    return;
  }
  let edge = db.getCanvasEdge(edgeIdPrefix);
  if (!edge) {
    // Try prefix resolution — list edges across recent canvases and match
    const canvases = db.listCanvases({ limit: 20 });
    for (const canvas of canvases) {
      for (const e of db.getCanvasEdges(canvas.id)) {
        if (e.id.startsWith(edgeIdPrefix)) {
          edge = e;
          break;
        }
      }
      if (edge) break;
    }
  }
  if (!edge) {
    ctx.send(eid, `Edge "${edgeIdPrefix}" not found.`);
    return;
  }
  const ok = db.deleteCanvasEdge(edge.id);
  if (!ok) {
    ctx.send(eid, "Could not delete edge.");
    return;
  }
  logEvent?.({
    type: "canvas_edge_deleted",
    entity: eid,
    canvasId: edge.canvas_id,
    edgeId: edge.id,
    timestamp: Date.now(),
  });
  ctx.send(eid, `Disconnected edge ${edge.id.slice(0, 8)}.`);
}

function resolveNodePrefix(db: MarinaDB, prefix: string) {
  // Scan recent canvases for a node whose id starts with prefix.
  if (prefix.length < 4) return undefined;
  const canvases = db.listCanvases({ limit: 20 });
  for (const canvas of canvases) {
    for (const node of db.getNodesByCanvas(canvas.id)) {
      if (node.id.startsWith(prefix)) return node;
    }
  }
  return undefined;
}

// ─── Canvas CRUD ─────────────────────────────────────────────────────────

function handleCreate(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  tokens: string[],
): void {
  const name = tokens[0];
  if (!name) {
    ctx.send(eid, "Usage: canvas create <name> [description]");
    return;
  }
  const existing = db.getCanvasByName(name);
  if (existing) {
    ctx.send(eid, `Canvas "${name}" already exists.`);
    return;
  }
  const desc = tokens.slice(1).join(" ");
  const id = crypto.randomUUID();
  db.createCanvas({ id, name, description: desc, creatorName: entity.name });
  ctx.send(eid, `Canvas "${name}" created (${id.slice(0, 8)}..)`);
}

function handleList(ctx: RoomContext, eid: EntityId, db: MarinaDB): void {
  const canvases = db.listCanvases({ limit: 20 });
  if (canvases.length === 0) {
    ctx.send(eid, "No canvases found. Use 'canvas create <name>' to make one.");
    return;
  }
  const lines = [
    header("Canvases"),
    separator(),
    ...canvases.map((c) => {
      const nodes = db.getNodesByCanvas(c.id);
      const date = new Date(c.updated_at).toISOString().slice(0, 10);
      return `  ${c.name} (${nodes.length} nodes, ${date}) by ${c.creator_name}`;
    }),
  ];
  ctx.send(eid, lines.join("\n"));
}

function handleInfo(ctx: RoomContext, eid: EntityId, db: MarinaDB, tokens: string[]): void {
  const name = tokens[0];
  if (!name) {
    ctx.send(eid, "Usage: canvas info <name>");
    return;
  }
  const canvas = db.getCanvasByName(name);
  if (!canvas) {
    ctx.send(eid, `Canvas "${name}" not found.`);
    return;
  }
  const nodes = db.getNodesByCanvas(canvas.id);
  const created = new Date(canvas.created_at).toISOString().slice(0, 16).replace("T", " ");
  const updated = new Date(canvas.updated_at).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    header(`Canvas: ${canvas.name}`),
    separator(),
    `  ID:          ${canvas.id}`,
    `  Description: ${canvas.description || "(none)"}`,
    `  Scope:       ${canvas.scope}${canvas.scope_id ? ` (${canvas.scope_id})` : ""}`,
    `  Creator:     ${canvas.creator_name}`,
    `  Created:     ${created}`,
    `  Updated:     ${updated}`,
    `  Nodes:       ${nodes.length}`,
  ];
  ctx.send(eid, lines.join("\n"));
}

/**
 * Per-node-type rules for which asset MIME types are accepted. The dashboard
 * renderers assume these constraints; publishing a JSON file as `image` would
 * stuff a JSON blob into an `<img>` and render blank. The lists are
 * permissive but reject the obvious mismatches that have been showing up
 * during demos.
 */
const TYPE_MIME_RULES: Record<string, (mime: string) => boolean> = {
  image: (m) => m.startsWith("image/"),
  video: (m) => m.startsWith("video/"),
  audio: (m) => m.startsWith("audio/"),
  pdf: (m) => m === "application/pdf",
  document: (m) => m.startsWith("text/") || m.startsWith("application/"),
  a2ui: (m) => m === "application/json" || m.startsWith("text/"),
  // text / embed / frame accept anything — they render the asset's body or a URL
  text: () => true,
  embed: () => true,
  frame: () => true,
};

function handlePublish(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  storage: StorageProvider | undefined,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
): void {
  const type = tokens[0]?.toLowerCase();
  const assetId = tokens[1];

  // Parse optional reply:<node_id> and canvas name from remaining tokens
  let canvasName: string | undefined;
  let parentNodeId: string | undefined;
  for (const t of tokens.slice(2)) {
    if (t.startsWith("reply:")) {
      parentNodeId = t.slice(6);
    } else if (!canvasName) {
      canvasName = t;
    }
  }

  if (!type || !assetId) {
    ctx.send(eid, "Usage: canvas publish <type> <asset_id> [canvas_name] [reply:<node_id>]");
    return;
  }

  const validTypes = Object.keys(TYPE_MIME_RULES);
  if (!validTypes.includes(type)) {
    ctx.send(eid, `Invalid node type. Valid: ${validTypes.join(", ")}`);
    return;
  }

  // Verify asset exists
  const asset =
    db.getAsset(assetId) ?? db.listAssets({ limit: 200 }).find((a) => a.id.startsWith(assetId));
  if (!asset) {
    ctx.send(eid, `Asset "${assetId}" not found.`);
    return;
  }

  // Reject MIME / type mismatches at the publish boundary. Without this,
  // `canvas publish image <json_asset_id>` succeeds and the dashboard renders
  // a broken <img> with no signal to the user that they picked the wrong type.
  const mimeOk = TYPE_MIME_RULES[type]?.(asset.mime_type ?? "") ?? true;
  if (!mimeOk) {
    ctx.send(
      eid,
      `Asset "${asset.filename}" (${asset.mime_type ?? "unknown"}) is not a valid ${type}. Pick a different type or upload a matching asset.`,
    );
    return;
  }

  // Find or use default canvas — prefer "global"
  let canvas = canvasName
    ? db.getCanvasByName(canvasName)
    : (db.getCanvasByName("global") ?? db.listCanvases({ limit: 1 })[0]);
  if (!canvas) {
    // Auto-create the global canvas
    const id = crypto.randomUUID();
    db.createCanvas({
      id,
      name: "global",
      description: "Shared canvas for all entities",
      creatorName: entity.name,
    });
    canvas = db.getCanvas(id)!;
  }

  // Auto-position: place new node below existing ones
  const existingNodes = db.getNodesByCanvas(canvas.id);
  const maxY = existingNodes.reduce((max, n) => Math.max(max, n.y + n.height), 0);

  const nodeId = crypto.randomUUID();
  const baseData = {
    filename: asset.filename,
    mime: asset.mime_type,
    url: storage?.resolve(asset.storage_key),
    title: asset.filename,
    author: entity.name,
    feedType: parentNodeId ? "conversation" : "manual",
  };
  db.createNode({
    id: nodeId,
    canvasId: canvas.id,
    type,
    x: 0,
    y: maxY + 20,
    assetId: asset.id,
    data: baseData,
    creatorName: entity.name,
    parentNodeId,
  });

  // Fire-and-forget preview build: text-shaped assets (csv / json / text) get
  // an inline preview so the dashboard renders rows / first chars without a
  // second fetch. Failures are best-effort and never block the publish, and
  // because this runs after createNode the publish itself stays synchronous —
  // existing callers don't have to await anything new.
  if (storage) {
    buildAssetPreview(db, storage, asset.id)
      .then((preview) => {
        if (!preview) return;
        const node = db.getNode(nodeId);
        if (!node) return;
        const merged = { ...JSON.parse(node.data), preview };
        db.updateNode(nodeId, { data: JSON.stringify(merged) });
        logEvent?.({
          type: "canvas_node_updated",
          entity: eid,
          canvasId: canvas.id,
          nodeId,
          timestamp: Date.now(),
        });
      })
      .catch((err) => {
        console.warn("[canvas] preview build failed:", (err as Error).message);
      });
  }

  if (logEvent) {
    logEvent({
      type: "canvas_publish",
      entity: eid,
      canvasId: canvas.id,
      nodeId,
      timestamp: Date.now(),
    });
  }

  ctx.send(eid, `Published ${type} node to canvas "${canvas.name}" (asset: ${asset.filename})`);
}

/**
 * One-shot text post: create a text node straight from inline text — no separate
 * asset-upload step. This is the cheap path agents use to populate canvas content.
 * Usage: canvas post [on:<canvas>] [reply:<node_id>] <text...>
 * Leading `on:`/`reply:` flags are optional; everything after them is the body.
 */
function handlePost(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
): void {
  let canvasName: string | undefined;
  let parentNodeId: string | undefined;
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("reply:")) parentNodeId = t.slice(6);
    else if (t.startsWith("on:")) canvasName = t.slice(3);
    else break;
  }
  const text = tokens.slice(i).join(" ").trim();
  if (!text) {
    ctx.send(eid, "Usage: canvas post [on:<canvas>] [reply:<node_id>] <text>");
    return;
  }

  // Find or create the target canvas — prefer the named one, else "global".
  let canvas = canvasName
    ? db.getCanvasByName(canvasName)
    : (db.getCanvasByName("global") ?? db.listCanvases({ limit: 1 })[0]);
  if (!canvas) {
    const id = crypto.randomUUID();
    db.createCanvas({
      id,
      name: canvasName ?? "global",
      description: "Shared canvas for all entities",
      creatorName: entity.name,
    });
    canvas = db.getCanvas(id)!;
  }

  // Auto-position below existing nodes.
  const existingNodes = db.getNodesByCanvas(canvas.id);
  const maxY = existingNodes.reduce((max, n) => Math.max(max, n.y + n.height), 0);

  const nodeId = crypto.randomUUID();
  const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  db.createNode({
    id: nodeId,
    canvasId: canvas.id,
    type: "text",
    x: 0,
    y: maxY + 20,
    // No asset — the dashboard text node renders data.content directly.
    data: {
      content: text,
      title,
      author: entity.name,
      feedType: parentNodeId ? "conversation" : "manual",
    },
    creatorName: entity.name,
    parentNodeId,
  });

  logEvent?.({
    type: "canvas_publish",
    entity: eid,
    canvasId: canvas.id,
    nodeId,
    timestamp: Date.now(),
  });

  ctx.send(eid, `Posted to canvas "${canvas.name}" (node ${nodeId.slice(0, 8)}..).`);
}

function handleNodes(ctx: RoomContext, eid: EntityId, db: MarinaDB, tokens: string[]): void {
  const name = tokens[0];
  if (!name) {
    ctx.send(eid, "Usage: canvas nodes <name>");
    return;
  }
  const canvas = db.getCanvasByName(name);
  if (!canvas) {
    ctx.send(eid, `Canvas "${name}" not found.`);
    return;
  }
  const nodes = db.getNodesByCanvas(canvas.id);
  if (nodes.length === 0) {
    ctx.send(eid, `Canvas "${name}" has no nodes.`);
    return;
  }
  const lines = [
    header(`Canvas "${name}" Nodes`),
    separator(),
    ...nodes.map((n) => {
      const date = new Date(n.created_at).toISOString().slice(0, 10);
      const reply = n.parent_node_id ? ` ↩ ${n.parent_node_id.slice(0, 8)}..` : "";
      return `  ${n.id.slice(0, 8)}.. [${n.type}] ${n.width}x${n.height} at (${n.x},${n.y}) by ${n.creator_name} ${date}${reply}`;
    }),
  ];
  ctx.send(eid, lines.join("\n"));
}

function handleDelete(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
): void {
  const name = tokens[0];
  if (!name) {
    ctx.send(eid, "Usage: canvas delete <name>");
    return;
  }
  const canvas = db.getCanvasByName(name);
  if (!canvas) {
    ctx.send(eid, `Canvas "${name}" not found.`);
    return;
  }
  db.deleteCanvas(canvas.id);
  // Without this, dashboard viewers keep the deleted board forever — the
  // canvas list is only fetched on mount/focus. FeedPublisher translates it
  // into a `canvas_deleted` WS broadcast so live clients clear and reselect.
  logEvent?.({
    type: "canvas_deleted",
    entity: eid,
    canvasId: canvas.id,
    name: canvas.name,
    timestamp: Date.now(),
  });
  ctx.send(eid, `Canvas "${name}" deleted.`);
}

/**
 * Visit someone's canvas — resolves target to a canvas, lazy-creating an
 * entity-scoped canvas if the target is an entity without one. CLI is
 * stateless, so this just reports the resolved canvas; the dashboard has a
 * matching button that switches the view after calling the same resolution
 * path via REST.
 */
function handleVisit(
  ctx: RoomContext,
  eid: EntityId,
  actingEntity: Entity,
  db: MarinaDB,
  findEntityGlobal: ((name: string) => Entity | undefined) | undefined,
  tokens: string[],
): void {
  const targetRaw = tokens[0] ?? "self";
  const target = targetRaw.toLowerCase();

  // `canvas visit self` or `canvas visit me` → the acting entity's canvas
  if (target === "self" || target === "me" || target === "mine") {
    const canvas = db.ensureEntityCanvas(actingEntity.id, actingEntity.name, actingEntity.name);
    ctx.send(
      eid,
      `Visiting your canvas: ${canvas.name} (${canvas.id.slice(0, 8)}..). ${
        db.getNodesByCanvas(canvas.id).length
      } node(s).`,
    );
    return;
  }

  // `canvas visit <name>` → try entity-name resolution first, fall back to
  // a named canvas lookup. Entity resolution wins if both exist.
  if (findEntityGlobal) {
    const targetEntity = findEntityGlobal(targetRaw);
    if (targetEntity) {
      const canvas = db.ensureEntityCanvas(targetEntity.id, targetEntity.name, actingEntity.name);
      ctx.send(
        eid,
        `Visiting ${targetEntity.name}'s canvas: ${canvas.name} (${canvas.id.slice(0, 8)}..). ${
          db.getNodesByCanvas(canvas.id).length
        } node(s).`,
      );
      return;
    }
  }

  // Fall-through: plain canvas name (global, feed, project-named, etc.)
  const named = db.getCanvasByName(targetRaw);
  if (named) {
    ctx.send(
      eid,
      `Visiting canvas: ${named.name} (${named.id.slice(0, 8)}..). ${
        db.getNodesByCanvas(named.id).length
      } node(s).`,
    );
    return;
  }

  ctx.send(
    eid,
    `No canvas or entity named "${targetRaw}". Try 'canvas list' or 'canvas visit self'.`,
  );
}

function handleEdges(ctx: RoomContext, eid: EntityId, db: MarinaDB, tokens: string[]): void {
  const name = tokens[0];
  if (!name) {
    ctx.send(eid, "Usage: canvas edges <name>");
    return;
  }
  const canvas = db.getCanvasByName(name);
  if (!canvas) {
    ctx.send(eid, `Canvas "${name}" not found.`);
    return;
  }
  const edges = db.getCanvasEdges(canvas.id);
  if (edges.length === 0) {
    ctx.send(eid, `Canvas "${name}" has no edges.`);
    return;
  }
  const lines = [
    header(`Canvas "${name}" Edges`),
    separator(),
    ...edges.map((e) => {
      const date = new Date(e.created_at).toISOString().slice(0, 10);
      return `  ${e.id.slice(0, 8)}..  ${e.source_id.slice(0, 8)} → ${e.target_id.slice(0, 8)}  [${e.relationship}]  by ${e.creator_name}  ${date}`;
    }),
  ];
  ctx.send(eid, lines.join("\n"));
}

// ─── Intent ─────────────────────────────────────────────────────────────

const INTENT_TIMEOUT_MS = 5 * 60 * 1000;

function parseIntent(node: { data: string }): CanvasIntentData | undefined {
  return parseCanvasIntent(node.data);
}

async function handleIntent(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  storage: StorageProvider | undefined,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
): Promise<void> {
  const action = tokens[0]?.toLowerCase();

  if (!action) {
    ctx.send(
      eid,
      "Usage: canvas intent list [canvas] | canvas intent claim <node_id> | canvas intent complete <node_id> <result>",
    );
    return;
  }

  switch (action) {
    case "list": {
      const canvasName = tokens[1];
      const results = db.listCanvasIntents({
        canvasName,
        statuses: ["pending", "active"],
        limit: 100,
        expireActiveMs: INTENT_TIMEOUT_MS,
      });

      if (results.length === 0) {
        ctx.send(eid, "No pending or active intents found.");
        return;
      }

      const lines = [
        header("Canvas Intents"),
        separator(),
        ...results.map((r) => {
          const claimed = r.intent.claimedBy ? ` [${r.intent.claimedBy}]` : "";
          const prompt =
            r.intent.prompt.length > 60 ? `${r.intent.prompt.slice(0, 57)}...` : r.intent.prompt;
          return `  ${r.nodeId.slice(0, 8)}.. [${r.intent.status}]${claimed} ${r.canvasName}/${r.type} — "${prompt}"`;
        }),
      ];
      ctx.send(eid, lines.join("\n"));
      return;
    }

    case "claim": {
      const nodeId = tokens[1];
      if (!nodeId) {
        ctx.send(eid, "Usage: canvas intent claim <node_id>");
        return;
      }

      const claim = db.claimCanvasIntent(nodeId, entity.name);
      if (!claim.ok) {
        if (claim.reason === "not_found") {
          ctx.send(eid, `Node "${nodeId}" not found.`);
          return;
        }
        if (claim.reason === "no_intent") {
          ctx.send(eid, "This node has no intent.");
          return;
        }
        ctx.send(eid, `Intent is already "${claim.status ?? "not pending"}", cannot claim.`);
        return;
      }

      const { node, intent } = claim;

      logEvent?.({
        type: "canvas_intent",
        entity: eid,
        canvasId: node.canvas_id,
        nodeId: node.id,
        prompt: intent.prompt,
        status: "active",
        timestamp: Date.now(),
      });

      // Preview attached asset if present — lets the agent see CSV columns /
      // text previews immediately, without needing a separate inspection step.
      const preview = await previewNodeAsset(db, storage, node.asset_id);
      const lines = [`Claimed intent on node ${node.id.slice(0, 8)}.. — "${intent.prompt}"`];
      if (preview) lines.push("", preview);
      ctx.send(eid, lines.join("\n"));
      return;
    }

    case "fail": {
      const nodeId = tokens[1];
      const reason = tokens.slice(2).join(" ") || "No reason given";
      if (!nodeId) {
        ctx.send(eid, "Usage: canvas intent fail <node_id> [reason]");
        return;
      }

      const node = resolveNode(db, nodeId);
      if (!node) {
        ctx.send(eid, `Node "${nodeId}" not found.`);
        return;
      }

      const intent = parseIntent(node);
      if (!intent) {
        ctx.send(eid, "This node has no intent.");
        return;
      }
      if (intent.status !== "active") {
        ctx.send(eid, `Intent status is "${intent.status}", expected "active".`);
        return;
      }

      const parsed = JSON.parse(node.data);
      parsed.intent = { ...intent, status: "failed", failReason: reason };
      db.updateNode(node.id, { data: JSON.stringify(parsed) });

      logEvent?.({
        type: "canvas_intent",
        entity: eid,
        canvasId: node.canvas_id,
        nodeId: node.id,
        prompt: intent.prompt,
        status: "failed",
        timestamp: Date.now(),
      });

      ctx.send(eid, `Intent failed on node ${node.id.slice(0, 8)}.. Reason: ${reason}`);
      return;
    }

    case "complete": {
      const nodeId = tokens[1];
      // Parse optional --type flag
      let resultType = "text";
      let resultTokens = tokens.slice(2);
      const typeIdx = resultTokens.indexOf("--type");
      if (typeIdx !== -1 && resultTokens[typeIdx + 1]) {
        resultType = resultTokens[typeIdx + 1]!;
        resultTokens = [...resultTokens.slice(0, typeIdx), ...resultTokens.slice(typeIdx + 2)];
      }
      if (!Object.hasOwn(TYPE_MIME_RULES, resultType)) {
        ctx.send(
          eid,
          `Invalid result node type. Valid: ${Object.keys(TYPE_MIME_RULES).join(", ")}`,
        );
        return;
      }
      const result = resultTokens.join(" ");
      if (!nodeId || !result) {
        ctx.send(eid, "Usage: canvas intent complete <node_id> [--type <type>] <result text>");
        return;
      }

      const node = resolveNode(db, nodeId);
      if (!node) {
        ctx.send(eid, `Node "${nodeId}" not found.`);
        return;
      }

      const intent = parseIntent(node);
      if (!intent) {
        ctx.send(eid, "This node has no intent.");
        return;
      }
      if (intent.status !== "active") {
        ctx.send(eid, `Intent status is "${intent.status}", expected "active".`);
        return;
      }

      // Create a result child node threaded under the original
      const resultNodeId = crypto.randomUUID();
      db.createNode({
        id: resultNodeId,
        canvasId: node.canvas_id,
        type: resultType,
        data: {
          body: result,
          author: entity.name,
          feedType: "intent_result",
          sourceNodeId: node.id,
          sourcePrompt: intent.prompt,
        },
        creatorName: entity.name,
        parentNodeId: node.id,
      });

      // Update original node's intent
      const parsed = JSON.parse(node.data);
      parsed.intent = { ...intent, status: "done", result, resultNodeId };
      db.updateNode(node.id, { data: JSON.stringify(parsed) });

      logEvent?.({
        type: "canvas_intent",
        entity: eid,
        canvasId: node.canvas_id,
        nodeId: node.id,
        prompt: intent.prompt,
        status: "done",
        timestamp: Date.now(),
      });

      // Fulfilling a work request someone else posted is a helping act —
      // credit the completer's standing (idempotent on ref=intent:<nodeId>).
      // Self-completion (creator == completer) earns nothing; that's not help.
      if (node.creator_name && node.creator_name !== entity.name) {
        recordStanding(db, eid, entity.name, "helping_act", `intent:${node.id}`);
      }

      // Record the completion in the agent's own memory so they can
      // recall what they've accomplished. Previously intents completed
      // silently — the agent did the work but had no memory of it.
      try {
        db.createNote(
          entity.name,
          `[intent-done] "${intent.prompt.slice(0, 120)}" → ${result.slice(0, 200)}`,
          entity.room,
          { importance: 7, noteType: "episode" },
        );
      } catch {
        // Note write is best-effort.
      }

      ctx.send(
        eid,
        `Intent completed on node ${node.id.slice(0, 8)}.. Result published as ${resultType} child node ${resultNodeId.slice(0, 8)}..`,
      );
      return;
    }

    case "complete-rich": {
      const nodeId = tokens[1];
      const jsonStr = tokens.slice(2).join(" ");
      if (!nodeId || !jsonStr) {
        ctx.send(eid, "Usage: canvas intent complete-rich <node_id> <a2ui_json>");
        return;
      }

      const node = resolveNode(db, nodeId);
      if (!node) {
        ctx.send(eid, `Node "${nodeId}" not found.`);
        return;
      }

      const intent = parseIntent(node);
      if (!intent) {
        ctx.send(eid, "This node has no intent.");
        return;
      }
      if (intent.status !== "active") {
        ctx.send(eid, `Intent status is "${intent.status}", expected "active".`);
        return;
      }

      let a2uiData: Record<string, unknown>;
      try {
        a2uiData = JSON.parse(jsonStr);
      } catch {
        ctx.send(eid, "Invalid JSON. Provide a valid A2UI component tree.");
        return;
      }
      if (!Array.isArray(a2uiData.components)) {
        ctx.send(eid, "JSON must contain a 'components' array.");
        return;
      }

      const resultNodeId = crypto.randomUUID();
      db.createNode({
        id: resultNodeId,
        canvasId: node.canvas_id,
        type: "a2ui",
        data: {
          ...a2uiData,
          author: entity.name,
          feedType: "intent_result",
          sourceNodeId: node.id,
          sourcePrompt: intent.prompt,
        },
        creatorName: entity.name,
        parentNodeId: node.id,
      });

      const parsed = JSON.parse(node.data);
      parsed.intent = { ...intent, status: "done", result: "[A2UI]", resultNodeId };
      db.updateNode(node.id, { data: JSON.stringify(parsed) });

      logEvent?.({
        type: "canvas_intent",
        entity: eid,
        canvasId: node.canvas_id,
        nodeId: node.id,
        prompt: intent.prompt,
        status: "done",
        timestamp: Date.now(),
      });
      if (node.creator_name && node.creator_name !== entity.name) {
        recordStanding(db, eid, entity.name, "helping_act", `intent:${node.id}`);
      }

      // Record rich completion in agent memory (see note above in `complete`).
      try {
        db.createNote(
          entity.name,
          `[intent-done-rich] "${intent.prompt.slice(0, 120)}" → A2UI result (node ${resultNodeId.slice(0, 8)}..)`,
          entity.room,
          { importance: 7, noteType: "episode" },
        );
      } catch {
        // Note write is best-effort.
      }

      ctx.send(
        eid,
        `Intent completed with A2UI result on node ${node.id.slice(0, 8)}.. Result: ${resultNodeId.slice(0, 8)}..`,
      );
      return;
    }

    default:
      ctx.send(
        eid,
        "Usage: canvas intent list [canvas] | canvas intent claim <node_id> | " +
          "canvas intent complete <node_id> [--type <type>] <result> | " +
          "canvas intent complete-rich <node_id> <a2ui_json>",
      );
  }
}

/** Resolve a node by full or prefix ID. */
function resolveNode(db: MarinaDB, idOrPrefix: string) {
  return db.resolveCanvasNode(idOrPrefix);
}

/**
 * Produce a small, mime-aware preview of an asset's content so an agent
 * claiming an intent can immediately see what data they're working with.
 * Returns undefined (no preview) for missing assets, unrecognized mime
 * types, or binary formats — the agent still sees the intent prompt and
 * can handle those cases via whatever tools they have available.
 *
 * Caps the read at 10KB so we never stream large files through a chat
 * response; TabH2O and similar tools fetch full content independently
 * once the agent decides to invoke them.
 */
/**
 * Structured preview of an asset's content. Stored on the node's `data.preview`
 * so the dashboard can render a CSV/text snippet inline without a second
 * fetch, and re-used by the CLI intent-claim path which formats it as text.
 */
export interface AssetPreview {
  kind: "csv" | "text" | "json" | "binary";
  filename: string;
  mime: string;
  size: number;
  /** First 6 rows for CSV. */
  rows?: string[];
  /** Column count from the header row, for CSV. */
  cols?: number;
  /** First 400 chars for text / json. */
  snippet?: string;
}

async function buildAssetPreview(
  db: MarinaDB,
  storage: StorageProvider | undefined,
  assetId: string,
): Promise<AssetPreview | null> {
  if (!storage) return null;
  const asset = db.getAsset(assetId);
  if (!asset) return null;
  const mime = asset.mime_type ?? "";
  const filename = asset.filename ?? "";
  const lower = filename.toLowerCase();
  const isCsv = mime === "text/csv" || lower.endsWith(".csv");
  const isJson = mime === "application/json" || lower.endsWith(".json");
  const isText = !isCsv && !isJson && mime.startsWith("text/");
  if (!isCsv && !isJson && !isText) {
    return { kind: "binary", filename, mime: mime || "unknown", size: asset.size };
  }
  const content = await storage.get(asset.storage_key);
  if (!content) return null;
  const textSlice = new TextDecoder().decode(content.data.slice(0, 10_240));
  if (isCsv) {
    const rows = textSlice.split(/\r?\n/).slice(0, 6);
    const cols = (rows[0] ?? "").split(",").length;
    return { kind: "csv", filename, mime: mime || "text/csv", size: asset.size, rows, cols };
  }
  return {
    kind: isJson ? "json" : "text",
    filename,
    mime: mime || (isJson ? "application/json" : "text/plain"),
    size: asset.size,
    snippet: textSlice.slice(0, 400).replace(/\s+$/, ""),
  };
}

/** Format a structured preview as the multi-line text the CLI intent claim expects. */
function formatAssetPreviewText(preview: AssetPreview): string {
  if (preview.kind === "binary") {
    return `  asset: ${preview.filename} (${preview.mime}, ${preview.size}B) — binary preview not supported`;
  }
  if (preview.kind === "csv") {
    const rows = preview.rows ?? [];
    return [
      `  asset: ${preview.filename} (csv, ${preview.size}B, ~${preview.cols ?? 0} cols)`,
      "  preview:",
      ...rows.map((r) => `    ${r.slice(0, 120)}`),
    ].join("\n");
  }
  const snippet = preview.snippet ?? "";
  return `  asset: ${preview.filename} (${preview.mime}, ${preview.size}B)\n  preview:\n    ${snippet.replace(/\n/g, "\n    ")}`;
}

async function previewNodeAsset(
  db: MarinaDB,
  storage: StorageProvider | undefined,
  assetId: string | null,
): Promise<string | undefined> {
  if (!assetId) return undefined;
  const preview = await buildAssetPreview(db, storage, assetId);
  if (!preview) return undefined;
  return formatAssetPreviewText(preview);
}

// ─── Layout ─────────────────────────────────────────────────────────────

function handleLayout(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  tokens: string[],
  logEvent?: (event: { type: string; entity: EntityId; [key: string]: unknown }) => void,
): void {
  const algo = tokens[0]?.toLowerCase();
  const name = tokens[1];
  if (!algo || !name) {
    ctx.send(eid, "Usage: canvas layout <grid|timeline|feed> <canvas_name>");
    return;
  }
  const canvas = db.getCanvasByName(name);
  if (!canvas) {
    ctx.send(eid, `Canvas "${name}" not found.`);
    return;
  }
  const nodes = db.getNodesByCanvas(canvas.id);
  if (nodes.length === 0) {
    ctx.send(eid, `Canvas "${name}" has no nodes to layout.`);
    return;
  }

  if (algo === "grid") {
    const cols = 3;
    const padX = 20;
    const padY = 20;
    const nodeW = 320;
    const nodeH = 240;
    for (let i = 0; i < nodes.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      db.updateNode(nodes[i]!.id, {
        x: col * (nodeW + padX),
        y: row * (nodeH + padY),
      });
      logEvent?.({
        type: "canvas_node_updated",
        entity: eid,
        canvasId: canvas.id,
        nodeId: nodes[i]!.id,
        timestamp: Date.now(),
      });
    }
    ctx.send(eid, `Arranged ${nodes.length} nodes in a ${cols}-column grid.`);
    return;
  }

  if (algo === "timeline") {
    const sorted = [...nodes].sort((a, b) => a.created_at - b.created_at);
    const padX = 40;
    const nodeW = 320;
    for (let i = 0; i < sorted.length; i++) {
      db.updateNode(sorted[i]!.id, {
        x: i * (nodeW + padX),
        y: 0,
      });
      logEvent?.({
        type: "canvas_node_updated",
        entity: eid,
        canvasId: canvas.id,
        nodeId: sorted[i]!.id,
        timestamp: Date.now(),
      });
    }
    ctx.send(eid, `Arranged ${sorted.length} nodes in chronological timeline.`);
    return;
  }

  if (algo === "feed") {
    // Feed layout: root nodes in reverse chronological order (newest first),
    // child nodes indented under their parents.
    const roots = nodes
      .filter((n) => !n.parent_node_id)
      .sort((a, b) => b.created_at - a.created_at);
    const childMap = new Map<string, typeof nodes>();
    for (const n of nodes) {
      if (n.parent_node_id) {
        const siblings = childMap.get(n.parent_node_id) ?? [];
        siblings.push(n);
        childMap.set(n.parent_node_id, siblings);
      }
    }

    const feedW = 500;
    const rootH = 200;
    const childH = 120;
    const padY = 16;
    const indentX = 60;
    let cursorY = 0;

    const layoutNode = (node: (typeof nodes)[0], depth: number) => {
      const h = depth === 0 ? rootH : childH;
      db.updateNode(node.id, {
        x: depth * indentX,
        y: cursorY,
        width: feedW - depth * indentX,
        height: h,
      });
      logEvent?.({
        type: "canvas_node_updated",
        entity: eid,
        canvasId: canvas.id,
        nodeId: node.id,
        timestamp: Date.now(),
      });
      cursorY += h + padY;
      const children = childMap.get(node.id)?.sort((a, b) => a.created_at - b.created_at) ?? [];
      for (const child of children) {
        layoutNode(child, depth + 1);
      }
    };

    for (const root of roots) {
      layoutNode(root, 0);
    }
    ctx.send(eid, `Arranged ${nodes.length} nodes in feed layout (${roots.length} top-level).`);
    return;
  }

  ctx.send(eid, "Unknown layout algorithm. Use 'grid', 'timeline', or 'feed'.");
}

// ─── Asset Handling ──────────────────────────────────────────────────────

async function handleAsset(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  storage: StorageProvider | undefined,
  tokens: string[],
  scratchRoot?: string,
): Promise<void> {
  const action = tokens[0]?.toLowerCase();

  if (!action) {
    ctx.send(
      eid,
      "Usage: canvas asset upload <url> | canvas asset list | canvas asset info <id> | canvas asset delete <id>",
    );
    return;
  }

  switch (action) {
    case "upload": {
      const url = tokens[1];
      if (!url) {
        ctx.send(eid, "Usage: canvas asset upload <url or file:filename>");
        return;
      }
      if (!storage) {
        ctx.send(eid, "Asset storage not configured.");
        return;
      }

      // Local file from entity's scratch directory
      if (url.startsWith("file:")) {
        const filename = url.slice(5);
        if (!filename || filename.includes("..") || filename.includes("/")) {
          ctx.send(eid, "Invalid filename. Use a simple filename from your scratch directory.");
          return;
        }
        const root = scratchRoot ?? "data/scratch";
        const filePath = join(root, eid, filename);
        try {
          const file = Bun.file(filePath);
          if (!(await file.exists())) {
            ctx.send(eid, `File not found in scratch directory: ${filename}`);
            return;
          }
          const bodyBytes = new Uint8Array(await file.arrayBuffer());
          if (bodyBytes.byteLength === 0) {
            ctx.send(eid, "File is empty.");
            return;
          }
          const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
          const mime = guessMime(ext);
          const id = crypto.randomUUID();
          const storageKey = `${id}${ext}`;

          await storage.put(storageKey, bodyBytes, mime);
          db.createAsset({
            id,
            entityName: entity.name,
            filename,
            mimeType: mime,
            size: bodyBytes.byteLength,
            storageKey,
          });

          const sizeKb = Math.round(bodyBytes.byteLength / 1024);
          ctx.send(eid, `Asset uploaded: ${id} (${filename}, ${sizeKb}KB, ${mime})`);
        } catch (err) {
          ctx.send(eid, `Upload failed: ${getErrorMessage(err)}`);
        }
        return;
      }

      // Remote URL fetch. ctx.fetch remains the capability gate (contexts
      // without HTTP stay without it), but the request itself goes through
      // guardedFetch: resolve-validate-pin per hop, so a DNS rebind can't swap
      // in a private address between the check and the connect (the old
      // validateFetchUrl-then-ctx.fetch split was exactly that TOCTOU).
      if (!ctx.fetch) {
        ctx.send(eid, "HTTP fetch not available in this context.");
        return;
      }
      try {
        const response = await guardedFetch(url);
        if (response.status >= 400) {
          ctx.send(eid, `Failed to fetch URL: HTTP ${response.status}`);
          return;
        }
        // arrayBuffer (not text) keeps binary assets byte-accurate.
        const bodyBytes = new Uint8Array(await response.arrayBuffer());
        if (bodyBytes.byteLength === 0) {
          ctx.send(eid, "Downloaded file is empty.");
          return;
        }
        if (bodyBytes.byteLength > 50 * 1024 * 1024) {
          ctx.send(eid, "File too large (max 50MB for remote URLs).");
          return;
        }
        const filename = url.split("/").pop()?.split("?")[0] ?? "download";
        const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
        const mime = guessMime(ext);
        const id = crypto.randomUUID();
        const storageKey = `${id}${ext}`;

        await storage.put(storageKey, bodyBytes, mime);
        db.createAsset({
          id,
          entityName: entity.name,
          filename,
          mimeType: mime,
          size: bodyBytes.byteLength,
          storageKey,
        });

        const sizeKb = Math.round(bodyBytes.byteLength / 1024);
        ctx.send(eid, `Asset uploaded: ${id} (${filename}, ${sizeKb}KB, ${mime})`);
      } catch (err) {
        ctx.send(eid, `Upload failed: ${getErrorMessage(err)}`);
      }
      return;
    }

    case "list": {
      const mine = tokens[1]?.toLowerCase() === "mine";
      const assets = mine ? db.getAssetsByEntity(entity.name, 20) : db.listAssets({ limit: 20 });
      if (assets.length === 0) {
        ctx.send(eid, "No assets found.");
        return;
      }
      const lines = [
        header("Assets"),
        separator(),
        ...assets.map((a) => {
          const sizeKb = Math.round(a.size / 1024);
          const date = new Date(a.created_at).toISOString().slice(0, 10);
          return `  ${a.id.slice(0, 8)}.. ${date} ${a.filename} (${sizeKb}KB, ${a.mime_type}) by ${a.entity_name}`;
        }),
      ];
      ctx.send(eid, lines.join("\n"));
      return;
    }

    case "info": {
      const id = tokens[1];
      if (!id) {
        ctx.send(eid, "Usage: canvas asset info <id>");
        return;
      }
      const asset =
        db.getAsset(id) ?? db.listAssets({ limit: 100 }).find((a) => a.id.startsWith(id));
      if (!asset) {
        ctx.send(eid, `Asset "${id}" not found.`);
        return;
      }
      const sizeKb = Math.round(asset.size / 1024);
      const date = new Date(asset.created_at).toISOString().slice(0, 16).replace("T", " ");
      const lines = [
        header("Asset Info"),
        separator(),
        `  ID:       ${asset.id}`,
        `  File:     ${asset.filename}`,
        `  Type:     ${asset.mime_type}`,
        `  Size:     ${sizeKb}KB`,
        `  Owner:    ${asset.entity_name}`,
        `  Created:  ${date}`,
        `  Key:      ${asset.storage_key}`,
      ];
      ctx.send(eid, lines.join("\n"));
      return;
    }

    case "delete": {
      const id = tokens[1];
      if (!id) {
        ctx.send(eid, "Usage: canvas asset delete <id>");
        return;
      }
      const asset =
        db.getAsset(id) ?? db.listAssets({ limit: 100 }).find((a) => a.id.startsWith(id));
      if (!asset) {
        ctx.send(eid, `Asset "${id}" not found.`);
        return;
      }
      if (storage) {
        await storage.delete(asset.storage_key);
      }
      db.deleteAsset(asset.id);
      ctx.send(eid, `Asset ${asset.id.slice(0, 8)}.. deleted.`);
      return;
    }

    default:
      ctx.send(
        eid,
        "Usage: canvas asset upload <url> | canvas asset list | canvas asset info <id> | canvas asset delete <id>",
      );
  }
}

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}
