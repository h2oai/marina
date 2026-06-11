import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentStatus } from "../src/agent/agent-types";
import { conductCommand } from "../src/engine/commands/conduct";
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

const TEST_DB = "test_conduct_resolve.db";

function ent(id: string, name: string): Entity {
  return {
    id: entityId(id),
    name,
    short: name,
    long: name,
    properties: { rank: 5 },
  } as unknown as Entity;
}

function running(name: string, role: string): AgentStatus {
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
  };
}

describe("conduct resolve — assignee → live target", () => {
  let db: MarinaDB;
  let sent: string[];
  const caller = ent("e_alice", "alice");
  let roster: AgentStatus[];

  function seedStanding(id: string, name: string, amount: number): void {
    const taskId = db.createTask({ title: "seed", creatorId: id, creatorName: name });
    db.recordStandingEarned(id, name, taskId, amount);
  }

  function cmd() {
    return conductCommand({
      db,
      getEntity: () => caller,
      listAgents: () => roster,
    });
  }

  function ctx(): RoomContext {
    return { send: (_t: EntityId, m: string) => sent.push(stripAnsi(m)) } as unknown as RoomContext;
  }

  function input(args: string): CommandInput {
    return {
      raw: `conduct ${args}`,
      verb: "conduct",
      args,
      tokens: args.split(/\s+/).filter(Boolean),
      entity: caller.id,
      room: roomId("test/start"),
    };
  }

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    sent = [];
    roster = [running("carol", "scholar"), running("dave", "scholar"), running("eve", "skeptic")];
    // dave has higher standing than carol → dave wins the role race.
    seedStanding("e_carol", "carol", 30);
    seedStanding("e_dave", "dave", 90);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("entity assignee resolves to itself", () => {
    cmd().handler(ctx(), input("resolve bob"));
    expect(sent.at(-1)).toBe("bob");
  });

  it("model assignee resolves to its id", () => {
    cmd().handler(ctx(), input("resolve model:openai/gpt-4o"));
    expect(sent.at(-1)).toBe("openai/gpt-4o");
  });

  it("role assignee resolves to the highest-standing live member", () => {
    cmd().handler(ctx(), input("resolve role:scholar"));
    expect(sent.at(-1)).toBe("dave");
  });

  it("role with no live member is unresolved", () => {
    cmd().handler(ctx(), input("resolve role:ghostwriter"));
    expect(sent.at(-1)).toBe("(unresolved)");
  });
});
