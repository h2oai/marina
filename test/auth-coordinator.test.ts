// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { AuthCoordinator, type AuthTimers } from "../src/engine/auth-coordinator";
import { BriefManager } from "../src/engine/brief-manager";
import { ConnectionManager } from "../src/engine/connection-manager";
import { Logger } from "../src/engine/logger";
import type { EngineEvent } from "../src/types";
import { roomId } from "../src/types";
import { EntityManager } from "../src/world/entity-manager";
import { MockConnection } from "./helpers";

function fixture() {
  const connections = new ConnectionManager();
  const entities = new EntityManager();
  const events: EngineEvent[] = [];
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  const timers: AuthTimers = {
    setTimeout: ((callback: () => void) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      callbacks.set(handle, callback);
      return handle;
    }) as typeof setTimeout,
    clearTimeout: (handle) => callbacks.delete(handle as ReturnType<typeof setTimeout>),
  };
  const auth = new AuthCoordinator(
    {
      config: { internalAuthToken: "fixture-token", maxLogins: 1 },
      connections,
      entities,
      briefs: new BriefManager(),
      logger: new Logger(),
      loginRateLimiter: new RateLimiter({ maxTokens: 1, refillRate: 1, refillInterval: 60000 }),
      spawnEntity(id, name) {
        const entity = entities.create({
          kind: "agent",
          name,
          short: name,
          long: name,
          room: roomId("test/start"),
        });
        connections.bindEntity(id, entity.id);
        return entity;
      },
      processCommand: async () => {},
      buildContext: () => undefined,
      logEvent: (event) => events.push(event),
    },
    timers,
  );
  const connect = (id: string) => {
    const conn = new MockConnection(id);
    conn.ip = "203.0.113.4";
    connections.add(conn);
  };
  return { auth, connections, entities, events, callbacks, connect };
}

test("auth owns shared IP attempt limits and internal-agent exemptions without an Engine", () => {
  const f = fixture();
  try {
    f.connect("first");
    expect(f.auth.login("first", "Alice")).toHaveProperty("entityId");
    f.connect("second");
    expect(f.auth.login("second", "Bob")).toEqual({
      error: "Too many login attempts. Please slow down and retry shortly.",
    });
    expect(f.auth.login("second", "Guide", "fixture-token")).toHaveProperty("entityId");
    expect(f.connections.boundExternalCount()).toBe(1);
  } finally {
    f.auth.stop();
  }
});

test("rebind cancels eviction; explicit quit emits one leave and removes immediately", () => {
  const f = fixture();
  try {
    f.connect("first");
    const login = f.auth.login("first", "Guide", "fixture-token");
    if ("error" in login) throw new Error(login.error);
    f.auth.removeConnection("first");
    expect(f.callbacks.size).toBe(1);
    expect(f.entities.get(login.entityId)).toBeDefined();
    f.connect("rebound");
    expect(f.auth.login("rebound", "Guide", "fixture-token")).toHaveProperty(
      "entityId",
      login.entityId,
    );
    expect(f.callbacks.size).toBe(0);
    f.auth.removeConnection("rebound", "explicit");
    expect(f.entities.get(login.entityId)).toBeUndefined();
    expect(f.events.filter((e) => e.type === "entity_leave")).toHaveLength(1);
  } finally {
    f.auth.stop();
  }
});

test("grace expiry removes the entity; stopping cancels timers even without starting a loop", () => {
  const f = fixture();
  f.connect("first");
  const login = f.auth.login("first", "Guide", "fixture-token");
  if ("error" in login) throw new Error(login.error);
  f.auth.removeConnection("first");
  const expire = [...f.callbacks.values()][0]!;
  expire();
  expect(f.entities.get(login.entityId)).toBeUndefined();
  f.callbacks.clear();
  f.connect("second");
  f.auth.login("second", "Guide", "fixture-token");
  f.auth.removeConnection("second");
  f.auth.stop();
  expect(f.callbacks.size).toBe(0);
});
