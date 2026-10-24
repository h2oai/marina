// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { recordTaskVerdict } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("advice on claiming a task", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    [alice, bob] = ["Alice", "Bob"].map((name, i) => {
      const c = new MockConnection(`c${i}`);
      engine.addConnection(c);
      engine.spawnEntity(`c${i}`, name);
      c.clear();
      return c;
    }) as [MockConnection, MockConnection];
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  const claimReply = async () => {
    await engine.processCommand(alice.entity!, "task create Map the grid | every exit");
    const id = /#(\d+)/.exec(stripAnsi(alice.allText().join("\n")))?.[1];
    alice.clear();
    bob.clear();
    await engine.processCommand(bob.entity!, `task claim ${id}`);
    return stripAnsi(bob.lastText());
  };

  it("says nothing extra without a clear leader", async () => {
    expect(await claimReply()).toMatch(/^Claimed task #\d+\.$/);
  });

  it("names the way of working that clearly leads, as advice", async () => {
    db.saveAgentConfig({ name: "Member", model: "vendor/a", role: "coder", spawnedBy: "system" });
    db.saveAgentConfig({ name: "Solo", model: "vendor/a", role: "coder", spawnedBy: "system" });
    db.saveCrew({
      id: "c1",
      name: "debaters",
      goal: "g",
      formation: "debate",
      ownerId: "o",
      state: "active",
      createdAt: 1,
      lastActivityAt: 1,
    });
    db.addCrewMember("c1", "Member", "member", 1);
    for (let i = 0; i < 8; i++) {
      recordTaskVerdict(db, { taskId: 100 + i, claimant: "Member", approved: true, at: 10 + i });
      recordTaskVerdict(db, { taskId: 200 + i, claimant: "Solo", approved: i < 2, at: 30 + i });
    }
    const reply = await claimReply();
    expect(reply).toMatch(/^Claimed task #\d+\./);
    expect(reply).toContain("What has worked here for work:task: crew:debate");
    expect(reply).toContain("competence best work:task");
  });
});
