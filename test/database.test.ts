// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent, Entity } from "../src/types";
import { entityId, roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_marina.db";

describe("MarinaDB", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  describe("entity persistence", () => {
    const testEntity: Entity = {
      id: entityId("e_1"),
      kind: "agent",
      name: "TestAgent",
      short: "TestAgent is here.",
      long: "A test agent.",
      room: roomId("core/nexus"),
      properties: { level: 5 },
      inventory: [],
      createdAt: Date.now(),
    };

    it("should save and load an entity", () => {
      db.saveEntity(testEntity);
      const loaded = db.loadEntity(entityId("e_1"));
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe("TestAgent");
      expect(loaded!.kind).toBe("agent");
      expect(loaded!.room).toBe(roomId("core/nexus"));
      expect(loaded!.properties).toEqual({ level: 5 });
    });

    it("should return undefined for missing entity", () => {
      expect(db.loadEntity(entityId("nonexistent"))).toBeUndefined();
    });

    it("should delete an entity", () => {
      db.saveEntity(testEntity);
      db.deleteEntity(entityId("e_1"));
      expect(db.loadEntity(entityId("e_1"))).toBeUndefined();
    });

    it("should load all entities", () => {
      db.saveEntity(testEntity);
      db.saveEntity({ ...testEntity, id: entityId("e_2"), name: "Agent2" });
      const all = db.loadAllEntities();
      expect(all.length).toBe(2);
    });

    it("should bulk save entities in a transaction", () => {
      const entities = Array.from({ length: 50 }, (_, i) => ({
        ...testEntity,
        id: entityId(`e_${i}`),
        name: `Agent${i}`,
      }));
      db.saveAllEntities(entities);
      expect(db.loadAllEntities().length).toBe(50);
    });
  });

  describe("room store", () => {
    const rid = roomId("core/nexus");

    it("should store and retrieve values", () => {
      db.setRoomStoreValue(rid, "counter", 42);
      expect(db.getRoomStoreValue(rid, "counter")).toBe(42);
    });

    it("should store complex objects", () => {
      db.setRoomStoreValue(rid, "data", { items: [1, 2, 3], nested: { ok: true } });
      expect(db.getRoomStoreValue(rid, "data")).toEqual({
        items: [1, 2, 3],
        nested: { ok: true },
      });
    });

    it("should return undefined for missing keys", () => {
      expect(db.getRoomStoreValue(rid, "nope")).toBeUndefined();
    });

    it("should list keys", () => {
      db.setRoomStoreValue(rid, "a", 1);
      db.setRoomStoreValue(rid, "b", 2);
      expect(db.getRoomStoreKeys(rid).sort()).toEqual(["a", "b"]);
    });

    it("should delete values", () => {
      db.setRoomStoreValue(rid, "x", 1);
      db.deleteRoomStoreValue(rid, "x");
      expect(db.getRoomStoreValue(rid, "x")).toBeUndefined();
    });
  });

  describe("event log", () => {
    it("should log and retrieve events", () => {
      const event: EngineEvent = {
        type: "command",
        entity: entityId("e_1"),
        input: "look",
        timestamp: Date.now(),
      };
      db.logEvent(event);
      const events = db.getRecentEvents(10);
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("command");
    });

    it("should count events", () => {
      for (let i = 0; i < 5; i++) {
        db.logEvent({ type: "tick", timestamp: Date.now() + i });
      }
      expect(db.getEventCount()).toBe(5);
    });

    it("should prune old events", () => {
      for (let i = 0; i < 10; i++) {
        db.logEvent({ type: "tick", timestamp: Date.now() + i });
      }
      db.pruneEvents(3);
      expect(db.getEventCount()).toBe(3);
    });
  });

  describe("coding events", () => {
    it("returns the most recent limited coding events in chronological order", async () => {
      db.createCodingSession({
        id: "code_session_events",
        title: "Event Ordering",
        workspaceRoot: "/tmp/marina-code-events",
        createdBy: "Alice",
      });

      for (let i = 0; i < 12; i++) {
        db.createCodingEvent({
          sessionId: "code_session_events",
          actor: "Alice",
          kind: `event_${i}`,
          payload: { index: i },
        });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      const events = db.listCodingEvents("code_session_events", 5);
      expect(events.map((event) => event.kind)).toEqual([
        "event_7",
        "event_8",
        "event_9",
        "event_10",
        "event_11",
      ]);
    });
  });
});
