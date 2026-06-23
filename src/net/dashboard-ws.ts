import type { ServerWebSocket } from "bun";
import type { AgentSupports } from "../agent/agent-types";
import type { Engine } from "../engine/engine";
import type { EngineEvent } from "../types";

export interface DashboardWSData {
  connId: string;
  isDashboard: true;
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
  private clients = new Set<ServerWebSocket<DashboardWSData>>();

  addClient(ws: ServerWebSocket<DashboardWSData>, engine: Engine): void {
    this.clients.add(ws);
    // Send initial snapshot
    const snapshot = this.buildSnapshot(engine);
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
    for (const ws of this.clients) {
      try {
        ws.send(msg);
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
    const snapshot = this.buildSnapshot(engine);
    const msg = JSON.stringify({ type: "state", data: snapshot });
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch (err) {
        console.warn("[dashboard-ws] broadcast state send failed:", (err as Error).message);
        this.clients.delete(ws);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private buildSnapshot(engine: Engine): WorldSnapshot {
    const entities = engine.entities.all().map((e) => {
      const agentHandle = engine.agentRuntime.get(e.name);
      const agentStatus = agentHandle
        ? (() => {
            const s = agentHandle.getStatus();
            return {
              state: s.state,
              model: s.model,
              role: s.role,
              focus: s.focus,
              uptime: s.uptime,
              toolCalls: s.toolCalls,
              errors: s.errors,
              errorReason: s.errorReason,
              supports: s.supports,
            };
          })()
        : undefined;

      // Origin: world-seeded ("system"), operator-launched ("operator"), or a
      // spawning agent's name (crew). Read from the persisted AgentConfig; only
      // meaningful for agent entities (humans / external agents have no config).
      const spawnedBy = agentHandle ? engine.db?.getAgentConfig(e.name)?.spawned_by : undefined;

      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        room: e.room as string,
        properties: e.properties,
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
