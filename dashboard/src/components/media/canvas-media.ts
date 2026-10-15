// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas media nodes as media-viewer entries, shared by the standalone
 * canvas and the unified surface so ←/→ walks a canvas's media in order.
 */

import type { ViewableAsset } from "./MediaViewer";

const MEDIA_NODE_TYPES = new Set(["image", "video", "audio", "pdf"]);

/** A media node (image/video/audio/pdf with a URL, not an intent) as a viewer entry. */
export function canvasNodeViewable(node: {
  type?: string;
  data?: unknown;
}): ViewableAsset | undefined {
  const d = (node.data ?? {}) as Record<string, unknown>;
  if (!node.type || !MEDIA_NODE_TYPES.has(node.type) || d.intent) return undefined;
  if (typeof d.url !== "string" || !d.url) return undefined;
  const title = [d.filename, d.title].find((v): v is string => typeof v === "string" && !!v);
  return {
    url: d.url,
    kind: node.type,
    title: title ?? node.type,
    ...(typeof d.mime === "string" ? { mime: d.mime } : {}),
    ...(typeof d.asset_id === "string" ? { id: d.asset_id } : {}),
  };
}

/** The media nodes of a canvas, in order. */
export function canvasMediaCollection(
  nodes: readonly { type?: string; data?: unknown }[],
): ViewableAsset[] {
  return nodes.flatMap((n) => {
    const v = canvasNodeViewable(n);
    return v ? [v] : [];
  });
}
