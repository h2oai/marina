// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.Map;

/**
 * Something changed: a hint to read again, never content or authority. Only {@code type} is
 * always present.
 *
 * @param type {@code canvas_node_created}, {@code resource_changed}, ...
 * @param resource on {@code resource_changed}: {@code coding}, {@code participant}, ...; or null
 * @param id the changed resource, or null
 * @param taskId a task, or null
 * @param noteId a note, or null
 * @param canvasId a canvas, or null
 * @param nodeId a canvas node, or null
 * @param spaceId a memory space, or null
 * @param raw everything the server sent
 */
public record PanelChangeEvent(
    String type,
    String resource,
    String id,
    Long taskId,
    Long noteId,
    String canvasId,
    String nodeId,
    String spaceId,
    Map<String, Object> raw) {

  /** The event a {@code /dashboard-ws} {@code event} frame carries, or null. */
  public static PanelChangeEvent from(Map<String, Object> data) {
    if (data == null || !(data.get("type") instanceof String type)) return null;
    return new PanelChangeEvent(
        type,
        Json.string(data.get("resource")),
        Json.string(data.get("id")),
        data.get("taskId") instanceof Number n ? n.longValue() : null,
        data.get("noteId") instanceof Number n ? n.longValue() : null,
        Json.string(data.get("canvasId")),
        Json.string(data.get("nodeId")),
        Json.string(data.get("spaceId")),
        java.util.Collections.unmodifiableMap(data));
  }
}
