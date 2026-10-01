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
  getCurrentCodingTarget,
  getCurrentCommand,
  grantCommandPass,
  isRankWaivedForRun,
  resetGateContextForTests,
  runCommandScope,
  setCurrentCodingTarget,
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
      setCurrentCodingTarget("e_x", { sessionId: "outer-session" });
      armGatePass("e_x", { ...PASS, gateIds: [...PASS.gateIds] });
      await runCommandScope("e_x", async () => {
        expect(getCurrentCommand("e_x")).toBeUndefined();
        expect(getCurrentCodingTarget("e_x")).toBeUndefined();
        setCurrentCodingTarget("e_x", { sessionId: "inner-session" });
        expect(isRankWaivedForRun("e_x", 5)).toBe(false);
        setCurrentCommand("e_x", "inner");
        armGatePass("e_x", undefined);
      });
      expect(getCurrentCommand("e_x")).toBe("outer");
      expect(getCurrentCodingTarget("e_x")).toEqual({ sessionId: "outer-session" });
      expect(isRankWaivedForRun("e_x", 5)).toBe(true);
      expect(takeArmedGatePass("e_x", "agent.spawn")).toBeDefined();
    });
    expect(getCurrentCommand("e_x")).toBeUndefined();
    expect(getCurrentCodingTarget("e_x")).toBeUndefined();
  });

  it("interleaved executions of one entity keep their own command and pass", async () => {
    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const first = runCommandScope("e_y", async () => {
      setCurrentCommand("e_y", "A");
      setCurrentCodingTarget("e_y", { sessionId: "a" });
      armGatePass("e_y", { ...PASS, gateIds: [...PASS.gateIds] });
      await holdA;
      return [
        getCurrentCommand("e_y"),
        isRankWaivedForRun("e_y", 5),
        getCurrentCodingTarget("e_y"),
      ];
    });
    const second = runCommandScope("e_y", async () => {
      setCurrentCommand("e_y", "B");
      expect(getCurrentCodingTarget("e_y")).toBeUndefined();
      setCurrentCodingTarget("e_y", { sessionId: "b" });
      armGatePass("e_y", undefined);
      return getCurrentCommand("e_y");
    });
    expect(await second).toBe("B");
    releaseA();
    expect(await first).toEqual(["A", true, { sessionId: "a" }]);
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
    /** Macros owned by `room:<roomId>` (room-scoped). */
    roomMacros?: Record<string, Record<string, string>>;
    systemMacros?: Record<string, string>;
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
  // `echo` records its raw argument text, so tests can assert byte-exact args.
  commands.registerBuiltin({
    name: "echo",
    help: "Echo",
    handler: (_ctx, input) => {
      calls.push(`echo ${input.args}`);
    },
  });
  const macros = opts.macros ?? {};
  const roomMacros = opts.roomMacros ?? {};
  const systemMacros = opts.systemMacros ?? {};
  const tableFor = (author: string): Record<string, string> => {
    if (author === "system") return systemMacros;
    if (author.startsWith("room:")) return roomMacros[author.slice("room:".length)] ?? {};
    return macros;
  };
  const macroManager = {
    getByName: (name: string, author: string) => {
      const table = tableFor(author);
      return Object.hasOwn(table, name)
        ? { id: 1, name, command: table[name]!, authorId: author, createdAt: 0 }
        : undefined;
    },
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

/** No operator overrides: the posture alone decides the macro limits. */
const UNSET_MACRO_ENV = {
  MARINA_MACRO_MAX_DEPTH: undefined,
  MARINA_MACRO_MAX_EXPANSIONS: undefined,
  MARINA_AUTONOMY: undefined,
};

/** `m0 → m1 → … → m{n}` ending in `look`. */
function chain(n: number): Record<string, string> {
  const macros: Record<string, string> = {};
  for (let i = 0; i < n; i++) macros[`m${i}`] = `m${i + 1}`;
  macros[`m${n}`] = "look";
  return macros;
}

/** 11 × 10 = 110 expanded `look`s (plus the 11 `fan` commands themselves). */
const WIDE = { wide: Array(11).fill("fan").join(";"), fan: Array(10).fill("look").join(";") };

describe("macro expansion — bounded and charged", () => {
  it("stops a macro cycle", async () => {
    using _state = scopeProcessState({ trustProfile: "shared", env: UNSET_MACRO_ENV });
    const f = phaseFixture({ macros: { ping: "pong", pong: "look; ping" } });
    await f.phase.execute(f.entity.id, "ping");
    expect(f.messages.join("\n")).toContain('Macro "ping" calls itself');
    expect(f.calls).toEqual(["look"]);
  });

  it(`stops nesting past MAX_MACRO_DEPTH (${MAX_MACRO_DEPTH}) on shared`, async () => {
    using _state = scopeProcessState({ trustProfile: "shared", env: UNSET_MACRO_ENV });
    const f = phaseFixture({ macros: chain(MAX_MACRO_DEPTH + 2) });
    await f.phase.execute(f.entity.id, "m0");
    const text = f.messages.join("\n");
    expect(text).toContain(`Macro nesting deeper than ${MAX_MACRO_DEPTH}`);
    expect(text).toContain("MARINA_MACRO_MAX_DEPTH");
    expect(f.calls).toEqual([]);
  });

  it(`caps one invocation at MAX_MACRO_EXPANSIONS (${MAX_MACRO_EXPANSIONS}) commands on shared`, async () => {
    using _state = scopeProcessState({ trustProfile: "shared", env: UNSET_MACRO_ENV });
    const f = phaseFixture({ macros: WIDE });
    await f.phase.execute(f.entity.id, "wide");
    expect(f.calls.length).toBeLessThan(MAX_MACRO_EXPANSIONS);
    const text = f.messages.join("\n");
    expect(text).toContain(`stopped after ${MAX_MACRO_EXPANSIONS}`);
    expect(text).toContain("MARINA_MACRO_MAX_EXPANSIONS");
  });

  it("lifts depth and expansion caps under the local-ungated profile", async () => {
    using _state = scopeProcessState({ trustProfile: "local", env: UNSET_MACRO_ENV });
    const deep = phaseFixture({ macros: chain(MAX_MACRO_DEPTH * 4) });
    await deep.phase.execute(deep.entity.id, "m0");
    expect(deep.calls).toEqual(["look"]);
    const wide = phaseFixture({ macros: WIDE });
    await wide.phase.execute(wide.entity.id, "wide");
    expect(wide.calls).toHaveLength(110);
    expect(wide.messages.join("\n")).not.toContain("stopped after");
  });

  it("lifts the caps under MARINA_AUTONOMY=open on a shared profile", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { ...UNSET_MACRO_ENV, MARINA_AUTONOMY: "open" },
    });
    const f = phaseFixture({ macros: chain(MAX_MACRO_DEPTH * 2) });
    await f.phase.execute(f.entity.id, "m0");
    expect(f.calls).toEqual(["look"]);
  });

  it("keeps the caps on local when MARINA_AUTONOMY=guarded", async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { ...UNSET_MACRO_ENV, MARINA_AUTONOMY: "guarded" },
    });
    const f = phaseFixture({ macros: chain(MAX_MACRO_DEPTH + 2) });
    await f.phase.execute(f.entity.id, "m0");
    expect(f.calls).toEqual([]);
  });

  it("env overrides the caps in either direction (0 = unlimited)", async () => {
    {
      using _state = scopeProcessState({
        trustProfile: "shared",
        env: { ...UNSET_MACRO_ENV, MARINA_MACRO_MAX_DEPTH: "0", MARINA_MACRO_MAX_EXPANSIONS: "0" },
      });
      const deep = phaseFixture({ macros: chain(MAX_MACRO_DEPTH * 3) });
      await deep.phase.execute(deep.entity.id, "m0");
      expect(deep.calls).toEqual(["look"]);
      const wide = phaseFixture({ macros: WIDE });
      await wide.phase.execute(wide.entity.id, "wide");
      expect(wide.calls).toHaveLength(110);
    }
    {
      using _state = scopeProcessState({
        trustProfile: "local",
        env: { ...UNSET_MACRO_ENV, MARINA_MACRO_MAX_DEPTH: "2", MARINA_MACRO_MAX_EXPANSIONS: "3" },
      });
      const deep = phaseFixture({ macros: chain(3) });
      await deep.phase.execute(deep.entity.id, "m0");
      expect(deep.messages.join("\n")).toContain("Macro nesting deeper than 2");
      expect(deep.calls).toEqual([]);
      const wide = phaseFixture({ macros: { five: "look; look; look; look; look" } });
      await wide.phase.execute(wide.entity.id, "five");
      expect(wide.calls).toEqual(["look", "look", "look"]);
      expect(wide.messages.join("\n")).toContain("stopped after 3 expanded commands");
    }
    {
      // Junk never changes the posture default.
      using _state = scopeProcessState({
        trustProfile: "shared",
        env: { ...UNSET_MACRO_ENV, MARINA_MACRO_MAX_DEPTH: "lots" },
      });
      const f = phaseFixture({ macros: chain(MAX_MACRO_DEPTH + 2) });
      await f.phase.execute(f.entity.id, "m0");
      expect(f.messages.join("\n")).toContain(`Macro nesting deeper than ${MAX_MACRO_DEPTH}`);
    }
  });

  it("refuses a cycle in every posture, even with unlimited caps", async () => {
    for (const [trustProfile, env] of [
      ["local", UNSET_MACRO_ENV],
      ["shared", { ...UNSET_MACRO_ENV, MARINA_AUTONOMY: "open" }],
      [
        "shared",
        { ...UNSET_MACRO_ENV, MARINA_MACRO_MAX_DEPTH: "0", MARINA_MACRO_MAX_EXPANSIONS: "0" },
      ],
    ] as const) {
      using _state = scopeProcessState({ trustProfile, env });
      const f = phaseFixture({ macros: { ping: "look; pong $*", pong: "ping $*" } });
      await f.phase.execute(f.entity.id, "ping x");
      expect(f.messages.join("\n")).toContain('Macro "ping" calls itself');
      expect(f.calls).toEqual(["look"]);
    }
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

describe("macro arguments — the caller's raw text binds into the body", () => {
  const run = async (macros: Record<string, string>, line: string) => {
    const f = phaseFixture({ macros });
    await f.phase.execute(f.entity.id, line);
    return f;
  };

  it("appends trailing arguments to the last command when the body has no placeholder", async () => {
    const f = await run(
      { book: "look; echo connect call tau2 book_reservation" },
      'book {"id":42}',
    );
    expect(f.calls).toEqual(["look", 'echo connect call tau2 book_reservation {"id":42}']);
    // No arguments, no trailing space.
    const bare = await run({ book: "echo call" }, "book");
    expect(bare.calls).toEqual(["echo call"]);
  });

  it("preserves JSON byte-exactly — spacing, quotes, braces and `;` inside it", async () => {
    const json = '{"name": "a  b",\t"q": "x; y", "n": [1, {"$": "$1"}]}';
    const appended = await run({ book: "echo call book" }, `book ${json}`);
    expect(appended.calls).toEqual([`echo call book ${json}`]);
    const placed = await run({ book: "echo call book $* --end" }, `book ${json}`);
    expect(placed.calls).toEqual([`echo call book ${json} --end`]);
  });

  it("substitutes $*, $@ and $1..$9; a missing positional is empty", async () => {
    const f = await run(
      { m: "echo [$*]; echo [$@]; echo $2-$1; echo <$9>; echo $1$3" },
      "m alpha  beta gamma",
    );
    expect(f.calls).toEqual([
      "echo [alpha  beta gamma]",
      "echo [alpha  beta gamma]",
      "echo beta-alpha",
      "echo <>",
      "echo alphagamma",
    ]);
  });

  it("binds $1 in several commands of a multi-command body and appends nothing", async () => {
    const f = await run({ m: "echo one $1; look; echo two $1 $2" }, "m 7 8 9");
    expect(f.calls).toEqual(["echo one 7", "look", "echo two 7 8"]);
  });

  it("$$ is a literal $ and does not count as a placeholder", async () => {
    const f = await run({ price: "echo cost $$5" }, "price usd");
    expect(f.calls).toEqual(["echo cost $5 usd"]);
    const mixed = await run({ price: "echo $$1 is $1" }, "price five");
    expect(mixed.calls).toEqual(["echo $1 is five"]);
  });

  it("passes arguments through a nested macro", async () => {
    const f = await run({ outer: "inner $1", inner: "echo got" }, "outer x y");
    expect(f.calls).toEqual(["echo got x"]);
  });
});

describe("room-scoped macros", () => {
  it("resolve only in their room, ahead of the entity's own and system macros", async () => {
    const roomed = phaseFixture({
      macros: { book: "echo own" },
      systemMacros: { book: "echo system", sys: "echo system-only" },
      roomMacros: { "test/start": { book: "echo room" } },
    });
    await roomed.phase.execute(roomed.entity.id, "book 1");
    await roomed.phase.execute(roomed.entity.id, "sys");
    expect(roomed.calls).toEqual(["echo room 1", "echo system-only"]);

    const elsewhere = phaseFixture({
      macros: { book: "echo own" },
      roomMacros: { "other/room": { book: "echo room" } },
    });
    await elsewhere.phase.execute(elsewhere.entity.id, "book 1");
    expect(elsewhere.calls).toEqual(["echo own 1"]);
  });

  it("never shadow a builtin or a room command", async () => {
    const f = phaseFixture({
      roomMacros: { "test/start": { look: "echo shadow", pray: "echo shadow" } },
      roomCommands: { pray: () => void f.calls.push("pray") },
    });
    await f.phase.execute(f.entity.id, "look");
    await f.phase.execute(f.entity.id, "pray");
    expect(f.calls).toEqual(["look", "pray"]);
  });

  it("`macro create … room:` stores under the room owner key, rank-floored on shared", () => {
    using _state = scopeProcessState({ trustProfile: "shared", env: UNSET_MACRO_ENV });
    const created: Array<[string, string, string]> = [];
    const macros = {
      getByName: () => undefined,
      list: () => [],
      create: (name: string, owner: string, command: string) =>
        created.push([name, owner, command]),
    } as unknown as MacroManager;
    const router = new CommandRouter();
    const cmd = macroCommand(
      macros,
      router,
      () => false,
      (id) => id === "lab/bench",
    );
    const out: string[] = [];
    let rank = 0;
    const ctx = {
      send: (_: string, text: string) => out.push(text),
      getEntity: () => ({ id: "e_1", name: "Mac", room: "test/start", properties: { rank } }),
    } as unknown as RoomContext;
    const exec = (line: string) =>
      cmd.handler(ctx, router.parse(line, "e_1" as EntityId, roomId("test/start")));

    exec('macro create book connect call tau2 book {"a":  1} room:here');
    expect(out.at(-1)).toContain("rank 4");
    expect(created).toEqual([]);

    rank = 4;
    exec('macro create book connect call tau2 book {"a":  1} room:here');
    exec("macro create peek room:lab/bench look $1");
    exec("macro create nowhere look room:missing/room");
    expect(out.at(-1)).toContain('Unknown room "missing/room"');
    exec('macro create mine echo {"k":  "v"}');
    expect(created).toEqual([
      ["book", "room:test/start", 'connect call tau2 book {"a":  1}'],
      ["peek", "room:lab/bench", "look $1"],
      ["mine", "e_1", 'echo {"k":  "v"}'],
    ]);
  });

  it("the room-macro floor is lifted locally", () => {
    using _state = scopeProcessState({ trustProfile: "local", env: UNSET_MACRO_ENV });
    const created: string[] = [];
    const macros = {
      getByName: () => undefined,
      create: (_name: string, owner: string) => created.push(owner),
    } as unknown as MacroManager;
    const router = new CommandRouter();
    const cmd = macroCommand(macros, router);
    const ctx = {
      send: () => {},
      getEntity: () => ({ id: "e_1", name: "Mac", room: "test/start", properties: { rank: 0 } }),
    } as unknown as RoomContext;
    cmd.handler(
      ctx,
      router.parse("macro create hi look room:here", "e_1" as EntityId, roomId("test/start")),
    );
    expect(created).toEqual(["room:test/start"]);
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
        MARINA_ARENA_ENTRANT: "example-entrant",
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
