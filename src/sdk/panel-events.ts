// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { PanelSource } from "./panel-resources";

/** A hint to reread; never use stream payloads as resource content or authority. */
export interface PanelChangeEvent {
  type: string;
  resource?: string;
  id?: string;
  taskId?: number;
  noteId?: number;
  canvasId?: string;
  nodeId?: string;
  spaceId?: string;
}
export function panelSourceAffected(source: PanelSource, event: PanelChangeEvent): boolean {
  // Catalog views span domains. Coalesce hints in the host and reread with the current
  // viewer credential; events never contain the snapshot or confer read authority.
  if (source.kind === "resource") return true;
  if (["rank_change", "coordination_change", "entity_leave"].includes(event.type)) return true;
  if (event.type === "resource_changed") {
    if (event.resource === "coding")
      return (
        source.kind === "task" ||
        source.kind === "run" ||
        (source.kind === "coding" && (!event.id || event.id === source.id)) ||
        (source.kind === "artifact" && (!event.id || event.id === source.sessionId))
      );
    return (
      source.kind === "participant" &&
      event.resource === "participant" &&
      (!event.id || event.id === source.id)
    );
  }
  switch (source.kind) {
    case "task":
      return (
        event.type.startsWith("task_") && (!event.taskId || String(event.taskId) === source.id)
      );
    case "note":
      return (
        event.type.startsWith("note_") ||
        event.type === "pool_note" ||
        event.type === "memory_service_event"
      );
    case "memory":
      return (
        event.type === "memory_service_event" &&
        (!event.spaceId || source.spaceId === event.spaceId)
      );
    case "feed":
      return event.type === "feed_event";
    case "canvas":
      return event.canvasId === source.canvasId;
    default:
      return false;
  }
}
