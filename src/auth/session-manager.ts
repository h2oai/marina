// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import type { MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";

// ─── Session Types ──────────────────────────────────────────────────────────

export interface Session {
  /**
   * At rest (in-memory map + DB) this holds the SHA-256 HASH of the raw token,
   * never the raw token itself — a memory/DB dump yields no usable credential.
   * The one exception is the object returned by {@link SessionManager.create},
   * which carries the RAW token so the caller can hand it to the client once;
   * that value is never stored.
   */
  token: string;
  entityId: EntityId;
  name: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  /**
   * The rank actually granted to the login that minted this token. A bare
   * passwordless-name token is NOT proof of identity: a remote login is capped
   * at rank 0 even when the persisted user row is elevated. reconnect() must
   * restore at most this rank (unless the reconnecting connection is itself a
   * trusted loopback/internal peer) — otherwise the token would launder the
   * login cap into a full rank restore. Undefined for legacy rows (treated as
   * rank 0 ceiling).
   */
  grantedRank?: number;
}

export interface SessionManagerOptions {
  /** Sliding idle TTL — refreshed on every validate/refresh within the cap. */
  sessionTtlMs?: number;
  /**
   * Absolute lifetime cap. A session's sliding `expiresAt` may be refreshed
   * only up to `createdAt + sessionMaxAgeMs`; past that, validate() rejects
   * regardless of recent activity, so a token cannot be renewed indefinitely.
   */
  sessionMaxAgeMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (absolute cap)

/** Parse a positive-integer ms env var, falling back when unset/invalid. */
function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Hash a raw token for at-rest storage / lookup. Never store the raw token. */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Constant-time comparison of two hex hashes (both are fixed-length). */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private entityIndex = new Map<string, string>(); // entityId -> token
  private db?: MarinaDB;
  private sessionTtlMs: number;
  private sessionMaxAgeMs: number;

  constructor(db?: MarinaDB, options?: SessionManagerOptions) {
    this.db = db;
    this.sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.sessionMaxAgeMs =
      options?.sessionMaxAgeMs ?? envMs("MARINA_SESSION_MAX_AGE_MS", DEFAULT_SESSION_MAX_AGE_MS);

    if (this.db) {
      this.db.deleteExpiredSessions(Date.now());
    }
  }

  /** Create a new session for the given entity. Revokes any existing session first.
   *  `grantedRank` records the rank actually granted to the minting login — the
   *  ceiling reconnect() may restore from this token (see Session.grantedRank). */
  create(entityId: EntityId, name: string, grantedRank?: number): Session {
    this.revokeByEntity(entityId);

    const now = Date.now();
    // Mint the raw token but persist only its hash. The raw token is returned
    // to the caller once (below) and never stored at rest.
    const rawToken = crypto.randomUUID();
    const tokenHash = hashToken(rawToken);
    const stored: Session = {
      token: tokenHash,
      entityId,
      name,
      createdAt: now,
      lastSeen: now,
      expiresAt: now + this.sessionTtlMs,
      grantedRank,
    };

    this.sessions.set(tokenHash, stored);
    this.entityIndex.set(entityId, tokenHash);

    if (this.db) {
      this.db.saveSession(stored);
    }

    // Return the RAW token to the caller exactly once; the at-rest record keeps
    // only the hash.
    return { ...stored, token: rawToken };
  }

  /** Validate a presented (raw) token. Returns the session if valid, not idle-
   *  expired, and within its absolute max-age cap. */
  validate(token: string): Session | undefined {
    return this.validateByHash(hashToken(token));
  }

  /** Core validation keyed by the at-rest token hash. */
  private validateByHash(tokenHash: string): Session | undefined {
    let session = this.sessions.get(tokenHash);

    if (!session && this.db) {
      session = this.db.loadSession(tokenHash);
      if (session) {
        this.sessions.set(session.token, session);
        this.entityIndex.set(session.entityId, session.token);
      }
    }

    if (!session) return undefined;

    // Constant-time confirm the presented hash matches the stored one (defends
    // any lookup that isn't a direct hash-keyed map hit).
    if (!hashesEqual(tokenHash, session.token)) return undefined;

    const now = Date.now();
    // Reject on idle-expiry OR once past the absolute lifetime cap — the latter
    // fires even if the token was used moments ago, so it can't be renewed
    // indefinitely by activity.
    if (now > session.expiresAt || now >= session.createdAt + this.sessionMaxAgeMs) {
      this.revokeByHash(tokenHash);
      return undefined;
    }

    return session;
  }

  /** Refresh a session's lastSeen and extend its sliding expiry — but never
   *  beyond the absolute `createdAt + maxAge` cap. */
  refresh(token: string): boolean {
    const tokenHash = hashToken(token);
    const session = this.validateByHash(tokenHash);
    if (!session) return false;

    const now = Date.now();
    session.lastSeen = now;
    // Clamp the sliding extension to the absolute cap so activity can't push a
    // session past createdAt + maxAge.
    session.expiresAt = Math.min(now + this.sessionTtlMs, session.createdAt + this.sessionMaxAgeMs);

    if (this.db) {
      this.db.saveSession(session);
    }

    return true;
  }

  /** Revoke a session by its presented (raw) token. */
  revoke(token: string): boolean {
    return this.revokeByHash(hashToken(token));
  }

  /** Revoke a session by its at-rest token hash. */
  private revokeByHash(tokenHash: string): boolean {
    const session = this.sessions.get(tokenHash);
    if (!session) {
      // Not resident in memory — still clear any DB row keyed by this hash.
      if (this.db) this.db.deleteSession(tokenHash);
      return false;
    }

    this.sessions.delete(tokenHash);
    this.entityIndex.delete(session.entityId);

    if (this.db) {
      this.db.deleteSession(tokenHash);
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
      if (now > session.expiresAt || now >= session.createdAt + this.sessionMaxAgeMs) {
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
    // entityIndex stores the at-rest token HASH, so validate by hash directly.
    const tokenHash = this.entityIndex.get(entityId);
    if (tokenHash) {
      return this.validateByHash(tokenHash);
    }

    if (this.db) {
      const session = this.db.loadSessionByEntity(entityId);
      if (session) {
        this.sessions.set(session.token, session);
        this.entityIndex.set(session.entityId, session.token);
        // Re-run the full validity check (idle TTL + absolute cap) via hash.
        return this.validateByHash(session.token);
      }
    }

    return undefined;
  }
}
