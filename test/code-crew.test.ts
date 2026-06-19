import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { LocalWorkspace } from "../src/coding/local-workspace";
import type { ChannelManager } from "../src/coordination/channel-manager";
import { type CreateCrewOpts, CrewError, type CrewManager } from "../src/coordination/crew-manager";
import { codeCommand } from "../src/engine/commands/code";
import { Engine } from "../src/engine/engine";
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

const TEST_DB = "test_code_crew.db";

interface CrewCall {
  opts: CreateCrewOpts;
}
interface DispatchCall {
  id: CrewId;
  message: string;
  sender?: { id: string; name: string };
}

/** Minimal CrewManager stub capturing create/dispatch and provisioning a channel. */
function makeCrewManagerStub(): {
  manager: CrewManager;
  created: CrewCall[];
  dispatched: DispatchCall[];
  setFail: (e: CrewError | null) => void;
} {
  const created: CrewCall[] = [];
  const dispatched: DispatchCall[] = [];
  let nextError: CrewError | null = null;
  const crews = new Map<string, Crew>();
  const manager = {
    create(opts: CreateCrewOpts): Crew {
      if (nextError) {
        const e = nextError;
        nextError = null;
        throw e;
      }
      created.push({ opts });
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
    dispatch(id: CrewId, message: string, sender?: { id: string; name: string }): void {
      dispatched.push({ id, message, sender });
      const crew = crews.get(id);
      if (crew && !crew.channelId) crew.channelId = `crew:${id}`;
    },
  } as unknown as CrewManager;
  return {
    manager,
    created,
    dispatched,
    setFail: (e) => {
      nextError = e;
    },
  };
}

function makeChannelManagerStub(): {
  manager: ChannelManager;
  members: Set<string>;
} {
  const members = new Set<string>();
  const manager = {
    isMember: (channelId: string, entityId: string) => members.has(`${channelId}:${entityId}`),
    addMember: (channelId: string, entityId: string) => {
      members.add(`${channelId}:${entityId}`);
    },
  } as unknown as ChannelManager;
  return { manager, members };
}

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

describe("code crew dispatch (Phase 4a)", () => {
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

  it("dispatches a real crew when members are named", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const bob = makeAgentEntity("agent_bob", "bob");
    const carol = makeAgentEntity("agent_carol", "carol");
    const crewStub = makeCrewManagerStub();
    const chanStub = makeChannelManagerStub();
    const sent: string[] = [];
    const metadata: Record<string, unknown>[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
      crewManager: crewStub.manager,
      channelManager: chanStub.manager,
      findAgentByName: (name) => (name === "bob" ? bob : name === "carol" ? carol : undefined),
    });
    const ctx = testRoomContext(sent, metadata);

    await command.handler(ctx, inputFor(entity, "code start Crew Session"));
    const sessionId = entity.properties.coding_session_id as string;

    await command.handler(ctx, inputFor(entity, "code crew ship the migration with bob,carol"));

    // A real crew was created + dispatched.
    expect(crewStub.created).toHaveLength(1);
    expect(crewStub.created[0]!.opts.members.map((m) => m.agentName).sort()).toEqual([
      "bob",
      "carol",
    ]);
    expect(crewStub.created[0]!.opts.lifetime).toBe("ephemeral");
    expect(crewStub.created[0]!.opts.goal).toBe("ship the migration");
    expect(crewStub.dispatched).toHaveLength(1);
    expect(crewStub.dispatched[0]!.message).toBe("ship the migration");

    // crew_dispatched artifact emitted with the exact metadata shape.
    const kinds = db.listCodingArtifacts(sessionId, 50).map((a) => a.kind);
    expect(kinds).toContain("crew_plan");
    expect(kinds).toContain("crew_dispatched");
    const dispatched = db
      .listCodingArtifacts(sessionId, 50)
      .find((a) => a.kind === "crew_dispatched")!;
    const meta = JSON.parse(dispatched.metadata_json) as Record<string, unknown>;
    expect(meta).toMatchObject({
      crewName: crewStub.created[0]!.opts.name,
      formation: "swarm",
      goal: "ship the migration",
    });
    expect(meta.crewId).toBeTruthy();
    expect(meta.channelId).toBeTruthy();
    expect(meta.members).toEqual([
      { agentName: "bob", role: "specialist" },
      { agentName: "carol", role: "specialist" },
    ]);
    // Proposal trail is linked to the dispatched artifact.
    expect(meta.sourceArtifactId).toBeTruthy();

    // Members + owner joined the lazily-provisioned channel.
    const channelId = meta.channelId as string;
    expect(chanStub.members.has(`${channelId}:${bob.id}`)).toBe(true);
    expect(chanStub.members.has(`${channelId}:${carol.id}`)).toBe(true);
    expect(chanStub.members.has(`${channelId}:${entity.id}`)).toBe(true);

    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Coding crew dispatched:");
  });

  it("degrades to crew_plan when no crew manager is wired", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const bob = makeAgentEntity("agent_bob", "bob");
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
      findAgentByName: (name) => (name === "bob" ? bob : undefined),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Solo Session"));
    const sessionId = entity.properties.coding_session_id as string;

    // Members named but no crewManager — must not throw, must still store plan.
    await command.handler(ctx, inputFor(entity, "code crew ship it with bob"));

    const kinds = db.listCodingArtifacts(sessionId, 50).map((a) => a.kind);
    expect(kinds).toContain("crew_plan");
    expect(kinds).not.toContain("crew_dispatched");
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Coding crew plan stored:");
  });

  it("degrades to crew_plan with no members named", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const crewStub = makeCrewManagerStub();
    const chanStub = makeChannelManagerStub();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
      crewManager: crewStub.manager,
      channelManager: chanStub.manager,
      findAgentByName: () => undefined,
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Plan Session"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code crew implement the migration"));

    expect(crewStub.created).toHaveLength(0);
    const kinds = db.listCodingArtifacts(sessionId, 50).map((a) => a.kind);
    expect(kinds).toContain("crew_plan");
    expect(kinds).not.toContain("crew_dispatched");
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Coding crew plan stored:");
  });

  it("degrades gracefully when crew create throws CrewError", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const bob = makeAgentEntity("agent_bob", "bob");
    const crewStub = makeCrewManagerStub();
    crewStub.setFail(new CrewError("duplicate", "duplicate_name"));
    const chanStub = makeChannelManagerStub();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
      crewManager: crewStub.manager,
      channelManager: chanStub.manager,
      findAgentByName: (name) => (name === "bob" ? bob : undefined),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Err Session"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code crew do it with bob"));

    const kinds = db.listCodingArtifacts(sessionId, 50).map((a) => a.kind);
    expect(kinds).toContain("crew_plan");
    expect(kinds).not.toContain("crew_dispatched");
    expect(stripAnsi(sent.join("\n"))).toContain("Crew dispatch failed");
  });
});

describe("code task + summary-to-pool (Phase 4b)", () => {
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

  it("code task creates a task and a session_task artifact", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const sent: string[] = [];
    const metadata: Record<string, unknown>[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent, metadata);

    await command.handler(ctx, inputFor(entity, "code start Task Session"));
    const sessionId = entity.properties.coding_session_id as string;

    await command.handler(ctx, inputFor(entity, "code task wire up the panel"));

    const artifact = db.listCodingArtifacts(sessionId, 50).find((a) => a.kind === "session_task");
    expect(artifact).toBeDefined();
    const meta = JSON.parse(artifact!.metadata_json) as Record<string, unknown>;
    expect(meta.title).toBe("wire up the panel");
    expect(typeof meta.taskId).toBe("number");

    const task = db.getTask(meta.taskId as number);
    expect(task).toBeDefined();
    expect(task!.title).toBe("wire up the panel");
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Linked task #");
  });

  it("summary deposits into the bound project pool and a personal note", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const workspace = new LocalWorkspace();
    const projectName = basename(workspace.displayRoot());
    // Bind a project (named after the workspace basename) carrying a pool.
    db.createMemoryPool("pool_code_test", "code-test-pool", entity.name);
    db.createProject({
      id: "proj_code_test",
      name: projectName,
      poolId: "pool_code_test",
      createdBy: entity.name,
    });

    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace,
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Summary Session"));

    await command.handler(ctx, inputFor(entity, "code summary finished the resolver wiring"));

    const poolNotes = db.getPoolNotes("pool_code_test", 20);
    expect(poolNotes.some((n) => n.content.includes("finished the resolver wiring"))).toBe(true);

    const personal = db.getNotesByEntity(entity.name, 20);
    expect(personal.some((n) => n.content.includes("finished the resolver wiring"))).toBe(true);
  });

  it("summary degrades silently when no pool is bound", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start No Pool Session"));
    // No matching project/pool — must not throw, still records the artifact.
    await command.handler(ctx, inputFor(entity, "code summary nothing bound"));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Summary stored:");
    // Personal note still written even without a pool.
    const personal = db.getNotesByEntity(entity.name, 20);
    expect(personal.some((n) => n.content.includes("nothing bound"))).toBe(true);
  });
});
