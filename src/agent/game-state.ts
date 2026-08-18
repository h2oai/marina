// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { EntityId, Perception, RoomId } from "../types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "authenticated";

export interface EntityInfo {
  id: EntityId;
  name: string;
  short: string;
}

export interface RoomInfo {
  id: RoomId;
  short: string;
  long: string;
  items: Record<string, string>;
  exits: string[];
  entities: EntityInfo[];
}

export interface GameState {
  connection: {
    status: ConnectionStatus;
    wsUrl?: string;
    connectedAt?: number;
    entityId?: EntityId;
    characterName?: string;
    token?: string;
  };
  location: {
    currentRoom?: RoomInfo;
  };
  entities: {
    present: EntityInfo[];
    known: Map<string, EntityInfo>;
  };
  recentPerceptions: Perception[];
  lastUpdate: number;
}

// ─── Game State Manager ─────────────────────────────────────────────────────

const MAX_RECENT_PERCEPTIONS = 100;

export class GameStateManager {
  private state: GameState;

  constructor() {
    this.state = this.createInitialState();
  }

  private createInitialState(): GameState {
    return {
      connection: { status: "disconnected" },
      location: {},
      entities: { present: [], known: new Map() },
      recentPerceptions: [],
      lastUpdate: Date.now(),
    };
  }

  setConnectionStatus(status: ConnectionStatus, wsUrl?: string): void {
    this.state.connection.status = status;
    if (wsUrl) this.state.connection.wsUrl = wsUrl;
    if (status === "connected") this.state.connection.connectedAt = Date.now();
    this.markUpdated();
  }

  setSession(entityId: EntityId, name: string, token: string): void {
    this.state.connection.entityId = entityId;
    this.state.connection.characterName = name;
    this.state.connection.token = token;
    this.state.connection.status = "authenticated";
    this.markUpdated();
  }

  handlePerception(p: Perception): void {
    this.state.recentPerceptions.push(p);
    if (this.state.recentPerceptions.length > MAX_RECENT_PERCEPTIONS) {
      this.state.recentPerceptions.shift();
    }

    switch (p.kind) {
      case "room":
        this.handleRoomPerception(p);
        break;
      case "movement":
        this.handleMovementPerception(p);
        break;
      case "system":
        this.handleSystemPerception(p);
        break;
    }

    this.markUpdated();
  }

  private handleRoomPerception(p: Perception): void {
    const data = p.data as Record<string, unknown>;
    const room: RoomInfo = {
      id: (data.id as RoomId) ?? ("" as RoomId),
      short: (data.short as string) ?? "",
      long: (data.long as string) ?? "",
      items: (data.items as Record<string, string>) ?? {},
      exits: (data.exits as string[]) ?? [],
      entities: ((data.entities as Array<{ id: EntityId; name: string; short: string }>) ?? []).map(
        (e) => ({ id: e.id, name: e.name, short: e.short }),
      ),
    };

    this.state.location.currentRoom = room;
    this.state.entities.present = room.entities;

    for (const entity of room.entities) {
      this.state.entities.known.set(entity.name, entity);
    }
  }

  private handleMovementPerception(p: Perception): void {
    const data = p.data as {
      entity?: EntityId;
      entityName?: string;
      direction?: "arrive" | "depart";
    };

    if (data.direction === "arrive" && data.entity) {
      const existing = this.state.entities.present.find((e) => e.id === data.entity);
      if (!existing) {
        const info: EntityInfo = {
          id: data.entity,
          name: data.entityName ?? "",
          short: data.entityName ?? "",
        };
        this.state.entities.present.push(info);
        this.state.entities.known.set(info.name, info);
      }
    } else if (data.direction === "depart" && data.entity) {
      this.state.entities.present = this.state.entities.present.filter((e) => e.id !== data.entity);
    }
  }

  private handleSystemPerception(p: Perception): void {
    const data = p.data as { entityId?: EntityId; token?: string };
    if (data.entityId && data.token) {
      this.state.connection.entityId = data.entityId;
      this.state.connection.token = data.token;
    }
  }

  getState(): Readonly<GameState> {
    return this.state;
  }

  getCurrentRoom(): RoomInfo | undefined {
    return this.state.location.currentRoom;
  }

  getPresentEntities(): EntityInfo[] {
    return this.state.entities.present;
  }

  getRecentPerceptions(kind?: string, limit = 10): Perception[] {
    const perceptions = kind
      ? this.state.recentPerceptions.filter((p) => p.kind === kind)
      : this.state.recentPerceptions;
    return perceptions.slice(-limit);
  }

  getContextSummary(): string {
    const parts: string[] = [];

    parts.push(`Connection: ${this.state.connection.status}`);
    if (this.state.connection.characterName) {
      parts.push(`Character: ${this.state.connection.characterName}`);
    }

    const room = this.state.location.currentRoom;
    if (room) {
      parts.push(`Location: ${room.short} (${room.id})`);
      if (room.exits.length > 0) parts.push(`Exits: ${room.exits.join(", ")}`);
      if (Object.keys(room.items).length > 0)
        parts.push(`Items: ${Object.keys(room.items).join(", ")}`);
      if (room.entities.length > 0)
        parts.push(`Present: ${room.entities.map((e) => e.name).join(", ")}`);
    }

    const recent = this.state.recentPerceptions.slice(-5);
    if (recent.length > 0) {
      parts.push("\nRecent events:");
      for (const p of recent) {
        const text = (p.data?.text as string) || (p.data?.short as string) || p.kind;
        parts.push(`  - [${p.kind}] ${text.substring(0, 100)}`);
      }
    }

    return parts.join("\n");
  }

  reset(): void {
    this.state = this.createInitialState();
  }

  private markUpdated(): void {
    this.state.lastUpdate = Date.now();
  }
}
