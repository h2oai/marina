// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Engine } from "../src/engine/engine";
import { Logger } from "../src/engine/logger";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_engine_tick_safety.db";

type TickAccess = { tick(): void; tickInner(): void; tickCount: number };

/**
 * The engine tick runs from setInterval. Any throw that escaped it would
 * surface as an uncaughtException and take the process down (main.ts →
 * shutdown(1)). Every failure inside a tick must be caught, counted, logged
 * (rate-limited) and the loop must keep going.
 */
describe("Engine tick crash safety", () => {
  let db: MarinaDB;
  let engine: Engine;
  let logger: Logger;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    logger = new Logger({ level: "error" });
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db, logger });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  const access = () => engine as unknown as TickAccess;

  it("keeps ticking when a per-tick DB op throws (e.g. SQLITE_BUSY)", () => {
    (db as unknown as { expireDirectMessages: () => void }).expireDirectMessages = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    const warn = spyOn(logger, "warn");

    expect(() => access().tick()).not.toThrow();
    expect(() => access().tick()).not.toThrow();

    expect(access().tickCount).toBe(2);
    // Wrapped in tryLog: logged as a warning, not counted as a tick failure.
    expect(engine.tickErrors).toBe(0);
    expect(warn.mock.calls.some((c) => c[1] === "Direct-message expiry failed")).toBe(true);
  });

  it("keeps ticking when a room onTick throws", () => {
    engine.registerRoom(
      roomId("test/boom"),
      makeTestRoom({
        short: "Boom",
        onTick: () => {
          throw new Error("room exploded");
        },
      }),
    );
    expect(() => access().tick()).not.toThrow();
    expect(() => access().tick()).not.toThrow();
    expect(access().tickCount).toBe(2);
  });

  it("catches a throw from the tick body, counts it, and rate-limits identical logs", () => {
    const error = spyOn(logger, "error");
    const original = access().tickInner.bind(engine);
    let armed = true;
    access().tickInner = () => {
      if (armed) throw new Error("SQLITE_BUSY: database is locked");
      original();
    };

    expect(() => access().tick()).not.toThrow();
    expect(() => access().tick()).not.toThrow();
    expect(() => access().tick()).not.toThrow();
    expect(engine.tickErrors).toBe(3);
    // Same message within the 30 s window → one log line.
    const tickLogs = error.mock.calls.filter((c) => c[0] === "tick");
    expect(tickLogs).toHaveLength(1);

    // The loop is still alive: once the fault clears, normal ticks resume.
    armed = false;
    const before = access().tickCount;
    access().tick();
    expect(access().tickCount).toBe(before + 1);
    expect(engine.tickErrors).toBe(3);
  });
});
