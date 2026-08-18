// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { setRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_playground.db";

// ─── Experiment Tests ───────────────────────────────────────────────────────

describe("Experiments", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;
  let conn3: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    conn3 = new MockConnection("c3");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.addConnection(conn3);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    engine.spawnEntity("c3", "Charlie");

    // Give Alice builder rank
    const alice = engine.entities.get(conn1.entity!);
    if (alice) setRank(alice, 2);

    conn1.clear();
    conn2.clear();
    conn3.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should list experiments (empty)", () => {
    engine.processCommand(conn1.entity!, "experiment list");
    expect(conn1.lastText()).toContain("No experiments");
  });

  it("should create an experiment", () => {
    engine.processCommand(conn1.entity!, "experiment create test-exp 2");
    expect(conn1.lastText()).toContain("created");
    expect(conn1.lastText()).toContain("test-exp");
  });

  it("should require rank 2+ to create", () => {
    engine.processCommand(conn2.entity!, "experiment create test-exp 2");
    expect(conn2.lastText()).toContain("Requires coordinator rank");
  });

  it("should join an experiment", () => {
    engine.processCommand(conn1.entity!, "experiment create joinable 2");
    conn2.clear();
    engine.processCommand(conn2.entity!, "experiment join joinable");
    expect(conn2.lastText()).toContain("Joined");
    expect(conn2.lastText()).toContain("2/2");
  });

  it("should not join twice", () => {
    engine.processCommand(conn1.entity!, "experiment create dup 2");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment join dup");
    expect(conn1.lastText()).toContain("already a participant");
  });

  it("should start when enough agents", () => {
    engine.processCommand(conn1.entity!, "experiment create startable 2");
    engine.processCommand(conn2.entity!, "experiment join startable");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment start startable");
    expect(conn1.lastText()).toContain("started");
  });

  it("should not start without enough agents", () => {
    engine.processCommand(conn1.entity!, "experiment create small 3");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment start small");
    expect(conn1.lastText()).toContain("Need 3 agents");
  });

  it("should show status", () => {
    engine.processCommand(conn1.entity!, "experiment create status-exp 2");
    engine.processCommand(conn2.entity!, "experiment join status-exp");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment status status-exp");
    expect(conn1.lastText()).toContain("status-exp");
    expect(conn1.lastText()).toContain("Alice");
    expect(conn1.lastText()).toContain("Bob");
  });

  it("should record and show results", () => {
    engine.processCommand(conn1.entity!, "experiment create results-exp 2");
    engine.processCommand(conn2.entity!, "experiment join results-exp");
    engine.processCommand(conn1.entity!, "experiment start results-exp");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment record results-exp accuracy 95");
    expect(conn1.lastText()).toContain("Recorded");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment results results-exp");
    expect(conn1.lastText()).toContain("accuracy");
    expect(conn1.lastText()).toContain("95");
  });

  it("should complete an experiment", () => {
    engine.processCommand(conn1.entity!, "experiment create complete-exp 2");
    engine.processCommand(conn2.entity!, "experiment join complete-exp");
    engine.processCommand(conn1.entity!, "experiment start complete-exp");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment complete complete-exp");
    expect(conn1.lastText()).toContain("completed");
  });

  it("should not complete a non-active experiment", () => {
    engine.processCommand(conn1.entity!, "experiment create inactive-exp 2");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment complete inactive-exp");
    expect(conn1.lastText()).toContain("not active");
  });

  it("should list experiments with details", () => {
    engine.processCommand(conn1.entity!, "experiment create exp-a 2");
    engine.processCommand(conn1.entity!, "experiment create exp-b 3");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment list");
    expect(conn1.lastText()).toContain("exp-a");
    expect(conn1.lastText()).toContain("exp-b");
  });

  it("should not join a started experiment", () => {
    engine.processCommand(conn1.entity!, "experiment create started-exp 2");
    engine.processCommand(conn2.entity!, "experiment join started-exp");
    engine.processCommand(conn1.entity!, "experiment start started-exp");
    conn3.clear();
    engine.processCommand(conn3.entity!, "experiment join started-exp");
    expect(conn3.lastText()).toContain("already active");
  });

  it("should handle nonexistent experiment", () => {
    engine.processCommand(conn1.entity!, "experiment join nope");
    expect(conn1.lastText()).toContain("not found");
  });

  it("should prevent duplicate experiment names", () => {
    engine.processCommand(conn1.entity!, "experiment create dup-name 2");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment create dup-name 2");
    expect(conn1.lastText()).toContain("already exists");
  });

  it("should show time limit in status", () => {
    engine.processCommand(conn1.entity!, "experiment create timed 2 300");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment status timed");
    expect(conn1.lastText()).toContain("300");
  });

  it("should not record results for non-active experiment", () => {
    engine.processCommand(conn1.entity!, "experiment create pending-exp 2");
    conn1.clear();
    engine.processCommand(conn1.entity!, "experiment record pending-exp metric 5");
    expect(conn1.lastText()).toContain("not active");
  });
});

// ─── Observe Tests ──────────────────────────────────────────────────────────

describe("Observe", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Start Room",
        exits: { north: roomId("test/north") },
      }),
    );
    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({ short: "North", exits: { south: roomId("test/start") } }),
    );

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    conn1.clear();
    conn2.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should require rank 3+ to observe a player", () => {
    engine.processCommand(conn1.entity!, "observe Bob");
    expect(conn1.lastText()).toContain("Requires organizer rank");
  });

  it("should observe a player with rank 3+", () => {
    const alice = engine.entities.get(conn1.entity!);
    if (alice) setRank(alice, 3);
    // Generate some events
    engine.processCommand(conn2.entity!, "look");
    conn1.clear();
    engine.processCommand(conn1.entity!, "observe Bob");
    expect(conn1.lastText()).toContain("Bob");
    expect(conn1.lastText()).toContain("Room");
  });

  it("should show stats with rank 2+", () => {
    const alice = engine.entities.get(conn1.entity!);
    if (alice) setRank(alice, 2);
    // Generate some commands
    engine.processCommand(conn2.entity!, "look");
    engine.processCommand(conn2.entity!, "look");
    conn1.clear();
    engine.processCommand(conn1.entity!, "observe stats");
    expect(conn1.lastText()).toContain("Server Statistics");
    expect(conn1.lastText()).toContain("Total commands");
  });

  it("should require rank 2+ for stats", () => {
    engine.processCommand(conn1.entity!, "observe stats");
    expect(conn1.lastText()).toContain("Requires coordinator rank");
  });

  it("should require rank 7 for log", () => {
    const alice = engine.entities.get(conn1.entity!);
    if (alice) setRank(alice, 3);
    engine.processCommand(conn1.entity!, "observe log Bob");
    expect(conn1.lastText()).toContain("Requires steward rank");
  });

  it("should show command log with rank 7", () => {
    const alice = engine.entities.get(conn1.entity!);
    if (alice) setRank(alice, 7);
    engine.processCommand(conn2.entity!, "look");
    engine.processCommand(conn2.entity!, "say hello");
    conn1.clear();
    engine.processCommand(conn1.entity!, "observe log Bob");
    const text = conn1.lastText();
    expect(text).toContain("Command Log");
    expect(text).toContain("Bob");
  });

  it("should handle nonexistent player", () => {
    const alice = engine.entities.get(conn1.entity!);
    if (alice) setRank(alice, 3);
    engine.processCommand(conn1.entity!, "observe Nobody");
    expect(conn1.lastText()).toContain("not found");
  });

  it("should show usage without args", () => {
    engine.processCommand(conn1.entity!, "observe");
    expect(conn1.lastText()).toContain("Usage:");
  });
});

// ─── Decode Room Tests ──────────────────────────────────────────────────────

describe("Decode Room", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;
  let conn3: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    // Create a decode-like room
    engine.registerRoom(
      roomId("test/decode"),
      makeTestRoom({
        short: "Decode Room",
        onEnter: (ctx, entityId) => {
          const entity = ctx.getEntity(entityId);
          if (entity?.kind !== "agent") return;
          let fragments: string[] | undefined = ctx.store.get("fragments");
          if (!fragments) {
            ctx.store.set("fragments", ["FRAG-A", "FRAG-B", "FRAG-C"]);
            ctx.store.set("puzzle_message", "Test decoded message");
            ctx.store.set("contributions", {});
            ctx.store.set("assignments", {});
            ctx.store.set("puzzle_solved", false);
            fragments = ["FRAG-A", "FRAG-B", "FRAG-C"];
          }
          const assignments: Record<string, string> = ctx.store.get("assignments") ?? {};
          if (!assignments[entity.name]) {
            const used = new Set(Object.values(assignments));
            const avail = fragments.filter((f) => !used.has(f));
            if (avail.length > 0) {
              assignments[entity.name] = avail[0]!;
              ctx.store.set("assignments", assignments);
              ctx.send(entityId, `Fragment: ${avail[0]}`);
            }
          }
        },
        commands: {
          contribute: (ctx, input) => {
            const entity = ctx.getEntity(input.entity);
            if (!entity) return;
            const solved: boolean = ctx.store.get("puzzle_solved") ?? false;
            if (solved) {
              ctx.send(input.entity, "Already solved.");
              return;
            }
            const fragment = input.args.trim().toUpperCase();
            const assignments: Record<string, string> = ctx.store.get("assignments") ?? {};
            if (assignments[entity.name] !== fragment) {
              ctx.send(input.entity, "Wrong fragment.");
              return;
            }
            const contributions: Record<string, string> = ctx.store.get("contributions") ?? {};
            if (contributions[entity.name]) {
              ctx.send(input.entity, "Already contributed.");
              return;
            }
            contributions[entity.name] = fragment;
            ctx.store.set("contributions", contributions);
            const fragments: string[] = ctx.store.get("fragments") ?? [];
            if (Object.keys(contributions).length >= fragments.length) {
              ctx.store.set("puzzle_solved", true);
              const msg: string = ctx.store.get("puzzle_message") ?? "";
              ctx.broadcast(`DECODED: "${msg}"`);
            } else {
              ctx.broadcast(`${entity.name} contributed!`);
            }
          },
          status: (ctx, input) => {
            const solved: boolean = ctx.store.get("puzzle_solved") ?? false;
            const contributions: Record<string, string> = ctx.store.get("contributions") ?? {};
            const fragments: string[] = ctx.store.get("fragments") ?? [];
            ctx.send(
              input.entity,
              `Solved: ${solved}, Progress: ${Object.keys(contributions).length}/${fragments.length}`,
            );
          },
        },
      }),
    );

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    conn3 = new MockConnection("c3");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.addConnection(conn3);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    engine.spawnEntity("c3", "Charlie");
    conn1.clear();
    conn2.clear();
    conn3.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should assign fragments on enter", () => {
    engine.entities.move(conn1.entity!, roomId("test/decode"));
    const ctx1 = engine.buildContext(roomId("test/decode"));
    ctx1?.entities; // trigger context
    // Manually trigger onEnter
    const room = engine.rooms.get(roomId("test/decode"));
    const context = engine.buildContext(roomId("test/decode"))!;
    room!.module.onEnter!(context, conn1.entity!);
    expect(conn1.lastText()).toContain("FRAG-A");
  });

  it("should track contributions", () => {
    engine.entities.move(conn1.entity!, roomId("test/decode"));
    engine.entities.move(conn2.entity!, roomId("test/decode"));
    engine.entities.move(conn3.entity!, roomId("test/decode"));
    const room = engine.rooms.get(roomId("test/decode"))!;
    const ctx = engine.buildContext(roomId("test/decode"))!;

    // Trigger onEnter for all three
    room.module.onEnter!(ctx, conn1.entity!);
    room.module.onEnter!(ctx, conn2.entity!);
    room.module.onEnter!(ctx, conn3.entity!);
    conn1.clear();
    conn2.clear();
    conn3.clear();

    // Check status
    engine.processCommand(conn1.entity!, "status");
    expect(conn1.lastText()).toContain("0/3");
  });

  it("should decode when all fragments contributed", () => {
    engine.entities.move(conn1.entity!, roomId("test/decode"));
    engine.entities.move(conn2.entity!, roomId("test/decode"));
    engine.entities.move(conn3.entity!, roomId("test/decode"));
    const room = engine.rooms.get(roomId("test/decode"))!;
    const ctx = engine.buildContext(roomId("test/decode"))!;

    room.module.onEnter!(ctx, conn1.entity!);
    room.module.onEnter!(ctx, conn2.entity!);
    room.module.onEnter!(ctx, conn3.entity!);
    conn1.clear();
    conn2.clear();
    conn3.clear();

    engine.processCommand(conn1.entity!, "contribute FRAG-A");
    engine.processCommand(conn2.entity!, "contribute FRAG-B");
    engine.processCommand(conn3.entity!, "contribute FRAG-C");

    // One of them should see the decoded message
    const allMessages = [...conn1.allText(), ...conn2.allText(), ...conn3.allText()];
    expect(allMessages.some((m) => m.includes("DECODED"))).toBe(true);
  });

  it("should reject wrong fragment", () => {
    engine.entities.move(conn1.entity!, roomId("test/decode"));
    const room = engine.rooms.get(roomId("test/decode"))!;
    const ctx = engine.buildContext(roomId("test/decode"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    conn1.clear();
    engine.processCommand(conn1.entity!, "contribute WRONG");
    expect(conn1.lastText()).toContain("Wrong fragment");
  });

  it("should reject duplicate contribution", () => {
    engine.entities.move(conn1.entity!, roomId("test/decode"));
    const room = engine.rooms.get(roomId("test/decode"))!;
    const ctx = engine.buildContext(roomId("test/decode"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    conn1.clear();
    engine.processCommand(conn1.entity!, "contribute FRAG-A");
    conn1.clear();
    engine.processCommand(conn1.entity!, "contribute FRAG-A");
    expect(conn1.lastText()).toContain("Already contributed");
  });
});

// ─── Assembly Room Tests ────────────────────────────────────────────────────

describe("Assembly Room", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    engine.registerRoom(
      roomId("test/assembly"),
      makeTestRoom({
        short: "Assembly",
        onEnter: (ctx, entityId) => {
          let bp: { name: string; components: string[] } | undefined = ctx.store.get("blueprint");
          if (!bp) {
            bp = { name: "Test Device", components: ["alpha", "beta", "gamma"] };
            ctx.store.set("blueprint", bp);
            ctx.store.set("assembled", []);
            ctx.store.set("assemblers", {});
          }
          const assembled: string[] = ctx.store.get("assembled") ?? [];
          ctx.send(entityId, `Project: ${bp.name} (${assembled.length}/${bp.components.length})`);
        },
        commands: {
          blueprint: (ctx, input) => {
            const bp: { name: string; components: string[] } | undefined =
              ctx.store.get("blueprint");
            if (!bp) return;
            const assembled: string[] = ctx.store.get("assembled") ?? [];
            const lines = bp.components.map(
              (c) => `${assembled.includes(c) ? "[done]" : "[todo]"} ${c}`,
            );
            ctx.send(input.entity, `${bp.name}:\n${lines.join("\n")}`);
          },
          assemble: (ctx, input) => {
            const entity = ctx.getEntity(input.entity);
            if (!entity) return;
            const component = input.args.trim().toLowerCase();
            const bp: { name: string; components: string[] } | undefined =
              ctx.store.get("blueprint");
            if (!bp) return;
            if (!bp.components.includes(component)) {
              ctx.send(input.entity, "Not needed.");
              return;
            }
            const assembled: string[] = ctx.store.get("assembled") ?? [];
            if (assembled.includes(component)) {
              ctx.send(input.entity, "Already assembled.");
              return;
            }
            assembled.push(component);
            ctx.store.set("assembled", assembled);
            const assemblers: Record<string, string> = ctx.store.get("assemblers") ?? {};
            assemblers[component] = entity.name;
            ctx.store.set("assemblers", assemblers);
            if (assembled.length >= bp.components.length) {
              ctx.broadcast("COMPLETE!");
            } else {
              ctx.broadcast(`${entity.name} assembled ${component}.`);
            }
          },
          status: (ctx, input) => {
            const assembled: string[] = ctx.store.get("assembled") ?? [];
            const bp: { name: string; components: string[] } | undefined =
              ctx.store.get("blueprint");
            ctx.send(input.entity, `Progress: ${assembled.length}/${bp?.components.length ?? 0}`);
          },
        },
      }),
    );

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    conn1.clear();
    conn2.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should show blueprint on enter", () => {
    engine.entities.move(conn1.entity!, roomId("test/assembly"));
    const room = engine.rooms.get(roomId("test/assembly"))!;
    const ctx = engine.buildContext(roomId("test/assembly"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    expect(conn1.lastText()).toContain("Test Device");
  });

  it("should display blueprint details", () => {
    engine.entities.move(conn1.entity!, roomId("test/assembly"));
    const room = engine.rooms.get(roomId("test/assembly"))!;
    const ctx = engine.buildContext(roomId("test/assembly"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    conn1.clear();
    engine.processCommand(conn1.entity!, "blueprint");
    expect(conn1.lastText()).toContain("alpha");
    expect(conn1.lastText()).toContain("beta");
    expect(conn1.lastText()).toContain("gamma");
  });

  it("should assemble components", () => {
    engine.entities.move(conn1.entity!, roomId("test/assembly"));
    const room = engine.rooms.get(roomId("test/assembly"))!;
    const ctx = engine.buildContext(roomId("test/assembly"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    conn1.clear();
    engine.processCommand(conn1.entity!, "assemble alpha");
    expect(conn1.allText().some((t) => t.includes("assembled alpha"))).toBe(true);
  });

  it("should reject invalid components", () => {
    engine.entities.move(conn1.entity!, roomId("test/assembly"));
    const room = engine.rooms.get(roomId("test/assembly"))!;
    const ctx = engine.buildContext(roomId("test/assembly"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    conn1.clear();
    engine.processCommand(conn1.entity!, "assemble invalid");
    expect(conn1.lastText()).toContain("Not needed");
  });

  it("should reject duplicate assembly", () => {
    engine.entities.move(conn1.entity!, roomId("test/assembly"));
    const room = engine.rooms.get(roomId("test/assembly"))!;
    const ctx = engine.buildContext(roomId("test/assembly"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    engine.processCommand(conn1.entity!, "assemble alpha");
    conn1.clear();
    engine.processCommand(conn1.entity!, "assemble alpha");
    expect(conn1.lastText()).toContain("Already assembled");
  });

  it("should complete when all assembled", () => {
    engine.entities.move(conn1.entity!, roomId("test/assembly"));
    engine.entities.move(conn2.entity!, roomId("test/assembly"));
    const room = engine.rooms.get(roomId("test/assembly"))!;
    const ctx = engine.buildContext(roomId("test/assembly"))!;
    room.module.onEnter!(ctx, conn1.entity!);
    conn1.clear();
    conn2.clear();
    engine.processCommand(conn1.entity!, "assemble alpha");
    engine.processCommand(conn2.entity!, "assemble beta");
    engine.processCommand(conn1.entity!, "assemble gamma");
    const all = [...conn1.allText(), ...conn2.allText()];
    expect(all.some((t) => t.includes("COMPLETE"))).toBe(true);
  });
});

// ─── Relay Room Tests ───────────────────────────────────────────────────────

interface RelayEntry {
  agent: string;
  message: string;
  accuracy: number;
}

interface RelayState {
  chain: string[];
  originalMessage: string;
  currentIndex: number;
  relays: RelayEntry[];
  started: boolean;
  finished: boolean;
}

describe("Relay Room", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    engine.registerRoom(
      roomId("test/relay"),
      makeTestRoom({
        short: "Relay",
        commands: {
          join: (ctx, input) => {
            const entity = ctx.getEntity(input.entity);
            if (!entity) return;
            const state = (ctx.store.get("relay_state") as RelayState | undefined) ?? {
              chain: [] as string[],
              originalMessage: "",
              currentIndex: 0,
              relays: [] as RelayEntry[],
              started: false,
              finished: false,
            };
            if (state.chain.includes(entity.name)) {
              ctx.send(input.entity, "Already in chain.");
              return;
            }
            state.chain.push(entity.name);
            ctx.store.set("relay_state", state);
            ctx.broadcast(`${entity.name} joined at position ${state.chain.length}.`);
          },
          start: (ctx, input) => {
            const state = (ctx.store.get("relay_state") as RelayState | undefined) ?? {
              chain: [],
              originalMessage: "",
              currentIndex: 0,
              relays: [],
              started: false,
              finished: false,
            };
            if (state.chain.length < 2) {
              ctx.send(input.entity, "Need 2+ agents.");
              return;
            }
            state.originalMessage = "the quick brown fox";
            state.currentIndex = 0;
            state.relays = [];
            state.started = true;
            state.finished = false;
            ctx.store.set("relay_state", state);
            const first = ctx.findEntity(state.chain[0]!);
            if (first) {
              ctx.send(first.id, `Relay: "${state.originalMessage}"`);
            }
            ctx.broadcast("Relay started!");
          },
          relay: (ctx, input) => {
            const entity = ctx.getEntity(input.entity);
            if (!entity) return;
            const state = ctx.store.get("relay_state") as RelayState | undefined;
            if (!state?.started || state.finished) {
              ctx.send(input.entity, "No active relay.");
              return;
            }
            if (entity.name !== state.chain[state.currentIndex]) {
              ctx.send(input.entity, "Not your turn.");
              return;
            }
            const message = input.args.trim();
            const origWords = state.originalMessage.toLowerCase().split(/\s+/);
            const relayWords = message.toLowerCase().split(/\s+/);
            let matches = 0;
            for (const w of origWords) {
              if (relayWords.includes(w)) matches++;
            }
            const accuracy = Math.round((matches / origWords.length) * 100);
            state.relays.push({ agent: entity.name, message, accuracy });
            state.currentIndex++;
            if (state.currentIndex >= state.chain.length) {
              state.finished = true;
              ctx.store.set("relay_state", state);
              ctx.broadcast(
                `RELAY COMPLETE! Average: ${Math.round(state.relays.reduce((s: number, r: RelayEntry) => s + r.accuracy, 0) / state.relays.length)}%`,
              );
            } else {
              ctx.store.set("relay_state", state);
              const next = ctx.findEntity(state.chain[state.currentIndex]!);
              if (next) ctx.send(next.id, `Relay: "${message}"`);
              ctx.broadcast(`${entity.name} relayed.`);
            }
          },
          status: (ctx, input) => {
            const state = (ctx.store.get("relay_state") as RelayState | undefined) ?? {
              chain: [],
              started: false,
            };
            ctx.send(input.entity, `Chain: ${state.chain.join(" > ")}, Started: ${state.started}`);
          },
          results: (ctx, input) => {
            const state = (ctx.store.get("relay_state") as RelayState | undefined) ?? {
              relays: [],
            };
            if (state.relays.length === 0) {
              ctx.send(input.entity, "No results.");
              return;
            }
            ctx.send(
              input.entity,
              state.relays.map((r: RelayEntry) => `${r.agent}: ${r.accuracy}%`).join(", "),
            );
          },
        },
      }),
    );

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    engine.entities.move(conn1.entity!, roomId("test/relay"));
    engine.entities.move(conn2.entity!, roomId("test/relay"));
    conn1.clear();
    conn2.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should allow joining the chain", () => {
    engine.processCommand(conn1.entity!, "join");
    expect(conn1.allText().some((t) => t.includes("joined"))).toBe(true);
  });

  it("should prevent double joining", () => {
    engine.processCommand(conn1.entity!, "join");
    conn1.clear();
    engine.processCommand(conn1.entity!, "join");
    expect(conn1.lastText()).toContain("Already in chain");
  });

  it("should require 2 agents to start", () => {
    engine.processCommand(conn1.entity!, "join");
    conn1.clear();
    engine.processCommand(conn1.entity!, "start");
    expect(conn1.lastText()).toContain("Need 2+");
  });

  it("should start and complete a relay", () => {
    engine.processCommand(conn1.entity!, "join");
    engine.processCommand(conn2.entity!, "join");
    conn1.clear();
    conn2.clear();
    engine.processCommand(conn1.entity!, "start");
    conn1.clear();
    conn2.clear();
    // Alice relays
    engine.processCommand(conn1.entity!, "relay the quick brown fox");
    conn1.clear();
    conn2.clear();
    // Bob relays
    engine.processCommand(conn2.entity!, "relay the quick brown fox");
    const all = [...conn1.allText(), ...conn2.allText()];
    expect(all.some((t) => t.includes("RELAY COMPLETE"))).toBe(true);
  });

  it("should track accuracy", () => {
    engine.processCommand(conn1.entity!, "join");
    engine.processCommand(conn2.entity!, "join");
    engine.processCommand(conn1.entity!, "start");
    engine.processCommand(conn1.entity!, "relay the quick brown fox");
    engine.processCommand(conn2.entity!, "relay the quick brown fox");
    conn1.clear();
    engine.processCommand(conn1.entity!, "results");
    expect(conn1.lastText()).toContain("100%");
  });

  it("should measure degraded accuracy", () => {
    engine.processCommand(conn1.entity!, "join");
    engine.processCommand(conn2.entity!, "join");
    engine.processCommand(conn1.entity!, "start");
    engine.processCommand(conn1.entity!, "relay the slow red cat");
    engine.processCommand(conn2.entity!, "relay something completely different");
    conn1.clear();
    engine.processCommand(conn1.entity!, "results");
    // "the" matches but others don't — should be less than 100%
    expect(conn1.lastText()).not.toContain("100%");
  });

  it("should show status", () => {
    engine.processCommand(conn1.entity!, "join");
    conn1.clear();
    engine.processCommand(conn1.entity!, "status");
    expect(conn1.lastText()).toContain("Alice");
  });

  it("should reject relay from wrong agent", () => {
    engine.processCommand(conn1.entity!, "join");
    engine.processCommand(conn2.entity!, "join");
    engine.processCommand(conn1.entity!, "start");
    conn2.clear();
    engine.processCommand(conn2.entity!, "relay test");
    expect(conn2.lastText()).toContain("Not your turn");
  });
});
