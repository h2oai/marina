// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  decodeInheritanceBundle,
  encodeInheritanceBundle,
  type InheritanceBundle,
} from "../src/engine/inheritance-bundle";
import { setRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_inheritance.db";

describe("Marina inheritance bundles", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn = new MockConnection("inheritance-reader");
    engine.addConnection(conn);
    const login = engine.login(conn.id, "Curator");
    if ("error" in login) throw new Error(login.error);
    entityId = login.entityId;
    setRank(engine.entities.get(entityId)!, 2);
    conn.clear();
  });

  afterEach(() => {
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("exports shared tradition evidence and imports it into quarantine", async () => {
    db.createMemoryPool("pool_tradition", "orchestration:research", "system");
    db.addPoolNote(
      "pool_tradition",
      "Ada",
      "Verify primary sources before synthesis.",
      8,
      "reflection",
    );

    await engine.processCommand(entityId, "inheritance export orchestration:research");
    const exported = stripAnsi(conn.lastText());
    const token = exported.match(/inherit ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();
    expect(decodeInheritanceBundle(token!)).toMatchObject({
      schema: "marina.inheritance.v1",
      artifacts: [{ pool: "orchestration:research", author: "Ada" }],
    });

    conn.clear();
    await engine.processCommand(entityId, `inherit ${token}`);
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("as unverified evidence");
    expect(output).toContain("Nothing was activated, executed, or merged");
    const imported = db.listMemoryPools().find((pool) => pool.name.startsWith("inheritance:"));
    expect(imported).toBeDefined();
    const notes = db.getPoolNotes(imported!.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note_type).toBe("evidence");
    expect(notes[0]?.content).toContain("claimed author=Ada");
  });

  it("imports via the merged `inheritance import` subcommand and enforces the rank floor", async () => {
    db.createMemoryPool("pool_tradition2", "orchestration:pipeline", "system");
    db.addPoolNote("pool_tradition2", "Ada", "Stage contracts before handoff.", 7, "reflection");
    await engine.processCommand(entityId, "inheritance export orchestration:pipeline");
    const token = stripAnsi(conn.lastText()).match(/inherit ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();

    // Below the rank floor, import refuses (list/export stay open at rank 0).
    setRank(engine.entities.get(entityId)!, 0);
    conn.clear();
    await engine.processCommand(entityId, `inheritance import ${token}`);
    expect(stripAnsi(conn.lastText())).toContain("requires rank 2+");

    setRank(engine.entities.get(entityId)!, 2);
    conn.clear();
    await engine.processCommand(entityId, `inheritance import ${token}`);
    expect(stripAnsi(conn.lastText())).toContain("as unverified evidence");
  });

  it("does not export ordinary shared or private pools", async () => {
    db.createMemoryPool("pool_project", "project-private", "Curator", "group-1");
    db.addPoolNote("pool_project", "Curator", "private plan", 5, "note");
    await engine.processCommand(entityId, "inheritance export project-private");
    expect(stripAnsi(conn.lastText())).toContain("not found");
  });

  it("rejects malformed and oversized artifact claims", () => {
    const bundle: InheritanceBundle = {
      schema: "marina.inheritance.v1",
      assertedSource: "peer",
      createdAt: 1,
      artifacts: [
        {
          pool: "guide",
          author: "Ada",
          content: "useful evidence",
          noteType: "reflection",
          importance: 8,
          createdAt: 1,
        },
      ],
    };
    const decoded = decodeInheritanceBundle(encodeInheritanceBundle(bundle));
    expect(decoded).toEqual(bundle);
    expect(() => decodeInheritanceBundle("not-json")).toThrow();
    expect(() =>
      decodeInheritanceBundle(
        encodeInheritanceBundle({
          ...bundle,
          artifacts: [{ ...bundle.artifacts[0]!, content: "x".repeat(1_001) }],
        }),
      ),
    ).toThrow("artifact fields");
  });
});
