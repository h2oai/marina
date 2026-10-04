// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one canvas read check: may principal P read canvas C, node N or asset A?
 *
 * Every path that reads a canvas, a node or an asset by id or name goes through
 * this module: the canvas WebSocket subscription and HTTP API, the asset API
 * and asset bytes, the `canvas` command (`look`, `nodes`, `info`, `visit`,
 * intents, …), `image describe` / `video describe`, and the `marina_see` agent
 * tool and MCP `canvas` tool (both run the `canvas` command).
 *
 * Rules:
 *  - A canvas whose scope is not `entity` (global, project, feed, …) is public,
 *    as it always was.
 *  - An `entity` canvas is private: its owner (`scope_id`) and operators
 *    (sovereign rank, or `admin.destructive` held unsupervised) read it. In
 *    world (commands, tools, MCP), the agent's creator also reads it, and the
 *    local-ungated profile lifts the restriction as before. A request inbox
 *    (`inbox:<owner>`, #281) gets neither: owner, operators and grants only.
 *  - Anyone else may read one NODE of a private canvas only through an
 *    explicit, time-limited {@link CanvasReadGrants} entry naming that node and
 *    that principal. The model API records one for a request's staged images,
 *    naming the agents that serve the request, for the request's lifetime plus
 *    a short margin. Knowing a node id is never enough.
 *  - An asset shown on a private canvas (or staged from a model-API request) is
 *    as private as the node that shows it; an asset on any public canvas, or on
 *    none, stays public.
 *
 * A refused read looks exactly like a missing one (callers answer "not
 * found"), so a refusal never confirms that a private node exists. Grants and
 * refusals are logged through the `canvas` Logger category.
 */

import type { MarinaDB } from "../persistence/database";
import type { AssetRow } from "../persistence/db-assets";
import type { CanvasNodeRow, CanvasRow } from "../persistence/db-canvas";
import type { Entity, EntityId } from "../types";
import { sanitizeEntityName } from "./entity-name";
import { Logger } from "./logger";
import { OWNERSHIP_ADMIN_RANK } from "./ownership";
import { getRank } from "./permissions";
import { checkUnattendedGate } from "./safety-gates";
import { isLocalUngated } from "./trust-profile";

const logger = new Logger();

/** Who is reading. Undefined fields mean anonymous / not an operator. */
export interface CanvasReader {
  /** The reader's entity id (or an auth sentinel). */
  entityId?: string;
  /** Operators and admins read every canvas. */
  isOperator?: boolean;
  /**
   * In-world readers only: the local-ungated profile (`isLocalUngated()`)
   * lifts the entity-canvas restriction, as it did before. Never set for
   * HTTP/WS principals, and never lifts a request inbox.
   */
  localUngated?: boolean;
  /**
   * In-world readers only: true when the reader created (spawned) the agent
   * that owns `ownerId` — the creator relation challenges use. Lets a creator
   * READ its agents' canvases; never a write, never a request inbox.
   */
  createdOwner?: (ownerId: string) => boolean;
}

/** The scope fields of a canvas row (`name` identifies a request inbox). */
export type CanvasScope = Pick<CanvasRow, "scope" | "scope_id"> & { name?: string };

/** `entity` canvases are private to their owner. */
export function isPrivateCanvas(canvas: CanvasScope | undefined): boolean {
  return canvas?.scope === "entity";
}

/** Name prefix of a model-API request inbox (`requestInboxName` in vision.ts). */
export const REQUEST_INBOX_PREFIX = "inbox:";

/**
 * A private request inbox (#281): another caller's uploads. Only its owner,
 * operators and grant holders read it, in every profile.
 */
export function isRequestInbox(canvas: CanvasScope | undefined): boolean {
  return isPrivateCanvas(canvas) && !!canvas?.name?.startsWith(REQUEST_INBOX_PREFIX);
}

/**
 * May `reader` read (or, with `mode: "write"`, write to) this canvas? A
 * missing canvas is allowed (there is nothing to leak: it holds no nodes and
 * broadcasts nothing). Owner and operators always pass. For in-world readers,
 * the local-ungated profile passes both, and an agent's creator passes reads;
 * neither applies to a request inbox.
 */
export function mayReadCanvas(
  canvas: CanvasScope | undefined,
  reader?: CanvasReader,
  mode: "read" | "write" = "read",
): boolean {
  if (!canvas || !isPrivateCanvas(canvas)) return true;
  if (reader?.isOperator) return true;
  if (reader?.entityId && reader.entityId === canvas.scope_id) return true;
  if (isRequestInbox(canvas)) return false;
  if (reader?.localUngated) return true;
  return mode === "read" && !!canvas.scope_id && reader?.createdOwner?.(canvas.scope_id) === true;
}

// ─── Grants ───────────────────────────────────────────────────────────────

/** One recorded grant, as {@link CanvasReadGrants.list} reports it. */
export interface CanvasReadGrant {
  nodeId: string;
  principal: string;
  expiresAt: number;
  reason: string;
}

/**
 * Explicit, expiring read grants on single nodes of private canvases. Held in
 * memory per engine: a grant covers one in-flight request, which a restart
 * ends anyway. Every grant and every expiry is logged.
 */
export class CanvasReadGrants {
  private readonly byNode = new Map<string, Map<string, { expiresAt: number; reason: string }>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Let each principal read each node until `ttlMs` from now. A later grant
   * for the same pair extends it, never shortens it. Returns the expiry.
   */
  grant(params: {
    nodeIds: readonly string[];
    principals: readonly string[];
    ttlMs: number;
    reason: string;
  }): number {
    this.prune();
    const expiresAt = this.now() + Math.max(0, params.ttlMs);
    const principals = [...new Set(params.principals.filter(Boolean))];
    const nodeIds = [...new Set(params.nodeIds.filter(Boolean))];
    if (principals.length === 0 || nodeIds.length === 0) return expiresAt;
    for (const nodeId of nodeIds) {
      let holders = this.byNode.get(nodeId);
      if (!holders) {
        holders = new Map();
        this.byNode.set(nodeId, holders);
      }
      for (const principal of principals) {
        const prior = holders.get(principal);
        if (!prior || prior.expiresAt < expiresAt) {
          holders.set(principal, { expiresAt, reason: params.reason });
        }
      }
    }
    logger.info("canvas", "read grant", {
      nodes: nodeIds,
      principals,
      expiresAt: new Date(expiresAt).toISOString(),
      reason: params.reason,
    });
    return expiresAt;
  }

  /** Does `principal` hold an unexpired grant on `nodeId`? */
  allows(nodeId: string, principal: string | undefined): boolean {
    if (!principal) return false;
    const holders = this.byNode.get(nodeId);
    const entry = holders?.get(principal);
    if (!holders || !entry) return false;
    if (entry.expiresAt > this.now()) return true;
    holders.delete(principal);
    if (holders.size === 0) this.byNode.delete(nodeId);
    logger.info("canvas", "read grant expired", { nodeId, principal, reason: entry.reason });
    return false;
  }

  /** Drop expired grants. Returns how many were dropped. */
  prune(): number {
    const now = this.now();
    let dropped = 0;
    for (const [nodeId, holders] of this.byNode) {
      for (const [principal, entry] of holders) {
        if (entry.expiresAt <= now) {
          holders.delete(principal);
          dropped++;
        }
      }
      if (holders.size === 0) this.byNode.delete(nodeId);
    }
    if (dropped > 0) logger.info("canvas", "read grants expired", { dropped });
    return dropped;
  }

  /** The live grants (for operators and tests), optionally for one node. */
  list(nodeId?: string): CanvasReadGrant[] {
    const now = this.now();
    const out: CanvasReadGrant[] = [];
    for (const [id, holders] of this.byNode) {
      if (nodeId && id !== nodeId) continue;
      for (const [principal, entry] of holders) {
        if (entry.expiresAt > now) out.push({ nodeId: id, principal, ...entry });
      }
    }
    return out;
  }
}

// ─── Host-bound checks ────────────────────────────────────────────────────

/** What the checks read: the store, live entities and the engine's grants. */
export interface CanvasAccessHost {
  db?: MarinaDB;
  entities: { get(id: never): Entity | undefined };
  canvasGrants?: CanvasReadGrants;
}

const norm = (name: string) => sanitizeEntityName(name).toLowerCase();

/**
 * The reader for an entity: the entity itself, an operator when it is a
 * sovereign admin or holds `admin.destructive` unsupervised (a supervised-only
 * holder is not an operator).
 *
 * With `inWorld` (commands, agent tools, MCP — not the HTTP/WS surfaces) the
 * reader also carries the local-ungated lift and the creator relation: the
 * entity that spawned an agent (`agent_configs.spawned_by`, as challenges use)
 * may read that agent's canvases.
 */
export function canvasReaderFor(
  host: Pick<CanvasAccessHost, "db" | "entities">,
  entityId: string,
  opts: { inWorld?: boolean } = {},
): CanvasReader {
  const entity = host.entities.get(entityId as never);
  const isOperator =
    (!!entity && getRank(entity) >= OWNERSHIP_ADMIN_RANK) ||
    (!!host.db && checkUnattendedGate(host.db, entityId, "admin.destructive").ok);
  if (!opts.inWorld) return { entityId, isOperator };
  const myName = entity ? norm(entity.name) : "";
  return {
    entityId,
    isOperator,
    localUngated: isLocalUngated(),
    createdOwner: (ownerId) => {
      if (!myName || !host.db) return false;
      const owner = host.entities.get(ownerId as never) ?? host.db.loadEntity(ownerId as EntityId);
      const creator = owner ? host.db.getAgentConfig(owner.name)?.spawned_by : undefined;
      return !!creator && norm(creator) === myName;
    },
  };
}

function refused(what: string, id: string, reader: CanvasReader | undefined, via: string): void {
  logger.warn("canvas", `private ${what} read refused`, {
    id,
    principal: reader?.entityId ?? "anonymous",
    via,
  });
}

/** May `reader` read this node row (its canvas, or a live grant on it)? Logs a refusal. */
export function mayReadNode(
  host: CanvasAccessHost,
  node: Pick<CanvasNodeRow, "id" | "canvas_id">,
  reader: CanvasReader | undefined,
  via: string,
): boolean {
  if (mayReadCanvas(host.db?.getCanvas(node.canvas_id), reader)) return true;
  if (host.canvasGrants?.allows(node.id, reader?.entityId)) return true;
  refused("node", node.id, reader, via);
  return false;
}

/**
 * The node `nodeId` when `reader` may read it, else undefined — exactly as if
 * it did not exist.
 */
export function readableNode(
  host: CanvasAccessHost,
  nodeId: string,
  reader: CanvasReader | undefined,
  via: string,
): CanvasNodeRow | undefined {
  const node = host.db?.getNode(nodeId);
  if (!node) return undefined;
  return mayReadNode(host, node, reader, via) ? node : undefined;
}

/**
 * May `reader` read this canvas? Logs a refusal; use {@link mayReadCanvas} to
 * filter listings silently.
 */
export function mayReadCanvasRow(
  canvas: CanvasRow | undefined,
  reader: CanvasReader | undefined,
  via: string,
  mode: "read" | "write" = "read",
): boolean {
  if (mayReadCanvas(canvas, reader, mode)) return true;
  refused("canvas", canvas?.id ?? "?", reader, via);
  return false;
}

/** Request-image metadata fields (`stageRequestImages`). */
function requestOwner(asset: Pick<AssetRow, "metadata">): string | undefined {
  try {
    const meta = JSON.parse(asset.metadata || "{}") as { origin?: unknown; owner?: unknown };
    return meta.origin === "request" && typeof meta.owner === "string" ? meta.owner : undefined;
  } catch {
    return undefined;
  }
}

/** True for an asset staged from a model-API request (private to its owner). */
export function isRequestAsset(asset: Pick<AssetRow, "metadata">): boolean {
  return requestOwner(asset) !== undefined;
}

/**
 * May `reader` read this asset? Public unless it is a request image or every
 * node showing it is on a private canvas; then the reader must be able to read
 * one of those nodes (owner, operator, or a grant), or own the request.
 */
export function mayReadAsset(
  host: CanvasAccessHost,
  asset: Pick<AssetRow, "id" | "metadata">,
  reader: CanvasReader | undefined,
  via: string,
  opts: { log?: boolean } = {},
): boolean {
  if (reader?.isOperator) return true;
  const owner = requestOwner(asset);
  const nodes = host.db?.listAssetNodeScopes(asset.id) ?? [];
  if (owner === undefined && nodes.every((n) => !isPrivateCanvas(n))) return true;
  if (owner !== undefined && reader?.entityId === owner) return true;
  for (const n of nodes) {
    if (mayReadCanvas(n, reader)) return true;
    if (host.canvasGrants?.allows(n.node_id, reader?.entityId)) return true;
  }
  if (opts.log !== false) refused("asset", asset.id, reader, via);
  return false;
}
