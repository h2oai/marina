// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `orient` surfaces the Phase-3 dispatch receipts next to the hygiene line:
 * the latest `[accumulation] …` process note (topic, note count, job id, age).
 * Two durable users — the owner whose notes accumulate and the reflector
 * helper whose principal becomes the worker. No model calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import {
  ACCUMULATION_TRIGGER_NOTES,
  createDispatchState,
  type MemoryDispatchDeps,
  runAccumulationDispatch,
} from "../src/engine/memory-dispatch";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const OWNER = "Owner";
const REFLECTOR = "Reflector";

let directory: string;
let db: MarinaDB;
let reflectorPrincipal: string;
let engine: Engine;
let conn: MockConnection;

function deps(): MemoryDispatchDeps {
  return {
    onlineEntities: () => [{ id: conn.entity!, name: OWNER }],
    residentMemoryOperation: (name, request) => residentMemoryOperation(db, name, request),
    tell: () => {},
    findRunningHelper: (role) =>
      role === "memory-reflector"
        ? { name: REFLECTOR, principalId: reflectorPrincipal }
        : undefined,
    standing: () => 0,
  };
}

function orient(): string {
  conn.clear();
  engine.processCommand(conn.entity!, "orient");
  return stripAnsi(conn.allTextJoined());
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-orient-receipts-"));
  db = new MarinaDB(join(directory, "world.db"));
  db.createUser({ id: crypto.randomUUID(), name: OWNER });
  reflectorPrincipal = crypto.randomUUID();
  db.createUser({ id: reflectorPrincipal, name: REFLECTOR });
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  conn = new MockConnection("c1");
  engine.addConnection(conn);
  engine.spawnEntity("c1", OWNER);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

describe("orient shows accumulation receipts", () => {
  it("renders the latest [accumulation] receipt with topic, note count, job id and age", async () => {
    for (let i = 0; i < ACCUMULATION_TRIGGER_NOTES; i++) {
      db.createNote(
        OWNER,
        `amber deploy observation ${i}: rollout touched service-${i}`,
        undefined,
        {
          skipDedup: true,
        },
      );
    }
    const [report] = await runAccumulationDispatch(db, deps(), createDispatchState(), Date.now());
    expect(report).toMatchObject({ dispatched: true, clusterSize: ACCUMULATION_TRIGGER_NOTES });
    const out = orient();
    expect(out).toContain(
      `Accumulation: ${ACCUMULATION_TRIGGER_NOTES} notes about "${report!.topic}" handed to reflector job ${report!.jobId}`,
    );
    expect(out).toMatch(/Accumulation: .*\d+m ago/);
  });

  it("omits the line when no receipt exists and falls back to the raw tail for a malformed one", () => {
    expect(orient()).not.toContain("Accumulation:");
    db.createNote(OWNER, "[accumulation] hand-written receipt", undefined, { tier: "process" });
    const out = orient();
    expect(out).toContain("Accumulation: hand-written receipt");
    // No open-jobs count: the jobs table has no synchronous accessor, so
    // orient points at the receipt's job id and `memory jobs` stays the live view.
    expect(out).not.toMatch(/open (assistance )?jobs/i);
  });
});
