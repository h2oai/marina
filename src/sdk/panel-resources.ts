// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { A2UINodeData } from "./panel-document";
import {
  type CatalogPanelSource,
  panelResourcePath,
  parseCatalogPanelSource,
} from "./panel-resource-catalog";

export type PanelSource =
  | CatalogPanelSource
  | { kind: "task" | "note" | "participant" | "run" | "coding"; id: string }
  | { kind: "artifact"; id: string; sessionId: string }
  | { kind: "memory"; id: string; spaceId: string }
  | { kind: "canvas"; id: string; canvasId: string }
  | { kind: "feed"; limit?: number; filter?: string };

export function parsePanelSource(input: unknown): PanelSource | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (r.kind === "resource") return parseCatalogPanelSource(input);
  const id = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "." &&
    value !== ".." &&
    ![...value].some((c) => c.charCodeAt(0) < 32);
  if (
    r.kind === "feed" &&
    (r.limit === undefined ||
      (Number.isInteger(r.limit) && Number(r.limit) >= 1 && Number(r.limit) <= 100)) &&
    (r.filter === undefined || (typeof r.filter === "string" && r.filter.length <= 100))
  )
    return {
      kind: "feed",
      ...(r.limit !== undefined ? { limit: Number(r.limit) } : {}),
      ...(typeof r.filter === "string" ? { filter: r.filter } : {}),
    };
  if (!id(r.id)) return null;
  if ((r.kind === "task" || r.kind === "note") && /^\d+$/.test(r.id))
    return { kind: r.kind, id: r.id };
  if (r.kind === "participant" || r.kind === "run" || r.kind === "coding")
    return { kind: r.kind, id: r.id };
  if (r.kind === "artifact" && id(r.sessionId))
    return { kind: r.kind, id: r.id, sessionId: r.sessionId };
  if (r.kind === "memory" && id(r.spaceId)) return { kind: r.kind, id: r.id, spaceId: r.spaceId };
  if (r.kind === "canvas" && id(r.canvasId))
    return { kind: r.kind, id: r.id, canvasId: r.canvasId };
  return null;
}

export interface PanelValueBinding {
  source: string;
  path: string[];
}
export function isPanelValueBinding(value: unknown): value is PanelValueBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.source === "string" &&
    b.source.length > 0 &&
    Array.isArray(b.path) &&
    b.path.length <= 8 &&
    b.path.every(
      (part) =>
        typeof part === "string" &&
        part.length <= 100 &&
        !["__proto__", "prototype", "constructor"].includes(part),
    )
  );
}
export function readPanelValue(data: unknown, path: string[]): unknown {
  let value = data;
  for (const part of path) {
    if (
      ["__proto__", "prototype", "constructor"].includes(part) ||
      !value ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    )
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Fixed adapters to canonical APIs. Credentials/authorization are owned by the caller. */
export async function resolvePanelSource(
  source: PanelSource,
  read: (path: string) => Promise<unknown>,
  memory?: (id: string, spaceId: string) => Promise<unknown>,
): Promise<unknown> {
  const normalized = parsePanelSource(source);
  if (!normalized) throw new Error("Invalid panel source reference.");
  source = normalized;
  const e = encodeURIComponent;
  switch (source.kind) {
    case "resource":
      return read(panelResourcePath(source));
    case "memory":
      if (!memory)
        throw new Error("Use an authenticated resident memory connection for this source.");
      return memory(source.id, source.spaceId);
    case "task": {
      const result = (await read(`/api/coordination/tasks/${e(source.id)}`)) as { task?: unknown };
      return result.task ?? result;
    }
    case "note": {
      const result = (await read(`/api/notes/${e(source.id)}`)) as { note?: unknown };
      return result.note ?? result;
    }
    case "artifact": {
      const result = (await read(`/api/coding/session/${e(source.sessionId)}`)) as {
        artifacts: Array<{ id: string }>;
      };
      const artifact = result.artifacts.find((a) => a.id === source.id);
      if (!artifact) throw new Error("Artifact is unavailable.");
      return artifact;
    }
    case "run":
      return read(`/api/coding/runs/${e(source.id)}`);
    case "coding":
      return read(`/api/coding/session/${e(source.id)}`);
    case "canvas":
      return read(`/api/canvases/${e(source.canvasId)}/nodes/${e(source.id)}`);
    case "participant": {
      const session = (await read(`/api/routing/sessions/${e(source.id)}`)) as {
        lastSequence: number;
      };
      const events = (await read(
        `/api/routing/sessions/${e(source.id)}/events?after=${Math.max(0, session.lastSequence - 100)}&limit=100`,
      )) as Record<string, unknown>;
      return { session, ...events };
    }
    case "feed":
      return read(
        `/api/feed?limit=${source.limit ?? 25}${source.filter ? `&kind=${e(source.filter)}` : ""}`,
      );
  }
}

/** Materialize a view without modifying the published definition or granting source authority. */
export function resolvePanelBindings(
  document: A2UINodeData,
  sources: Record<string, unknown>,
): A2UINodeData {
  return {
    ...document,
    components: document.components.map((component) => {
      const next = { ...component };
      for (const [property, binding] of Object.entries(
        (component.bindings ?? {}) as Record<string, unknown>,
      )) {
        if (!isPanelValueBinding(binding)) continue;
        const value = readPanelValue(
          binding.source === "dataModel" ? document.dataModel : sources[binding.source],
          binding.path,
        );
        next[property] =
          value !== undefined
            ? value
            : property === "text"
              ? "Source unavailable or loading…"
              : property === "rows" || property === "items"
                ? []
                : property === "value"
                  ? ""
                  : false;
      }
      return next;
    }),
  };
}
