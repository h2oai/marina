// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentHandle } from "../src/agent/agent-types";
import { CodeSessionDriver } from "../src/coding/code-session-driver";
import { LocalWorkspace, type WorkspaceRuntime } from "../src/coding/local-workspace";
import type { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { sanitizeEntityName } from "../src/engine/entity-name";
import { grant } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Entity,
  type EntityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { cleanupDb, stripAnsi } from "./helpers";

const TEST_DB = "test_code_session_agent.db";

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

function testRoomContext(sent: string[]): RoomContext {
  return {
    send: (_target: EntityId, message: string) => {
      sent.push(stripAnsi(message));
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

/** Live-agent handle stub with a role in status and reconfigure/task-mode spies. */
function fakeHandle(
  name: string,
  entityId: string | null,
  role = "coder",
): {
  handle: AgentHandle;
  attention: string[];
  calls: { reconfigure: number };
  codingTasks: (string | null)[];
  emit: (event: AgentEvent) => void;
} {
  const attention: string[] = [];
  const calls = { reconfigure: 0 };
  const codingTasks: (string | null)[] = [];
  const subscribers: Array<(event: AgentEvent) => void> = [];
  const handle = {
    name,
    getStatus: () => ({ entityId, role }) as never,
    sendAttention: async (message: string) => {
      attention.push(message);
    },
    setActiveCodingTask: (task: string | null) => {
      codingTasks.push(task);
    },
    reconfigure: async () => {
      calls.reconfigure += 1;
    },
    subscribe: (handler: (event: AgentEvent) => void) => {
      subscribers.push(handler);
      return () => {};
    },
  } as unknown as AgentHandle;
  const emit = (event: AgentEvent) => {
    for (const subscriber of subscribers) subscriber(event);
  };
  return { handle, attention, calls, codingTasks, emit };
}

interface EditCall {
  path: string;
  oldText: string;
  newText: string;
  opts?: { replaceAll?: boolean };
}

/** LocalWorkspace extended with the editFile/writeFile mutation surface, spied. */
function makeEditableWorkspace(): {
  workspace: WorkspaceRuntime;
  edits: EditCall[];
  writes: { path: string; content: string }[];
} {
  const edits: EditCall[] = [];
  const writes: { path: string; content: string }[] = [];
  const workspace = Object.assign(new LocalWorkspace(), {
    editFile: async (
      path: string,
      oldText: string,
      newText: string,
      opts?: { replaceAll?: boolean },
    ) => {
      edits.push({ path, oldText, newText, opts });
      return { ok: true, output: `edited ${path}`, occurrences: opts?.replaceAll ? 2 : 1 };
    },
    writeFile: async (path: string, content: string) => {
      writes.push({ path, content });
      return { ok: true, output: `wrote ${path}`, created: true };
    },
  }) as WorkspaceRuntime;
  return { workspace, edits, writes };
}

/** Registry stub that always hands back the given workspace instance. */
function makeRegistryStub(workspace: WorkspaceRuntime): WorkspaceRegistry {
  const root = workspace.displayRoot();
  return {
    roots: [root],
    defaultRoot: root,
    usesCwdFallback: false,
    defaultWorkspace: () => workspace,
    workspaceForRoot: () => workspace,
    resolveRoot: () => ({ root, label: "test" }),
    listChoices: () => [{ root, label: "test" }],
  } as unknown as WorkspaceRegistry;
}

describe("code single-agent binding (writer lock + role-aware recruit)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("sets session.writer to the recruited bound agent so it can apply", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const coder = makeAgentEntity("agent_coder", "Coder");
    db.saveEntity(coder);
    const { handle } = fakeHandle("Coder", "agent_coder");
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : id === "agent_coder" ? coder : undefined),
      workspace: new LocalWorkspace(),
      agentRuntime: {
        get: (n: string) => (n === "Coder" ? handle : undefined),
        isAvailable: () => true,
        list: () => [{ name: "Coder" }],
      },
      listAgents: () => [{ name: "Coder" }],
      findAgentByName: (n: string) => (n === "Coder" ? coder : undefined),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(alice, "code do fix the tokenizer"));

    const sid = alice.properties.coding_session_id as string;
    const session = db.getCodingSession(sid)!;
    expect(session.agent).toBe("Coder");
    // The write lock follows the binding (mirrors crew dispatch) so the bound
    // agent's `code apply` passes the writer/creator guard.
    expect(session.writer).toBe("Coder");
    const writerEvent = db
      .listCodingEvents(sid, 50)
      .find((event) => event.kind === "writer_changed");
    expect(writerEvent).toBeDefined();
    expect(JSON.parse(writerEvent!.payload_json)).toMatchObject({
      writer: "Coder",
      reason: "agent_bind",
    });
  });

  it("skips non-coding roles when recruiting and falls through to spawn", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    grant(db, alice.id, "agent.spawn");
    const oracle = makeAgentEntity("agent_oracle", "Oracle");
    db.saveEntity(oracle);
    const { handle: oracleHandle } = fakeHandle("Oracle", "agent_oracle", "market-oracle");
    const spawned: { name: string; role?: string }[] = [];
    const spawnedEntities = new Map<string, Entity>();
    const spawnedHandles = new Map<string, AgentHandle>();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) =>
        id === "u_alice" ? alice : id === "agent_oracle" ? oracle : spawnedEntities.get(id),
      workspace: new LocalWorkspace(),
      agentRuntime: {
        get: (n: string) => (n === "Oracle" ? oracleHandle : spawnedHandles.get(n)),
        isAvailable: () => true,
        list: () => [{ name: "Oracle" }],
        spawn: async (config: { name: string; role?: string }) => {
          spawned.push({ name: config.name, role: config.role });
          const entityId = `agent_${config.name}`;
          spawnedEntities.set(entityId, makeAgentEntity(entityId, config.name));
          const { handle } = fakeHandle(config.name, entityId, config.role);
          spawnedHandles.set(config.name, handle);
          return handle;
        },
      },
      listAgents: () => [{ name: "Oracle" }],
      findAgentByName: (n: string) => (n === "Oracle" ? oracle : undefined),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(alice, "code do add a resolver"));

    // The market-oracle is never drafted; a fresh coder is spawned instead.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.role).toBe("coding-agent");
    const sid = alice.properties.coding_session_id as string;
    const session = db.getCodingSession(sid)!;
    expect(session.agent).toBe(spawned[0]!.name);
    expect(session.writer).toBe(spawned[0]!.name);
  });

  it("code stop aborts the bound agent's run and leaves the session intact", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const coder = makeAgentEntity("agent_coder", "Coder");
    db.saveEntity(coder);
    const { handle, attention, calls } = fakeHandle("Coder", "agent_coder");
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : id === "agent_coder" ? coder : undefined),
      workspace: new LocalWorkspace(),
      agentRuntime: {
        get: (n: string) => (n === "Coder" ? handle : undefined),
        isAvailable: () => true,
        list: () => [{ name: "Coder" }],
      },
      listAgents: () => [{ name: "Coder" }],
      findAgentByName: (n: string) => (n === "Coder" ? coder : undefined),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(alice, "code do refactor the parser"));
    const sid = alice.properties.coding_session_id as string;
    const artifactsBefore = db.listCodingArtifacts(sid, 50).length;

    sent.length = 0;
    await command.handler(ctx, inputFor(alice, "code stop"));

    // The abort seam (reconfigure) fired once; the human is told what stopped.
    expect(calls.reconfigure).toBe(1);
    expect(attention.at(-1)).toContain("stopped your current run");
    expect(sent.join("\n")).toContain("Stopped Coder");
    // Session, binding, and artifacts stay intact.
    const session = db.getCodingSession(sid)!;
    expect(session.agent).toBe("Coder");
    expect(session.status).toBe("active");
    expect(db.listCodingArtifacts(sid, 50).length).toBe(artifactsBefore);
    const stopEvent = db
      .listCodingEvents(sid, 50)
      .find((event) => event.kind === "code_agent_stopped");
    expect(stopEvent).toBeDefined();

    // Alias: `code cancel` runs the same path.
    await command.handler(ctx, inputFor(alice, "code cancel"));
    expect(calls.reconfigure).toBe(2);
  });

  it("code stop without a bound agent explains there is nothing to stop", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : undefined),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(alice, "code start Idle"));
    sent.length = 0;
    await command.handler(ctx, inputFor(alice, "code stop"));
    expect(sent.join("\n")).toContain("nothing to stop");
  });
});

describe("code edit / code write (guarded direct file mutations)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  function makeCommand(alice: Entity, extras: Entity[] = []) {
    const { workspace, edits, writes } = makeEditableWorkspace();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === alice.id ? alice : extras.find((extra) => extra.id === id)),
      workspace,
      workspaceRegistry: makeRegistryStub(workspace),
    });
    return { command, ctx: testRoomContext(sent), sent, edits, writes };
  }

  it("code edit applies a conflict-marker replacement and records an artifact", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    grant(db, alice.id, "code.exec");
    const { command, ctx, sent, edits } = makeCommand(alice);

    await command.handler(ctx, inputFor(alice, "code start Edits"));
    const sid = alice.properties.coding_session_id as string;
    await command.handler(
      ctx,
      inputFor(alice, "code edit src/a.ts\n<<<<<<< OLD\nfoo\n=======\nbar\n>>>>>>> NEW"),
    );

    expect(edits).toEqual([
      { path: "src/a.ts", oldText: "foo", newText: "bar", opts: { replaceAll: false } },
    ]);
    expect(sent.join("\n")).toContain("Edited src/a.ts");
    const artifact = db.listCodingArtifacts(sid, 50).find((a) => a.kind === "file_edit")!;
    expect(artifact.status).toBe("applied");
    expect(artifact.content_text).toContain("foo");
    expect(artifact.content_text).toContain("bar");
    const event = db.listCodingEvents(sid, 50).find((e) => e.kind === "file_edited");
    expect(event).toBeDefined();
  });

  it("trailing ' all' after the path requests replaceAll", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    grant(db, alice.id, "code.exec");
    const { command, ctx, edits } = makeCommand(alice);

    await command.handler(ctx, inputFor(alice, "code start Edits"));
    await command.handler(
      ctx,
      inputFor(alice, "code edit src/a.ts all\n<<<<<<< OLD\nfoo\n=======\nbar\n>>>>>>> NEW"),
    );

    expect(edits[0]!.opts).toEqual({ replaceAll: true });
    expect(edits[0]!.path).toBe("src/a.ts");
  });

  it("malformed edit input yields usage and never touches the workspace", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    grant(db, alice.id, "code.exec");
    const { command, ctx, sent, edits } = makeCommand(alice);

    await command.handler(ctx, inputFor(alice, "code start Edits"));
    await command.handler(ctx, inputFor(alice, "code edit src/a.ts"));
    expect(sent.join("\n")).toContain("Usage: code edit");
    expect(edits).toHaveLength(0);
  });

  it("code write creates a file, records file_write, and emits an event", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    grant(db, alice.id, "code.exec");
    const { command, ctx, sent, writes } = makeCommand(alice);

    await command.handler(ctx, inputFor(alice, "code start Writes"));
    const sid = alice.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(alice, "code write notes.txt\nhello\nworld"));

    expect(writes).toEqual([{ path: "notes.txt", content: "hello\nworld" }]);
    expect(sent.join("\n")).toContain("Created notes.txt");
    const artifact = db.listCodingArtifacts(sid, 50).find((a) => a.kind === "file_write")!;
    expect(artifact.status).toBe("applied");
    expect(artifact.content_text).toBe("hello\nworld");
    const event = db.listCodingEvents(sid, 50).find((e) => e.kind === "file_written");
    expect(event).toBeDefined();
  });

  it("enforces the same writer/creator guard as apply", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const bob = makeAgentEntity("agent_bob", "bob");
    db.saveEntity(bob);
    grant(db, alice.id, "code.exec");
    grant(db, bob.id, "code.exec");
    const { command, ctx, sent, edits, writes } = makeCommand(alice, [bob]);

    await command.handler(ctx, inputFor(alice, "code start Guarded"));
    const sid = alice.properties.coding_session_id as string;

    // No writer set: a non-creator is refused.
    bob.properties.coding_session_id = sid;
    sent.length = 0;
    await command.handler(
      ctx,
      inputFor(bob, "code edit src/a.ts\n<<<<<<< OLD\nfoo\n=======\nbar\n>>>>>>> NEW"),
    );
    expect(sent.join("\n")).toContain("Only the session creator can edit files");
    await command.handler(ctx, inputFor(bob, "code write notes.txt\nhi"));
    expect(sent.join("\n")).toContain("Only the session creator can write files");

    // Writer set to someone else: even the creator is refused.
    await command.handler(ctx, inputFor(alice, "code writer impl"));
    sent.length = 0;
    await command.handler(
      ctx,
      inputFor(alice, "code edit src/a.ts\n<<<<<<< OLD\nfoo\n=======\nbar\n>>>>>>> NEW"),
    );
    expect(sent.join("\n")).toContain("impl holds the write lock");
    expect(edits).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
});

describe("assignAgent workspace-convention ingestion", () => {
  let db: MarinaDB;
  let dir: string;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    dir = mkdtempSync(join(tmpdir(), "marina-conventions-"));
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends CLAUDE.md/.marina.md under Project conventions, bounded to ~4KB", async () => {
    // CLAUDE.md longer than the 4KB cap — the tail marker must not be included.
    writeFileSync(join(dir, "CLAUDE.md"), `Use two-space indent.\n${"x".repeat(5000)}TAIL_MARKER`);
    writeFileSync(join(dir, ".marina.md"), "Prefer bun test for verification.");
    // No AGENTS.md on purpose — missing files are skipped.
    const session = db.createCodingSession({
      id: "code_conv",
      title: "Conventions",
      workspaceRoot: dir,
      createdBy: "Alice",
    });
    const { handle, attention } = fakeHandle("Coder", "agent_coder");
    const driver = new CodeSessionDriver({
      db,
      agentRuntime: { get: (n: string) => (n === "Coder" ? handle : undefined) },
    });

    await driver.assignAgent({
      actor: "Alice",
      agentName: "Coder",
      profile: "marina",
      prompt: "add a health endpoint",
      session,
    });

    const prompt = attention.join("\n");
    expect(prompt).toContain("Project conventions:");
    expect(prompt).toContain("--- CLAUDE.md ---");
    expect(prompt).toContain("Use two-space indent.");
    expect(prompt).toContain("--- .marina.md ---");
    expect(prompt).toContain("Prefer bun test for verification.");
    expect(prompt).not.toContain("--- AGENTS.md ---");
    expect(prompt).not.toContain("TAIL_MARKER");
  });

  it("omits the section entirely when no convention files exist", async () => {
    const session = db.createCodingSession({
      id: "code_noconv",
      title: "None",
      workspaceRoot: dir,
      createdBy: "Alice",
    });
    const { handle, attention } = fakeHandle("Coder", "agent_coder");
    const driver = new CodeSessionDriver({
      db,
      agentRuntime: { get: (n: string) => (n === "Coder" ? handle : undefined) },
    });

    await driver.assignAgent({
      actor: "Alice",
      agentName: "Coder",
      profile: "marina",
      prompt: "add a health endpoint",
      session,
    });

    expect(attention.join("\n")).not.toContain("Project conventions:");
  });
});

describe("coding task mode (set on assign, cleared on stop/completion)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  /** Human dispatcher + one running coder the runtime can recruit and bind. */
  function makeBoundSetup(notifications?: string[]) {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const coder = makeAgentEntity("agent_coder", "Coder");
    db.saveEntity(coder);
    const fake = fakeHandle("Coder", "agent_coder");
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : id === "agent_coder" ? coder : undefined),
      workspace: new LocalWorkspace(),
      agentRuntime: {
        get: (n: string) => (n === "Coder" ? fake.handle : undefined),
        isAvailable: () => true,
        list: () => [{ name: "Coder" }],
      },
      listAgents: () => [{ name: "Coder" }],
      findAgentByName: (n: string) => (n === "Coder" ? coder : undefined),
      notify: notifications
        ? (_id: string, message: string) => {
            notifications.push(stripAnsi(message));
          }
        : undefined,
    });
    return { alice, coder, fake, sent, command, ctx: testRoomContext(sent) };
  }

  it("code do persists coding_task on the bound entity and flips adapter task mode", async () => {
    const { coder, fake, command, ctx, alice } = makeBoundSetup();

    await command.handler(ctx, inputFor(alice, "code do fix the tokenizer"));

    expect(coder.properties.coding_task).toBe("fix the tokenizer");
    expect(fake.codingTasks).toEqual(["fix the tokenizer"]);
    // Persisted, not just in-memory — a reloaded entity carries the task.
    const reloaded = db.loadEntity("agent_coder" as EntityId);
    expect(reloaded?.properties.coding_task).toBe("fix the tokenizer");
  });

  it("code stop clears coding_task and drops adapter task mode", async () => {
    const { coder, fake, command, ctx, alice } = makeBoundSetup();

    await command.handler(ctx, inputFor(alice, "code do refactor the parser"));
    expect(coder.properties.coding_task).toBe("refactor the parser");

    await command.handler(ctx, inputFor(alice, "code stop"));

    expect(coder.properties.coding_task).toBeUndefined();
    expect(fake.codingTasks.at(-1)).toBeNull();
    expect(db.loadEntity("agent_coder" as EntityId)?.properties.coding_task).toBeUndefined();
  });

  it("the summary-artifact completion heuristic clears the task without an explicit stop", async () => {
    const notifications: string[] = [];
    const { coder, fake, command, ctx, alice } = makeBoundSetup(notifications);

    await command.handler(ctx, inputFor(alice, "code do add a health endpoint"));
    expect(coder.properties.coding_task).toBe("add a health endpoint");

    // Mid-task actions must NOT clear the assignment.
    fake.emit({ type: "tool_call", toolName: "marina_code", args: { action: "read" } });
    expect(coder.properties.coding_task).toBe("add a health endpoint");

    // Recording a durable summary marks the work completed → task mode ends.
    fake.emit({
      type: "tool_call",
      toolName: "marina_code",
      args: { action: "summary", notes: "done" },
    });
    expect(coder.properties.coding_task).toBeUndefined();
    expect(fake.codingTasks.at(-1)).toBeNull();
  });
});

describe("structured completion signal (machine-readable lifecycle metadata)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  interface Notification {
    entityId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }
  interface SentWithMeta {
    message: string;
    metadata?: Record<string, unknown>;
  }

  /** Extract the `code` lifecycle payload from a notify/send metadata bag. */
  function codeMeta(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
    return metadata?.code as Record<string, unknown> | undefined;
  }

  /** Bound setup whose notify AND ctx.send capture full metadata. */
  function makeStructuredSetup() {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const coder = makeAgentEntity("agent_coder", "Coder");
    db.saveEntity(coder);
    const fake = fakeHandle("Coder", "agent_coder");
    const notifications: Notification[] = [];
    const sent: SentWithMeta[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : id === "agent_coder" ? coder : undefined),
      workspace: new LocalWorkspace(),
      agentRuntime: {
        get: (n: string) => (n === "Coder" ? fake.handle : undefined),
        isAvailable: () => true,
        list: () => [{ name: "Coder" }],
      },
      listAgents: () => [{ name: "Coder" }],
      findAgentByName: (n: string) => (n === "Coder" ? coder : undefined),
      notify: (entityId: string, message: string, metadata?: Record<string, unknown>) => {
        notifications.push({ entityId, message: stripAnsi(message), metadata });
      },
    });
    const ctx = {
      send: (
        _target: EntityId,
        message: string,
        _tag?: string,
        metadata?: Record<string, unknown>,
      ) => {
        sent.push({ message: stripAnsi(message), metadata });
      },
    } as unknown as RoomContext;
    return { alice, coder, fake, notifications, sent, command, ctx };
  }

  it("the summary completion notification carries terminal machine-readable metadata", async () => {
    const { alice, fake, notifications, command, ctx } = makeStructuredSetup();

    await command.handler(ctx, inputFor(alice, "code do add a health endpoint"));
    const sid = alice.properties.coding_session_id as string;

    fake.emit({
      type: "tool_call",
      toolName: "marina_code",
      args: { action: "summary", text: "Added /health in server.ts; bun test passes." },
    });

    const completed = notifications
      .map((n) => codeMeta(n.metadata))
      .find((code) => code?.phase === "completed");
    expect(completed).toBeDefined();
    expect(completed!.event).toBe("code_lifecycle");
    expect(completed!.sessionId).toBe(sid);
    expect(completed!.status).toBe("complete");
    const payload = completed!.metadata as Record<string, unknown>;
    expect(payload.terminal).toBe(true);
    expect(payload.summary).toBe("Added /health in server.ts; bun test passes.");
    expect(payload.agent).toBe("Coder");
  });

  it("agent death mid-task emits a terminal failed notification and clears the task", async () => {
    const { alice, coder, fake, notifications, command, ctx } = makeStructuredSetup();

    await command.handler(ctx, inputFor(alice, "code do refactor the parser"));
    const sid = alice.properties.coding_session_id as string;
    expect(coder.properties.coding_task).toBe("refactor the parser");

    fake.emit({
      type: "status_change",
      status: { state: "stopped" } as never,
    });

    const failed = notifications
      .map((n) => codeMeta(n.metadata))
      .find((code) => code?.phase === "failed");
    expect(failed).toBeDefined();
    expect(failed!.event).toBe("code_lifecycle");
    expect(failed!.sessionId).toBe(sid);
    expect(failed!.status).toBe("failed");
    const payload = failed!.metadata as Record<string, unknown>;
    expect(payload.terminal).toBe(true);
    expect(payload.reason).toBe("agent_died");
    // Task mode ends with the death — no orphaned assignment.
    expect(coder.properties.coding_task).toBeUndefined();
    expect(fake.codingTasks.at(-1)).toBeNull();
    // The failure is durable in the session event log too.
    const dbFailed = db
      .listCodingEvents(sid, 100)
      .filter((event) => event.kind === "code_lifecycle")
      .map((event) => JSON.parse(event.payload_json))
      .find((payloadJson) => payloadJson.phase === "failed");
    expect(dbFailed).toMatchObject({ reason: "agent_died", terminal: true });
  });

  it("agent death after completion emits no spurious failure", async () => {
    const { alice, fake, notifications, command, ctx } = makeStructuredSetup();

    await command.handler(ctx, inputFor(alice, "code do add a health endpoint"));
    fake.emit({
      type: "tool_call",
      toolName: "marina_code",
      args: { action: "summary", text: "done" },
    });
    fake.emit({ type: "status_change", status: { state: "stopped" } as never });

    const failed = notifications
      .map((n) => codeMeta(n.metadata))
      .find((code) => code?.phase === "failed");
    expect(failed).toBeUndefined();
  });

  it("a recoverable tool error streams failed WITHOUT the terminal flag", async () => {
    const { alice, fake, notifications, command, ctx } = makeStructuredSetup();

    await command.handler(ctx, inputFor(alice, "code do fix the tokenizer"));
    fake.emit({ type: "tool_result", toolName: "marina_code", result: "boom", isError: true });

    const failed = notifications
      .map((n) => codeMeta(n.metadata))
      .find((code) => code?.phase === "failed");
    expect(failed).toBeDefined();
    const payload = failed!.metadata as Record<string, unknown>;
    expect(payload.terminal).toBeUndefined();
  });

  it("code stop mid-task sends a terminal failed lifecycle; an idle stop stays 'stopped'", async () => {
    const { alice, sent, command, ctx } = makeStructuredSetup();

    await command.handler(ctx, inputFor(alice, "code do refactor the parser"));
    const sid = alice.properties.coding_session_id as string;

    sent.length = 0;
    await command.handler(ctx, inputFor(alice, "code stop"));

    const stopMeta = sent
      .map((entry) => codeMeta(entry.metadata))
      .find((code) => code?.event === "code_lifecycle");
    expect(stopMeta).toBeDefined();
    expect(stopMeta!.phase).toBe("failed");
    expect(stopMeta!.sessionId).toBe(sid);
    const payload = stopMeta!.metadata as Record<string, unknown>;
    expect(payload.terminal).toBe(true);
    expect(payload.reason).toBe("stopped");

    // Second stop: nothing in flight anymore — benign "stopped", not a failure.
    sent.length = 0;
    await command.handler(ctx, inputFor(alice, "code stop"));
    const idleMeta = sent
      .map((entry) => codeMeta(entry.metadata))
      .find((code) => code?.event === "code_lifecycle");
    expect(idleMeta!.phase).toBe("stopped");
    expect((idleMeta!.metadata as Record<string, unknown>).terminal).toBeUndefined();
  });
});

describe("resume: entering code re-adopts the creator's latest active session", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  function makeCommandFor(entity: Entity) {
    const sent: SentEntry[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === entity.id ? entity : undefined),
      workspace: new LocalWorkspace(),
    });
    const ctx = {
      send: (
        _target: EntityId,
        message: string,
        _tag?: string,
        metadata?: Record<string, unknown>,
      ) => {
        sent.push({ message: stripAnsi(message), metadata });
      },
    } as unknown as RoomContext;
    return { command, ctx, sent };
  }
  interface SentEntry {
    message: string;
    metadata?: Record<string, unknown>;
  }

  it("a rebuilt entity (quit deletes the row) resumes its prior active session", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const first = makeCommandFor(alice);
    await first.command.handler(first.ctx, inputFor(alice, "code start Persistent work"));
    const sid = alice.properties.coding_session_id as string;

    // Simulate quit + relaunch: a brand-new entity with the same name and no
    // session pointer (engine `quit` deletes the entity row entirely).
    const reborn = makeAgentEntity("u_alice2", "Alice");
    db.saveEntity(reborn);
    const second = makeCommandFor(reborn);
    await second.command.handler(second.ctx, inputFor(reborn, "code"));

    expect(reborn.properties.coding_session_id).toBe(sid);
    const banner = second.sent.map((entry) => entry.message).join("\n");
    expect(banner).toContain(`Session: ${sid}`);
    // The entry metadata is machine-readable for launchers.
    const meta = second.sent
      .map((entry) => entry.metadata?.code as Record<string, unknown> | undefined)
      .find((code) => code?.event === "code_mode_entered");
    expect(meta).toBeDefined();
    expect(meta!.sessionId).toBe(sid);
    expect(typeof meta!.sessionCreatedAt).toBe("number");
  });

  it("completed sessions are not re-adopted", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const first = makeCommandFor(alice);
    await first.command.handler(first.ctx, inputFor(alice, "code start Old work"));
    const sid = alice.properties.coding_session_id as string;
    db.updateCodingSession(sid, { status: "complete" });

    const reborn = makeAgentEntity("u_alice2", "Alice");
    db.saveEntity(reborn);
    const second = makeCommandFor(reborn);
    await second.command.handler(second.ctx, inputFor(reborn, "code"));

    expect(reborn.properties.coding_session_id).toBeUndefined();
    expect(second.sent.map((entry) => entry.message).join("\n")).toContain("No active session yet");
  });

  it("an existing valid pointer wins over re-adoption", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const { command, ctx } = makeCommandFor(alice);
    await command.handler(ctx, inputFor(alice, "code start First"));
    const firstSid = alice.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(alice, "code start Second"));
    const secondSid = alice.properties.coding_session_id as string;
    expect(secondSid).not.toBe(firstSid);

    // Explicitly resume the FIRST session, then re-enter the modal: the
    // pointer must be respected, not overwritten by "most recent".
    await command.handler(ctx, inputFor(alice, `code resume ${firstSid}`));
    await command.handler(ctx, inputFor(alice, "code"));
    expect(alice.properties.coding_session_id).toBe(firstSid);
  });
});

describe("self-dispatch guard (bound coder cannot queue tasks to itself)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  function makeBoundSetup() {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const coder = makeAgentEntity("agent_coder", "Coder");
    db.saveEntity(coder);
    const fake = fakeHandle("Coder", "agent_coder");
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : id === "agent_coder" ? coder : undefined),
      workspace: new LocalWorkspace(),
      agentRuntime: {
        get: (n: string) => (n === "Coder" ? fake.handle : undefined),
        isAvailable: () => true,
        list: () => [{ name: "Coder" }],
      },
      listAgents: () => [{ name: "Coder" }],
      findAgentByName: (n: string) => (n === "Coder" ? coder : undefined),
    });
    return { alice, coder, fake, sent, command, ctx: testRoomContext(sent) };
  }

  it("a stray modal line from the bound coder is refused, not queued as a task", async () => {
    const { alice, coder, fake, sent, command, ctx } = makeBoundSetup();

    await command.handler(ctx, inputFor(alice, "code do fix the tokenizer"));
    const sid = alice.properties.coding_session_id as string;
    const assignedBefore = db
      .listCodingEvents(sid, 100)
      .filter((event) => event.kind === "code_agent_assigned").length;
    const attentionBefore = fake.attention.length;

    // The engine's modal routing rewrites the coder's own `brief` into
    // `code brief`; "brief" is no subcommand, so it falls through to the
    // natural-language-task path — the exact self-dispatch loop.
    sent.length = 0;
    await command.handler(ctx, inputFor(coder, "code brief"));

    expect(sent.join("\n")).toContain("You are this session's coding agent");
    expect(sent.join("\n")).not.toContain("Task received");
    // Nothing was queued or delivered: no new assignment event, no attention.
    expect(
      db.listCodingEvents(sid, 100).filter((event) => event.kind === "code_agent_assigned").length,
    ).toBe(assignedBefore);
    expect(fake.attention.length).toBe(attentionBefore);
    const strayReceived = db
      .listCodingEvents(sid, 100)
      .filter(
        (event) =>
          event.kind === "code_lifecycle" && JSON.parse(event.payload_json).task === "brief",
      );
    expect(strayReceived).toHaveLength(0);
  });

  it("the coder's legitimate code subcommands are unaffected by the guard", async () => {
    const { alice, coder, sent, command, ctx } = makeBoundSetup();

    await command.handler(ctx, inputFor(alice, "code do fix the tokenizer"));
    sent.length = 0;
    await command.handler(ctx, inputFor(coder, "code status"));

    expect(sent.join("\n")).not.toContain("You are this session's coding agent");
    expect(sent.length).toBeGreaterThan(0);
  });

  it("the human dispatcher can still queue follow-up tasks normally", async () => {
    const { alice, fake, sent, command, ctx } = makeBoundSetup();

    await command.handler(ctx, inputFor(alice, "code do fix the tokenizer"));
    sent.length = 0;
    await command.handler(ctx, inputFor(alice, "code do also update the docs"));

    expect(sent.join("\n")).toContain("Task received");
    expect(fake.attention.length).toBe(2);
  });
});

describe("identity mismatch: dashed config names vs login-sanitized entity names", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // Engine login sanitizes to alnum+underscore, ≤20 chars — a coding agent
  // spawned under a dashed config name gets a different ENTITY name.
  const CONFIG_NAME = "code-coder-code_1";
  const ENTITY_NAME = "codecodercode_1";

  it("sanitizeEntityName maps the config form to the login form (and is idempotent)", () => {
    expect(sanitizeEntityName(CONFIG_NAME)).toBe(ENTITY_NAME);
    expect(sanitizeEntityName(ENTITY_NAME)).toBe(ENTITY_NAME);
    expect(sanitizeEntityName("a".repeat(30))).toHaveLength(20);
    expect(sanitizeEntityName(sanitizeEntityName("we!rd-Name_42"))).toBe(
      sanitizeEntityName("we!rd-Name_42"),
    );
  });

  /** Alice's session; the coder runs under CONFIG_NAME but its entity is ENTITY_NAME. */
  function makeMismatchSetup() {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    const coder = makeAgentEntity("agent_coder", ENTITY_NAME);
    db.saveEntity(coder);
    grant(db, alice.id, "code.exec");
    grant(db, coder.id, "code.exec");
    const fake = fakeHandle(CONFIG_NAME, "agent_coder");
    const { workspace, edits, writes } = makeEditableWorkspace();
    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : id === "agent_coder" ? coder : undefined),
      workspace,
      workspaceRegistry: makeRegistryStub(workspace),
      agentRuntime: {
        get: (n: string) => (n === CONFIG_NAME ? fake.handle : undefined),
        isAvailable: () => true,
        list: () => [{ name: CONFIG_NAME }],
      },
      listAgents: () => [{ name: CONFIG_NAME }],
      // Mirrors EntityManager.findAgentByName: case-insensitive on ENTITY names.
      findAgentByName: (n: string) =>
        n.toLowerCase() === ENTITY_NAME.toLowerCase() ? coder : undefined,
    });
    return { alice, coder, fake, sent, edits, writes, command, ctx: testRoomContext(sent) };
  }

  it("a legacy dashed writer still admits the bound agent's apply/edit/write", async () => {
    const { alice, coder, sent, edits, writes, command, ctx } = makeMismatchSetup();

    await command.handler(ctx, inputFor(alice, "code start Mismatch"));
    const sid = alice.properties.coding_session_id as string;
    // Legacy binding: the session rows hold the dashed CONFIG name.
    db.updateCodingSession(sid, { agent: CONFIG_NAME, writer: CONFIG_NAME });
    coder.properties.coding_session_id = sid;

    sent.length = 0;
    await command.handler(
      ctx,
      inputFor(coder, "code edit src/a.ts\n<<<<<<< OLD\nfoo\n=======\nbar\n>>>>>>> NEW"),
    );
    expect(sent.join("\n")).not.toContain("holds the write lock");
    expect(edits).toHaveLength(1);

    await command.handler(ctx, inputFor(coder, "code write notes.txt\nhi"));
    expect(writes).toHaveLength(1);

    // Apply reaches the patch path — it may fail for lack of a pending patch,
    // but never on the writer/creator identity guard.
    sent.length = 0;
    await command.handler(ctx, inputFor(coder, "code apply last patch"));
    const out = sent.join("\n");
    expect(out).not.toContain("holds the write lock");
    expect(out).not.toContain("Only the session creator");
  });

  it("the self-dispatch guard recognizes the bound agent across the name drift", async () => {
    const { alice, coder, fake, sent, command, ctx } = makeMismatchSetup();

    await command.handler(ctx, inputFor(alice, "code start Mismatch"));
    const sid = alice.properties.coding_session_id as string;
    db.updateCodingSession(sid, { agent: CONFIG_NAME, writer: CONFIG_NAME });
    coder.properties.coding_session_id = sid;
    coder.properties.active_modal = "code"; // the bound coder sits in the code modal

    // The coder's stray `brief` (modal-rewritten to `code brief`) must be
    // refused — not queued back to itself as a new task.
    sent.length = 0;
    await command.handler(ctx, inputFor(coder, "code brief"));
    expect(sent.join("\n")).toContain("You are this session's coding agent");
    expect(sent.join("\n")).not.toContain("Task received");
    expect(fake.attention).toHaveLength(0);
  });

  it("recruiting resolves the drifted entity and stores the writer in entity-name form", async () => {
    const { alice, command, ctx } = makeMismatchSetup();

    await command.handler(ctx, inputFor(alice, "code do fix the tokenizer"));

    const sid = alice.properties.coding_session_id as string;
    const session = db.getCodingSession(sid)!;
    // session.agent keeps the runtime-facing name so dispatch/streaming work…
    expect(session.agent).toBe(CONFIG_NAME);
    // …while the write lock holds the entity form the guards compare against.
    expect(session.writer).toBe(ENTITY_NAME);
  });

  it("spawned coder names are fixed points of the login sanitizer", async () => {
    const alice = makeAgentEntity("u_alice", "Alice");
    db.saveEntity(alice);
    grant(db, alice.id, "agent.spawn");
    const spawned: { name: string }[] = [];
    const spawnedEntities = new Map<string, Entity>();
    const spawnedHandles = new Map<string, AgentHandle>();
    const command = codeCommand({
      db,
      getEntity: (id) => (id === "u_alice" ? alice : spawnedEntities.get(id)),
      workspace: new LocalWorkspace(),
      agentRuntime: {
        get: (n: string) => spawnedHandles.get(n),
        isAvailable: () => true,
        list: () => spawned,
        spawn: async (config: { name: string }) => {
          spawned.push({ name: config.name });
          const entityId = `agent_${config.name}`;
          spawnedEntities.set(entityId, makeAgentEntity(entityId, config.name));
          const { handle } = fakeHandle(config.name, entityId);
          spawnedHandles.set(config.name, handle);
          return handle;
        },
      },
      listAgents: () => [],
      findAgentByName: () => undefined,
    });
    const ctx = testRoomContext([]);

    await command.handler(ctx, inputFor(alice, "code do add a resolver"));

    expect(spawned).toHaveLength(1);
    const name = spawned[0]!.name;
    // Config name == the entity name login will produce: no drift possible.
    expect(sanitizeEntityName(name)).toBe(name);
    expect(name.length).toBeLessThanOrEqual(20);
    expect(name).toMatch(/^[a-zA-Z0-9_]+$/);
    const sid = alice.properties.coding_session_id as string;
    const session = db.getCodingSession(sid)!;
    expect(session.agent).toBe(name);
    expect(session.writer).toBe(name);
  });
});

describe("code resume ownership (BYPASS 1a)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("refuses resume for a non-creator/non-bound entity; allows the creator and bound agent", async () => {
    const creator = makeAgentEntity("u_creator", "Creator");
    db.saveEntity(creator);
    const boundAgent = makeAgentEntity("agent_bound", "BoundCoder");
    db.saveEntity(boundAgent);
    const stranger = makeAgentEntity("u_stranger", "Stranger");
    db.saveEntity(stranger);

    const session = db.createCodingSession({
      id: "cs_ownership_1",
      title: "Owned",
      workspaceRoot: process.cwd(),
      createdBy: creator.name,
      mode: "agent",
    });
    db.updateCodingSession(session.id, { agent: boundAgent.name });

    const sent: string[] = [];
    const command = codeCommand({
      db,
      getEntity: (id) => [creator, boundAgent, stranger].find((e) => e.id === id),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent);

    // A stranger who merely knows the id cannot adopt the session (confused
    // deputy toward the creator's exec authorization).
    sent.length = 0;
    await command.handler(ctx, inputFor(stranger, `code resume ${session.id}`));
    expect(stripAnsi(sent.join("\n"))).toContain("only resume a coding session you created");
    expect(stranger.properties.coding_session_id).toBeUndefined();

    // The creator may resume.
    sent.length = 0;
    await command.handler(ctx, inputFor(creator, `code resume ${session.id}`));
    expect(creator.properties.coding_session_id).toBe(session.id);

    // The session's own bound coding agent may resume.
    sent.length = 0;
    await command.handler(ctx, inputFor(boundAgent, `code resume ${session.id}`));
    expect(boundAgent.properties.coding_session_id).toBe(session.id);
  });
});
