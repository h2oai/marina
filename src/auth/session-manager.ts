// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";

// ─── Session Types ──────────────────────────────────────────────────────────

export interface Session {
  token: string;
  entityId: EntityId;
  name: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
}

export interface SessionManagerOptions {
  sessionTtlMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private entityIndex = new Map<string, string>(); // entityId -> token
  private db?: MarinaDB;
  private sessionTtlMs: number;

  constructor(db?: MarinaDB, options?: SessionManagerOptions) {
    this.db = db;
    this.sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

    if (this.db) {
      this.db.deleteExpiredSessions(Date.now());
    }
  }

  /** Create a new session for the given entity. Revokes any existing session first. */
  create(entityId: EntityId, name: string): Session {
    this.revokeByEntity(entityId);

    const now = Date.now();
    const session: Session = {
      token: crypto.randomUUID(),
      entityId,
      name,
      createdAt: now,
      lastSeen: now,
      expiresAt: now + this.sessionTtlMs,
    };

    this.sessions.set(session.token, session);
    this.entityIndex.set(entityId, session.token);

    if (this.db) {
      this.db.saveSession(session);
    }

    return session;
  }

  /** Validate a token. Returns the session if valid and not expired. */
  validate(token: string): Session | undefined {
    let session = this.sessions.get(token);

    if (!session && this.db) {
      session = this.db.loadSession(token);
      if (session) {
        this.sessions.set(session.token, session);
        this.entityIndex.set(session.entityId, session.token);
      }
    }

    if (!session) return undefined;

    if (Date.now() > session.expiresAt) {
      this.revoke(token);
      return undefined;
    }

    return session;
  }

  /** Refresh a session's lastSeen and extend its expiry. */
  refresh(token: string): boolean {
    const session = this.validate(token);
    if (!session) return false;

    const now = Date.now();
    session.lastSeen = now;
    session.expiresAt = now + this.sessionTtlMs;

    if (this.db) {
      this.db.saveSession(session);
    }

    return true;
  }

  /** Revoke a session by its token. */
  revoke(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;

    this.sessions.delete(token);
    this.entityIndex.delete(session.entityId);

    if (this.db) {
      this.db.deleteSession(token);
    }

    return true;
  }

  /** Revoke all sessions belonging to a given entity. */
  revokeByEntity(entityId: EntityId): void {
    // Walk the in-memory map — entityIndex only tracks the latest token,
    // but multiple can exist if earlier ones were loaded from DB on validate().
    for (const [token, session] of this.sessions) {
      if (session.entityId === entityId) {
        this.sessions.delete(token);
      }
    }
    this.entityIndex.delete(entityId);

    if (this.db) {
      this.db.deleteSessionsByEntity(entityId);
    }
  }

  /** Remove all expired sessions. Returns count removed. */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
        this.entityIndex.delete(session.entityId);
        removed++;
      }
    }

    if (this.db) {
      const dbRemoved = this.db.deleteExpiredSessions(now);
      removed = Math.max(removed, dbRemoved);
    }

    return removed;
  }

  /** Get the active session for a given entity. */
  getByEntity(entityId: EntityId): Session | undefined {
    const token = this.entityIndex.get(entityId);
    if (token) {
      return this.validate(token);
    }

    if (this.db) {
      const session = this.db.loadSessionByEntity(entityId);
      if (session && Date.now() <= session.expiresAt) {
        this.sessions.set(session.token, session);
        this.entityIndex.set(session.entityId, session.token);
        return session;
      }
    }

    return undefined;
  }
}
