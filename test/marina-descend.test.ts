// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * marina-descend gate smoke test.
 *
 * `marina-descend` declares `minRank: 5` + `gate: "admin.destructive"`. Under
 * the default guarded posture the engine router is the authority: a rank-0
 * caller is refused before the handler runs, and no descendant row is created.
 * Mirrors the style of test/spawn-gate-sites.test.ts (observable contract:
 * refusal + zero side effects), driven through a real Engine so the router's
 * minRank/gate check is what does the refusing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const DB_PATH = `/tmp/marina-descend-gate-${process.pid}.db`;
const savedPosture = process.env.MARINA_AUTONOMY;

describe("marina-descend is fenced by rank + the admin.destructive gate", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    delete process.env.MARINA_AUTONOMY; // default posture: guarded
    db = new MarinaDB(DB_PATH);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
  });

  afterEach(() => {
    if (savedPosture === undefined) delete process.env.MARINA_AUTONOMY;
    else process.env.MARINA_AUTONOMY = savedPosture;
    engine.stop();
    db.close();
    cleanupDb(DB_PATH);
  });

  it("refuses a rank-0 caller under guarded posture and creates nothing", async () => {
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const rookie = engine.spawnEntity("c1", "Rookie"); // rank 0, zero standing
    expect(rookie).toBeDefined();

    await engine.processCommand(conn.entity!, "marina-descend create sha256:abc | Sprout");

    const sent = conn.messages.map((p) => (p.data as { text?: string }).text ?? "").join("\n");
    // Router refusal (minRank is the authority under guarded), not the handler.
    expect(sent).toContain("rank 5");
    expect(sent).not.toContain("Declared sovereign descendant");
    // Nothing was created.
    expect(db.listMarinaDescendants()).toHaveLength(0);
  });

  it("still refuses at rank 0 under earned posture — the gate becomes the authority and denies", async () => {
    process.env.MARINA_AUTONOMY = "earned";
    const conn = new MockConnection("c2");
    engine.addConnection(conn);
    engine.spawnEntity("c2", "Hopeful"); // rank 0, zero standing

    await engine.processCommand(conn.entity!, "marina-descend create sha256:abc | Sprout");

    const sent = conn.messages.map((p) => (p.data as { text?: string }).text ?? "").join("\n");
    // The gate check refuses (zero standing, no competence, destructive core).
    expect(sent).not.toContain("Declared sovereign descendant");
    expect(db.listMarinaDescendants()).toHaveLength(0);
  });
});
