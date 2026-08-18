// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CanvasNodeData } from "./types";

/**
 * Single source of truth for "who created this node."
 *
 * Backend always writes the friendly entity name into `data.author` for
 * feed-published and manually-published nodes. The standalone canvas page's
 * useCanvasWs lifts the row's `creator_name` column into the React Flow
 * node.data alongside the JSON blob, so older nodes (pre-Phase-1) that don't
 * have `data.author` still resolve. Renderers only ever go through this
 * helper so they can't disagree about precedence.
 */
export function resolveAuthor(data: Record<string, unknown>): string {
  const author = data.author;
  if (typeof author === "string" && author) return author;
  const creator = data.creator_name;
  if (typeof creator === "string" && creator) return creator;
  return "";
}

/**
 * Friendly display label for a missing or unknown asset by node type. Renderers
 * use this when a media element fails to load or no URL is set, so the empty
 * states read consistently across image / video / audio / pdf / document.
 */
export function emptyAssetLabel(type: string, errored = false): string {
  const verb = errored ? "failed to load" : "missing";
  switch (type) {
    case "image":
      return `Image ${verb}`;
    case "video":
      return `Video ${verb}`;
    case "audio":
      return `Audio ${verb}`;
    case "pdf":
      return `PDF ${verb}`;
    case "document":
      return `Document ${verb}`;
    default:
      return errored ? `${type} failed to load` : `No ${type}`;
  }
}

/**
 * Pull the title string a node should advertise. Falls back through
 * `title → label → filename → type` so a node without explicit metadata still
 * gets a recognizable header instead of an empty span.
 */
export function resolveTitle(data: Record<string, unknown>, type?: string): string {
  const t = data.title;
  if (typeof t === "string" && t) return t;
  const l = data.label;
  if (typeof l === "string" && l) return l;
  const f = data.filename;
  if (typeof f === "string" && f) return f;
  return type ?? "";
}

/** Convenience for code paths that already have a typed CanvasNodeData. */
export function resolveAuthorFromNode(node: CanvasNodeData): string {
  return resolveAuthor({ ...node.data, creator_name: node.creator_name });
}
