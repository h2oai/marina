// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import type { MediaJobRow } from "../persistence/database";
import type { EntityId } from "../types";
import { corsHeaders } from "./cors";

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

    const { entityId, entityName } = resolveEntity(engine, body);

    try {
      const job =
        kind === "image"
          ? await engine.mediaManager.startJob({
              type: "image",
              entityId,
              entityName,
              prompt: body.prompt,
              model: body.model ?? "openai/gpt-image-1",
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
              model: body.model ?? "runway/gen3-alpha",
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
    if (!job) return mediaError(404, "Media job not found.");
    return mediaJson(serializeJob(job, engine));
  }

  return mediaError(404, "Not found.");
}

function resolveEntity(
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
    const match =
      engine.entities.findAgentByName(body.entityName) ??
      engine.entities.all().find((e) => e.name === body.entityName);
    if (match) {
      return { entityId: match.id, entityName: match.name };
    }
    return { entityId: body.entityName as EntityId, entityName: body.entityName };
  }
  return { entityId: "system" as EntityId, entityName: "system" };
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
