// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ServerWebSocket } from "bun";
import type { AgentSupports } from "../agent/agent-types";
import { DASHBOARD_OBSERVER_TTL_MS } from "../engine/constants";
import type { Engine } from "../engine/engine";
import { Logger } from "../engine/logger";
import type { EngineEvent } from "../types";
import { memoryObserver } from "./memory-visibility";

/** Module logger: dashboard broadcast failures. */
const logger = new Logger();

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

type SnapshotEntity = WorldSnapshot["entities"][number];
type Observer = ReturnType<typeof memoryObserver>;

/** Everything in a snapshot that does not vary by principal, plus both shapes
 *  of every entity so a client payload is a per-entity pick, not a rebuild. */
interface BaseSnapshot {
  shared: Omit<WorldSnapshot, "entities">;
  entities: { id: string; pub: SnapshotEntity; priv: SnapshotEntity }[];
}

/**
 * Events after which a cached per-principal observer may be wrong before its
 * TTL lapses. `memoryObserver` captures the principal's live entity binding
 * (`engine.entities.get`) and its sovereign check (`getRank(entity) >= 9`);
 * these are the `EngineEvent`s that change either. Standing / gate / witness
 * changes emit no engine event — the TTL (`DASHBOARD_OBSERVER_TTL_MS`) bounds
 * how long an `admin.destructive` grant or revoke takes to reach the WS view.
 */
export const OBSERVER_INVALIDATING_EVENTS: ReadonlySet<EngineEvent["type"]> = new Set<
  EngineEvent["type"]
>(["rank_change", "agent_spawn", "agent_stop", "entity_enter", "entity_leave"]);

/** Test seams: swap the observer factory / clock, shorten the TTL. */
export interface DashboardBroadcasterDeps {
  observer?: typeof memoryObserver;
  now?: () => number;
  observerTtlMs?: number;
}

export class DashboardBroadcaster {
  private clients = new Map<ServerWebSocket<DashboardWSData>, Engine>();
  /** Per-principal observer, reused across clients and events within one TTL. */
  private observers = new Map<string, { observer: Observer; expires: number }>();
  private readonly makeObserver: typeof memoryObserver;
  private readonly now: () => number;
  private readonly observerTtlMs: number;

  constructor(deps: DashboardBroadcasterDeps = {}) {
    this.makeObserver = deps.observer ?? memoryObserver;
    this.now = deps.now ?? Date.now;
    this.observerTtlMs = deps.observerTtlMs ?? DASHBOARD_OBSERVER_TTL_MS;
  }

  addClient(ws: ServerWebSocket<DashboardWSData>, engine: Engine): void {
    this.clients.set(ws, engine);
    // Send initial snapshot
    const snapshot = this.maskSnapshot(
      this.buildBaseSnapshot(engine),
      this.observerFor(engine, ws.data.principal),
    );
    ws.send(JSON.stringify({ type: "snapshot", data: snapshot }));
  }

  removeClient(ws: ServerWebSocket<DashboardWSData>): void {
    this.clients.delete(ws);
  }

  broadcastEvent(event: EngineEvent): void {
    if (event.type === "tick") return;
    // Invalidate before the visibility check so the event that changed a
    // principal's privilege is itself judged by a fresh observer.
    this.invalidateObservers(event);
    if (this.clients.size === 0) return;
    const filtered = this.filterEvent(event);
    if (!filtered) return;
    const msg = JSON.stringify({ type: "event", data: filtered });
    // Memory observability events are already reduced to ids/names/states by
    // the poller (no task, answer or record content), so every authenticated
    // dashboard client may receive them; per-principal content scoping happens
    // in the REST endpoints (`/api/memory/jobs/:id` etc.).
    const publicShape = event.type === "memory_job" || event.type === "memory_service_event";
    for (const [ws, engine] of this.clients) {
      try {
        if (publicShape || this.observerFor(engine, ws.data.principal).event(event)) ws.send(msg);
      } catch (err) {
        logger.warn("dashboard-ws", "broadcast event send failed", {
          error: (err as Error).message,
        });
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
      case "memory_job":
      case "memory_service_event":
        // Emitted by src/net/memory-observability.ts with ids/names/states
        // only (never task/answer/record content) — pass through unchanged.
        return event as Record<string, unknown>;
      default:
        return event as Record<string, unknown>;
    }
  }

  /**
   * One base snapshot per tick (entity walk, room walk, `getAllAgentConfigs`),
   * then a per-entity shape pick per client. Clients in the same visibility
   * class — privileged, or unprivileged with no entity of their own — share
   * the serialized JSON too; only a principal viewing its own entity gets a
   * bespoke payload (and two tabs of that principal still share one).
   */
  broadcastState(engine: Engine): void {
    if (this.clients.size === 0) return;
    this.pruneObservers();
    const base = this.buildBaseSnapshot(engine);
    const serialized = new Map<string, string>();
    for (const [ws] of this.clients) {
      try {
        const observer = this.observerFor(engine, ws.data.principal);
        const cls = observer.privilegedRead
          ? "privileged"
          : observer.entity
            ? `own:${observer.entity.id}`
            : "public";
        let msg = serialized.get(cls);
        if (msg === undefined) {
          msg = JSON.stringify({ type: "state", data: this.maskSnapshot(base, observer) });
          serialized.set(cls, msg);
        }
        ws.send(msg);
      } catch (err) {
        logger.warn("dashboard-ws", "broadcast state send failed", {
          error: (err as Error).message,
        });
        this.clients.delete(ws);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // ─── Observer cache ────────────────────────────────────────────────────

  private observerFor(engine: Engine, principal?: string): Observer {
    // `undefined` (no principal on the socket) and `""` (an empty one) are both
    // anonymous but must not share an entry — keep them distinct sentinels so a
    // future change to either path cannot silently reuse the other's observer.
    const key = principal === undefined ? "\u0000anon" : `p:${principal}`;
    const now = this.now();
    const hit = this.observers.get(key);
    if (hit && hit.expires > now) return hit.observer;
    const observer = this.makeObserver(engine, principal);
    this.observers.set(key, { observer, expires: now + this.observerTtlMs });
    return observer;
  }

  /**
   * Drop the affected principal's cached observer for events in
   * `OBSERVER_INVALIDATING_EVENTS`. An event that names no entity clears the
   * whole cache: deliberately conservative, since we cannot tell whose
   * privilege changed. These events are rare and an observer costs one gate +
   * standing read to rebuild, so thrash is bounded; correctness wins over the
   * cache. If an entity-less invalidating event ever becomes frequent, narrow
   * it rather than dropping the clear.
   */
  private invalidateObservers(event: EngineEvent): void {
    if (!OBSERVER_INVALIDATING_EVENTS.has(event.type)) return;
    if ("entity" in event && typeof event.entity === "string")
      this.observers.delete(`p:${event.entity}`);
    else this.observers.clear();
  }

  private pruneObservers(): void {
    const now = this.now();
    for (const [key, entry] of this.observers) if (entry.expires <= now) this.observers.delete(key);
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────

  /** Pick each entity's private or public shape for one observer. Field order
   *  is fixed here so every principal's payload has the same wire layout. */
  private maskSnapshot(base: BaseSnapshot, observer: Observer): WorldSnapshot {
    const { privilegedRead, entity } = observer;
    const own = entity?.id;
    const entities = base.entities.map((e) => (privilegedRead || own === e.id ? e.priv : e.pub));
    const s = base.shared;
    return {
      timestamp: s.timestamp,
      instanceName: s.instanceName,
      worldName: s.worldName,
      startRoom: s.startRoom,
      entities,
      roomPopulations: s.roomPopulations,
      rooms: s.rooms,
      connections: s.connections,
      memory: s.memory,
      gridPositions: s.gridPositions,
    };
  }

  private buildBaseSnapshot(engine: Engine): BaseSnapshot {
    // One bulk read per snapshot (broadcast every 2s) — a per-entity
    // getAgentConfig lookup was ~N queries/snapshot just for spawned_by.
    const spawnedByName = new Map<string, string | null>();
    if (engine.db) {
      for (const config of engine.db.getAllAgentConfigs()) {
        spawnedByName.set(config.name, config.spawned_by);
      }
    }
    const roomPopulations: Record<string, number> = {};
    const entities = engine.entities.all().map((e) => {
      const room = e.room as string;
      roomPopulations[room] = (roomPopulations[room] ?? 0) + 1;
      const agentHandle = engine.agentRuntime.get(e.name);
      const status = agentHandle?.getStatus();
      // `focus` and `errorReason` are the only per-principal fields of the
      // status — they may quote a goal or an upstream error body, so they
      // are visible to the entity itself and privileged readers only.
      const agentStatus = (privateView: boolean): SnapshotEntity["agentStatus"] =>
        status
          ? {
              state: status.state,
              model: status.model,
              role: status.role,
              focus: privateView ? status.focus : null,
              uptime: status.uptime,
              toolCalls: status.toolCalls,
              errors: status.errors,
              errorReason: privateView ? status.errorReason : null,
              supports: status.supports,
              // Liveness signals (observability): "last acted", model latency,
              // and the stuck counter — let the roster show alive/idle/stuck/dead.
              lastActivity: status.lastActivity,
              avgTurnMs: status.avgTurnMs,
              silentTurns: status.silentTurns,
            }
          : undefined;

      // Origin: world-seeded ("system"), operator-launched ("operator"), or a
      // spawning agent's name (crew). Read from the persisted AgentConfig; only
      // meaningful for agent entities (humans / external agents have no config).
      const spawnedBy = agentHandle ? (spawnedByName.get(e.name) ?? undefined) : undefined;

      const shape = (privateView: boolean): SnapshotEntity => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        room,
        properties: privateView
          ? e.properties
          : { rank: e.properties.rank, role: e.properties.role },
        agentStatus: agentStatus(privateView),
        spawnedBy,
      });
      return { id: e.id as string, pub: shape(false), priv: shape(true) };
    });

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
      shared: {
        timestamp: this.now(),
        instanceName: engine.instanceName,
        worldName: engine.world?.name ?? "Unknown",
        startRoom: engine.config.startRoom as string,
        roomPopulations,
        rooms,
        connections: engine.getConnections().size,
        memory: { heapUsed: mem.heapUsed, rss: mem.rss },
        gridPositions: engine.world?.gridPositions,
      },
      entities,
    };
  }
}
