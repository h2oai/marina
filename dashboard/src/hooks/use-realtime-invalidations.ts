// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import type { DashboardEvent } from "../lib/types";
import { useInvalidateOnEvent } from "./use-realtime";

/**
 * App-level realtime wiring: maps WS event types to react-query keys
 * that need to be invalidated when those events arrive. Called once
 * from `App.tsx` so every component using the affected `useX` hooks
 * gets live data without having to know about the event stream.
 *
 * Realtime is a core tenet (`feedback_realtime_core_tenet.md`): polled
 * snapshots are only acceptable for bootstrap. This hook is how a
 * polled inspector graduates to live without being rewritten.
 *
 * Param-scoped queries (e.g. `["taskDetail", id]`, `["room", roomId]`,
 * `["entity", name]`) stay in their owning component because the key
 * depends on a prop and the predicate needs to match that param.
 */
export function useGlobalRealtimeInvalidations(): void {
  // ── Coordination: tasks ────────────────────────────────────────────
  useInvalidateOnEvent(
    ["tasks"],
    useCallback(
      (e: DashboardEvent) =>
        e.type === "task_claimed" ||
        e.type === "task_submitted" ||
        e.type === "task_approved" ||
        e.type === "task_rejected",
      [],
    ),
  );

  // ── Coordination: containers ───────────────────────────────────────
  // Every coordination list (projects, groups, channels, pools, boards,
  // connectors, commands) refreshes on a generic `coordination_change`
  // (create/update/delete) scoped by `resource`. This is the path that lets
  // a freshly-created container appear live instead of waiting on the 30s
  // poll. Content events below stack on top for the resources that have them.
  useInvalidateOnEvent(
    ["groups"],
    useCallback(
      (e: DashboardEvent) => e.type === "coordination_change" && e.resource === "group",
      [],
    ),
  );
  useInvalidateOnEvent(
    ["connectors"],
    useCallback(
      (e: DashboardEvent) => e.type === "coordination_change" && e.resource === "connector",
      [],
    ),
  );
  useInvalidateOnEvent(
    ["commands"],
    useCallback(
      (e: DashboardEvent) => e.type === "coordination_change" && e.resource === "command",
      [],
    ),
  );

  // ── Coordination: projects ─────────────────────────────────────────
  // A project's bundleProgress is derived from its child tasks' completion
  // (see getProjects in dashboard-api), so the same task lifecycle events
  // that move ["tasks"] must also refresh ["projects"]; coordination_change
  // covers create + orchestration/memory edits.
  useInvalidateOnEvent(
    ["projects"],
    useCallback(
      (e: DashboardEvent) =>
        (e.type === "coordination_change" && e.resource === "project") ||
        e.type === "task_claimed" ||
        e.type === "task_submitted" ||
        e.type === "task_approved" ||
        e.type === "task_rejected",
      [],
    ),
  );

  // ── Coordination: boards ───────────────────────────────────────────
  useInvalidateOnEvent(
    ["boards"],
    useCallback(
      (e: DashboardEvent) =>
        e.type === "board_post" || (e.type === "coordination_change" && e.resource === "board"),
      [],
    ),
  );

  // ── Coordination: channels ─────────────────────────────────────────
  useInvalidateOnEvent(
    ["channels"],
    useCallback(
      (e: DashboardEvent) =>
        e.type === "channel_message" ||
        (e.type === "coordination_change" && e.resource === "channel"),
      [],
    ),
  );

  // ── Coordination: pools ────────────────────────────────────────────
  useInvalidateOnEvent(
    ["pools"],
    useCallback(
      (e: DashboardEvent) =>
        e.type === "pool_note" || (e.type === "coordination_change" && e.resource === "pool"),
      [],
    ),
  );

  // ── Admin: adapters ────────────────────────────────────────────────
  useInvalidateOnEvent(
    ["adapters"],
    useCallback((e: DashboardEvent) => e.type === "adapter_change", []),
  );

  // ── Admin: keys ────────────────────────────────────────────────────
  useInvalidateOnEvent(
    ["keys"],
    useCallback((e: DashboardEvent) => e.type === "key_change", []),
  );

  // ── Agents: lifecycle (spawn/stop/error/state/rank) ────────────────
  useInvalidateOnEvent(
    ["agents"],
    useCallback(
      (e: DashboardEvent) =>
        e.type === "agent_spawn" ||
        e.type === "agent_stop" ||
        e.type === "agent_error" ||
        e.type === "agent_state_change" ||
        e.type === "rank_change",
      [],
    ),
  );

  // ── System: counts drift on spawn/stop + connect/disconnect ───────
  useInvalidateOnEvent(
    ["system"],
    useCallback(
      (e: DashboardEvent) =>
        e.type === "agent_spawn" ||
        e.type === "agent_stop" ||
        e.type === "connect" ||
        e.type === "disconnect",
      [],
    ),
  );
}
