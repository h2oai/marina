import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentHandle } from "../src/agent/agent-types";
import { LocalWorkspace } from "../src/coding/local-workspace";
import type { ChannelManager } from "../src/coordination/channel-manager";
import type { CreateCrewOpts, CrewManager } from "../src/coordination/crew-manager";
import { codeCommand } from "../src/engine/commands/code";
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

  it("code handoff <notes> to <agent> transfers the lock + writes a handoff", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Handoff"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code handoff finished the resolver to carol"));

    expect(db.getCodingSession(sessionId)!.writer).toBe("carol");
    const kinds = db.listCodingArtifacts(sessionId, 50).map((a) => a.kind);
    expect(kinds).toContain("handoff");
    expect(kinds).toContain("writer_changed");
    const handoff = db.listCodingArtifacts(sessionId, 50).find((a) => a.kind === "handoff")!;
    // Notes exclude the "to <agent>" tail.
    expect(handoff.content_text).toBe("finished the resolver");
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
    const crewStub = makeCrewManagerStub();
    const baseGet = (id: string) => (id === entity.id ? entity : id === idle.id ? idle : undefined);
    const rt = makeAgentRuntimeStub(baseGet);
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: rt.wrappedGetEntity,
      workspace: new LocalWorkspace(),
      agentRuntime: rt.runtime as never,
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
