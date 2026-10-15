// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { isOperatorPrincipal as isOperatorPerson } from "../../engine/challenges";
import type { Engine } from "../../engine/engine";
import { defaultImageModel } from "../../engine/media/providers/image-registry";
import { DEFAULT_VIDEO_MODEL } from "../../engine/media/providers/video-util";
import { isOwnershipEnforced } from "../../engine/ownership";
import type { MediaJobRow } from "../../persistence/database";
import type { EntityId } from "../../types";
import { buildCanvasPrincipal, resolveCanvasHttpPrincipal } from "../canvas/canvas-principal";
import { authorizeCanvasSubscription } from "../canvas/canvas-ws";
import { corsHeaders } from "../cors";
import type { PassthruAuthResult } from "../model-api/shared";

/** Minimal socket-peer accessor — the real, unspoofable `server.requestIP`. */
type PeerAddr = { requestIP?: (req: Request) => { address: string } | null };

const MEDIA_CORS = corsHeaders(null, {
  methods: "GET, POST, OPTIONS",
  headers: "Content-Type, Authorization",
  expose: "x-request-id",
});

interface MediaRequest {
  type: string;
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  style?: string;
  duration?: number;
  fps?: number;
  referenceImage?: string;
  canvasId?: string;
  aspectRatio?: string;
  metadata?: Record<string, unknown>;
  entityName?: string;
  entityId?: string;
}

export async function handleMediaApi(
  url: URL,
  method: string,
  req: Request,
  engine: Engine,
  server?: PeerAddr,
  /** The model-API authentication outcome (`handleModelApi`); undefined = anonymous. */
  auth?: PassthruAuthResult,
): Promise<Response> {
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: MEDIA_CORS });
  }

  if (!engine.mediaManager) {
    return mediaError(503, "Media pipeline is not configured.");
  }

  if (url.pathname === "/v1/media" && method === "POST") {
    let body: MediaRequest | null = null;
    try {
      body = (await req.json()) as MediaRequest;
    } catch {
      return mediaError(400, "Invalid JSON body.");
    }

    if (!body || typeof body.prompt !== "string" || typeof body.type !== "string") {
      return mediaError(400, "type and prompt are required.");
    }

    const kind = body.type.toLowerCase();
    if (kind !== "image" && kind !== "video") {
      return mediaError(400, 'type must be "image" or "video".');
    }

    // Canvas-write authorization. The media pipeline appends an output node to a
    // caller-supplied `canvasId` — but that append happens ASYNCHRONOUSLY after
    // this request returns (during provider polling). Enforce the shared canvas
    // owner/operator predicate SYNCHRONOUSLY here, before the job is enqueued, so
    // the denial holds regardless of the async pipeline. The body-supplied entity
    // identity is untrusted (the model API is a shared-key surface), so ownership
    // is derived from the SAME canvas principal the WS/HTTP canvas gates use
    // (real socket peer IP + authenticated canvas session/desktop/open-api),
    // never from `entityId`/`entityName`. Omitted canvasId falls back to the
    // caller's own entity canvas downstream — existing behavior preserved.
    if (body.canvasId && engine.db) {
      const peerIp = server?.requestIP?.(req)?.address ?? undefined;
      const principal = buildCanvasPrincipal(
        resolveCanvasHttpPrincipal(req, engine, peerIp),
        engine,
        engine.db,
      );
      if (!authorizeCanvasSubscription(engine.db, body.canvasId, principal)) {
        // 404 (not 403) so a private canvas's existence is not disclosed —
        // matches the canvas HTTP mutation-denial contract.
        return mediaError(404, "Canvas not found.");
      }
    }

    // The acting entity (quotas, spend, job + asset ownership) is the
    // AUTHENTICATED caller. Body identity fields may only restate it; a trusted
    // caller (internal token, multi-tenant operator key, operator) may still
    // act for a named entity.
    const caller = resolveCaller(engine, req, auth);
    const acting = actingEntity(engine, caller, body);
    if ("error" in acting) return acting.error;
    const { entityId, entityName } = acting;

    try {
      const job =
        kind === "image"
          ? await engine.mediaManager.startJob({
              type: "image",
              entityId,
              entityName,
              prompt: body.prompt,
              model: body.model ?? defaultImageModel(engine.db?.getDefaultModel()),
              width: body.width ?? undefined,
              height: body.height ?? undefined,
              style: body.style ?? undefined,
              canvasId: body.canvasId ?? undefined,
              metadata: body.metadata ?? undefined,
            })
          : await engine.mediaManager.startJob({
              type: "video",
              entityId,
              entityName,
              prompt: body.prompt,
              model: body.model ?? DEFAULT_VIDEO_MODEL,
              duration: body.duration ?? undefined,
              fps: body.fps ?? undefined,
              referenceImage: body.referenceImage ?? undefined,
              canvasId: body.canvasId ?? undefined,
              aspectRatio: body.aspectRatio ?? undefined,
              metadata: body.metadata ?? undefined,
            });
      const status = job.status === "succeeded" ? 200 : 202;
      return mediaJson(serializeJob(job, engine), status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return mediaError(400, message);
    }
  }

  const match = url.pathname.match(/^\/v1\/media\/([^/]+)$/);
  if (match && method === "GET") {
    const jobId = decodeURIComponent(match[1]!);
    const job = engine.mediaManager.getJob(jobId);
    // Only the job's owner (or a trusted caller) sees it; anyone else gets the
    // same 404 as a missing id, so job ids do not leak existence.
    if (!job || !mayReadJob(job, resolveCaller(engine, req, auth))) {
      return mediaError(404, "Media job not found.");
    }
    return mediaJson(serializeJob(job, engine));
  }

  return mediaError(404, "Not found.");
}

export interface MediaCaller {
  entityId: EntityId;
  entityName: string;
  /** May act for, and read the jobs of, any entity. */
  trusted: boolean;
}

const SYSTEM_IDENTITY = { entityId: "system" as EntityId, entityName: "system" };

/**
 * Who is calling, from the model-API credential: the internal token or a
 * multi-tenant `secret:*` operator key is trusted; a `secret:entity` key (or a
 * run key) IS its bound entity; otherwise a Marina session bearer token
 * resolves to its entity (an operator person is trusted); anything else (a
 * shared unbound key, dev-open mode) is the anonymous `system` caller.
 */
export function resolveCaller(
  engine: Engine,
  req: Request,
  auth?: PassthruAuthResult,
): MediaCaller {
  if (auth && (auth.internal || (auth.canNameMap && !auth.openMode))) {
    return { ...SYSTEM_IDENTITY, trusted: true };
  }
  if (auth?.boundEntityName) {
    const name = auth.boundEntityName;
    const bound = findEntityByName(engine, name);
    return bound
      ? { entityId: bound.id, entityName: bound.name, trusted: false }
      : { entityId: name as EntityId, entityName: name, trusted: false };
  }
  const header = req.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const sessionId = token ? engine.authenticate(token) : null;
  if (sessionId) {
    const entity = engine.entities.get(sessionId);
    return {
      entityId: sessionId,
      entityName: entity?.name ?? sessionId,
      trusted: isOperatorPerson(entity),
    };
  }
  return { ...SYSTEM_IDENTITY, trusted: false };
}

function findEntityByName(engine: Engine, name: string) {
  const lower = name.toLowerCase();
  return (
    engine.entities.findAgentByName(name) ??
    engine.entities.all().find((e) => e.name.toLowerCase() === lower)
  );
}

/**
 * The entity a job runs as. A trusted caller may name any entity in the body
 * (the historical contract); any other caller acts as itself, and a body
 * identity naming someone else is refused rather than silently rewritten.
 */
function actingEntity(
  engine: Engine,
  caller: MediaCaller,
  body: MediaRequest,
): { entityId: EntityId; entityName: string } | { error: Response } {
  if (caller.trusted) {
    return body.entityId || body.entityName
      ? resolveBodyEntity(engine, body)
      : { entityId: caller.entityId, entityName: caller.entityName };
  }
  const otherId =
    typeof body.entityId === "string" && body.entityId !== "" && body.entityId !== caller.entityId;
  const otherName =
    typeof body.entityName === "string" &&
    body.entityName !== "" &&
    body.entityName.toLowerCase() !== caller.entityName.toLowerCase();
  if (otherId || otherName) {
    return {
      error: mediaError(
        403,
        `Media jobs run as the authenticated caller (${caller.entityName}); ` +
          "entityId/entityName cannot name another entity. Omit them.",
      ),
    };
  }
  return { entityId: caller.entityId, entityName: caller.entityName };
}

/** A job is visible to its owner, a trusted caller, or anyone when ownership is not enforced. */
function mayReadJob(job: MediaJobRow, caller: MediaCaller): boolean {
  if (caller.trusted || !isOwnershipEnforced()) return true;
  if (job.entity_id && job.entity_id === caller.entityId) return true;
  return job.entity_name.toLowerCase() === caller.entityName.toLowerCase();
}

/** Body-named identity — honored only for a trusted caller. */
function resolveBodyEntity(
  engine: Engine,
  body: MediaRequest,
): { entityId: EntityId; entityName: string } {
  if (body.entityId) {
    const existing = engine.entities.get(body.entityId as EntityId);
    if (existing) {
      return { entityId: existing.id, entityName: existing.name };
    }
    return { entityId: body.entityId as EntityId, entityName: body.entityName ?? body.entityId };
  }
  if (body.entityName) {
    const match = findEntityByName(engine, body.entityName);
    if (match) {
      return { entityId: match.id, entityName: match.name };
    }
    return { entityId: body.entityName as EntityId, entityName: body.entityName };
  }
  return { ...SYSTEM_IDENTITY };
}

function serializeJob(job: MediaJobRow, engine: Engine): Record<string, unknown> {
  const options = parseJson(job.options) as Record<string, unknown> | null;
  const metadata = parseJson(job.metadata) as Record<string, unknown> | null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    entityName: job.entity_name,
    provider: job.provider,
    model: job.model,
    prompt: job.prompt,
    options,
    metadata,
    costEstimate: job.cost_estimate,
    error: job.error,
    assetId: job.asset_id,
    assetUrl: job.asset_id ? resolveAssetUrl(engine, job.asset_id) : null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
  };
}

function resolveAssetUrl(engine: Engine, assetId: string): string | null {
  if (!engine.db || !engine.storage) return null;
  const asset = engine.db.getAsset(assetId);
  if (!asset) return null;
  return engine.storage.resolve(asset.storage_key);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mediaJson(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { ...MEDIA_CORS, "x-request-id": generateRequestId() },
  });
}

function mediaError(status: number, message: string): Response {
  return mediaJson({ error: { message, type: "media_error", code: status } }, status);
}

function generateRequestId(): string {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}
