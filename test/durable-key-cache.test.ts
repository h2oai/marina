// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `MarinaDB.durableEntityKey()`'s transient-id → `users.id` cache is a bounded
 * LRU (`DURABLE_KEY_CACHE_MAX`): entity ids re-mint on every name-login, so an
 * unbounded map grew with the lifetime login count.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DURABLE_KEY_CACHE_MAX } from "../src/engine/constants";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, entityId, roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_durable_key_cache.db";

function entity(id: string, name: string): Entity {
  return {
    id: entityId(id),
    kind: "agent",
    name,
    short: name,
    long: name,
    room: roomId("test/start"),
    properties: {},
    inventory: [],
    createdAt: 0,
  };
}

let db: MarinaDB;
const cache = () => (db as unknown as { durableKeyCache: Map<string, string> }).durableKeyCache;

beforeEach(() => {
  db = new MarinaDB(TEST_DB);
  db.transaction(() => {
    for (let i = 0; i <= DURABLE_KEY_CACHE_MAX + 1; i++) {
      db.createUser({ id: `u_${i}`, name: `User${i}` });
      db.saveEntity(entity(`e_${i}`, `User${i}`));
    }
  });
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

describe("durableKeyCache LRU", () => {
  it("inserting MAX+1 keys evicts the oldest and stays bounded", () => {
    for (let i = 0; i <= DURABLE_KEY_CACHE_MAX; i++)
      expect(db.durableEntityKey(`e_${i}`)).toBe(`u_${i}`);
    expect(cache().size).toBe(DURABLE_KEY_CACHE_MAX);
    expect(cache().has("e_0")).toBe(false);
    expect(cache().has("e_1")).toBe(true);
    expect(cache().has(`e_${DURABLE_KEY_CACHE_MAX}`)).toBe(true);
    // An evicted key still resolves (re-queried) and re-enters the cache.
    expect(db.durableEntityKey("e_0")).toBe("u_0");
    expect(cache().has("e_0")).toBe(true);
    expect(cache().size).toBe(DURABLE_KEY_CACHE_MAX);
  });

  it("a hit refreshes recency so the next eviction skips it", () => {
    for (let i = 0; i < DURABLE_KEY_CACHE_MAX; i++) db.durableEntityKey(`e_${i}`);
    expect(cache().size).toBe(DURABLE_KEY_CACHE_MAX);
    // e_0 is the oldest; touching it moves it to the tail.
    expect(db.durableEntityKey("e_0")).toBe("u_0");
    expect([...cache().keys()].at(-1)).toBe("e_0");
    // The next miss evicts e_1 (now the oldest), not e_0.
    db.durableEntityKey(`e_${DURABLE_KEY_CACHE_MAX}`);
    expect(cache().has("e_0")).toBe(true);
    expect(cache().has("e_1")).toBe(false);
    expect(cache().size).toBe(DURABLE_KEY_CACHE_MAX);
  });

  it("ids with no account pass through and are never cached", () => {
    expect(db.durableEntityKey("e_nobody")).toBe("e_nobody");
    expect(cache().has("e_nobody")).toBe(false);
  });

  it("deleteUser still clears every entry that resolved to the account", () => {
    db.durableEntityKey("e_3");
    db.durableEntityKey("e_4");
    expect(cache().get("e_3")).toBe("u_3");
    db.deleteUser("u_3");
    expect(cache().has("e_3")).toBe(false);
    expect(cache().get("e_4")).toBe("u_4");
    // The entity row survives; with its account gone the id passes through.
    expect(db.durableEntityKey("e_3")).toBe("e_3");
  });
});
