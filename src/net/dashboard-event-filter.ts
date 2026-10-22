// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EngineEvent } from "../types";

/**
 * The shape of an engine event as the dashboard serves it, shared by the
 * WebSocket broadcast and `GET /api/events` so both surfaces apply one rule.
 * Connection IDs and raw command input are internal details — dashboard
 * viewers only need to know *that* something happened. `null` = not served.
 */
export function dashboardEventShape(event: EngineEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "connect":
    case "disconnect":
      // Raw transport-level connect/disconnect fire before entity binding and
      // after teardown, so they carry no entity — only a connectionId, which
      // is an internal identifier. That leaves nothing to display, and they
      // flood the feed on reconnect churn. The meaningful arrival/departure
      // signal is the named entity_enter / entity_leave pair.
      return null;
    case "command":
      // Raw input may carry tokens, keys or passwords, and the meaningful
      // commands already surface as their own typed events (say_sent,
      // tell_sent, note_created, recall_trace, task_*), so the bare command
      // event is never served.
      return null;
    default:
      // say_sent / tell_sent are content-free by construction (names, a
      // message ref and the causal envelope); memory_job /
      // memory_service_event carry ids/names/states only. Who may see each
      // event is decided per viewer in memoryObserver().event.
      return event as Record<string, unknown>;
  }
}
