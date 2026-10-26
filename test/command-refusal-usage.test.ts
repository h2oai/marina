// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A command that refuses — bad usage, an unknown subcommand, no such target,
 * a rank floor or a safety gate — records failed usage and a failed activity,
 * on every shared refusal path. A read that finds nothing, a bare command that
 * shows its usage, and a no-op on a state that already holds stay successes.
 * As with every handler refusal, quest progress and the `command` event are
 * unchanged: the command ran.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  failCommandResponse,
  observeHandlerOutcome,
  refuseCommand,
  withoutRefusal,
} from "../src/engine/command-response";
import { Engine } from "../src/engine/engine";
import { unknownSubcommand } from "../src/engine/parse-input";
import { rankFloorRefusal } from "../src/engine/rank-floor";
import { checkGateForExecution } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_command_refusal_usage.db");

describe("shared refusal helpers mark the running command failed", () => {
  const failedOf = (run: () => void) => {
    const outcome = observeHandlerOutcome(run);
    if (outcome instanceof Promise) throw new Error("expected a synchronous outcome");
    return outcome.failed;
  };

  it("refuseCommand sends the message and fails the command", () => {
    const sent: unknown[][] = [];
    const ctx = { send: (...args: unknown[]) => void sent.push(args) };
    const failed = failedOf(() => refuseCommand(ctx, "e_1" as EntityId, "Usage: x <y>"));
    expect(failed).toBe("Usage: x <y>");
    // Optional tag/metadata pass through only when given.
    expect(sent).toEqual([["e_1", "Usage: x <y>"]]);
    failedOf(() => refuseCommand(ctx, "e_1" as EntityId, "no", "tag", { a: 1 }));
    expect(sent[1]).toEqual(["e_1", "no", "tag", { a: 1 }]);
  });

  it("unknownSubcommand fails the command it answers", () => {
    let reply = "";
    const failed = failedOf(() => {
      reply = unknownSubcommand("demo", "frob", "Usage: demo a|b");
    });
    expect(reply).toBe('Unknown demo subcommand "frob". Usage: demo a|b');
    expect(failed).toBe(reply);
  });

  it("a rank floor refusal fails the command; a passed floor does not", () => {
    const low = { id: "e_low" as EntityId, properties: { rank: 0 } };
    const high = { id: "e_high" as EntityId, properties: { rank: 9 } };
    expect(failedOf(() => rankFloorRefusal(low, 3, "Requires rank 3."))).toContain(
      "Requires rank 3.",
    );
    expect(failedOf(() => rankFloorRefusal(high, 3, "Requires rank 3."))).toBeUndefined();
  });

  it("a safety gate refusal fails the command", () => {
    const db = new MarinaDB(":memory:");
    try {
      const failed = failedOf(() => checkGateForExecution(db, "e_nobody", "agent.spawn"));
      expect(failed).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("withoutRefusal keeps a probe's refusal out of the outer command", () => {
    const low = { id: "e_low" as EntityId, properties: { rank: 0 } };
    let probe: string | undefined;
    const failed = failedOf(() => {
      probe = withoutRefusal(() => rankFloorRefusal(low, 3, "Requires rank 3."));
    });
    expect(probe).toContain("Requires rank 3.");
    expect(failed).toBeUndefined();
    // A nested refusal outside the probe still counts.
    expect(failedOf(() => failCommandResponse("refused"))).toBe("refused");
  });
});

describe("refusals in commands record failed usage and activity", () => {
  let db: MarinaDB;
  let engine: Engine;

  const run = async (conn: MockConnection, text: string) => {
    conn.clear();
    await engine.processCommand(conn.entity as EntityId, text);
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
  const query = <T>(sql: string, ...params: string[]): T[] => {
    const raw = new Database(TEST_DB, { readonly: true });
    try {
      return raw.query(sql).all(...params) as T[];
    } finally {
      raw.close();
    }
  };
  const lastUsage = (actor: string) =>
    query<{ primitive: string; success: number }>(
      "SELECT primitive, success FROM primitive_usage WHERE actor_name = ? ORDER BY id",
      actor,
    ).at(-1);
  const activity = (actor: string, verb: string) =>
    query<{ success_count: number; fail_count: number }>(
      "SELECT success_count, fail_count FROM entity_activity WHERE entity_name = ? AND activity_type = 'command' AND activity_key = ?",
      actor,
      verb,
    )[0];

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

  it.each([
    ["an unknown subcommand", "task frobnicate", "Unknown task subcommand", "task"],
    ["a missing argument", "group join", "Usage: group join", "group"],
    ["no such target", "group info nowhere", 'Group "nowhere" not found', "group"],
    ["a wrong state", "experiment join nowhere", 'Experiment "nowhere" not found', "experiment"],
    ["an invalid value", "calc", "Usage: calc", "calc"],
    [
      "an in-handler rank floor",
      "experiment create trial",
      "Requires coordinator rank",
      "experiment",
    ],
    ["a missing note", "note delete 99999", "not found", "note"],
    ["a missing macro", "macro delete nope", 'Macro "nope" not found', "macro"],
    ["a missing crew", "crew join nope", 'Crew "nope" not found', "crew"],
    ["a missing board post", "board reply 99999 hi", "not found", "board"],
    ["an unknown memory kv verb", "memory kv frob", "Unknown memory kv subcommand", "memory"],
  ])("%s is failed usage and a failed activity", async (_label, input, expected, verb) => {
    const a = join("u_a", "Ann");
    expect(await run(a, input)).toContain(expected);
    expect(lastUsage("Ann")).toMatchObject({ success: 0 });
    expect(activity("Ann", verb)).toMatchObject({ success_count: 0, fail_count: 1 });
  });

  it("a refusal still logs the command event, as any handler refusal does", async () => {
    const a = join("u_a", "Ann");
    const before = engine.eventLog.filter((e) => e.type === "command").length;
    await run(a, "group info nowhere");
    expect(engine.eventLog.filter((e) => e.type === "command").length).toBe(before + 1);
  });

  it("a read with no results, a bare usage display and an idempotent no-op stay successes", async () => {
    const a = join("u_a", "Ann");
    expect(await run(a, "task list")).not.toContain("Usage:");
    expect(lastUsage("Ann")).toMatchObject({ success: 1 });

    expect(await run(a, "ignore")).toContain("Usage: ignore");
    expect(lastUsage("Ann")).toMatchObject({ success: 1 });

    await run(a, "channel create lounge");
    await run(a, "channel join lounge");
    expect(await run(a, "channel join lounge")).toContain("already in channel");
    expect(lastUsage("Ann")).toMatchObject({ success: 1 });
  });

  it("the same command succeeds once its refusal no longer applies", async () => {
    const a = join("u_a", "Ann");
    expect(await run(a, "group info crew1")).toContain("not found");
    expect(lastUsage("Ann")).toMatchObject({ success: 0 });
    await run(a, "group create crew1");
    expect(await run(a, "group info crew1")).not.toContain("not found");
    expect(lastUsage("Ann")).toMatchObject({ success: 1 });
    expect(activity("Ann", "group")).toMatchObject({ fail_count: 1 });
  });
});
