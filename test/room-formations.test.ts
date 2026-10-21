// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  type RoomRound,
  roomFormationName,
  roomFormationOf,
  roomFormationTurn,
} from "../src/coordination/room-formations";
import { setRank } from "../src/engine/permissions";
import { AttentionBridge, type AttentionBridgeHost } from "../src/routing/attention-bridge";
import type { Perception } from "../src/sdk/client";
import type { EngineEvent, EntityId, RoomId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi, until } from "./helpers";

const PRESENT = ["Ash", "Bea", "Cy"];

function play(formation: "debate" | "chorus" | "verification", speakers: string[]) {
  let round: RoomRound | undefined;
  return speakers.map((speaker) => {
    const turn = roomFormationTurn(formation, round, speaker, PRESENT);
    round = turn.round;
    return turn;
  });
}

describe("room formation turns", () => {
  it("names canonical formations only", () => {
    expect(roomFormationName("Debate")).toBe("debate");
    expect(roomFormationName("verification")).toBe("verification");
    expect(roomFormationName("pipeline")).toBeUndefined();
    expect(roomFormationName(undefined)).toBeUndefined();
  });

  it("debate: a position, an answer, a judge, then quiet", () => {
    const [a, b, c, d] = play("debate", ["Ash", "Bea", "Cy", "Ash"]);
    expect(a!.next).toEqual(["Bea"]);
    expect(a!.line).toContain("@Bea");
    expect(b!.next).toEqual(["Cy"]);
    expect(b!.line).toContain("judge");
    expect(c!.phase).toBe("closed");
    expect(c!.next).toEqual([]);
    expect(c!.round).toBeUndefined();
    // The next message opens a fresh round.
    expect(d!.phase).toBe("open");
  });

  it("debate: a repeat speaker, or anyone but the judge, adds no line", () => {
    const [, again] = play("debate", ["Ash", "Ash"]);
    expect(again!.line).toBeUndefined();
    const [, , notJudge] = play("debate", ["Ash", "Bea", "Ash"]);
    expect(notJudge!.phase).toBe("quiet");
  });

  it("chorus: everyone posts, then the opener merges", () => {
    const [a, b, c, d] = play("chorus", ["Ash", "Bea", "Cy", "Ash"]);
    expect(a!.next).toEqual(["Bea", "Cy"]);
    expect(b!.next).toEqual(["Cy"]);
    expect(c!.next).toEqual(["Ash"]);
    expect(c!.line).toContain("merge");
    expect(d!.phase).toBe("closed");
  });

  it("verification: a draft, one check per member, then the drafter fixes", () => {
    const [a, b, c, d] = play("verification", ["Bea", "Ash", "Cy", "Bea"]);
    expect(a!.next).toEqual(["Ash", "Cy"]);
    expect(a!.line).toContain("aspect");
    expect(b!.next).toEqual(["Cy"]);
    expect(c!.next).toEqual(["Bea"]);
    expect(d!.phase).toBe("closed");
  });
});

function mediatorLines(messages: Perception[]): Perception[] {
  return messages.filter((m) => m.data?.senderName === "formation-mediator");
}

describe("formations in a room", () => {
  it("a room module's formation posts one owed line per say, in the room log", async () => {
    const fixture = createTestEngine({ room: { formation: "debate" } });
    const events: EngineEvent[] = [];
    fixture.engine.addEventListener((event) => events.push(event));
    try {
      const ash = fixture.login("Ash");
      const bea = fixture.login("Bea");
      const cy = fixture.login("Cy");
      fixture.engine.processCommand(ash.entityId, "say tabs are better than spaces");
      const seen = mediatorLines(bea.connection.messages);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.tag).toBe("say");
      expect(String(seen[0]!.data.message)).toContain("@Bea");
      expect(mediatorLines(cy.connection.messages)).toHaveLength(1);

      const turns = events.filter((event) => event.type === "room_formation_turn");
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ formation: "debate", phase: "open", next: ["Bea"] });
      // Content-free: names and the phase, never what was said.
      expect(JSON.stringify(turns[0])).not.toContain("tabs");

      fixture.engine.processCommand(bea.entityId, "say spaces, for alignment");
      expect(mediatorLines(cy.connection.messages).at(-1)?.data.message).toContain("@Cy");

      fixture.engine.processCommand(cy.entityId, "look log");
      expect(stripAnsi(cy.connection.lastText())).toContain("[formation-mediator]");
    } finally {
      await fixture.dispose();
    }
  });

  it("the line wakes and owes a supervised resident, whose reply goes back to the room", async () => {
    const fixture = createTestEngine({ room: { formation: "debate" } });
    try {
      const ash = fixture.login("Ash");
      const bea = fixture.login("Bea");
      fixture.engine.processCommand(ash.entityId, "say tabs are better than spaces");
      const line = mediatorLines(bea.connection.messages)[0]!;

      const prompts: string[] = [];
      const commands: string[] = [];
      const host: AttentionBridgeHost = {
        status: () => "idle",
        blocked: () => false,
        steerKind: () => "mid-turn",
        steer: async () => "steered",
        prompt: async (text) => {
          prompts.push(text);
        },
        command: async (input) => {
          commands.push(input);
          return { ok: true, output: "" };
        },
        record: () => {},
        emit: () => {},
      };
      const bridge = new AttentionBridge("Bea", host);
      bridge.perceive(line);
      await until(() => prompts.length > 0);
      expect(prompts[0]).toContain("[!]");
      expect(prompts[0]).toContain("@Bea");
      await bridge.replied("spaces, for alignment");
      expect(commands).toEqual(["say spaces, for alignment"]);
    } finally {
      await fixture.dispose();
    }
  });

  it("`build formation` sets, reads and clears it; templates carry it", async () => {
    const fixture = createTestEngine();
    try {
      const builder = fixture.login("Builder");
      const ash = fixture.login("Ash");
      setRank(fixture.engine.entities.get(builder.entityId as EntityId)!, 4);
      const run = (input: string) => {
        fixture.engine.processCommand(builder.entityId, input);
        return stripAnsi(builder.connection.lastText());
      };

      expect(run("build formation")).toContain("has no formation");
      expect(run("build formation pipeline")).toContain("Unknown room formation");
      expect(run("build formation chorus")).toContain("chorus");
      expect(run("build formation test/start")).toContain("chorus");
      expect(fixture.db.getRoomSource("test/start")?.source).toContain('formation: "chorus"');

      fixture.engine.processCommand(ash.entityId, "say part one");
      expect(mediatorLines(builder.connection.messages)).toHaveLength(1);

      run("build template save test/start choir A chorus room");
      expect(fixture.db.getRoomTemplate("choir")?.source).toContain('formation: "chorus"');

      expect(run("build formation off")).toContain("cleared");
      const before = mediatorLines(builder.connection.messages).length;
      fixture.engine.processCommand(ash.entityId, "say part two");
      expect(mediatorLines(builder.connection.messages)).toHaveLength(before);
    } finally {
      await fixture.dispose();
    }
  });

  it("an in-world setting survives a restart, even for a room defined in files", async () => {
    const fixture = createTestEngine();
    try {
      const builder = fixture.login("Builder");
      setRank(fixture.engine.entities.get(builder.entityId as EntityId)!, 4);
      fixture.engine.processCommand(builder.entityId, "build formation verification");
      fixture.engine.saveWorldState();
      // What a restart restores into the room's store, under its file definition.
      const stored = fixture.db.getRoomStoreValue("test/start" as RoomId, "formation");
      expect(stored).toBe("verification");
      const restored = new Map<string, unknown>([["formation", stored]]);
      const store = { get: <T>(key: string) => restored.get(key) as T | undefined };
      expect(roomFormationOf({ module: {}, store })).toBe("verification");
      restored.set("formation", "off");
      expect(roomFormationOf({ module: { formation: "debate" }, store })).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("a room without a formation hears exactly what it always did", async () => {
    const fixture = createTestEngine();
    const events: EngineEvent[] = [];
    fixture.engine.addEventListener((event) => events.push(event));
    try {
      const ash = fixture.login("Ash");
      const bea = fixture.login("Bea");
      const before = bea.connection.messages.length;
      fixture.engine.processCommand(ash.entityId, "say hello");
      expect(bea.connection.messages.length - before).toBe(1);
      expect(mediatorLines(bea.connection.messages)).toHaveLength(0);
      expect(events.some((event) => event.type === "room_formation_turn")).toBe(false);
      expect(fixture.engine.rooms.get("test/start" as RoomId)?.module.formation).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });
});
