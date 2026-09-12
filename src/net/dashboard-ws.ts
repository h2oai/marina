// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ServerWebSocket } from "bun";
import type { AgentSupports } from "../agent/agent-types";
import type { Engine } from "../engine/engine";
import type { EngineEvent } from "../types";
import { memoryObserver } from "./memory-visibility";

export interface DashboardWSData {
  connId: string;
  isDashboard: true;
  principal?: string;
}

export interface WorldSnapshot {
  timestamp: number;
  instanceName: string;
  worldName: string;
  startRoom: string;
  entities: {
    id: string;
    name: string;
    kind: string;
    room: string;
    properties: Record<string, unknown>;
    agentStatus?: {
      state: string;
      model: string;
      role: string;
      focus: string | null;
      uptime: number;
      toolCalls: number;
      errors: number;
      errorReason: string | null;
      supports: AgentSupports;
      /** ms-since-epoch of the agent's last activity (liveness). */
      lastActivity?: number;
      /** EMA of LLM turn latency in ms — the "is the model slow?" signal. */
      avgTurnMs?: number;
      /** Consecutive zero-tool-call turns — the "stuck" signal. */
      silentTurns?: number;
    };
    /** AgentConfig.spawned_by — "system" (seeded), "operator" (dashboard/CLI),
     *  or a spawning agent's name (crew). Undefined for non-runtime entities. */
    spawnedBy?: string;
  }[];
  roomPopulations: Record<string, number>;
  rooms: {
    id: string;
    short: string;
    district: string;
    exits: Record<string, string>;
  }[];
  connections: number;
  memory: { heapUsed: number; rss: number };
  gridPositions?: Record<string, { row: number; col: number }>;
}

export class DashboardBroadcaster {
  private clients = new Map<ServerWebSocket<DashboardWSData>, Engine>();

  addClient(ws: ServerWebSocket<DashboardWSData>, engine: Engine): void {
    this.clients.set(ws, engine);
    // Send initial snapshot
    const snapshot = this.buildSnapshot(engine, ws.data.principal);
    ws.send(JSON.stringify({ type: "snapshot", data: snapshot }));
  }

  removeClient(ws: ServerWebSocket<DashboardWSData>): void {
    this.clients.delete(ws);
  }

  broadcastEvent(event: EngineEvent): void {
    if (event.type === "tick") return;
    if (this.clients.size === 0) return;
    const filtered = this.filterEvent(event);
    if (!filtered) return;
    const msg = JSON.stringify({ type: "event", data: filtered });
    for (const [ws, engine] of this.clients) {
      try {
        if (memoryObserver(engine, ws.data.principal).event(event)) ws.send(msg);
      } catch (err) {
        console.warn("[dashboard-ws] broadcast event send failed:", (err as Error).message);
        this.clients.delete(ws);
      }
    }
  }

  /**
   * Strip sensitive fields from events before broadcasting to dashboard clients.
   * Connection IDs and raw command input are internal details — dashboard viewers
   * only need to know *that* something happened, not the internal identifiers.
   */
  private filterEvent(event: EngineEvent): Record<string, unknown> | null {
    switch (event.type) {
      case "connect":
      case "disconnect":
        // Raw transport-level connect/disconnect fire before entity binding and
        // after teardown, so they carry no entity — only a connectionId, which
        // we strip as an internal identifier. That leaves nothing to display
        // (the feed rendered "undefined connected"), and they flood the feed on
        // reconnect churn. The meaningful arrival/departure signal is the named
        // entity_enter / entity_leave pair, so drop these entirely.
        return null;
      case "command":
        // Drop entirely. Raw input is stripped (it may carry tokens/keys/
        // passwords), which left a content-free row that rendered as a bare
        // "> " — and the meaningful commands already surface as their own
        // richer typed events (say, tell, note_created, recall_trace, task_*).
        // So the bare command event is either empty noise or a duplicate of a
        // better row beside it. Same rationale as connect/disconnect above.
        return null;
      default:
        return event as Record<string, unknown>;
    }
  }

  broadcastState(engine: Engine): void {
    if (this.clients.size === 0) return;
    for (const [ws] of this.clients) {
      try {
        ws.send(
          JSON.stringify({ type: "state", data: this.buildSnapshot(engine, ws.data.principal) }),
        );
      } catch (err) {
        console.warn("[dashboard-ws] broadcast state send failed:", (err as Error).message);
        this.clients.delete(ws);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private buildSnapshot(engine: Engine, principal?: string): WorldSnapshot {
    const observer = memoryObserver(engine, principal);
    // One bulk read per snapshot (broadcast every 2s) — a per-entity
    // getAgentConfig lookup was ~N queries/snapshot just for spawned_by.
    const spawnedByName = new Map<string, string | null>();
    if (engine.db) {
      for (const config of engine.db.getAllAgentConfigs()) {
        spawnedByName.set(config.name, config.spawned_by);
      }
    }
    const entities = engine.entities.all().map((e) => {
      const privateView = observer.privilegedRead || observer.entity?.id === e.id;
      const agentHandle = engine.agentRuntime.get(e.name);
      const agentStatus = agentHandle
        ? (() => {
            const s = agentHandle.getStatus();
            return {
              state: s.state,
              model: s.model,
              role: s.role,
              focus: privateView ? s.focus : null,
              uptime: s.uptime,
              toolCalls: s.toolCalls,
              errors: s.errors,
              errorReason: privateView ? s.errorReason : null,
              supports: s.supports,
              // Liveness signals (observability): "last acted", model latency,
              // and the stuck counter — let the roster show alive/idle/stuck/dead.
              lastActivity: s.lastActivity,
              avgTurnMs: s.avgTurnMs,
              silentTurns: s.silentTurns,
            };
          })()
        : undefined;

      // Origin: world-seeded ("system"), operator-launched ("operator"), or a
      // spawning agent's name (crew). Read from the persisted AgentConfig; only
      // meaningful for agent entities (humans / external agents have no config).
      const spawnedBy = agentHandle ? (spawnedByName.get(e.name) ?? undefined) : undefined;

      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        room: e.room as string,
        properties: privateView
          ? e.properties
          : { rank: e.properties.rank, role: e.properties.role },
        agentStatus,
        spawnedBy,
      };
    });

    const roomPopulations: Record<string, number> = {};
    for (const e of entities) {
      roomPopulations[e.room] = (roomPopulations[e.room] ?? 0) + 1;
    }

    const rooms = engine.rooms.all().map((r) => ({
      id: r.id as string,
      short: r.module.short,
      district: (r.id as string).split("/")[0] ?? "",
      exits: Object.fromEntries(
        Object.entries(r.module.exits ?? {}).map(([k, v]) => [k, v as string]),
      ),
    }));

    const mem = process.memoryUsage();
    return {
      timestamp: Date.now(),
      instanceName: engine.instanceName,
      worldName: engine.world?.name ?? "Unknown",
      startRoom: engine.config.startRoom as string,
      entities,
      roomPopulations,
      rooms,
      connections: engine.getConnections().size,
      memory: { heapUsed: mem.heapUsed, rss: mem.rss },
      gridPositions: engine.world?.gridPositions,
    };
  }
}
