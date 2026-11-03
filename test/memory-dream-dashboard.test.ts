// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Dashboard Dreams panel's contract: `GET /api/memory/dreams` lists the
 * newest dreams in the caller's scope — a resident its own, a privileged
 * observer everyone's with the guard and the held-out measurement — as ids,
 * counts and hashes, never note text; it needs a session like every memory
 * observability route.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { runDream } from "../src/memory/dream";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { listMemoryDreams } from "../src/net/memory/memory-observability";
import type { MemoryDreamsResponse } from "../src/net/memory/memory-observability-types";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_memory_dream_dashboard.db");
const HOUR = 60 * 60 * 1000;

describe("the Dreams panel's route", () => {
  let db: MarinaDB;
  let engine: Engine;
  const tokens: Record<string, string> = {};
  const now = Date.now();

  beforeEach(async () => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    for (const name of ["Ada", "Bob"]) {
      const conn = new MockConnection(`c-${name}`);
      engine.addConnection(conn);
      const login = engine.login(conn.id, name);
      if ("error" in login) throw new Error(`login failed: ${login.error}`);
      tokens[name] = login.token;
      for (const text of [
        "The amber deployment listens on port 8443 behind the staging proxy",
        "The amber deployment listens on port 8443 behind the staging gateway",
        "The quartz build takes eleven minutes on the shared runner",
        "Cobalt tests need the fixture database reset before each run",
        "Lantern maintenance is scheduled for the first Monday of each month",
      ])
        db.createNote(name, text, undefined, { skipDedup: true });
    }
    const ids = (name: string) =>
      db
        .getNotesByEntity(name, 10)
        .map((n) => n.id)
        .sort((a, b) => a - b);
    for (const name of ["Ada", "Bob"]) {
      const [a, b] = ids(name);
      await runDream(db, name, "command", {
        now: now + HOUR,
        model: "test/dreamer",
        complete: async () =>
          JSON.stringify({
            ops: [
              { op: "merge", keep: a, into: [b], reason: "same note" },
              { op: "decay", id: a, reason: "no evidence, will be refused" },
            ],
          }),
      });
    }
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const get = async (path: string, token?: string) => {
    const url = new URL(`http://localhost:3300${path}`);
    const req = new Request(url.toString(), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return handleDashboardApi(req, url, "GET", engine, db);
  };

  it("a resident sees its own dreams as counts; a privileged observer sees everyone's with guard and effect", async () => {
    const resident = listMemoryDreams(db, {
      privileged: false,
      entityName: "Ada",
      readNote: (() => true) as never,
    });
    expect(resident.dreams.map((d) => d.entity)).toEqual(["Ada"]);
    expect(resident.guarded).toEqual([]);
    expect(resident.effect).toBeUndefined();
    const view = resident.dreams[0]!;
    expect(view).toMatchObject({
      pool: false,
      trigger: "command",
      state: "observed",
      ops: { accepted: 1, rejected: 1, applied: 0, pendingProposals: 0, byKind: { merge: 1 } },
      rejectedByCheck: { evidence: 1 },
      probes: { before: { pass: 1, fail: 0 }, after: { pass: 1, fail: 0 } },
      model: "test/dreamer",
    });
    expect(JSON.stringify(resident)).not.toContain("amber deployment");

    const all = listMemoryDreams(db, { privileged: true, readNote: (() => true) as never });
    expect(all.dreams.map((d) => d.entity).sort()).toEqual(["Ada", "Bob"]);
    expect(all.guarded).toEqual([]);
    expect(all.effect?.verdict).toBe("insufficient");
    expect(all.mode).toBe("observe");
    expect(
      listMemoryDreams(
        db,
        { privileged: true, readNote: (() => true) as never },
        { entity: "Bob" },
      ).dreams.map((d) => d.entity),
    ).toEqual(["Bob"]);
    expect(
      listMemoryDreams(db, { privileged: false, readNote: (() => true) as never }).dreams,
    ).toEqual([]);
  });

  it("the route needs a session and scopes the caller", async () => {
    expect((await get("/api/memory/dreams"))?.status).toBe(401);
    const resp = await get("/api/memory/dreams?limit=5", tokens.Ada);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as MemoryDreamsResponse;
    expect(body.dreams.map((d) => d.entity)).toEqual(["Ada"]);
    expect(body.mode).toBe("observe");
  });
});
