// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A task a world seeds as `system` must be reviewable: `system` never logs in,
 * and only a task's creator approves it. An operator (a person at rank 9) who
 * has not claimed it becomes its reviewer of record on review; anyone else is
 * told who reviews it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_seeded_task_review.db";

describe("seeded tasks have a reviewer", () => {
  let db: MarinaDB;
  let engine: Engine;

  const run = (conn: MockConnection, text: string) => {
    conn.clear();
    engine.processCommand(conn.entity as EntityId, text);
    return stripAnsi(conn.allTextJoined());
  };
  const join = (id: string, name: string, rank = 0) => {
    const conn = new MockConnection(`c-${name}`);
    db.createUser({ id, name });
    engine.addConnection(conn);
    engine.spawnEntity(conn.id, name);
    engine.entities.get(conn.entity as EntityId)!.properties.rank = rank;
    return conn;
  };
  const seedTask = () =>
    db.createTask({ title: "Seeded", creatorId: "system", creatorName: "system", standing: 2 });

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("an operator who has not claimed it approves, and becomes the reviewer of record", () => {
    const worker = join("u_worker", "Worker");
    const op = join("u_op", "Op", 9);
    const id = seedTask();
    run(worker, `task claim ${id}`);
    run(worker, `task submit ${id} done, see note 1`);

    expect(run(op, `task approve ${id} Worker`)).toContain("Approved Worker's submission");
    const task = db.getTask(id)!;
    expect(task.status).toBe("completed");
    expect(task.creator_name).toBe("Op");
  });

  it("an operator can reject, sending the task back open", () => {
    const worker = join("u_worker", "Worker");
    const op = join("u_op", "Op", 9);
    const id = seedTask();
    run(worker, `task claim ${id}`);
    run(worker, `task submit ${id} draft`);

    expect(run(op, `task reject ${id} Worker`)).toContain("Rejected Worker's submission");
    expect(db.getTask(id)!.status).toBe("open");
  });

  it("a non-operator is told who reviews it; nothing changes hands", () => {
    const worker = join("u_worker", "Worker");
    const peer = join("u_peer", "Peer", 4);
    const id = seedTask();
    run(worker, `task claim ${id}`);
    run(worker, `task submit ${id} done`);

    expect(run(peer, `task approve ${id} Worker`)).toContain("an operator (a person at rank 9)");
    expect(db.getTask(id)!.creator_name).toBe("system");
  });

  it("an operator never reviews a seeded task they claimed themselves", () => {
    const op = join("u_op", "Op", 9);
    const id = seedTask();
    run(op, `task claim ${id}`);
    run(op, `task submit ${id} done`);

    expect(run(op, `task approve ${id} Op`)).toContain("Cannot approve");
    const task = db.getTask(id)!;
    expect(task.status).not.toBe("completed");
    expect(task.creator_name).toBe("system");
  });

  it("a task with a real creator is untouched by an operator", () => {
    const worker = join("u_worker", "Worker");
    const author = join("u_author", "Author");
    const op = join("u_op", "Op", 9);
    const id = db.createTask({
      title: "Authored",
      creatorId: author.entity!,
      creatorName: "Author",
    });
    run(worker, `task claim ${id}`);
    run(worker, `task submit ${id} done`);

    expect(run(op, `task approve ${id} Worker`)).toContain("Cannot approve");
    expect(db.getTask(id)!.creator_name).toBe("Author");
  });
});
