// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentHandle } from "../src/agent/agent-types";
import { LocalWorkspace } from "../src/coding/local-workspace";
import type { ChannelManager } from "../src/coordination/channel-manager";
import type { CreateCrewOpts, CrewManager } from "../src/coordination/crew-manager";
import { codeCommand } from "../src/engine/commands/code";
import { parseHandoffArgs } from "../src/engine/commands/code/session";
import { Engine } from "../src/engine/engine";
import { grant } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Crew,
  type CrewId,
  type Entity,
  type EntityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_code_writelock.db";

function inputFor(entity: Entity, raw: string): CommandInput {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const verb = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return {
    raw: trimmed,
    verb,
    args,
    tokens: args ? args.split(/\s+/) : [],
    entity: entity.id,
    room: roomId("test/start"),
  };
}

function testRoomContext(sent: string[], metadata: Record<string, unknown>[] = []): RoomContext {
  return {
    send: (
      _target: EntityId,
      message: string,
      _tag?: string,
      messageMetadata?: Record<string, unknown>,
    ) => {
      sent.push(stripAnsi(message));
      if (messageMetadata) metadata.push(messageMetadata);
    },
  } as unknown as RoomContext;
}

function makeAgentEntity(id: string, name: string): Entity {
  return {
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: "coding helper",
    inventory: [],
    properties: {},
  };
}

/** CrewManager stub capturing create/dispatch + lazily provisioning a channel. */
function makeCrewManagerStub(): {
  manager: CrewManager;
  created: CreateCrewOpts[];
  dispatched: { id: CrewId; message: string }[];
} {
  const created: CreateCrewOpts[] = [];
  const dispatched: { id: CrewId; message: string }[] = [];
  const crews = new Map<string, Crew>();
  const manager = {
    forAgent(name: string): Crew[] {
      return [...crews.values()].filter((crew) =>
        crew.members.some((member) => member.agentName === name),
      );
    },
    create(opts: CreateCrewOpts): Crew {
      created.push(opts);
      const crew: Crew = {
        id: `crew-${created.length}` as CrewId,
        name: opts.name,
        goal: opts.goal,
        formation: opts.formation ?? "freeform",
        lifetime: opts.lifetime ?? "ephemeral",
        ownerId: opts.owner,
        members: opts.members.map((m) => ({
          agentName: m.agentName,
          role: m.role ?? "specialist",
          joinedAt: Date.now(),
        })),
        state: "assembling",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      crews.set(crew.id, crew);
      return crew;
    },
    dispatch(id: CrewId, message: string): void {
      dispatched.push({ id, message });
      const crew = crews.get(id);
      if (crew && !crew.channelId) crew.channelId = `crew:${id}`;
    },
  } as unknown as CrewManager;
  return { manager, created, dispatched };
}

function makeChannelManagerStub(): ChannelManager {
  const members = new Set<string>();
  return {
    isMember: (channelId: string, entityId: string) => members.has(`${channelId}:${entityId}`),
    addMember: (channelId: string, entityId: string) => {
      members.add(`${channelId}:${entityId}`);
    },
  } as unknown as ChannelManager;
}

/** AgentRuntime stub: spawn returns a handle bound to a fresh agent entity. */
function makeAgentRuntimeStub(getEntity: (id: string) => Entity | undefined) {
  const spawned: { name: string; role?: string; goal?: string }[] = [];
  const entities = new Map<string, Entity>();
  const runtime = {
    get: () => undefined,
    isAvailable: () => true,
    list: () => spawned.map((s) => ({ name: s.name })),
    spawn: async (config: { name: string; role?: string; goal?: string }): Promise<AgentHandle> => {
      spawned.push({ name: config.name, role: config.role, goal: config.goal });
      const entityId = `agent_${config.name}`;
      const agentEntity = makeAgentEntity(entityId, config.name);
      entities.set(entityId, agentEntity);
      const handle = {
        name: config.name,
        getStatus: () => ({ entityId }) as never,
        sendAttention: async () => {},
      } as unknown as AgentHandle;
      return handle;
    },
  };
  // Bridge so bindSpawnedAgentEntity (via getEntity) can find spawned entities.
  const wrappedGetEntity = (id: string) => entities.get(id) ?? getEntity(id);
  return { runtime, spawned, wrappedGetEntity };
}

describe("code write-lock enforcement (Phase 4 B2/B3)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("null writer is unrestricted — solo creator can apply a patch", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const workspace = new LocalWorkspace();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace,
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Solo"));
    const sessionId = entity.properties.coding_session_id as string;
    const session = db.getCodingSession(sessionId)!;
    expect(session.writer).toBeNull();

    // A trivially-empty patch artifact would fail git apply; instead just
    // assert the lock does not refuse the creator (no "holds the write lock").
    await command.handler(ctx, inputFor(entity, "code apply last patch"));
    expect(stripAnsi(sent.join("\n"))).not.toContain("holds the write lock");
  });

  it("set writer refuses a non-writer and allows the writer to apply", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const writerEntity = makeAgentEntity("agent_impl", "impl");
    // Both actors hold code.exec so the write-lock (not the exec gate) is what's tested.
    grant(db, entity.id, "code.exec");
    grant(db, writerEntity.id, "code.exec");
    const workspace = new LocalWorkspace();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) =>
        id === entity.id ? entity : id === writerEntity.id ? writerEntity : undefined,
      workspace,
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Locked"));
    const sessionId = entity.properties.coding_session_id as string;
    // Set the write lock to "impl" via the owner (Alice is the session creator).
    await command.handler(ctx, inputFor(entity, "code writer impl"));
    expect(db.getCodingSession(sessionId)!.writer).toBe("impl");

    // Alice (creator but NOT the writer) is refused on apply.
    sent.length = 0;
    await command.handler(ctx, inputFor(entity, "code apply last patch"));
    expect(stripAnsi(sent.join("\n"))).toContain("impl holds the write lock");

    // The writer (impl) reaches the patch path (no lock refusal). It will fail
    // later for lack of a pending patch, but never on the lock.
    writerEntity.properties.coding_session_id = sessionId;
    sent.length = 0;
    await command.handler(ctx, inputFor(writerEntity, "code apply last patch"));
    expect(stripAnsi(sent.join("\n"))).not.toContain("holds the write lock");
  });

  it("code writer <agent> transfers; non-holder/non-owner is refused", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const bob = makeAgentEntity("agent_bob", "bob");
    const workspace = new LocalWorkspace();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : id === bob.id ? bob : undefined),
      workspace,
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Transfer"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code writer impl"));
    expect(db.getCodingSession(sessionId)!.writer).toBe("impl");

    // bob is neither the holder (impl) nor the creator (Alice) — refused.
    bob.properties.coding_session_id = sessionId;
    sent.length = 0;
    await command.handler(ctx, inputFor(bob, "code writer bob"));
    expect(stripAnsi(sent.join("\n"))).toContain("can reassign the write lock");
    expect(db.getCodingSession(sessionId)!.writer).toBe("impl");

    // The creator (Alice) can reassign, emitting writer_changed.
    sent.length = 0;
    await command.handler(ctx, inputFor(entity, "code writer bob"));
    expect(db.getCodingSession(sessionId)!.writer).toBe("bob");
    const changed = db.listCodingArtifacts(sessionId, 50).find((a) => a.kind === "writer_changed");
    expect(changed).toBeDefined();
    expect(stripAnsi(sent.join("\n"))).toContain("Write lock now held by bob");
    // The writer flows onto the code_context entity property so the UI chip
    // renders without the artifacts overlay open (contract Track B→C).
    expect((entity.properties.code_context as { writer?: string }).writer).toBe("bob");
  });

  it("code writer with no arg shows the current holder / open", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Show"));
    await command.handler(ctx, inputFor(entity, "code writer"));
    expect(stripAnsi(sent.join("\n"))).toContain("Holder: open");

    await command.handler(ctx, inputFor(entity, "code writer impl"));
    sent.length = 0;
    await command.handler(ctx, inputFor(entity, "code writer"));
    expect(stripAnsi(sent.join("\n"))).toContain("Holder: impl");
  });

  /** A session started by Alice where `carol` has acted (so she is a participant). */
  async function handoffSession(title: string) {
    const entity = engine.entities.get(conn.entity!)!;
    const bob = makeAgentEntity("agent_bob", "bob");
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : id === bob.id ? bob : undefined),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent);
    await command.handler(ctx, inputFor(entity, `code start ${title}`));
    const sessionId = entity.properties.coding_session_id as string;
    db.createCodingEvent({ sessionId, actor: "carol", kind: "note_recorded", payload: {} });
    sent.length = 0;
    const run = (who: Entity, raw: string) => command.handler(ctx, inputFor(who, raw));
    const handoffs = () =>
      db.listCodingArtifacts(sessionId, 50).filter((a) => a.kind === "handoff");
    return { entity, bob, sent, sessionId, run, handoffs };
  }

  it("legacy `code handoff <notes> to <participant>` transfers the lock + writes a handoff", async () => {
    const { entity, sessionId, run, handoffs } = await handoffSession("Handoff");
    await run(entity, "code handoff finished the resolver to carol");

    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    const kinds = db.listCodingArtifacts(sessionId, 50).map((a) => a.kind);
    expect(kinds).toContain("writer_changed");
    // Notes exclude the "to <agent>" tail.
    expect(handoffs()[0]!.content_text).toBe("finished the resolver");
  });

  it("explicit `to:<agent>` transfers and keeps every word of the notes", async () => {
    const { entity, sessionId, run, handoffs } = await handoffSession("Explicit");
    await run(entity, "code handoff moved the parser to error handling to:carol");

    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    expect(handoffs()[0]!.content_text).toBe("moved the parser to error handling");
    const meta = JSON.parse(handoffs()[0]!.metadata_json) as { handoffTo?: string };
    expect(meta.handoffTo).toBe("carol");
  });

  it("a `to` inside the notes never moves the lock", async () => {
    const { entity, sent, sessionId, run, handoffs } = await handoffSession("Prose");
    await run(entity, "code writer carol");
    sent.length = 0;
    // Progress notes whose prose contains several "to"s, one in the final pair.
    const notes = "store failures are transferred to error state; next step is to use";
    await run(entity, `code handoff ${notes}`);

    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    expect(handoffs()[0]!.content_text).toBe(notes);
    expect(
      db.listCodingArtifacts(sessionId, 50).filter((a) => a.kind === "writer_changed"),
    ).toHaveLength(1);
    expect(stripAnsi(sent.join("\n"))).toContain("Handoff stored");
  });

  it("a trailing `to <word>` that is not a participant stores the note and keeps the lock", async () => {
    const { entity, sent, sessionId, run, handoffs } = await handoffSession("Trailing");
    await run(entity, "code writer carol");
    sent.length = 0;
    await run(entity, "code handoff state is transferred to error");

    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    expect(handoffs()[0]!.content_text).toBe("state is transferred to error");
    const out = stripAnsi(sent.join("\n"));
    expect(out).toContain('"error" is not a session participant');
    expect(out).toContain("to:<agent>");
  });

  it("an unknown explicit recipient refuses the handoff and keeps the lock", async () => {
    const { entity, sent, sessionId, run, handoffs } = await handoffSession("Unknown");
    await run(entity, "code writer carol");
    sent.length = 0;
    await run(entity, "code handoff ready for review to:LoginFacade");

    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    expect(handoffs()).toHaveLength(0);
    const out = stripAnsi(sent.join("\n"));
    expect(out).toContain('"LoginFacade" is not a participant');
    expect(out).toContain("Write lock unchanged (carol)");
  });

  it("an existing entity that never joined the session is not a valid recipient", async () => {
    const { entity, bob, sent, sessionId, run } = await handoffSession("Stranger");
    expect(bob.name).toBe("bob");
    await run(entity, "code handoff over to you to:bob");
    expect(db.getCodingSession(sessionId)!.writer).toBeNull();
    expect(stripAnsi(sent.join("\n"))).toContain('"bob" is not a participant');
  });

  it("only the holder or the creator can pass a held lock on", async () => {
    const { entity, bob, sent, sessionId, run, handoffs } = await handoffSession("Authority");
    await run(entity, "code writer carol");
    bob.properties.coding_session_id = sessionId;
    // bob acts in the session (so he is a participant), but does not hold the lock.
    await run(bob, "code plan look around");
    sent.length = 0;
    await run(bob, "code handoff taking over to:bob");
    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    expect(handoffs()).toHaveLength(0);
    expect(stripAnsi(sent.join("\n"))).toContain("can pass the write lock on");
  });

  it("the tool spelling `to:<agent> -- <notes>` keeps notes literal", async () => {
    const { entity, sessionId, run, handoffs } = await handoffSession("Tool");
    await run(entity, "code handoff to:carol -- wired the facade to:LoginFacade to use");
    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    expect(handoffs()[0]!.content_text).toBe("wired the facade to:LoginFacade to use");

    await run(entity, "code handoff -- ends with to carol");
    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    expect(handoffs()[0]!.content_text).toBe("ends with to carol");
  });
});

describe("code autonomous crew assembly (Phase 4 B1)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("spawns + dispatches a crew with no members and sets writer=implementer", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    // Grant agent.spawn so the gated spawn path succeeds (unsupervised).
    grant(db, entity.id, "agent.spawn");
    const crewStub = makeCrewManagerStub();
    const baseGet = (id: string) => (id === entity.id ? entity : undefined);
    const rt = makeAgentRuntimeStub(baseGet);
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: rt.wrappedGetEntity,
      workspace: new LocalWorkspace(),
      agentRuntime: rt.runtime as never,
      crewManager: crewStub.manager,
      channelManager: makeChannelManagerStub(),
      findAgentByName: () => undefined,
      listAgents: () => [], // no recruits → all roles spawn
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Auto"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code crew ship the migration"));

    // One crew created with the three default roles.
    expect(crewStub.created).toHaveLength(1);
    const roles = crewStub.created[0]!.members.map((m) => m.role).sort();
    expect(roles).toEqual(["implementer", "reviewer", "tester"]);
    expect(crewStub.dispatched).toHaveLength(1);

    // crew_dispatched artifact with source=spawned on each member.
    const dispatched = db
      .listCodingArtifacts(sessionId, 50)
      .find((a) => a.kind === "crew_dispatched")!;
    const meta = JSON.parse(dispatched.metadata_json) as {
      members: { agentName: string; role: string; source: string }[];
    };
    expect(meta.members).toHaveLength(3);
    expect(meta.members.every((m) => m.source === "spawned")).toBe(true);

    // The implementer holds the write lock.
    const implementer = meta.members.find((m) => m.role === "implementer")!;
    expect(db.getCodingSession(sessionId)!.writer).toBe(implementer.agentName);
    expect(stripAnsi(sent.join("\n"))).toContain(`Write lock: ${implementer.agentName}`);
  });

  it("recruits an idle agent for a role (source=recruited)", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    grant(db, entity.id, "agent.spawn");
    const idle = makeAgentEntity("agent_idle", "idle");
    // Recruitment is role-aware: only coding-appropriate roles are drafted.
    idle.properties.role = "coding-agent";
    const idleHandle = {
      name: "idle",
      getStatus: () => ({ entityId: idle.id, role: "coding-agent", state: "idle" }),
      sendAttention: async () => {},
    } as unknown as AgentHandle;
    const crewStub = makeCrewManagerStub();
    const baseGet = (id: string) => (id === entity.id ? entity : id === idle.id ? idle : undefined);
    const rt = makeAgentRuntimeStub(baseGet);
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: rt.wrappedGetEntity,
      workspace: new LocalWorkspace(),
      agentRuntime: {
        ...rt.runtime,
        get: (name: string) => (name === "idle" ? idleHandle : undefined),
      },
      crewManager: crewStub.manager,
      channelManager: makeChannelManagerStub(),
      findAgentByName: (name) => (name === "idle" ? idle : undefined),
      listAgents: () => [{ name: "idle" }],
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Recruit"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code crew build the feature"));

    const dispatched = db
      .listCodingArtifacts(sessionId, 50)
      .find((a) => a.kind === "crew_dispatched")!;
    const meta = JSON.parse(dispatched.metadata_json) as {
      members: { agentName: string; source: string }[];
    };
    // idle is recruited for implementer (first role); the rest are spawned.
    const recruited = meta.members.filter((m) => m.source === "recruited");
    expect(recruited.map((m) => m.agentName)).toContain("idle");
  });

  it("gate-blocked + no recruits degrades to crew_plan with no throw", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    // No grant: a fresh entity has zero standing → agent.spawn gate blocks.
    const crewStub = makeCrewManagerStub();
    const baseGet = (id: string) => (id === entity.id ? entity : undefined);
    const rt = makeAgentRuntimeStub(baseGet);
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: rt.wrappedGetEntity,
      workspace: new LocalWorkspace(),
      agentRuntime: rt.runtime as never,
      crewManager: crewStub.manager,
      channelManager: makeChannelManagerStub(),
      findAgentByName: () => undefined,
      listAgents: () => [], // no recruits available
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Blocked"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code crew do the thing"));

    // No crew created, no spawn, plan stored, no throw.
    expect(crewStub.created).toHaveLength(0);
    expect(rt.spawned).toHaveLength(0);
    const kinds = db.listCodingArtifacts(sessionId, 50).map((a) => a.kind);
    expect(kinds).toContain("crew_plan");
    expect(kinds).not.toContain("crew_dispatched");
    expect(db.getCodingSession(sessionId)!.writer).toBeNull();
    expect(stripAnsi(sent.join("\n"))).toContain("Could not assemble a crew");
  });
});

describe("parseHandoffArgs", () => {
  const parse = (raw: string) => parseHandoffArgs(raw.split(/\s+/));

  it("never takes a `to` in the middle of the notes", () => {
    expect(parse("errors are transferred to error state")).toEqual({
      text: "errors are transferred to error state",
      errors: [],
    });
  });

  it("offers only a final `to <word>` as a legacy candidate", () => {
    expect(parse("ready for review to alice.")).toEqual({
      text: "ready for review to alice.",
      trailing: "alice",
      textWithoutTrailing: "ready for review",
      errors: [],
    });
  });

  it("reads every modifier spelling of the explicit recipient", () => {
    for (const raw of ["notes to:alice", "notes to=alice", "notes --to alice", "to:alice notes"]) {
      expect(parse(raw)).toEqual({ text: "notes", explicit: "alice", errors: [] });
    }
  });

  it("treats everything after `--` as literal notes", () => {
    expect(parse("-- handed to alice")).toEqual({ text: "handed to alice", errors: [] });
  });

  it("reports a modifier with no value", () => {
    expect(parse("notes to:").errors).toEqual(["to: missing value"]);
  });
});
