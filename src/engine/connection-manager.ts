// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Connection, EntityId, Perception } from "../types";

/**
 * Manages the bidirectional mapping between connections and entities.
 *
 * Extracted from Engine to reduce god-object surface area.
 * Owns the `connections` and `entityToConnection` maps.
 * The Engine delegates connection storage and lookup through this class.
 */
export class ConnectionManager {
  private connections = new Map<string, Connection>();
  private entityToConnection = new Map<EntityId, string>();

  /** Store a new connection. */
  add(conn: Connection): void {
    this.connections.set(conn.id, conn);
  }

  /** Remove a connection by ID. Returns the removed connection, or undefined. */
  remove(connId: string): Connection | undefined {
    const conn = this.connections.get(connId);
    if (!conn) return undefined;
    if (conn.entity) {
      this.entityToConnection.delete(conn.entity);
    }
    this.connections.delete(connId);
    return conn;
  }

  /** Get a connection by ID. */
  get(connId: string): Connection | undefined {
    return this.connections.get(connId);
  }

  /** Check if a connection exists. */
  has(connId: string): boolean {
    return this.connections.has(connId);
  }

  /** Get the full connections map (for backward compatibility). */
  getAll(): Map<string, Connection> {
    return this.connections;
  }

  /** Bind an entity to a connection. */
  bindEntity(connId: string, entityId: EntityId): void {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.entity = entityId;
      this.entityToConnection.set(entityId, connId);
    }
  }

  /** Unbind an entity, removing the entity-to-connection mapping. */
  unbindEntity(entityId: EntityId): void {
    this.entityToConnection.delete(entityId);
  }

  /** Get the entity ID bound to a connection. */
  getEntity(connId: string): EntityId | null {
    const conn = this.connections.get(connId);
    return conn?.entity ?? null;
  }

  /** Get the connection for an entity. */
  getConnectionForEntity(entityId: EntityId): Connection | undefined {
    const connId = this.entityToConnection.get(entityId);
    if (!connId) return undefined;
    return this.connections.get(connId);
  }

  /** Check if an entity has an active connection. */
  isEntityConnected(entityId: EntityId): boolean {
    const connId = this.entityToConnection.get(entityId);
    return connId !== undefined && this.connections.has(connId);
  }

  /** Bound entities on non-internal connections — the instance login-cap denominator. */
  boundExternalCount(): number {
    let count = 0;
    for (const connId of this.entityToConnection.values()) {
      const conn = this.connections.get(connId);
      if (conn && !conn.internal) count++;
    }
    return count;
  }

  /** Send a perception to an entity's connection. Returns false if not connected. */
  sendToEntity(entityId: EntityId, perception: Perception): boolean {
    const connId = this.entityToConnection.get(entityId);
    if (!connId) return false;
    const conn = this.connections.get(connId);
    if (!conn) return false;
    conn.send(perception);
    return true;
  }
}
