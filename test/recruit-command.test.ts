// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentStatus } from "../src/agent/agent-types";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewManager } from "../src/coordination/crew-manager";
import { recruitCommand } from "../src/engine/commands/recruit";
import { MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Entity,
  type EntityId,
  entityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { cleanupDb, stripAnsi } from "./helpers";

const TEST_DB = "test_recruit_command.db";

/** Minimal Entity stub — recruit only reads name, id, properties.rank. */
function ent(id: string, name: string, rank = 0): Entity {
  return {
    id: entityId(id),
    name,
    short: name,
    long: name,
    properties: { rank },
  } as unknown as Entity;
}

/** A running, recruitable agent status. */
function running(name: string, role = "specialist"): AgentStatus {
  return {
    name,
    entityId: entityId(`e_${name}`),
    state: "autonomous",
    model: "x/y",
    role,
    focus: null,
    goal: null,
    uptime: 1000,
    toolCalls: 0,
    errors: 0,
    errorReason: null,
    lastActivity: Date.now(),
    supports: { text: true },
    contextWindow: 128000,
    effectiveContextWindow: 128000,
    maxOutputTokens: 4096,
    peakInputTokens: 0,
    lastTurnMs: 0,
    avgTurnMs: 0,
    silentTurns: 0,
  };
}

describe("recruit command", () => {
  let db: MarinaDB;
  let channels: ChannelManager;
  let crews: CrewManager;
  let sent: string[];

  // Caller (organizer) and a roster of agents.
  const alice = ent("e_alice", "alice", 2); // rank 2 → may recruit
  const newbie = ent("e_newbie", "newbie", 0); // rank 0 → may not
  const entities: Record<string, Entity> = {
    alice,
    newbie,
    bob: ent("e_bob", "bob"),
    carol: ent("e_carol", "carol"),
    dave: ent("e_dave", "dave"),
  };

  let roster: AgentStatus[];

  function makeDeps() {
    return {
      crews,
      channels,
      getEntity: (id: string) => Object.values(entities).find((e) => e.id === id),
      findAgentByName: (name: string) => entities[name],
      listAgents: () => roster,
      // db omitted → permission falls back to rank (alice=2 passes, newbie=0 fails)
    };
  }

  function ctx(): RoomContext {
    return {
      send: (_t: EntityId, msg: string) => {
        sent.push(stripAnsi(msg));
      },
    } as unknown as RoomContext;
  }

  function input(caller: Entity, args: string): CommandInput {
    const tokens = args.split(/\s+/).filter(Boolean);
    return {
      raw: `recruit ${args}`,
      verb: "recruit",
      args,
      tokens,
      entity: caller.id,
      room: roomId("test/start"),
    };
  }

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    channels = new ChannelManager(db, () => {});
    crews = new CrewManager({ channels });
    sent = [];
    roster = [running("bob"), running("carol", "scholar"), running("dave")];

    // alice owns crew "alpha"; dave is busy in another crew "beta".
    crews.create({
      name: "alpha",
      goal: "ship",
      owner: alice.id,
      members: [{ agentName: "alice" }],
    });
    crews.create({
      name: "beta",
      goal: "other",
      owner: alice.id,
      members: [{ agentName: "dave" }],
    });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("lists idle agents (running, not in a live crew), excluding the caller and the busy", () => {
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(alice, "available"));
    const out = sent.join("\n");
    expect(out).toContain("bob");
    expect(out).toContain("carol");
    expect(out).not.toContain("dave"); // busy in crew beta
  });

  it("filters discovery by role=", () => {
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(alice, "available role=scholar"));
    const out = sent.join("\n");
    expect(out).toContain("carol");
    expect(out).not.toContain("bob");
  });

  it("capability-matches and recruits the strongest available fit", () => {
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(alice, "best into alpha for scholar research count=1"));
    expect(sent.join("\n")).toContain("carol");
    expect(crews.getByName("alpha")!.members.some((m) => m.agentName === "carol")).toBe(true);
    expect(crews.getByName("alpha")!.members.some((m) => m.agentName === "dave")).toBe(false);
  });

  it("refuses callers below organizer rank/standing", () => {
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(newbie, "bob into alpha"));
    expect(sent.join("\n")).toContain("organizer capability");
    expect(crews.getByName("alpha")!.members.some((m) => m.agentName === "bob")).toBe(false);
  });

  it("recruits an idle agent into a crew the caller owns", () => {
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(alice, "bob into alpha"));
    expect(sent.join("\n")).toContain("Recruited bob");
    expect(crews.getByName("alpha")!.members.some((m) => m.agentName === "bob")).toBe(true);
  });

  it("leaves busy agents alone — never pulled off a live crew", () => {
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(alice, "dave into alpha"));
    const out = sent.join("\n");
    expect(out).toContain('busy with crew "beta"');
    expect(crews.getByName("alpha")!.members.some((m) => m.agentName === "dave")).toBe(false);
  });

  it("skips offline/unknown and non-running names with reasons", () => {
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(alice, "ghost into alpha"));
    expect(sent.join("\n")).toContain("offline/unknown");
  });

  it("non-owner below rank 4 cannot recruit into a crew", () => {
    // carol (rank 0 here via default entity) — but make a rank-2 non-owner.
    const mallory = ent("e_mallory", "mallory", 2);
    entities.mallory = mallory;
    const cmd = recruitCommand(makeDeps());
    cmd.handler(ctx(), input(mallory, "bob into alpha"));
    expect(sent.join("\n")).toContain("Only the owner or rank 4+");
  });
});
