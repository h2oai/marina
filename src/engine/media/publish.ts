// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { extname } from "node:path";
import type { EntityId } from "../../types";
import type { Engine } from "../engine";

const DEFAULT_IMAGE_EXT = ".png";
const DEFAULT_VIDEO_EXT = ".mp4";

interface StoreGeneratedAssetParams {
  engine: Engine;
  entityName: string;
  filename?: string;
  mimeType: string;
  data: Uint8Array;
  prompt: string;
  model: string;
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface StoredAssetResult {
  id: string;
  filename: string;
  storageKey: string;
}

export async function storeGeneratedAsset({
  engine,
  entityName,
  filename,
  mimeType,
  data,
  prompt,
  model,
  metadata,
  id,
}: StoreGeneratedAssetParams): Promise<StoredAssetResult> {
  if (!engine.db) throw new Error("Database not configured — cannot store generated asset.");
  if (!engine.storage) throw new Error("Storage not configured — cannot store generated asset.");

  const assetId = id ?? crypto.randomUUID();
  const safeFilename =
    filename?.trim() && filename.trim().length > 0
      ? filename.trim()
      : `${assetId}${inferExt(mimeType)}`;
  const storageKey = `${assetId}${inferExt(mimeType, safeFilename)}`;

  await engine.storage.put(storageKey, data, mimeType);

  engine.db.createAsset({
    id: assetId,
    entityName,
    filename: safeFilename,
    mimeType,
    size: data.byteLength,
    storageKey,
    metadata: {
      origin: "generated",
      prompt,
      model,
      ...metadata,
    },
  });

  return { id: assetId, filename: safeFilename, storageKey };
}

interface PublishGeneratedAssetParams {
  engine: Engine;
  entityId: EntityId;
  entityName: string;
  assetId: string;
  nodeType: "image" | "video";
  prompt: string;
  model: string;
  canvasId?: string;
  summary?: string;
}

export interface PublishResult {
  canvasId: string;
  nodeId: string;
}

export function publishGeneratedAsset({
  engine,
  entityId,
  entityName,
  assetId,
  nodeType,
  prompt,
  model,
  canvasId,
  summary,
}: PublishGeneratedAssetParams): PublishResult {
  if (!engine.db) throw new Error("Database not configured — cannot publish generated asset.");

  const db = engine.db;
  const asset = db.getAsset(assetId);
  if (!asset) {
    throw new Error(`Asset ${assetId} not found — cannot publish.`);
  }

  const canvas =
    (canvasId ? db.getCanvas(canvasId) : null) ??
    db.ensureEntityCanvas(entityId, entityName, entityName);
  const targetCanvasId = canvas.id;

  const nodes = db.getNodesByCanvas(targetCanvasId);
  const maxY = nodes.reduce((acc, node) => Math.max(acc, node.y + node.height), 0);

  const nodeId = crypto.randomUUID();
  const now = Date.now();
  const data = {
    filename: asset.filename,
    mime: asset.mime_type,
    url: engine.storage?.resolve(asset.storage_key),
    title: asset.filename,
    author: entityName,
    prompt,
    model,
  };

  db.createNode({
    id: nodeId,
    canvasId: targetCanvasId,
    type: nodeType,
    x: 0,
    y: maxY + 20,
    assetId: assetId,
    data,
    creatorName: entityName,
  });

  engine.logEvent({
    type: "canvas_publish",
    entity: entityId,
    canvasId: targetCanvasId,
    nodeId,
    timestamp: now,
  });

  engine.logEvent({
    type: "feed_event",
    kind: nodeType === "video" ? "video_generated" : "image_generated",
    entity: entityId,
    ref: assetId,
    summary: summary ?? `${entityName} generated ${nodeType} "${asset.filename}" with ${model}`,
    payload: {
      canvasId: targetCanvasId,
      nodeId,
      assetId,
      model,
      prompt,
      mime: asset.mime_type,
      filename: asset.filename,
    },
    timestamp: now,
  });

  return { canvasId: targetCanvasId, nodeId };
}

function inferExt(mime: string, fallbackFilename?: string): string {
  const fallback = fallbackFilename ? extname(fallbackFilename) : "";
  if (mime.startsWith("image/")) {
    return fallback || DEFAULT_IMAGE_EXT;
  }
  if (mime.startsWith("video/")) {
    return fallback || DEFAULT_VIDEO_EXT;
  }
  return fallback || DEFAULT_IMAGE_EXT;
}
