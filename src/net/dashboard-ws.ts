import type { ServerWebSocket } from "bun";
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
    agentStatus?: {
      state: string;
      model: string;
      role: string;
      focus: string | null;
      uptime: number;
      toolCalls: number;
      errors: number;
      errorReason: string | null;
    };
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
        return { type: event.type, protocol: event.protocol, timestamp: event.timestamp };
      case "disconnect":
        return { type: event.type, timestamp: event.timestamp };
      case "command":
        // Omit raw input — may contain sensitive data (tokens, keys, passwords)
        return { type: event.type, entity: event.entity, timestamp: event.timestamp };
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
            };
          })()
        : undefined;

      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        room: e.room as string,
        agentStatus,
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
