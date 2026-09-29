// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Command-phase integrity: one FIFO ingress, per-execution gate state, bounded
 * macros, honest async failures, room commands under their own definition,
 * spawn accounting, drained background work, and the telnet line/connection
 * bounds. Each block names the defect it pins.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record as recordStanding } from "../src/agent/standing";
import { generateArenaKey } from "../src/arena/protocol";
import { runArenaAutopilot } from "../src/arena/service";
import type { MacroManager } from "../src/coordination/macro-manager";
import {
  CommandPhaseCoordinator,
  type CommandPhaseHost,
  MAX_MACRO_DEPTH,
  MAX_MACRO_EXPANSIONS,
} from "../src/engine/command-phase-coordinator";
import { CommandRouter } from "../src/engine/command-router";
import { connectCommand } from "../src/engine/commands/connect";
import { evolveCommand } from "../src/engine/commands/evolve";
import { macroCommand } from "../src/engine/commands/macro";
import { rankCommand } from "../src/engine/commands/rank";
import { runCommand } from "../src/engine/commands/run";
import {
  armGatePass,
  type GatePass,
  getCurrentCommand,
  grantCommandPass,
  isRankWaivedForRun,
  resetGateContextForTests,
  runCommandScope,
  setCurrentCommand,
  takeArmedGatePass,
} from "../src/engine/gate-context";
import { Logger } from "../src/engine/logger";
import { grant } from "../src/engine/safety-gates";
import type { ShellRuntime } from "../src/engine/shell-runtime";
import { TickScheduler } from "../src/engine/tick-scheduler";
import {
  splitTelnetChunk,
  TELNET_MAX_CONNECTIONS_PER_IP,
  TELNET_MAX_LINE_CHARS,
  TELNET_MAX_TOTAL_CONNECTIONS,
  TelnetServer,
} from "../src/net/telnet-server";
import { MarinaDB } from "../src/persistence/database";
import type { CommandHandler, EngineEvent, Entity, EntityId, RoomContext } from "../src/types";
import { roomId } from "../src/types";
import { EntityManager } from "../src/world/entity-manager";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

const PASS: GatePass = {
  gateIds: ["agent.spawn"],
  rankWaived: true,
  waivedRank: 5,
  approverName: "Admin",
  token: "t1",
};

afterEach(() => resetGateContextForTests());

// ─── 1. One ingress: admission + per-entity FIFO ─────────────────────────────

describe("engine.dispatchCommand — the one command ingress", () => {
  it("runs one entity's commands in arrival order and resolves once each ran", async () => {
    const t = createTestEngine();
    try {
      const { entityId } = t.login("Alice");
      const order: string[] = [];
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.engine.commands.registerBuiltin({
        name: "slowcmd",
        help: "slow",
        handler: async () => {
          order.push("slow:start");
          await barrier;
          order.push("slow:end");
        },
      });
      t.engine.commands.registerBuiltin({
        name: "fastcmd",
        help: "fast",
        handler: () => {
          order.push("fast");
        },
      });
      const first = t.engine.dispatchCommand(entityId, "slowcmd");
      const second = t.engine.dispatchCommand(entityId, "fastcmd");
      await Bun.sleep(10);
      // The second pasted line waits for the first; it does not interleave.
      expect(order).toEqual(["slow:start"]);
      release();
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(order).toEqual(["slow:start", "slow:end", "fast"]);
    } finally {
      await t.dispose();
    }
  });

  it("runs a dispatch made from inside the entity's own slot inline instead of deadlocking", async () => {
    const t = createTestEngine();
    try {
      const { entityId } = t.login("Bea");
      const order: string[] = [];
      t.engine.commands.registerBuiltin({
        name: "innercmd",
        help: "inner",
        handler: () => {
          order.push("inner");
        },
      });
      t.engine.commands.registerBuiltin({
        name: "outercmd",
        help: "outer",
        handler: async (_ctx, input) => {
          order.push("outer:start");
          expect(await t.engine.dispatchCommand(input.entity, "innercmd")).toBe(true);
          order.push("outer:end");
        },
      });
      expect(await t.engine.dispatchCommand(entityId, "outercmd")).toBe(true);
      expect(order).toEqual(["outer:start", "inner", "outer:end"]);
    } finally {
      await t.dispose();
    }
  });

  it("no transport or re-run site calls engine.processCommand directly", () => {
    for (const file of [
      "src/net/telnet-server.ts",
      "src/net/discord-adapter.ts",
      "src/net/telegram-adapter.ts",
      "src/net/mcp-session.ts",
      "src/engine/auth-coordinator.ts",
      "src/engine/registrations/coordination.ts",
    ]) {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect({ file, direct: /\b(engine|host)\.processCommand\(/.test(source) }).toEqual({
        file,
        direct: false,
      });
    }
  });
});

// ─── 2. Gate-pass state is per execution ──────────────────────────────────────

describe("gate context — one frame per execution", () => {
  it("a nested execution neither reads nor clears the outer command's approved pass", async () => {
    await runCommandScope("e_x", async () => {
      setCurrentCommand("e_x", "outer");
      armGatePass("e_x", { ...PASS, gateIds: [...PASS.gateIds] });
      await runCommandScope("e_x", async () => {
        expect(getCurrentCommand("e_x")).toBeUndefined();
        expect(isRankWaivedForRun("e_x", 5)).toBe(false);
        setCurrentCommand("e_x", "inner");
        armGatePass("e_x", undefined);
      });
      expect(getCurrentCommand("e_x")).toBe("outer");
      expect(isRankWaivedForRun("e_x", 5)).toBe(true);
      expect(takeArmedGatePass("e_x", "agent.spawn")).toBeDefined();
    });
    expect(getCurrentCommand("e_x")).toBeUndefined();
  });

  it("interleaved executions of one entity keep their own command and pass", async () => {
    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const first = runCommandScope("e_y", async () => {
      setCurrentCommand("e_y", "A");
      armGatePass("e_y", { ...PASS, gateIds: [...PASS.gateIds] });
      await holdA;
      return [getCurrentCommand("e_y"), isRankWaivedForRun("e_y", 5)];
    });
    const second = runCommandScope("e_y", async () => {
      setCurrentCommand("e_y", "B");
      armGatePass("e_y", undefined);
      return getCurrentCommand("e_y");
    });
    expect(await second).toBe("B");
    releaseA();
    expect(await first).toEqual(["A", true]);
  });

  it("detached work a command left behind sees no pass once the command returned", async () => {
    let later!: () => [string | undefined, boolean];
    await runCommandScope("e_z", async () => {
      setCurrentCommand("e_z", "held");
      armGatePass("e_z", { ...PASS, gateIds: [...PASS.gateIds] });
      later = () => [getCurrentCommand("e_z"), isRankWaivedForRun("e_z", 5)];
    });
    expect(later()).toEqual([undefined, false]);
    const detached = await new Promise<[string | undefined, boolean]>((resolve) => {
      void runCommandScope("e_z", async () => {
        setCurrentCommand("e_z", "held");
        armGatePass("e_z", { ...PASS, gateIds: [...PASS.gateIds] });
        setTimeout(() => resolve([getCurrentCommand("e_z"), isRankWaivedForRun("e_z", 5)]), 5);
      });
    });
    expect(detached).toEqual([undefined, false]);
  });

  it("an approved pass survives a nested command inside the approved run", async () => {
    const t = createTestEngine();
    try {
      const { entityId } = t.login("Cleo");
      const seen: unknown[] = [];
      t.engine.commands.registerBuiltin({ name: "noop", help: "noop", handler: () => {} });
      t.engine.commands.registerBuiltin({
        name: "probe",
        help: "probe",
        handler: async (_ctx, input) => {
          await t.engine.processCommand(input.entity, "noop");
          seen.push(isRankWaivedForRun(input.entity, 5), getCurrentCommand(input.entity));
        },
      });
      grantCommandPass(entityId, "probe", { ...PASS, gateIds: [...PASS.gateIds] });
      await t.engine.dispatchCommand(entityId, "probe");
      expect(seen).toEqual([true, "probe"]);
    } finally {
      await t.dispose();
    }
  });
});

// ─── 3–5. Command phase: macros, async failures, room commands ───────────────

function phaseFixture(
  opts: {
    macros?: Record<string, string>;
    rate?: () => boolean;
    roomCommands?: Record<string, CommandHandler>;
    rank?: number;
  } = {},
) {
  const entities = new EntityManager();
  const entity = entities.create({
    kind: "agent",
    name: "Dana",
    short: "Dana",
    long: "Dana",
    room: roomId("test/start"),
    properties: { rank: opts.rank ?? 0 },
  });
  const commands = new CommandRouter();
  const messages: string[] = [];
  const events: EngineEvent[] = [];
  const calls: string[] = [];
  const usage: boolean[] = [];
  const activity: Array<[string, string, boolean | undefined]> = [];
  commands.registerBuiltin({
    name: "look",
    help: "Look",
    handler: () => {
      calls.push("look");
    },
  });
  const macros = opts.macros ?? {};
  const macroManager = {
    getByName: (name: string, author: string) =>
      author !== "system" && Object.hasOwn(macros, name)
        ? { id: 1, name, command: macros[name]!, authorId: author, createdAt: 0 }
        : undefined,
  } as unknown as Pick<MacroManager, "getByName">;
  const db = {
    recordPrimitiveUsage: (row: { success: boolean }) => usage.push(row.success),
    trackActivity: (_name: string, kind: string, value: string, ok?: boolean) =>
      activity.push([kind, value, ok]),
  };
  let phase!: CommandPhaseCoordinator;
  const host: CommandPhaseHost = {
    entities,
    commands,
    rooms: {
      get: () =>
        opts.roomCommands
          ? ({ module: { commands: opts.roomCommands } } as unknown as ReturnType<
              CommandPhaseHost["rooms"]["get"]
            >)
          : undefined,
    },
    db: db as unknown as MarinaDB,
    macroManager,
    logger: new Logger(),
    promptVersion: () => undefined,
    sendToEntity: (_, message) => messages.push(stripAnsi(message)),
    processCommand: (id, raw) => phase.execute(id, raw),
    ...(opts.rate ? { checkRateLimit: opts.rate } : {}),
    buildCommandContext: () => undefined,
    buildContext: () => ({}) as RoomContext,
    logEvent: (event) => events.push(event),
  };
  phase = new CommandPhaseCoordinator(host);
  return { phase, entity, commands, messages, events, calls, usage, activity };
}

describe("macro expansion — bounded and charged", () => {
  it("stops a macro cycle", async () => {
    const f = phaseFixture({ macros: { ping: "pong", pong: "look; ping" } });
    await f.phase.execute(f.entity.id, "ping");
    expect(f.messages.join("\n")).toContain('Macro "ping" calls itself');
    expect(f.calls).toEqual(["look"]);
  });

  it(`stops nesting past MAX_MACRO_DEPTH (${MAX_MACRO_DEPTH})`, async () => {
    const macros: Record<string, string> = {};
    for (let i = 0; i < MAX_MACRO_DEPTH + 2; i++) macros[`m${i}`] = `m${i + 1}`;
    macros[`m${MAX_MACRO_DEPTH + 2}`] = "look";
    const f = phaseFixture({ macros });
    await f.phase.execute(f.entity.id, "m0");
    expect(f.messages.join("\n")).toContain(`Macro nesting deeper than ${MAX_MACRO_DEPTH}`);
    expect(f.calls).toEqual([]);
  });

  it(`caps one invocation at MAX_MACRO_EXPANSIONS (${MAX_MACRO_EXPANSIONS}) commands`, async () => {
    const f = phaseFixture({
      macros: { wide: Array(11).fill("fan").join(";"), fan: Array(10).fill("look").join(";") },
    });
    await f.phase.execute(f.entity.id, "wide");
    expect(f.calls.length).toBeLessThan(MAX_MACRO_EXPANSIONS);
    expect(f.messages.join("\n")).toContain(`stopped after ${MAX_MACRO_EXPANSIONS}`);
  });

  it("charges one rate-limit token per expanded command", async () => {
    let tokens = 2;
    const f = phaseFixture({ macros: { three: "look; look; look" }, rate: () => tokens-- > 0 });
    await f.phase.execute(f.entity.id, "three");
    expect(f.calls).toEqual(["look", "look"]);
    expect(f.messages.join("\n")).toContain("rate-limited 1 command(s)");
  });

  it("`macro create` refuses an empty command and a name a room command owns", () => {
    const created: string[] = [];
    const macros = {
      getByName: () => undefined,
      create: (name: string) => created.push(name),
    } as unknown as MacroManager;
    const router = new CommandRouter();
    const cmd = macroCommand(macros, router, (name) => name === "pray");
    const out: string[] = [];
    const ctx = {
      send: (_: string, text: string) => out.push(text),
      getEntity: () => ({ id: "e_1", name: "Mac", properties: {} }),
    } as unknown as RoomContext;
    const run = (line: string) => {
      const tokens = line.split(/\s+/).slice(1);
      cmd.handler(ctx, {
        raw: line,
        verb: "macro",
        args: tokens.join(" "),
        tokens,
        entity: "e_1" as EntityId,
        room: roomId("test/start"),
      });
    };
    run("macro create pray look");
    expect(out.at(-1)).toContain("conflicts with a room command");
    run("macro create blank ; ;");
    expect(out.at(-1)).toContain("Cannot create an empty macro");
    run("macro create fine look ; look");
    expect(created).toEqual(["fine"]);
  });
});

describe("an async handler that rejects is a failed command", () => {
  it("records failure: no command event, a failed activity row and failed usage", async () => {
    const f = phaseFixture();
    f.commands.registerBuiltin({
      name: "boom",
      help: "boom",
      handler: async () => {
        await Promise.resolve();
        throw new Error("nope");
      },
    });
    await f.phase.execute(f.entity.id, "boom");
    expect(f.messages.at(-1)).toBe("Command error: nope");
    expect(f.events.filter((e) => e.type === "command")).toHaveLength(0);
    expect(f.activity).toEqual([["command", "boom", false]]);
    expect(f.usage).toEqual([false]);

    await f.phase.execute(f.entity.id, "look");
    expect(f.events.filter((e) => e.type === "command")).toHaveLength(1);
    expect(f.usage).toEqual([false, true]);
  });
});

describe("room commands run under their own definition", () => {
  it("a room command shadowing a gated/ranked builtin is not held to the builtin's floor", async () => {
    const roomCalls: string[] = [];
    const f = phaseFixture({
      roomCommands: {
        forge: () => {
          roomCalls.push("room forge");
        },
      },
    });
    f.commands.registerBuiltin({
      name: "forge",
      help: "builtin forge",
      minRank: 9,
      handler: () => {
        roomCalls.push("builtin forge");
      },
    });
    await f.phase.execute(f.entity.id, "forge");
    expect(roomCalls).toEqual(["room forge"]);
    expect(f.messages.join("\n")).not.toContain("rank 9");
  });

  it("only a room's own keys resolve — never Object.prototype members", () => {
    const router = new CommandRouter();
    for (const verb of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(router.resolveCommand(verb, {})).toBeUndefined();
    }
  });
});

// ─── 6. usecase spawn accounting ─────────────────────────────────────────────

describe("usecase team spawn", () => {
  function patchRuntime(t: ReturnType<typeof createTestEngine>, available: boolean) {
    const spawned: Array<{ name: string; spawnedBy?: string }> = [];
    Object.assign(t.engine.agentRuntime, {
      isAvailable: () => available,
      list: () => [],
      spawn: async (o: { name: string; spawnedBy?: string }) => {
        spawned.push(o);
        return { setFocus() {}, getStatus: () => ({ model: "test/model" }) };
      },
    });
    return spawned;
  }
  function earnStanding(t: ReturnType<typeof createTestEngine>, id: EntityId, amount: number) {
    recordStanding(t.db, id, "Tess", "task_complete", "task:1", amount);
  }

  it("spawns as the requester, within the requester's budget, recording one execution", async () => {
    using _state = scopeProcessState({ trustProfile: null, env: { MARINA_AUTONOMY: "earned" } });
    const t = createTestEngine();
    try {
      const { entityId, connection } = t.login("Tess");
      earnStanding(t, entityId, 45); // ≥ 40 (optimistic under earned); budget floor(45/25) = 1
      const spawned = patchRuntime(t, true);
      await t.engine.dispatchCommand(entityId, "usecase evolve sharpen research notes");
      expect(spawned).toHaveLength(1); // the two-member team, capped at the budget
      expect(spawned[0]?.spawnedBy).toBe("Tess");
      expect(stripAnsi(connection.allTextJoined())).toContain("Spawn budget");
      expect(t.db.listOpenWitnessRows({ kind: "pending", gate: "agent.spawn" })).toHaveLength(1);
    } finally {
      await t.dispose();
    }
  });

  it("records nothing when the runtime is unavailable", async () => {
    using _state = scopeProcessState({ trustProfile: null, env: { MARINA_AUTONOMY: "earned" } });
    const t = createTestEngine();
    try {
      const { entityId, connection } = t.login("Tess");
      earnStanding(t, entityId, 45);
      const spawned = patchRuntime(t, false);
      await t.engine.dispatchCommand(entityId, "usecase evolve sharpen research notes");
      expect(spawned).toHaveLength(0);
      expect(stripAnsi(connection.allTextJoined())).toContain("no model provider configured");
      expect(t.db.listOpenWitnessRows({ kind: "pending", gate: "agent.spawn" })).toHaveLength(0);
    } finally {
      await t.dispose();
    }
  });

  it("the local profile still spawns the whole team (counted, not capped)", async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_AUTONOMY: undefined },
    });
    const t = createTestEngine();
    try {
      const { entityId } = t.login("Tess");
      const spawned = patchRuntime(t, true);
      await t.engine.dispatchCommand(entityId, "usecase evolve sharpen research notes");
      expect(spawned.map((s) => s.spawnedBy)).toEqual(["Tess", "Tess"]);
    } finally {
      await t.dispose();
    }
  });
});

// ─── 7. evolve discovery ─────────────────────────────────────────────────────

describe("evolve usage", () => {
  it("declares a structured form for every subcommand", () => {
    const usage = evolveCommand({ getEntity: () => undefined }).usage ?? [];
    const syntaxes = usage.map((u) => (typeof u === "string" ? u : u.syntax));
    for (const sub of [
      "loop",
      "adoption",
      "sessions",
      "qualify",
      "create",
      "start",
      "pause",
      "resume",
      "complete",
      "status",
      "analyze",
      "propose",
      "trial",
      "evaluate",
      "decide",
      "replicate",
    ]) {
      expect({ sub, found: syntaxes.some((s) => s.startsWith(`evolve ${sub}`)) }).toEqual({
        sub,
        found: true,
      });
    }
  });
});

// ─── 8. Async tick jobs and background work are drained ──────────────────────

describe("async tick jobs and background work", () => {
  it("never overlaps an in-flight async job and drains it", async () => {
    const s = new TickScheduler(new Logger());
    let finish!: () => void;
    let runs = 0;
    s.register({
      name: "slow",
      every: 1,
      phase: 0,
      run: () => {
        runs++;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    s.runDue(0);
    s.runDue(1);
    expect(runs).toBe(1);
    expect(s.describe()[0]).toMatchObject({ inFlight: true, skippedOverlaps: 1 });
    let drained = false;
    const drain = s.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(5);
    expect(drained).toBe(false);
    finish();
    await drain;
    expect(s.pendingCount).toBe(0);
    s.runDue(2);
    expect(runs).toBe(2);
    finish();
    await s.drain();
  });

  it("engine.shutdown waits for tracked background work before it returns", async () => {
    const t = createTestEngine();
    try {
      let release!: () => void;
      let wrote = false;
      t.engine.trackBackground(
        new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => {
          wrote = true;
        }),
      );
      const done = t.engine.shutdown();
      await Bun.sleep(5);
      expect(wrote).toBe(false);
      release();
      await done;
      expect(wrote).toBe(true);
      // A drain is bounded: work that has not settled does not hold it forever.
      let settle!: () => void;
      t.engine.trackBackground(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      expect(await t.engine.drainBackground(10)).toBe(false);
      settle();
      expect(await t.engine.drainBackground(1_000)).toBe(true);
    } finally {
      await t.dispose();
    }
  });
});

// ─── 9. Inline rank floors and the shell.exec gate ───────────────────────────

describe("inline floors go through the shared helpers", () => {
  const shellEntity = (rank: number) =>
    ({
      id: "e_sh" as EntityId,
      name: "Shell",
      kind: "agent",
      room: roomId("test/start"),
      properties: { rank },
    }) as unknown as Entity;
  const runLine = async (cmd: ReturnType<typeof runCommand>, line: string) => {
    const out: string[] = [];
    const tokens = line.split(/\s+/).slice(1);
    await cmd.handler(
      { send: (_: string, text: string) => out.push(stripAnsi(text)) } as unknown as RoomContext,
      {
        raw: line,
        verb: line.split(/\s+/)[0]!,
        args: tokens.join(" "),
        tokens,
        entity: "e_sh" as EntityId,
        room: roomId("test/start"),
      },
    );
    return out.join("\n");
  };
  const fakeShell = (raws: string[]) =>
    ({
      execRaw: async (_: string, command: string) => {
        raws.push(command);
        return {
          exitCode: 0,
          preview: "",
          outputFile: "out.txt",
          truncated: false,
          timedOut: false,
          newFiles: [],
        };
      },
    }) as unknown as ShellRuntime;

  it("`run raw` needs shell.exec on a shared instance and passes on a local one", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const raws: string[] = [];
      const entity = shellEntity(9);
      const cmd = runCommand({ getEntity: () => entity, shellRuntime: fakeShell(raws), db });
      {
        using _state = scopeProcessState({ trustProfile: null, env: { MARINA_AUTONOMY: "open" } });
        // Sovereign rank alone no longer runs `sh -c`; `open` never passes the core gate.
        expect(await runLine(cmd, "run raw echo hi")).not.toContain("exit 0");
        expect(raws).toEqual([]);
        grant(db, "e_sh", "shell.exec");
        expect(await runLine(cmd, "run raw echo hi")).toContain("exit 0");
        expect(raws).toEqual(["echo hi"]);
      }
      db.revokeCompetence("e_sh", "shell.exec");
      {
        using _state = scopeProcessState({
          trustProfile: "local",
          env: { MARINA_AUTONOMY: undefined },
        });
        await runLine(cmd, "run raw echo local");
        expect(raws).toEqual(["echo hi", "echo local"]);
      }
    } finally {
      db.close();
    }
  });

  it("`connect add … stdio` needs shell.exec on a shared instance", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const entity = shellEntity(9);
      const cmd = connectCommand({ getEntity: () => entity, db });
      const line = "connect add fsx stdio node server.js";
      {
        using _state = scopeProcessState({
          trustProfile: null,
          env: { MARINA_AUTONOMY: undefined },
        });
        await runLine(cmd as never, line);
        expect(db.getConnectorByName("fsx")).toBeFalsy();
      }
      {
        using _state = scopeProcessState({
          trustProfile: "local",
          env: { MARINA_AUTONOMY: undefined },
        });
        await runLine(cmd as never, line);
        expect(db.getConnectorByName("fsx")).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });

  it("setting a rank stays sovereign-only under `open` (a path into the core), not under local", async () => {
    const target = { ...shellEntity(0), id: "e_t" as EntityId, name: "Tgt" } as Entity;
    const self = shellEntity(4);
    const cmd = rankCommand({ findEntity: (name) => (name === "Tgt" ? target : undefined) });
    const run = (line: string) => {
      const out: string[] = [];
      const tokens = line.split(/\s+/).slice(1);
      cmd.handler(
        {
          send: (_: string, text: string) => out.push(stripAnsi(text)),
          getEntity: () => self,
        } as unknown as RoomContext,
        {
          raw: line,
          verb: "rank",
          args: tokens.join(" "),
          tokens,
          entity: self.id,
          room: roomId("test/start"),
        },
      );
      return out.join("\n");
    };
    {
      using _state = scopeProcessState({ trustProfile: null, env: { MARINA_AUTONOMY: "open" } });
      expect(run("rank Tgt 5")).toContain("Only sovereigns");
      expect(target.properties.rank).toBe(0);
    }
    {
      using _state = scopeProcessState({
        trustProfile: "local",
        env: { MARINA_AUTONOMY: undefined },
      });
      run("rank Tgt 5");
      expect(target.properties.rank).toBe(5);
    }
  });
});

// ─── 10. Arena autopilot is single-flight from the first await ───────────────

describe("arena autopilot", () => {
  it("an overlapping call returns at once instead of filing a second time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-race-"));
    try {
      const keyFile = join(dir, "k.pem");
      writeFileSync(keyFile, generateArenaKey().privatePem);
      chmodSync(keyFile, 0o600);
      const env = {
        MARINA_ARENA_ENTRANT: "h2oai-marina",
        MARINA_ARENA_AUTOPILOT: "on",
        MARINA_ARENA_KEY_FILE: keyFile,
        // Refused by the SSRF guard: the first run fails inside its work.
        MARINA_ARENA_DATA_URL: "https://127.0.0.1:9/race",
      };
      const store = {} as Parameters<typeof runArenaAutopilot>[0];
      const [first, second] = await Promise.allSettled([
        runArenaAutopilot(store, env),
        runArenaAutopilot(store, env),
      ]);
      expect(first.status).toBe("rejected");
      expect(second).toEqual({ status: "fulfilled", value: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 11. Telnet line buffer and connection caps ──────────────────────────────

describe("telnet bounds", () => {
  it("splits only complete lines and keeps the partial one", () => {
    const state = { buffer: "" };
    expect(splitTelnetChunk(state, "look\r\nno")).toEqual(["look\r"]);
    expect(state.buffer).toBe("no");
    expect(splitTelnetChunk(state, "rth")).toEqual([]);
    expect(splitTelnetChunk(state, "\nsay hi\n")).toEqual(["north", "say hi"]);
    expect(state.buffer).toBe("");
  });

  it("refuses an over-long line, whole or accumulated across packets", () => {
    expect(splitTelnetChunk({ buffer: "" }, "x".repeat(TELNET_MAX_LINE_CHARS + 1))).toBeNull();
    const state = { buffer: "" };
    expect(splitTelnetChunk(state, "x".repeat(TELNET_MAX_LINE_CHARS))).toEqual([]);
    expect(splitTelnetChunk(state, "y")).toBeNull();
    expect(
      splitTelnetChunk({ buffer: "" }, `${"z".repeat(TELNET_MAX_LINE_CHARS + 1)}\n`),
    ).toBeNull();
  });

  it("splits a large paste in one linear pass", () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `say ${i}`);
    const started = performance.now();
    expect(splitTelnetChunk({ buffer: "" }, `${lines.join("\n")}\n`)).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("caps connections per client address and in total", () => {
    const server = new TelnetServer({} as never, 0);
    for (let i = 0; i < TELNET_MAX_CONNECTIONS_PER_IP; i++) {
      expect(server.admit("10.0.0.1")).toBeUndefined();
    }
    expect(server.admit("10.0.0.1")).toContain("Too many");
    server.release("10.0.0.1");
    expect(server.admit("10.0.0.1")).toBeUndefined();
    let n = 1;
    while (server.connectionCount < TELNET_MAX_TOTAL_CONNECTIONS) {
      expect(server.admit(`10.1.${Math.floor(n / 250)}.${n % 250}`)).toBeUndefined();
      n++;
    }
    expect(server.admit("10.9.9.9")).toContain("connection limit");
  });
});
