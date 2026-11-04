// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A pass that never starts must be seen: `memory dream why` says every gate
 * as it stands and whether the dreamer's model can be called; the jobs log
 * counts of silent skips (no model, a model error, the budget) and stay
 * quiet about the schedule gates; the model library's loopback key seam
 * lets an in-process call to `marina/*` run without an operator key.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { DREAM_IDLE_MS, explainDream, runDream, silentSkips } from "../src/memory/dream";
import type { DreamSummary } from "../src/memory/dream/types";
import { modelAccess, setLoopbackModelKey } from "../src/model/access";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_memory_dream_why.db");

describe("why a dream did not run", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Ada");
    ada = conn.entity!;
    conn.clear();
    db.createNote("Ada", "The amber deployment listens on port 8443 behind the staging proxy");
  });

  afterEach(() => {
    setLoopbackModelKey(undefined);
    db.close();
    cleanupDb(TEST_DB);
  });

  it("silent skips are counted by their first words; schedule gates are not", () => {
    const skipped = (reason: string): DreamSummary => ({
      entityName: "x",
      trigger: "schedule",
      mode: "observe",
      state: "skipped",
      skipped: reason,
      createdAt: 0,
    });
    expect(
      silentSkips([
        skipped("quiet: last tool call 4 min ago"),
        skipped("material: 3 new records"),
        skipped("cooldown: last dream 10 min ago"),
        skipped("no model: no key for marina/* (set MODEL_API_KEYS)"),
        skipped("no model: no key for marina/* (set MODEL_API_KEYS)"),
        skipped("model: The model spent max_tokens on reasoning"),
        skipped("budget: daily cap reached"),
        skipped("no records in the window"),
        { ...skipped("x"), state: "observed", skipped: undefined },
      ]),
    ).toEqual({ "no model": 2, model: 1, budget: 1, "no records in the window": 1 });
    expect(silentSkips([skipped("quiet: now")])).toEqual({});
  });

  it("explains the gates, the request and the model's key; the command renders it, another entity needs an operator", async () => {
    using _state = scopeProcessState({
      env: { MARINA_DREAMING: "observe", MODEL_API_KEYS: "op-key" },
    });
    const now = Date.now() + 1000;
    const e = await explainDream(db, "Ada", { now });
    expect(e.mode).toBe("observe");
    expect(e.blocked).toBeUndefined();
    expect(e.gate).toMatch(/^material:/);
    expect(e.newRecords).toBe(1);
    expect(e.lastDreamAt).toBeUndefined();
    expect(e.model.key).toBe("operator");
    expect(e.guardTripped).toBe(false);
    // After a dream, the cooldown gate is the reason.
    await runDream(db, "Ada", "command", { now, complete: async () => '{"ops":[]}' });
    const after = await explainDream(db, "Ada", { now: now + 60_000 });
    expect(after.gate).toMatch(/^cooldown:/);
    expect(after.lastDreamAt).toBe(now);
    await engine.processCommand(ada, "memory dream why");
    expect(conn.lastText()).toContain("gates: cooldown:");
    expect(conn.lastText()).toContain("key: operator (MODEL_API_KEYS)");
    conn.clear();
    await engine.processCommand(ada, "memory dream why Bob");
    expect(conn.lastText()).toContain("operator's readout");
    // Off is blocked outright; a quiet agent with material and no key says so.
    using _off = scopeProcessState({ env: { MARINA_DREAMING: "off" } });
    expect((await explainDream(db, "Ada", { now })).blocked).toBe("MARINA_DREAMING=off");
    expect(DREAM_IDLE_MS).toBeGreaterThan(0);
  });

  it("the model library takes the serving process's internal token for its own /v1 when no operator key is set", () => {
    using _state = scopeProcessState({ env: { MODEL_API_KEYS: undefined } });
    expect(() => modelAccess("marina/cheap", {})).toThrow(/no key for marina/);
    setLoopbackModelKey(() => "internal-token");
    expect(modelAccess("marina/cheap", {}).apiKey).toBe("internal-token");
    // Another Marina's /v1 is an outside call: the internal token is not for it.
    expect(() => modelAccess("marina/cheap@other.example", {})).toThrow(/no key for marina/);
    // An operator key wins.
    expect(modelAccess("marina/cheap", { MODEL_API_KEYS: "op" }).apiKey).toBe("op");
  });
});
