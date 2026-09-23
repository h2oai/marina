// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TaskManager } from "../src/coordination/task-manager";
import { FlywheelManager } from "../src/integrations/flywheel-manager";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, type EntityId, entityId, roomId } from "../src/types";
import { EntityManager } from "../src/world/entity-manager";
import { cleanupDb } from "./helpers";

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
    createdAt: Date.now(),
  };
}

describe("durable keys survive re-login", () => {
  const path = `/tmp/marina-durable-${crypto.randomUUID()}.db`;
  let db: MarinaDB;
  let raw: Database;

  beforeEach(() => {
    db = new MarinaDB(path);
    raw = new Database(path);
    db.createUser({ id: "u_alice", name: "Alice" });
    db.saveEntity(entity("e_1", "Alice"));
  });

  afterEach(() => {
    raw.close();
    db.close();
    cleanupDb(path);
  });

  /** Alice's first entity is evicted; the next name-login mints a fresh id. */
  function relogin(): EntityId {
    db.deleteEntity(entityId("e_1"));
    db.saveEntity(entity("e_2", "Alice"));
    return entityId("e_2");
  }

  it("keys group and channel membership by the account, reads back the live id", () => {
    db.createGroup({ id: "g1", name: "builders", leaderId: "e_1" });
    db.addGroupMember("g1", "e_1", 1);
    db.createChannel({ id: "ch1", type: "group", name: "group:g1" });
    db.addChannelMember("ch1", "e_1");

    // Stored under the durable key, not the transient entity id.
    expect(
      (
        raw.query("SELECT entity_id FROM group_members WHERE group_id = 'g1'").all() as {
          entity_id: string;
        }[]
      ).map((r) => r.entity_id),
    ).toEqual(["u_alice"]);

    // While e_1 is live the read path projects it back.
    expect(db.getGroupMembers("g1").map((m) => m.entity_id)).toEqual(["e_1"]);
    expect(db.getChannelMembers("ch1").map((m) => m.entity_id)).toEqual(["e_1"]);

    const e2 = relogin();
    expect(db.getGroupMember("g1", e2)?.rank).toBe(1);
    expect(db.getGroupMembers("g1").map((m) => m.entity_id)).toEqual([e2]);
    expect(db.getEntityGroups(e2).map((g) => g.id)).toEqual(["g1"]);
    expect(db.isChannelMember("ch1", e2)).toBe(true);
    expect(db.getEntityChannels(e2).map((c) => c.id)).toEqual(["ch1"]);
    expect(db.getChannelMembers("ch1").map((m) => m.entity_id)).toEqual([e2]);

    db.updateGroupMemberRank("g1", e2, 2);
    expect(db.getGroupMember("g1", e2)?.rank).toBe(2);
    db.removeGroupMember("g1", e2);
    expect(db.getGroupMembers("g1")).toHaveLength(0);
    db.removeChannelMember("ch1", e2);
    expect(db.isChannelMember("ch1", e2)).toBe(false);

    // Offline account: no live entity, the durable key itself is returned.
    db.addGroupMember("g1", e2);
    db.deleteEntity(e2);
    expect(db.getGroupMembers("g1").map((m) => m.entity_id)).toEqual(["u_alice"]);
  });

  it("keys the group leader and task creator by the account (migration 118)", () => {
    db.createGroup({ id: "g3", name: "leaders", leaderId: "e_1" });
    db.addGroupMember("g3", "e_1", 2);
    const tasks = new TaskManager(db);
    const task = tasks.create({ title: "owned", creatorId: "e_1", creatorName: "Alice" });

    // Stored under the durable key …
    expect(
      (raw.query("SELECT leader_id FROM groups_ WHERE id = 'g3'").get() as { leader_id: string })
        .leader_id,
    ).toBe("u_alice");
    expect(
      (
        raw.query("SELECT creator_id FROM tasks WHERE id = ?").get(task.id) as {
          creator_id: string;
        }
      ).creator_id,
    ).toBe("u_alice");
    // … and read back as the live entity id on every read path.
    expect(db.getGroup("g3")?.leader_id).toBe("e_1");
    expect(db.getGroupByName("leaders")?.leader_id).toBe("e_1");
    expect(db.getAllGroups().find((g) => g.id === "g3")?.leader_id).toBe("e_1");
    expect(db.getEntityGroups("e_1").map((g) => g.leader_id)).toEqual(["e_1"]);
    expect(task.creatorId).toBe("e_1");
    expect(db.listTasks().find((t) => t.id === task.id)?.creator_id).toBe("e_1");
    expect(db.searchTasks("owned").map((t) => t.creator_id)).toEqual(["e_1"]);

    const e2 = relogin();
    expect(db.getGroup("g3")?.leader_id).toBe(e2);
    expect(db.getGroupByName("leaders")?.leader_id).toBe(e2);
    expect(db.getEntityGroups(e2).map((g) => g.leader_id)).toEqual([e2]);
    expect(tasks.get(task.id)?.creatorId).toBe(e2);
    expect(db.listTasks({ status: "open" }).find((t) => t.id === task.id)?.creator_id).toBe(e2);
    // Ownership checks that compare against the caller's entity id still pass.
    expect(tasks.cancel(task.id, e2)).toBe(true);
    expect(tasks.get(task.id)?.status).toBe("cancelled");

    // Offline account: the durable key itself is returned.
    db.deleteEntity(e2);
    expect(db.getGroup("g3")?.leader_id).toBe("u_alice");
    expect(db.getTask(task.id)?.creator_id).toBe("u_alice");
  });

  it("passes ids with no world account through unchanged", () => {
    db.createGroup({ id: "g2", name: "guests", leaderId: "e_9" });
    db.addGroupMember("g2", "e_9");
    expect(db.getGroup("g2")?.leader_id).toBe("e_9");
    const orphanTask = db.createTask({ title: "t", creatorId: "e_9", creatorName: "Nine" });
    expect(db.getTask(orphanTask)?.creator_id).toBe("e_9");
    expect(
      (
        raw.query("SELECT entity_id FROM group_members WHERE group_id = 'g2'").get() as {
          entity_id: string;
        }
      ).entity_id,
    ).toBe("e_9");
    expect(db.getGroupMember("g2", "e_9")).toBeDefined();
    expect(db.getGroupMembers("g2").map((m) => m.entity_id)).toEqual(["e_9"]);
  });

  it("keeps board votes attributable across re-login", () => {
    db.createBoard({ id: "b1", name: "ideas" });
    const post = db.createBoardPost({
      boardId: "b1",
      authorId: "e_1",
      authorName: "Alice",
      body: "x",
    });
    db.voteBoardPost(post, "e_1", 1, 4);
    const e2 = relogin();
    // Re-voting from the new id updates the same row instead of double-counting.
    db.voteBoardPost(post, e2, 1, 5);
    expect(db.getBoardPostVoteCount(post)).toBe(1);
    expect(db.getBoardPostScores(post)).toEqual([{ entity_id: e2, value: 1, score: 5 }]);
    expect(db.getScoreMatrix("b1")).toEqual([{ post_id: post, entity_id: e2, score: 5 }]);
  });

  it("keeps the flywheel binding and coding projects across re-login", () => {
    db.saveFlywheelBinding({
      entityId: entityId("e_1"),
      sessionId: "s1",
      sandboxId: "sb1",
      image: "img",
      keepAlive: true,
      state: "running",
    });
    db.createCodingProject({
      id: "p1",
      entityId: entityId("e_1"),
      sandboxId: "sb1",
      name: "demo",
      sourceType: "empty",
      guestPath: "/workspace/demo",
    });
    expect(
      (raw.query("SELECT entity_id FROM flywheel_bindings").get() as { entity_id: string })
        .entity_id,
    ).toBe("u_alice");
    expect(db.getFlywheelBinding(entityId("e_1"))?.entity_id).toBe("e_1");

    const e2 = relogin();
    const binding = db.getFlywheelBinding(e2);
    expect(binding?.sandbox_id).toBe("sb1");
    expect(binding?.entity_id).toBe(e2);
    expect(db.listFlywheelBindings().map((b) => b.entity_id)).toEqual([e2]);
    expect(db.getCodingProjectForEntity(e2, "demo")?.id).toBe("p1");
    expect(db.listCodingProjects(e2).map((p) => p.entity_id)).toEqual([e2]);
    expect(db.getCodingProject("p1")?.entity_id).toBe(e2);

    db.updateFlywheelBinding(e2, { state: "hibernated" });
    expect(db.getFlywheelBinding(e2)?.state).toBe("hibernated");
    db.deleteCodingProject(e2, "p1", "sb1");
    expect(db.listCodingProjects(e2)).toHaveLength(0);
    db.deleteFlywheelBinding(e2);
    expect(db.listFlywheelBindings()).toHaveLength(0);
  });

  it("FlywheelManager finds the account's sandbox after re-login and across restarts", async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const method = String(input).split("/").at(-1);
      if (method === "CreateSession") return Response.json({ sessionId: "session-1" });
      if (method === "MintCapability") {
        return Response.json({
          token: "cap",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (method === "CreateSandbox") {
        return Response.json({ sandboxId: "sandbox-1", keepAlive: true });
      }
      if (method === "Publish")
        return Response.json({ url: "https://app.example", subdomain: "a" });
      return Response.json({});
    };
    const manager = new FlywheelManager("http://flywheel/rpc", "operator", "img", fetch, db);
    await manager.create(entityId("e_1"));
    expect(manager.status(entityId("e_1"))?.state).toBe("running");

    const e2 = relogin();
    expect(manager.status(e2)?.sandboxId).toBe("sandbox-1");
    await expect(manager.create(e2)).rejects.toThrow("already has a Flywheel sandbox");
    expect(await manager.publish(e2, 8080)).toBe("https://app.example");

    // A fresh manager (restart) rehydrates from the durable binding.
    const restarted = new FlywheelManager("http://flywheel/rpc", "operator", "img", fetch, db);
    expect(restarted.status(e2)?.sandboxId).toBe("sandbox-1");
    expect(restarted.inventory().map((item) => item.entityId)).toEqual([e2]);

    // Someone else's id still cannot reach it.
    db.createUser({ id: "u_bob", name: "Bob" });
    db.saveEntity(entity("e_3", "Bob"));
    expect(restarted.status(entityId("e_3"))).toBeUndefined();
  });

  it("re-keys live task claims by name when a fresh entity id is first persisted", () => {
    const tasks = new TaskManager(db);
    const task = tasks.create({ title: "t", creatorId: "e_creator", creatorName: "C" });
    expect(tasks.claim(task.id, "e_1", "Alice")).not.toBeNull();

    // EntityManager.create is the production path for a name-login: it mints
    // the id and persists it through MarinaDB.saveEntity.
    db.deleteEntity(entityId("e_1"));
    const entities = new EntityManager();
    entities.setDb(db);
    entities.setNextId(2);
    const fresh = entities.create({
      kind: "agent",
      name: "Alice",
      short: "Alice",
      long: "Alice",
      room: roomId("test/start"),
    });
    expect(String(fresh.id)).toBe("e_2");
    expect(tasks.getClaim(task.id, "e_2")?.status).toBe("claimed");
    expect(tasks.getClaim(task.id, "e_1")).toBeNull();

    // Re-saving the same entity (room move, property change) is a no-op.
    entities.move(fresh.id, roomId("test/other"));
    expect(tasks.getClaim(task.id, "e_2")?.status).toBe("claimed");
  });

  it("deleteUser cascades the reputation ledgers keyed by the account", () => {
    db.grantCompetence("e_1", "shell.exec");
    db.appendStandingEvent({
      entityId: "e_1",
      entityName: "Alice",
      kind: "task_completed",
      ref: "task:1",
      amount: 1,
    });
    db.setStandingCache("e_1", 1, Date.now());
    const rows = (table: string) =>
      (
        raw.query(`SELECT COUNT(*) AS n FROM ${table} WHERE entity_id = 'u_alice'`).get() as {
          n: number;
        }
      ).n;
    expect(rows("entity_competence")).toBe(1);
    expect(rows("entity_standing")).toBe(1);
    expect(rows("entity_standing_cache")).toBe(1);

    db.deleteUser("u_alice");
    expect(db.getUser("u_alice")).toBeUndefined();
    expect(rows("entity_competence")).toBe(0);
    expect(rows("entity_standing")).toBe(0);
    expect(rows("entity_standing_cache")).toBe(0);
  });
});
