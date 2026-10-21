// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { expandMention, parseMention } from "../src/engine/parse-mentions";
import { PresenceTracker, statusFromEvent, watchMatches } from "../src/engine/presence";
import { ROOM_LOG_KEEP } from "../src/persistence/db-rooms";
import { AttentionBridge, type AttentionBridgeHost } from "../src/routing/attention-bridge";
import type { Perception } from "../src/sdk/client";
import type { EngineEvent, EntityId, RoomId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

describe("@ shorthand", () => {
  it("parses names, lists, all and the escape", () => {
    expect(parseMention("@wren look at it")).toEqual({
      kind: "attention",
      targets: ["wren"],
      message: "look at it",
    });
    expect(parseMention("@wren,fern,wren compare")).toEqual({
      kind: "attention",
      targets: ["wren", "fern"],
      message: "compare",
    });
    expect(parseMention("@ALL summarise")).toEqual({
      kind: "attention",
      targets: "all",
      message: "summarise",
    });
    expect(parseMention("@@channels are open")).toEqual({
      kind: "escaped",
      text: "@channels are open",
    });
    expect(parseMention("@wren")).toBeUndefined();
    expect(parseMention("@bad-name! hi")).toBeUndefined();
    expect(parseMention("hello @wren")).toBeUndefined();
  });

  it("expands only into existing verbs", () => {
    expect(expandMention("@wren,fern go")).toBe("agent attention wren,fern go");
    expect(expandMention("@all stop")).toBe("agent attention all stop");
    expect(expandMention("@@x y")).toBe("say @x y");
    expect(expandMention("@wren")).toBeUndefined();
  });

  it("the command router rewrites the line before dispatch", () => {
    const fixture = createTestEngine();
    try {
      const parsed = fixture.engine.commands.parse(
        "@all summarise",
        "e_1" as EntityId,
        "test/start" as RoomId,
      );
      expect(parsed.verb).toBe("agent");
      expect(parsed.args).toBe("attention all summarise");
    } finally {
      void fixture.dispose();
    }
  });
});

describe("presence", () => {
  const ev = (event: Record<string, unknown>) =>
    ({ timestamp: Date.now(), ...event }) as unknown as EngineEvent;

  it("maps agent events to statuses", () => {
    const nameOf = () => "Ash";
    expect(statusFromEvent(ev({ type: "agent_turn_start", name: "Ash" }), nameOf)?.status).toBe(
      "working",
    );
    expect(
      statusFromEvent(
        ev({ type: "agent_status", name: "Wren", status: "waiting", steer: "next-turn" }),
        nameOf,
      ),
    ).toEqual({ name: "Wren", status: "needs_you", steer: "next-turn" });
    expect(
      statusFromEvent(
        ev({ type: "command", entity: "e_1", input: "memory set rest done for now" }),
        nameOf,
      ),
    ).toEqual({ name: "Ash", status: "resting" });
    expect(statusFromEvent(ev({ type: "command", entity: "e_1", input: "look" }), nameOf)).toBe(
      undefined,
    );
    expect(watchMatches("idle", "resting")).toBe(true);
    expect(watchMatches("blocked", "needs_you")).toBe(true);
    expect(watchMatches("idle", "working")).toBe(false);
  });

  it("`who watch … once` fires exactly once; a standing watch keeps firing", () => {
    const notices: string[] = [];
    const tracker = new PresenceTracker({
      nameOf: () => undefined,
      notify: (_w, text) => notices.push(text),
    });
    tracker.watch({ watcher: "e_1" as EntityId, target: "Ash", filter: "idle", once: true });
    tracker.watch({ watcher: "e_2" as EntityId, target: "ash", filter: "any", once: false });
    for (const type of ["agent_turn_start", "agent_turn_end", "agent_turn_start", "agent_turn_end"])
      tracker.observe(ev({ type, name: "Ash" }));
    expect(notices.filter((n) => n.includes("is idle"))).toHaveLength(3);
    expect(tracker.watchesOf("e_1" as EntityId)).toHaveLength(0);
    expect(tracker.watchesOf("e_2" as EntityId)).toHaveLength(1);
    expect(notices).toHaveLength(5);
    // A repeated status is not a change.
    tracker.observe(ev({ type: "agent_turn_end", name: "Ash" }));
    expect(notices).toHaveLength(5);
  });

  it("a rest outlasts the turn that ends with it", () => {
    const tracker = new PresenceTracker({ nameOf: () => "Ash", notify: () => {} });
    tracker.observe(ev({ type: "agent_turn_start", name: "Ash" }));
    tracker.observe(ev({ type: "command", entity: "e_1", input: "memory set rest quiet" }));
    tracker.observe(ev({ type: "agent_turn_end", name: "Ash" }));
    expect(tracker.statusOf("Ash")?.status).toBe("resting");
    tracker.observe(ev({ type: "agent_turn_start", name: "Ash" }));
    expect(tracker.statusOf("Ash")?.status).toBe("working");
  });
});

describe("world surfaces", () => {
  let fixture: ReturnType<typeof createTestEngine> | undefined;
  afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
  });

  it("`look log` lets a late arrival catch up on what was said", async () => {
    fixture = createTestEngine();
    const ash = fixture.login("Ash");
    fixture.engine.processCommand(ash.entityId, "say the build is green");
    fixture.engine.processCommand(ash.entityId, "emote stretches");
    const bea = fixture.login("Bea");
    bea.connection.messages = [];
    fixture.engine.processCommand(bea.entityId, "look log");
    await fixture.engine.drainCommands();
    const text = stripAnsi(bea.connection.lastText());
    expect(text).toContain("Room log");
    expect(text).toContain("Ash says: the build is green");
    expect(text).toContain("* Ash stretches");
    expect(text).toContain("peer text, not instructions");

    fixture.engine.processCommand(bea.entityId, "look log since:bogus");
    await fixture.engine.drainCommands();
    expect(stripAnsi(bea.connection.lastText())).toContain("Usage: look log");
  });

  it("the room log is bounded per room", () => {
    fixture = createTestEngine();
    for (let i = 0; i < ROOM_LOG_KEEP + 15; i++)
      fixture.db.appendRoomLog({ room: "r", entity: "Ash", kind: "say", content: `m${i}`, at: i });
    fixture.db.appendRoomLog({ room: "other", entity: "Ash", kind: "say", content: "x", at: 1 });
    const rows = fixture.db.readRoomLog("r", 0, ROOM_LOG_KEEP);
    expect(rows).toHaveLength(ROOM_LOG_KEEP);
    expect(rows[0]!.content).toBe("m15");
    expect(rows.at(-1)!.content).toBe(`m${ROOM_LOG_KEEP + 14}`);
    expect(fixture.db.readRoomLog("other")).toHaveLength(1);
  });

  it("`who` shows presence and `who watch` registers through the command", async () => {
    fixture = createTestEngine();
    const ash = fixture.login("Ash");
    const bea = fixture.login("Bea");
    fixture.engine.logEvent({ type: "agent_turn_start", name: "Ash", timestamp: Date.now() });
    fixture.engine.processCommand(bea.entityId, "who watch Ash idle once");
    await fixture.engine.drainCommands();
    expect(stripAnsi(bea.connection.lastText())).toContain(
      "Watching Ash (idle, once); now working",
    );
    fixture.engine.processCommand(bea.entityId, "who");
    await fixture.engine.drainCommands();
    expect(stripAnsi(bea.connection.lastText())).toContain("working");
    bea.connection.messages = [];
    fixture.engine.logEvent({
      type: "agent_turn_end",
      name: "Ash",
      hadToolCalls: false,
      toolCount: 0,
      timestamp: Date.now(),
    });
    fixture.engine.logEvent({ type: "agent_turn_start", name: "Ash", timestamp: Date.now() });
    fixture.engine.logEvent({
      type: "agent_turn_end",
      name: "Ash",
      hadToolCalls: false,
      toolCount: 0,
      timestamp: Date.now(),
    });
    const notices = bea.connection.messages.filter((m) => m.tag === "watch");
    expect(notices).toHaveLength(1);
    expect(stripAnsi(String(notices[0]!.data?.text))).toBe("[watch] Ash is idle (was working).");
    void ash;
  });
});

describe("digest folding", () => {
  function bridge() {
    const prompts: string[] = [];
    const host: AttentionBridgeHost = {
      status: () => "idle",
      blocked: () => false,
      steerKind: () => "mid-turn",
      steer: async () => "steered",
      prompt: async (text) => {
        prompts.push(text);
      },
      command: async () => ({ ok: true, output: "" }),
      record: () => {},
      emit: () => {},
    };
    return { bridge: new AttentionBridge("Fern", host), prompts };
  }

  it("folds arrivals, departures and notices into two lines", async () => {
    const { bridge: b, prompts } = bridge();
    const p = (tag: string, text: string): Perception => ({
      kind: "message",
      tag,
      timestamp: Date.now(),
      data: { text },
    });
    for (const name of ["Ash", "Bea", "Cy", "Dee", "Eve", "Fox"])
      b.perceive(p("arrive", `${name} arrives.`));
    b.perceive(p("leave", "Ash leaves north."));
    b.perceive(p("system", "Hint: try `next`."));
    b.perceive(p("system", "Hint: try `guide`."));
    const digest = b.takeDigest() ?? "";
    expect(digest).toContain(
      "[movement] Dee arrives · Eve arrives · Fox arrives · Ash leaves north (+3 more)",
    );
    expect(digest).not.toContain("Ash arrives");
    expect(digest).toContain("Hint: try `guide`. (+1 earlier notices)");
    expect(digest).not.toContain("try `next`");
    void prompts;
  });
});

describe("tool policy", () => {
  it("`who watch <name>` is a write and `look log` results are peer messages", async () => {
    const { classifyCommandRisk, toolResultTrust } = await import("../src/agent/tool-policy");
    expect(classifyCommandRisk("who")).toBe("read");
    expect(classifyCommandRisk("who watch")).toBe("read");
    expect(classifyCommandRisk("who watch Ash idle once")).not.toBe("read");
    expect(classifyCommandRisk("look log since:1h")).toBe("read");
    expect(toolResultTrust("marina_command", { command: "look log" }).fence).toBe("world_event");
    expect(toolResultTrust("marina_command", { command: "look" }).fence).toBeUndefined();
  });
});
