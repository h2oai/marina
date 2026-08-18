// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("look command", () => {
  let db: MarinaDB;
  let engine: Engine;
  let aliceId: EntityId;
  let c1: MockConnection;
  const dbPath = `/tmp/marina-look-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    c1 = new MockConnection("c1");
    const c2 = new MockConnection("c2");
    engine.addConnection(c1);
    engine.addConnection(c2);
    aliceId = engine.spawnEntity("c1", "Alice")!.id;
    engine.spawnEntity("c2", "Builder"); // co-located in test/start
    c1.clear();
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("plain look lists co-located entities", async () => {
    await engine.processCommand(aliceId, "look");
    const text = stripAnsi(c1.lastText());
    expect(text).toContain("Present");
    expect(text).toContain("Builder");
  });

  it('"look at builder" resolves the entity (strips the leading "at")', async () => {
    await engine.processCommand(aliceId, "look at builder");
    const text = stripAnsi(c1.lastText());
    expect(text).not.toContain("don't see");
    expect(text).toContain("Builder");
  });

  it('"look at the builder" strips the article too', async () => {
    await engine.processCommand(aliceId, "look at the builder");
    expect(stripAnsi(c1.lastText())).not.toContain("don't see");
  });

  it('"look builder" (no preposition) still resolves', async () => {
    await engine.processCommand(aliceId, "look builder");
    expect(stripAnsi(c1.lastText())).not.toContain("don't see");
  });

  it('"look at" with no target prompts instead of failing silently', async () => {
    await engine.processCommand(aliceId, "look at");
    expect(stripAnsi(c1.lastText())).toContain("Look at what?");
  });

  it("unknown target still says it's not here", async () => {
    await engine.processCommand(aliceId, "look at dragon");
    expect(stripAnsi(c1.lastText())).toContain("don't see");
  });
});
