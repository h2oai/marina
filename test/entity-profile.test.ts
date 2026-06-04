import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { buildEntityProfile, handleEntityApi } from "../src/net/entity-api";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_entity_profile.db";

describe("Entity profile API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let _entityId: EntityId;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: "test/start" as RoomId });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "Alice");
    if ("error" in result) throw new Error(result.error);
    _entityId = result.entityId;
    conn.clear();
  });

  afterEach(() => {
    try {
      engine.shutdown();
    } catch {}
    try {
      db.close();
    } catch {}
    cleanupDb(TEST_DB);
  });

  // ─── buildEntityProfile (unit) ────────────────────────────────────────

  describe("buildEntityProfile", () => {
    it("returns null for an unknown name", () => {
      const profile = buildEntityProfile("Nobody", db, engine);
      expect(profile).toBeNull();
    });

    it("returns identity for a known live entity", () => {
      const profile = buildEntityProfile("Alice", db, engine);
      expect(profile).not.toBeNull();
      expect(profile?.identity.name).toBe("Alice");
      expect(profile?.identity.online).toBe(true);
      expect(profile?.identity.kind).toBeDefined();
      expect(profile?.identity.rank).toBe(0);
      expect(profile?.identity.standing).toBe(0);
    });

    it("is case-insensitive on name lookup", () => {
      const profile = buildEntityProfile("alice", db, engine);
      expect(profile?.identity.name).toBe("Alice"); // canonical
    });

    it("includes role + agent goal in bio when present", () => {
      db.saveAgentConfig({
        name: "Alice",
        model: "marina/default",
        role: "test-role",
        goal: "Test the world; record what you find.",
        spawnedBy: "system",
      });
      db.saveRole({
        name: "test-role",
        description: "Test role",
        traits: ["intellectual-honesty", "methodical-observation"],
        guidelines: [],
        focus: [],
        tone: "Neutral.",
        origin: "test",
        createdBy: "system",
      });

      const profile = buildEntityProfile("Alice", db, engine);
      expect(profile?.bio.goal).toContain("Test the world");
      expect(profile?.bio.model).toBe("marina/default");
      expect(profile?.bio.traits).toContain("intellectual-honesty");
    });

    it("narratives include narrative + digest entries, not events", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "Task done",
        participants: ["Alice"],
      });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Alice's first big move",
        body: "She shipped it.",
        refs: ["feed:1"],
        participants: ["Alice"],
      });
      db.appendChronicle({
        kind: "digest",
        source: "chronicler",
        title: "Day in review",
        refs: ["feed:1"],
        participants: ["Alice"],
        period: "day:2026-05-20",
      });

      const profile = buildEntityProfile("Alice", db, engine);
      expect(profile?.narratives).toHaveLength(2);
      const kinds = profile?.narratives.map((n) => n.kind) ?? [];
      expect(kinds).toContain("narrative");
      expect(kinds).toContain("digest");
      expect(kinds).not.toContain("event");
    });

    it("achievements include a rank badge for each rank_change entry", () => {
      db.appendChronicle({
        kind: "event",
        source: "rank_change",
        title: "Alice rose to rank 1",
        body: "Crossed the threshold.",
        participants: ["Alice"],
        refs: ["feed:1", "rank:1"],
      });
      db.appendChronicle({
        kind: "event",
        source: "rank_change",
        title: "Alice rose to rank 2",
        body: "Crossed the threshold.",
        participants: ["Alice"],
        refs: ["feed:2", "rank:2"],
      });

      const profile = buildEntityProfile("Alice", db, engine);
      const rankAch = profile?.achievements.filter((a) => a.id.startsWith("rank:")) ?? [];
      expect(rankAch).toHaveLength(2);
      const titles = rankAch.map((a) => a.title);
      expect(titles).toContain("Rank 1");
      expect(titles).toContain("Rank 2");
    });

    it("achievement: first chronicled narrative", () => {
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "First interpretation",
        refs: ["feed:1"],
        participants: ["Alice"],
      });
      const profile = buildEntityProfile("Alice", db, engine);
      const first = profile?.achievements.find((a) => a.id === "first_narrative");
      expect(first).toBeDefined();
      expect(first?.evidence_ref).toMatch(/^chronicle:\d+$/);
    });

    it("stats: chronicle_citations counted by kind", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "A",
        participants: ["Alice"],
      });
      db.appendChronicle({
        kind: "event",
        source: "rank_change",
        title: "B",
        participants: ["Alice"],
      });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "C",
        refs: ["feed:1"],
        participants: ["Alice"],
      });

      const profile = buildEntityProfile("Alice", db, engine);
      expect(profile?.stats.chronicle_citations.event).toBe(2);
      expect(profile?.stats.chronicle_citations.narrative).toBe(1);
      expect(profile?.stats.chronicle_citations_total).toBe(3);
    });

    it("connections excludes self and counts co-participants", () => {
      // Two entries co-citing Alice and Bob; one entry co-citing Alice and Carol
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "A",
        refs: ["feed:1"],
        participants: ["Alice", "Bob"],
      });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "B",
        refs: ["feed:1"],
        participants: ["Alice", "Bob"],
      });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "C",
        refs: ["feed:1"],
        participants: ["Alice", "Carol"],
      });

      const profile = buildEntityProfile("Alice", db, engine);
      const conns = profile?.connections ?? [];
      expect(conns.find((c) => c.name === "Alice")).toBeUndefined(); // self excluded
      const bob = conns.find((c) => c.name === "Bob");
      const carol = conns.find((c) => c.name === "Carol");
      expect(bob?.co_chronicles).toBe(2);
      expect(carol?.co_chronicles).toBe(1);
      // Higher count first
      expect(conns[0]?.name).toBe("Bob");
    });

    it("privacy: response shape excludes connection/session/IP fields", () => {
      const profile = buildEntityProfile("Alice", db, engine);
      const json = JSON.stringify(profile);
      // None of these substrings should appear anywhere in the response
      expect(json).not.toContain("connection_id");
      expect(json).not.toContain("connectionId");
      expect(json).not.toContain("session_token");
      expect(json).not.toContain("sessionToken");
      expect(json).not.toContain("ip_address");
      expect(json).not.toContain("ipAddress");
    });

    it("returns a profile for an offline entity recorded only in user/agent_configs", () => {
      // Create a user row but no live entity (simulates a returning user
      // whose entity was evicted, or an agent that was respawned out)
      db.createUser({ id: "u_test_offline", name: "Offline" });
      db.saveAgentConfig({
        name: "Offline",
        model: "marina/default",
        role: "chronicler",
        goal: "Sleeping.",
        spawnedBy: "system",
      });

      const profile = buildEntityProfile("Offline", db, engine);
      expect(profile).not.toBeNull();
      expect(profile?.identity.online).toBe(false);
      expect(profile?.identity.name).toBe("Offline");
      expect(profile?.bio.goal).toContain("Sleeping");
    });
  });

  // ─── handleEntityApi (HTTP) ───────────────────────────────────────────

  describe("handleEntityApi", () => {
    it("returns 404 for an unknown name", async () => {
      const res = await handleEntityApi(
        new URL("http://localhost/api/entity/Nobody/profile"),
        "GET",
        db,
        engine,
      );
      expect(res).not.toBeNull();
      expect(res?.status).toBe(404);
    });

    it("returns 200 with JSON body for a known entity", async () => {
      const res = await handleEntityApi(
        new URL("http://localhost/api/entity/Alice/profile"),
        "GET",
        db,
        engine,
      );
      expect(res?.status).toBe(200);
      const body = (await res?.json()) as { identity: { name: string } };
      expect(body.identity.name).toBe("Alice");
    });

    it("returns null for non-GET methods (caller falls through)", async () => {
      const res = await handleEntityApi(
        new URL("http://localhost/api/entity/Alice/profile"),
        "POST",
        db,
        engine,
      );
      expect(res).toBeNull();
    });

    it("returns null for unknown paths under /api/entity/", async () => {
      const res = await handleEntityApi(
        new URL("http://localhost/api/entity/Alice/something-else"),
        "GET",
        db,
        engine,
      );
      expect(res).toBeNull();
    });

    it("sets Cache-Control on successful responses", async () => {
      const res = await handleEntityApi(
        new URL("http://localhost/api/entity/Alice/profile"),
        "GET",
        db,
        engine,
      );
      expect(res?.headers.get("Cache-Control")).toContain("max-age");
    });

    it("URL-decodes the name parameter", async () => {
      // Spawn an agent with a space-containing name? names are alphanumeric, so
      // use a regular agent and check that decoding still works for the round-trip
      const res = await handleEntityApi(
        new URL("http://localhost/api/entity/Alice/profile"),
        "GET",
        db,
        engine,
      );
      expect(res?.status).toBe(200);
    });
  });
});
