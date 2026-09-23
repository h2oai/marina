// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The tick's command phase: queued commands run strictly in order per entity
 * (different entities still interleave), a throw that escapes `processCommand`
 * before the handler's own try/catch lands on the tick error path, and the
 * phase stops dispatching once its wall-clock budget is spent — the leftover
 * runs next tick in the same FIFO order.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { COMMAND_PHASE_BUDGET_MS, Engine } from "../src/engine/engine";
import { Logger } from "../src/engine/logger";
import type { Entity } from "../src/types";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

type TickAccess = { tick(): void };

/** Handler replies only — drops the "<name> connects." broadcasts from later joins. */
function done(conn: MockConnection): string[] {
  return conn.allText().filter((t) => t.endsWith("done"));
}

function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* busy */
  }
}

describe("command queue: ordering, error path, phase budget", () => {
  let engine: Engine;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger({ level: "error" });
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, logger });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    // Built-ins, not room commands: `RoomSandbox.wrapModule` discards a room
    // handler's promise, so only a built-in's `await` reaches the engine.
    engine.commands.registerBuiltin({
      name: "slow",
      help: "test",
      handler: async (ctx, input) => {
        await Bun.sleep(30);
        ctx.send(input.entity, "slow done");
      },
    });
    engine.commands.registerBuiltin({
      name: "fast",
      help: "test",
      handler: (ctx, input) => {
        ctx.send(input.entity, "fast done");
      },
    });
    engine.commands.registerBuiltin({
      name: "busy",
      help: "test",
      handler: (ctx, input) => {
        spin(15);
        ctx.send(input.entity, "busy done");
      },
    });
  });

  afterEach(() => {
    engine.stop();
  });

  const tick = () => (engine as unknown as TickAccess).tick();

  function join(name: string): { conn: MockConnection; entity: Entity } {
    const conn = new MockConnection(`conn_${name}`);
    engine.addConnection(conn);
    const entity = engine.spawnEntity(conn.id, name)!;
    conn.clear();
    return { conn, entity };
  }

  it("runs one entity's commands in order while another entity's interleave", async () => {
    const a = join("Alpha");
    const b = join("Beta");
    engine.queueCommand(a.entity.id, "slow");
    engine.queueCommand(a.entity.id, "fast");
    engine.queueCommand(b.entity.id, "fast");

    tick();
    // Beta's command ran synchronously inside the tick; Alpha's `fast` is
    // chained behind the still-awaiting `slow` instead of overtaking it.
    expect(done(b.conn)).toEqual(["fast done"]);
    expect(done(a.conn)).toEqual([]);
    expect(engine.queuedCommandCount).toBe(0);

    await engine.drainCommands();
    expect(done(a.conn)).toEqual(["slow done", "fast done"]);
  });

  it("keeps order across ticks when a command is still in flight", async () => {
    const a = join("Alpha");
    engine.queueCommand(a.entity.id, "slow");
    tick();
    engine.queueCommand(a.entity.id, "fast");
    tick();
    await engine.drainCommands();
    expect(done(a.conn)).toEqual(["slow done", "fast done"]);
  });

  it("routes a throw before the handler's try/catch to the tick error path", async () => {
    const a = join("Alpha");
    const error = spyOn(logger, "error");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      spyOn(engine.commands, "parse").mockImplementationOnce(() => {
        throw new Error("parse exploded");
      });
      engine.queueCommand(a.entity.id, "look");
      expect(() => tick()).not.toThrow();
      await engine.drainCommands();
      // Let any stray rejection reach the process hook before asserting.
      await Bun.sleep(0);

      expect(unhandled).toEqual([]);
      expect(engine.tickErrors).toBe(1);
      expect(
        error.mock.calls.some(
          (c) =>
            c[1] === "Tick failed; loop continues" &&
            (c[2] as { error: string }).error === "parse exploded",
        ),
      ).toBe(true);

      // The queue keeps working afterwards.
      engine.queueCommand(a.entity.id, "fast");
      tick();
      await engine.drainCommands();
      expect(done(a.conn)).toEqual(["fast done"]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stops dispatching once the phase budget is spent and resumes next tick in order", async () => {
    const budget = engine as unknown as { commandPhaseBudgetMs: number };
    expect(COMMAND_PHASE_BUDGET_MS).toBe(150);
    budget.commandPhaseBudgetMs = 1;

    const members = ["One", "Two", "Three", "Four", "Five"].map(join);
    for (const m of members) engine.queueCommand(m.entity.id, "busy");

    // Each `busy` spins 15 ms synchronously, so a 1 ms budget admits exactly
    // the first command per tick (at least one always dispatches).
    tick();
    expect(engine.queuedCommandCount).toBe(4);
    expect(done(members[0]!.conn)).toEqual(["busy done"]);
    expect(done(members[1]!.conn)).toEqual([]);

    let ticks = 1;
    while (engine.queuedCommandCount > 0 && ticks < 20) {
      tick();
      ticks++;
    }
    expect(ticks).toBe(5);
    await engine.drainCommands();
    for (const m of members) expect(done(m.conn)).toEqual(["busy done"]);

    // A generous budget drains the same load in one tick.
    budget.commandPhaseBudgetMs = 10_000;
    for (const m of members) engine.queueCommand(m.entity.id, "fast");
    tick();
    expect(engine.queuedCommandCount).toBe(0);
    await engine.drainCommands();
    for (const m of members) expect(done(m.conn)).toEqual(["busy done", "fast done"]);
  });

  it("keeps per-entity FIFO order in the leftover after a budget cut", async () => {
    (engine as unknown as { commandPhaseBudgetMs: number }).commandPhaseBudgetMs = 1;
    const a = join("Alpha");
    const b = join("Beta");
    engine.queueCommand(a.entity.id, "busy");
    engine.queueCommand(a.entity.id, "fast");
    engine.queueCommand(b.entity.id, "busy");
    engine.queueCommand(b.entity.id, "fast");

    tick(); // Alpha busy only (15 ms > 1 ms budget)
    expect(engine.queuedCommandCount).toBe(3);
    // Round-robin resumes: Alpha's `fast` (sub-ms) then Beta's `busy` both fit
    // before the budget check trips; Beta's `fast` waits.
    tick();
    expect(engine.queuedCommandCount).toBe(1);
    tick();
    expect(engine.queuedCommandCount).toBe(0);
    await engine.drainCommands();
    expect(done(a.conn)).toEqual(["busy done", "fast done"]);
    expect(done(b.conn)).toEqual(["busy done", "fast done"]);
  });
});
