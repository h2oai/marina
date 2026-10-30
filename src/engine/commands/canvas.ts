// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { scratchRoot as defaultScratchRoot } from "../../config/data-dir";
import { header, separator } from "../../net/ansi";
import { guardedFetch } from "../../net/url-guard";
import type { MarinaDB } from "../../persistence/database";
import { PANEL_RESOURCE_CATALOG } from "../../sdk/panel-resource-catalog";
import { assetMimeForFile } from "../../storage/asset-mime";
import type { StorageProvider } from "../../storage/provider";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import {
  type CanvasAccessHost,
  type CanvasReader,
  type CanvasReadGrants,
  canvasReaderFor,
  mayReadAsset,
  mayReadCanvas,
  mayReadCanvasRow,
} from "../canvas-access";
import { canvasDocumentData } from "../canvas-document";
import { canvasItemOwners, canvasOwners } from "../canvas-ownership";
import { refuseCommand } from "../command-response";
import { getErrorMessage } from "../errors";
import { Logger } from "../logger";
import { ingestAsset } from "../media/asset-library";
import { type LookReply, sendLookReply } from "../media/vision";
import { ownershipRefusal } from "../ownership";
import { rankFloorRefusal } from "../rank-floor";
import { type AssetCommandDeps, runAssetCommand } from "./asset";
import { handleCanvasIntent } from "./canvas-intent";
import { requiresPersistence } from "./command-messages";

/** Module logger. */
const logger = new Logger();

/**
 * The caller's read access, from the shared canvas read check
 * (`src/engine/canvas-access.ts`): private (`entity`) canvases are their
 * owner's and operators'; a node may also be read under a live grant.
 */
interface Access {
  host: CanvasAccessHost;
  reader: CanvasReader;
}

/** The canvas when the caller may read it; otherwise undefined, as if missing. */
function readableCanvas<T extends { id: string; scope: string; scope_id: string | null }>(
  access: Access,
  canvas: T | undefined,
  via: string,
  mode: "read" | "write" = "read",
): T | undefined {
  if (!canvas) return undefined;
  return mayReadCanvasRow(canvas as never, access.reader, via, mode) ? canvas : undefined;
}

/**
 * The node when the caller may write to it: canvas-level write access (owner,
 * operator, or the local-ungated profile). A read grant and the creator
 * relation cover reading only, so neither counts here.
 */
function canvasLevelNode<T extends { id: string; canvas_id: string }>(
  access: Access,
  node: T | undefined,
  via: string,
): T | undefined {
  if (!node) return undefined;
  const canvas = access.host.db?.getCanvas(node.canvas_id);
  return mayReadCanvasRow(canvas, access.reader, via, "write") ? node : undefined;
}

const HELP =
  "Canvas management. Subcommands: canvas create <name> [desc] | canvas list | canvas info <name> | canvas visit <self|entity|name> | canvas post [on:<canvas>] [reply:<node_id>] <text> | canvas publish <type> <asset_id> [canvas] [reply:<node_id>] | canvas nodes <name> | canvas look <node_id> [question] | canvas edges <name> | canvas layout <grid|timeline|feed> <name> | canvas delete <name> | canvas asset upload|list|info|delete | canvas intent list [canvas] | canvas intent claim <node_id> | canvas intent fail <node_id> [reason] | canvas intent complete <node_id> [--type <type>] <result> | canvas intent complete-rich <node_id> <json> | canvas connect <src_node_id> <tgt_node_id> <relationship> [canvas] | canvas disconnect <edge_id>" +
  "\n\nUse canvas resources [filter] to discover authorized data adapters for panel sources (kind: resource). Publish an A2UI JSON asset to compose Marina resources. Open it beside Chat from Workspace → Canvas → Published panels, or use Create coding desk for an existing coding session." +
  "\nResource reads use each viewer’s permissions; operational buttons require review. Opening or closing a panel leaves agents running. The coding terminal also supports these publications through /panel and F8.";

export function canvasCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  findEntityGlobal?: (name: string) => Entity | undefined;
  db?: MarinaDB;
  storage?: StorageProvider;
  logEvent?: (event: { type: string; entity: EntityId; [k: string]: unknown }) => void;
  scratchRoot?: string;
  /** Expiring read grants on private nodes (the engine's `canvasGrants`). */
  canvasGrants?: CanvasReadGrants;
  /** `canvas look` — see a node's image, document or video (src/engine/media/vision.ts). */
  look?: (
    who: { entityId: EntityId; name: string },
    tokens: string[],
  ) => Promise<string | LookReply>;
  /** The `asset` command's deps: `canvas asset list|info|delete` delegate to it. */
  assets?: AssetCommandDeps;
}): CommandDef {
  return {
    category: "Canvas & Media",
    usage: [
      { syntax: "canvas asset delete <id>", effect: "delete" },
      { syntax: "canvas asset info <id>", effect: "read" },
      { syntax: "canvas asset list", effect: "read" },
      { syntax: "canvas asset upload <url or file:filename>", effect: "write" },
      { syntax: "canvas asset upload <url>", effect: "write" },
      { syntax: "canvas connect <src_node_id> <tgt_node_id> <relationship>", effect: "write" },
      {
        syntax: "canvas connect <src_node_id> <tgt_node_id> <relationship> [canvas]",
        effect: "write",
      },
      { syntax: "canvas create <name> [desc]", effect: "write" },
      { syntax: "canvas create <name> [description]", effect: "write" },
      { syntax: "canvas delete <name>", effect: "delete" },
      { syntax: "canvas disconnect <edge_id>", effect: "delete" },
      { syntax: "canvas edges <name>", effect: "read" },
      { syntax: "canvas info <name>", effect: "read" },
      { syntax: "canvas intent claim <node_id>", effect: "write" },
      { syntax: "canvas intent claim <node_id> |", effect: "write" },
      { syntax: "canvas intent complete <node_id> [--type <type>] <result text>", effect: "write" },
      { syntax: "canvas intent complete <node_id> [--type <type>] <result>", effect: "write" },
      { syntax: "canvas intent complete <node_id> <result>", effect: "write" },
      { syntax: "canvas intent complete-rich <node_id> <a2ui_json>", effect: "write" },
      { syntax: "canvas intent complete-rich <node_id> <json>", effect: "write" },
      { syntax: "canvas intent fail <node_id> [reason]", effect: "write" },
      { syntax: "canvas intent list [canvas]", effect: "read" },
      { syntax: "canvas layout <grid|timeline|feed> <canvas_name>", effect: "write" },
      { syntax: "canvas layout <grid|timeline|feed> <name>", effect: "write" },
      { syntax: "canvas list", effect: "read" },
      {
        syntax:
          "canvas look <node_id> [question...] [model:<provider/model>] [mode:native|describe]",
        effect: "write",
      },
      { syntax: "canvas resources [filter]", effect: "read" },
      { syntax: "canvas nodes <name>", effect: "read" },
      { syntax: "canvas post [on:<canvas>] [reply:<node_id>] <text>", effect: "write" },
      {
        syntax: "canvas publish <type> <asset_id> [canvas_name] [reply:<node_id>]",
        effect: "write",
      },
      { syntax: "canvas publish <type> <asset_id> [canvas] [reply:<node_id>]", effect: "write" },
      { syntax: "canvas visit <self|entity|name>", effect: "write" },
    ],
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
        refuseCommand(ctx, input.entity, requiresPersistence("canvas"));
        return;
      }
      const db = deps.db;
      const eid = input.entity;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();
      const host: CanvasAccessHost = {
        db,
        entities: { get: (id: never) => deps.getEntity(id) },
        ...(deps.canvasGrants ? { canvasGrants: deps.canvasGrants } : {}),
      };
      const access: Access = { host, reader: canvasReaderFor(host, eid, { inWorld: true }) };

      if (!sub) {
        ctx.send(eid, HELP);
        return;
      }
      if (sub === "resources") {
        const filter = tokens.slice(1).join(" ").toLowerCase();
        ctx.send(
          eid,
          JSON.stringify(
            {
              schema: "marina.panel-resources.v1",
              resources: PANEL_RESOURCE_CATALOG.filter((r) => r.id.includes(filter)),
            },
            null,
            2,
          ),
        );
        return;
      }

      switch (sub) {
        case "asset":
          await handleAsset(
            ctx,
            eid,
            entity,
            deps.storage,
            tokens.slice(1),
            deps.scratchRoot,
            deps.assets ?? {
              getEntity: deps.getEntity,
              db,
              ...(deps.storage ? { storage: deps.storage } : {}),
              ...(deps.canvasGrants ? { canvasGrants: deps.canvasGrants } : {}),
            },
          );
          return;
        case "create":
          handleCreate(ctx, eid, entity, db, tokens.slice(1));
          return;
        case "list":
          handleList(ctx, eid, db, access);
          return;
        case "info":
          handleInfo(ctx, eid, db, tokens.slice(1), access);
          return;
        case "publish":
          await handlePublish(
            ctx,
            eid,
            entity,
            db,
            deps.storage,
            deps.logEvent,
            tokens.slice(1),
            access,
          );
          return;
        case "post":
          handlePost(ctx, eid, entity, db, deps.logEvent, tokens.slice(1), access);
          return;
        case "nodes":
          handleNodes(ctx, eid, db, tokens.slice(1), access);
          return;
        case "layout":
          handleLayout(ctx, eid, entity, db, tokens.slice(1), access, deps.logEvent);
          return;
        case "delete": {
          // Deleting a whole canvas (and its nodes) is destructive and shared —
          // gate it above newcomer rank while leaving posting open to all.
          const floor = rankFloorRefusal(
            entity,
            1,
            "Deleting a canvas requires rank 1+. Create, publish, and post are open to all.",
          );
          if (floor) {
            ctx.send(eid, floor);
            return;
          }
          handleDelete(ctx, eid, entity, db, deps.logEvent, tokens.slice(1), access);
          return;
        }
        case "intent":
          await handleCanvasIntent({
            ctx,
            entity,
            db,
            tokens: tokens.slice(1),
            reader: access.reader,
            resolveWritableNode: (id) =>
              canvasLevelNode(access, resolveNode(db, id), `canvas intent ${tokens[1]}`),
            preview: (id) => previewNodeAsset(db, deps.storage, id),
            resultTypes: Object.keys(TYPE_MIME_RULES),
            logEvent: deps.logEvent,
          });
          return;
        case "look":
        case "see": {
          if (!deps.look) {
            refuseCommand(ctx, eid, "Looking at canvas nodes is not available on this server.");
            return;
          }
          sendLookReply(
            ctx,
            eid,
            await deps.look({ entityId: eid, name: entity.name }, tokens.slice(1)),
          );
          return;
        }
        case "connect":
          handleConnect(ctx, eid, entity, db, deps.logEvent, tokens.slice(1), access);
          return;
        case "disconnect":
          handleDisconnect(ctx, eid, entity, db, deps.logEvent, tokens.slice(1), access);
          return;
        case "edges":
          handleEdges(ctx, eid, db, tokens.slice(1), access);
          return;
        case "visit":
          handleVisit(ctx, eid, entity, db, deps.findEntityGlobal, tokens.slice(1), access);
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

function handleConnect(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
  access: Access,
): void {
  const sourceIdPrefix = tokens[0];
  const targetIdPrefix = tokens[1];
  const relationship = tokens[2]?.toLowerCase();
  if (!sourceIdPrefix || !targetIdPrefix || !relationship) {
    refuseCommand(ctx, eid, "Usage: canvas connect <src_node_id> <tgt_node_id> <relationship>");
    return;
  }
  if (!VALID_EDGE_RELATIONSHIPS.has(relationship)) {
    refuseCommand(
      ctx,
      eid,
      `Unknown relationship "${relationship}". Valid: ${[...VALID_EDGE_RELATIONSHIPS].join(", ")}`,
    );
    return;
  }
  // Resolve prefixes to full node ids
  const sourceNode = canvasLevelNode(
    access,
    db.getNode(sourceIdPrefix) ?? resolveNodePrefix(db, sourceIdPrefix, access),
    "canvas connect",
  );
  const targetNode = canvasLevelNode(
    access,
    db.getNode(targetIdPrefix) ?? resolveNodePrefix(db, targetIdPrefix, access),
    "canvas connect",
  );
  if (!sourceNode || !targetNode) {
    refuseCommand(
      ctx,
      eid,
      "One of those nodes doesn't exist. `canvas nodes <name>` lists node ids.",
    );
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
  entity: Entity,
  db: MarinaDB,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
  access: Access,
): void {
  const edgeIdPrefix = tokens[0];
  if (!edgeIdPrefix) {
    refuseCommand(ctx, eid, "Usage: canvas disconnect <edge_id>");
    return;
  }
  let edge = db.getCanvasEdge(edgeIdPrefix);
  if (!edge) {
    // Try prefix resolution — list edges across recent canvases and match
    const canvases = db.listCanvases({ limit: 20 });
    for (const canvas of canvases) {
      if (!mayReadCanvas(canvas, access.reader)) continue;
      for (const e of db.getCanvasEdges(canvas.id)) {
        if (e.id.startsWith(edgeIdPrefix)) {
          edge = e;
          break;
        }
      }
      if (edge) break;
    }
  }
  // An edge on a private canvas the caller cannot read is "not found".
  const edgeCanvas = edge ? db.getCanvas(edge.canvas_id) : undefined;
  if (!edge || (edgeCanvas && !readableCanvas(access, edgeCanvas, "canvas disconnect"))) {
    refuseCommand(ctx, eid, `Edge "${edgeIdPrefix}" not found.`);
    return;
  }
  // The edge's author or the canvas owner (or an admin) may remove it.
  const refusal = ownershipRefusal(
    entity,
    canvasItemOwners(db, edge, edgeCanvas),
    `Only the edge's author, the canvas owner, or an admin can remove edge ${edge.id.slice(0, 8)}.`,
  );
  if (refusal) {
    refuseCommand(ctx, eid, refusal);
    return;
  }
  const ok = db.deleteCanvasEdge(edge.id);
  if (!ok) {
    ctx.send(eid, "No edge matched those endpoints. `canvas edges <name>` lists what exists.");
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

function resolveNodePrefix(db: MarinaDB, prefix: string, access: Access) {
  // Scan recent canvases the caller may read for a node whose id starts with prefix.
  if (prefix.length < 4) return undefined;
  const canvases = db.listCanvases({ limit: 20 });
  for (const canvas of canvases) {
    if (!mayReadCanvas(canvas, access.reader)) continue;
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
    refuseCommand(ctx, eid, "Usage: canvas create <name> [description]");
    return;
  }
  const existing = db.getCanvasByName(name);
  if (existing) {
    refuseCommand(ctx, eid, `Canvas "${name}" already exists.`);
    return;
  }
  const desc = tokens.slice(1).join(" ");
  const id = crypto.randomUUID();
  db.createCanvas({ id, name, description: desc, creatorName: entity.name });
  ctx.send(eid, `Canvas "${name}" created (${id.slice(0, 8)}..)`);
}

function handleList(ctx: RoomContext, eid: EntityId, db: MarinaDB, access: Access): void {
  // Private canvases the caller cannot read are left out, not marked.
  const canvases = db.listCanvases({ limit: 20 }).filter((c) => mayReadCanvas(c, access.reader));
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

function handleInfo(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  tokens: string[],
  access: Access,
): void {
  const name = tokens[0];
  if (!name) {
    refuseCommand(ctx, eid, "Usage: canvas info <name>");
    return;
  }
  const canvas = readableCanvas(access, db.getCanvasByName(name), "canvas info");
  if (!canvas) {
    refuseCommand(ctx, eid, `Canvas "${name}" not found.`);
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

async function handlePublish(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  storage: StorageProvider | undefined,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
  access: Access,
): Promise<void> {
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
    refuseCommand(
      ctx,
      eid,
      "Usage: canvas publish <type> <asset_id> [canvas_name] [reply:<node_id>]",
    );
    return;
  }

  const validTypes = Object.keys(TYPE_MIME_RULES);
  if (!validTypes.includes(type)) {
    refuseCommand(ctx, eid, `Invalid node type. Valid: ${validTypes.join(", ")}`);
    return;
  }

  // Verify asset exists
  // Publishing shows the asset: a private one (shown only on private canvases,
  // or a request image) needs the caller's read access, else "not found".
  const exact = db.getAsset(assetId);
  const asset = exact
    ? mayReadAsset(access.host, exact, access.reader, "canvas publish")
      ? exact
      : undefined
    : db
        .listAssets({ limit: 200 })
        .find(
          (a) =>
            a.id.startsWith(assetId) &&
            mayReadAsset(access.host, a, access.reader, "canvas publish", { log: false }),
        );
  if (!asset) {
    refuseCommand(ctx, eid, `Asset "${assetId}" not found.`);
    return;
  }

  // Reject MIME / type mismatches at the publish boundary. Without this,
  // `canvas publish image <json_asset_id>` succeeds and the dashboard renders
  // a broken <img> with no signal to the user that they picked the wrong type.
  const mimeOk = TYPE_MIME_RULES[type]?.(asset.mime_type ?? "") ?? true;
  if (!mimeOk) {
    refuseCommand(
      ctx,
      eid,
      `Asset "${asset.filename}" (${asset.mime_type ?? "unknown"}) is not a valid ${type}. Pick a different type or upload a matching asset.`,
    );
    return;
  }

  let panelData: Record<string, unknown> = {};
  if (type === "a2ui") {
    try {
      panelData = await canvasDocumentData({}, asset.id, db, storage);
    } catch (error) {
      refuseCommand(ctx, eid, `Cannot publish panel: ${getErrorMessage(error)}`);
      return;
    }
  }

  // Find or use default canvas — prefer "global"
  const named = canvasName ? db.getCanvasByName(canvasName) : undefined;
  if (named && !readableCanvas(access, named, "canvas publish", "write")) {
    refuseCommand(ctx, eid, `Canvas "${canvasName}" not found.`);
    return;
  }
  let canvas = canvasName
    ? named
    : (db.getCanvasByName("global") ??
      db.listCanvases({ limit: 20 }).find((c) => mayReadCanvas(c, access.reader, "write")));
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
  if (parentNodeId) {
    const parent = resolveReplyNode(db, canvas, parentNodeId);
    if ("error" in parent) {
      ctx.send(eid, parent.error);
      return;
    }
    parentNodeId = parent.id;
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
    data: { ...baseData, ...panelData },
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
        logger.warn("canvas", "preview build failed", { error: (err as Error).message });
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
 * Resolve a `reply:<node_id>` reference on `canvas`: an exact id, or a unique
 * prefix as `canvas nodes` prints it (`1a2b3c4d..`). An unknown id is a clear
 * refusal instead of a database foreign-key failure.
 */
function resolveReplyNode(
  db: MarinaDB,
  canvas: { id: string; name: string },
  ref: string,
): { id: string } | { error: string } {
  const wanted = ref.replace(/\.+$/, "");
  const exact = wanted ? db.getNode(wanted) : undefined;
  if (exact?.canvas_id === canvas.id) return { id: exact.id };
  const matches = wanted
    ? db.getNodesByCanvas(canvas.id).filter((node) => node.id.startsWith(wanted))
    : [];
  if (matches.length === 1) return { id: matches[0]!.id };
  return {
    error:
      matches.length > 1
        ? `Node id "${ref}" is ambiguous on canvas "${canvas.name}"; give more of it (\`canvas nodes ${canvas.name}\`).`
        : `Unknown node id "${ref}" on canvas "${canvas.name}". List node ids with \`canvas nodes ${canvas.name}\`.`,
  };
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
  access: Access,
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
    refuseCommand(ctx, eid, "Usage: canvas post [on:<canvas>] [reply:<node_id>] <text>");
    return;
  }

  // Resolve an explicit id or name before falling back to the global canvas.
  const named = canvasName
    ? (db.getCanvas(canvasName) ?? db.getCanvasByName(canvasName))
    : undefined;
  // A private canvas the caller cannot read is "not found" (and never
  // shadowed by a new canvas of the same name).
  if (named && !readableCanvas(access, named, "canvas post", "write")) {
    refuseCommand(ctx, eid, `Canvas "${canvasName}" not found.`);
    return;
  }
  let canvas = canvasName
    ? named
    : (db.getCanvasByName("global") ??
      db.listCanvases({ limit: 20 }).find((c) => mayReadCanvas(c, access.reader, "write")));
  if (!canvas && parentNodeId) {
    refuseCommand(
      ctx,
      eid,
      `Unknown node id "${parentNodeId}": canvas "${canvasName ?? "global"}" does not exist yet. \`canvas list\` shows canvases.`,
    );
    return;
  }
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
  if (parentNodeId) {
    const parent = resolveReplyNode(db, canvas, parentNodeId);
    if ("error" in parent) {
      ctx.send(eid, parent.error);
      return;
    }
    parentNodeId = parent.id;
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

function handleNodes(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  tokens: string[],
  access: Access,
): void {
  const name = tokens[0];
  if (!name) {
    refuseCommand(ctx, eid, "Usage: canvas nodes <name>");
    return;
  }
  const canvas = readableCanvas(access, db.getCanvasByName(name), "canvas nodes");
  if (!canvas) {
    refuseCommand(ctx, eid, `Canvas "${name}" not found.`);
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
  entity: Entity,
  db: MarinaDB,
  logEvent: ((event: { type: string; entity: EntityId; [k: string]: unknown }) => void) | undefined,
  tokens: string[],
  access: Access,
): void {
  const name = tokens[0];
  if (!name) {
    refuseCommand(ctx, eid, "Usage: canvas delete <name>");
    return;
  }
  const canvas = readableCanvas(access, db.getCanvasByName(name), "canvas delete");
  if (!canvas) {
    refuseCommand(ctx, eid, `Canvas "${name}" not found.`);
    return;
  }
  const refusal = ownershipRefusal(
    entity,
    canvasOwners(db, canvas),
    `Only the owner of canvas "${canvas.name}" or an admin can delete it.`,
  );
  if (refusal) {
    refuseCommand(ctx, eid, refusal);
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
  access: Access,
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
      // Another entity's canvas is private: only its owner or an operator
      // visits it, and a visit by anyone else never creates it (as over HTTP).
      if (!mayReadCanvas({ scope: "entity", scope_id: targetEntity.id }, access.reader)) {
        ctx.send(eid, `${targetEntity.name}'s canvas is private.`);
        return;
      }
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
  const named = readableCanvas(access, db.getCanvasByName(targetRaw), "canvas visit");
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

function handleEdges(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  tokens: string[],
  access: Access,
): void {
  const name = tokens[0];
  if (!name) {
    refuseCommand(ctx, eid, "Usage: canvas edges <name>");
    return;
  }
  const canvas = readableCanvas(access, db.getCanvasByName(name), "canvas edges");
  if (!canvas) {
    refuseCommand(ctx, eid, `Canvas "${name}" not found.`);
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
  entity: Entity,
  db: MarinaDB,
  tokens: string[],
  access: Access,
  logEvent?: (event: { type: string; entity: EntityId; [key: string]: unknown }) => void,
): void {
  const algo = tokens[0]?.toLowerCase();
  const name = tokens[1];
  if (!algo || !name) {
    refuseCommand(ctx, eid, "Usage: canvas layout <grid|timeline|feed> <canvas_name>");
    return;
  }
  const canvas = readableCanvas(access, db.getCanvasByName(name), "canvas layout");
  if (!canvas) {
    refuseCommand(ctx, eid, `Canvas "${name}" not found.`);
    return;
  }
  // Re-laying out moves every author's nodes: the canvas owner's call.
  const refusal = ownershipRefusal(
    entity,
    canvasOwners(db, canvas),
    `Only the owner of canvas "${canvas.name}" or an admin can re-layout it.`,
  );
  if (refusal) {
    refuseCommand(ctx, eid, refusal);
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

  refuseCommand(ctx, eid, "Unknown layout algorithm. Use 'grid', 'timeline', or 'feed'.");
}

// ─── Asset Handling ──────────────────────────────────────────────────────

/** Store an upload through the asset library (dedupe: the same bytes return the owner's copy). */
async function uploadReply(
  assets: AssetCommandDeps,
  entity: Entity,
  file: { filename: string; mime: string; ext: string; data: Uint8Array; eid: EntityId },
): Promise<string> {
  const { asset, deduplicated } = await ingestAsset(
    {
      ...(assets.db ? { db: assets.db } : {}),
      ...(assets.storage ? { storage: assets.storage } : {}),
      ...(assets.logEvent ? { logEvent: assets.logEvent } : {}),
      ...(assets.trackBackground ? { trackBackground: assets.trackBackground } : {}),
    },
    {
      owner: entity.name,
      filename: file.filename,
      mime: file.mime,
      data: file.data,
      ext: file.ext,
      origin: "upload",
      dedupe: true,
      actor: file.eid,
    },
  );
  const sizeKb = Math.round(file.data.byteLength / 1024);
  return deduplicated
    ? `Already uploaded: ${asset.id} (${asset.filename}, same content) — returning the existing asset.`
    : `Asset uploaded: ${asset.id} (${file.filename}, ${sizeKb}KB, ${file.mime})`;
}

async function handleAsset(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  storage: StorageProvider | undefined,
  tokens: string[],
  scratchRoot: string | undefined,
  assets: AssetCommandDeps,
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
        refuseCommand(ctx, eid, "Usage: canvas asset upload <url or file:filename>");
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
          refuseCommand(
            ctx,
            eid,
            "Invalid filename. Use a simple filename from your scratch directory.",
          );
          return;
        }
        const root = scratchRoot ?? defaultScratchRoot();
        const filePath = join(root, eid, filename);
        try {
          const file = Bun.file(filePath);
          if (!(await file.exists())) {
            refuseCommand(ctx, eid, `File not found in scratch directory: ${filename}`);
            return;
          }
          const bodyBytes = new Uint8Array(await file.arrayBuffer());
          if (bodyBytes.byteLength === 0) {
            ctx.send(eid, "File is empty.");
            return;
          }
          const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
          const mime = assetMimeForFile(ext, bodyBytes);
          ctx.send(
            eid,
            await uploadReply(assets, entity, { filename, mime, ext, data: bodyBytes, eid }),
          );
        } catch (err) {
          refuseCommand(ctx, eid, `Upload failed: ${getErrorMessage(err)}`);
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
        const MAX_REMOTE_BYTES = 50 * 1024 * 1024;
        const response = await guardedFetch(url);
        if (response.status >= 400) {
          ctx.send(eid, `Failed to fetch URL: HTTP ${response.status}`);
          return;
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_REMOTE_BYTES) {
          ctx.send(eid, "File too large (max 50MB for remote URLs).");
          return;
        }
        // Stream with a byte cap — buffering first and checking after lets a
        // hostile server (or one omitting content-length) force an unbounded
        // in-memory allocation. Bytes stay raw so binary assets are accurate.
        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = response.body?.getReader();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > MAX_REMOTE_BYTES) {
              await reader.cancel();
              ctx.send(eid, "File too large (max 50MB for remote URLs).");
              return;
            }
            chunks.push(value);
          }
        }
        const bodyBytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (bodyBytes.byteLength === 0) {
          ctx.send(eid, "Downloaded file is empty.");
          return;
        }
        const filename = url.split("/").pop()?.split("?")[0] ?? "download";
        const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
        const mime = assetMimeForFile(ext, bodyBytes);
        ctx.send(
          eid,
          await uploadReply(assets, entity, { filename, mime, ext, data: bodyBytes, eid }),
        );
      } catch (err) {
        refuseCommand(ctx, eid, `Upload failed: ${getErrorMessage(err)}`);
      }
      return;
    }

    // The library verbs live in the `asset` command (src/engine/commands/asset.ts).
    case "list":
      await runAssetCommand(assets, ctx, eid, ["list", ...tokens.slice(1)], "");
      return;
    case "info":
      await runAssetCommand(assets, ctx, eid, ["show", ...tokens.slice(1)], "");
      return;
    case "delete":
      await runAssetCommand(assets, ctx, eid, ["delete", ...tokens.slice(1)], "");
      return;

    default:
      ctx.send(
        eid,
        "Usage: canvas asset upload <url> | canvas asset list | canvas asset info <id> | canvas asset delete <id>",
      );
  }
}
