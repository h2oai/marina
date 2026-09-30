// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { beginCodingRun, endCodingRun } from "../src/coding/task-run";
import type { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { listRaisedBy, settleChallenge } from "../src/engine/challenges";
import { withCommandResponse } from "../src/engine/command-response";
import { codeCommand } from "../src/engine/commands/code";
import { grantCommandPass } from "../src/engine/gate-context";
import { grant } from "../src/engine/safety-gates";
import { parseCodingCommandTarget } from "../src/sdk/command-target";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

function fixture() {
  const world = createTestEngine();
  const owner = world.login("Owner");
  const worker = world.login("Worker");
  const stranger = world.login("Stranger");
  const entity = world.engine.entities.get(owner.entityId)!;
  for (const id of ["a", "b"]) {
    world.db.createCodingSession({
      id,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      createdBy: entity.name,
    });
  }
  world.db.updateCodingSession("b", { agent: "Worker" });
  entity.properties.coding_session_id = "a";
  entity.properties.active_modal = "code";
  entity.properties.code_context = { sessionId: "a" };
  world.db.saveEntity(entity);
  const begin = (sessionId: string) =>
    beginCodingRun(world.db, {
      session: world.db.getCodingSession(sessionId)!,
      owner: entity,
      worker: sessionId === "a" ? entity : world.engine.entities.get(worker.entityId)!,
      prompt: "Target fixture",
      profile: "marina",
    });
  const runA = begin("a");
  const runB = begin("b");
  const send = (raw: string, target = { sessionId: "b", runId: runB.id }, actor = owner.entityId) =>
    world.engine.processCommand(actor, raw, { codingTarget: target });
  return { ...world, owner, worker, stranger, entity, begin, runA, runB, send };
}

describe("request-local coding destinations", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(async () => {
    await f.dispose();
  });

  it("writes and inspects another owned session without changing saved selection or legacy routing", async () => {
    const before = structuredClone(f.entity.properties);
    await f.send("code observe belongs to b");
    await f.send("code status");
    const note = f.db.listCodingArtifacts("b").find((a) => a.kind === "observation")!;
    expect(JSON.parse(note.metadata_json).runId).toBe(f.runB.id);
    expect(f.db.listCodingArtifacts("a").filter((a) => a.kind === "observation")).toEqual([]);
    expect(f.entity.properties).toEqual(before);
    expect(f.db.loadEntity(f.entity.id)?.properties).toEqual(before);
    await f.engine.processCommand(f.entity.id, "observe legacy belongs to a");
    expect(f.db.listCodingArtifacts("a").find((a) => a.kind === "observation")?.content_text).toBe(
      "legacy belongs to a",
    );
  });

  it("supports a solo session with no selected session or task attempt", async () => {
    f.db.createCodingSession({
      id: "solo",
      title: "Solo",
      workspaceRoot: "/tmp/solo",
      createdBy: "Owner",
    });
    delete f.entity.properties.coding_session_id;
    delete f.entity.properties.active_modal;
    await f.engine.processCommand(f.entity.id, "code plan work alone", {
      codingTarget: { sessionId: "solo" },
    });
    expect(f.db.listCodingArtifacts("solo").find((a) => a.kind === "plan")?.content_text).toBe(
      "work alone",
    );
    expect(f.entity.properties.coding_session_id).toBeUndefined();
    expect(f.entity.properties.active_modal).toBeUndefined();
  });

  it("uses the existing creator/bound-agent authority and does not treat a write lock as adoption", async () => {
    await f.send("code observe worker evidence", undefined, f.worker.entityId);
    expect(f.db.listCodingArtifacts("b").filter((a) => a.kind === "observation")).toHaveLength(1);
    f.db.updateCodingSession("b", { writer: "Stranger" });
    await f.send("code observe forbidden", undefined, f.stranger.entityId);
    expect(f.stranger.connection.lastText()).toContain("unavailable or not authorized");
    expect(f.db.listCodingArtifacts("b").filter((a) => a.kind === "observation")).toHaveLength(1);
    f.db.updateCodingSession("b", { agent: null });
    await f.send("code observe revoked", undefined, f.worker.entityId);
    expect(f.worker.connection.lastText()).toContain("unavailable or not authorized");
  });

  it("rejects missing, foreign, wrong-kind and terminal runs before writing; responses report failure", async () => {
    const ordinary = f.db.createCodingArtifact({
      sessionId: "b",
      kind: "plan",
      title: "Plan",
      contentText: "",
      createdBy: "Owner",
    });
    endCodingRun(f.db, f.runB.id, "interrupted", "fixture");
    const replacement = f.begin("b");
    for (const runId of ["missing", f.runA.id, ordinary.id, f.runB.id]) {
      const completion: Perception[] = [];
      await withCommandResponse(
        f.owner.connection.id,
        runId,
        () => f.send("code observe invalid", { sessionId: "b", runId }),
        (p) => completion.push(p),
      );
      expect(completion[0]?.data.command_result).toMatchObject({ ok: false });
      expect(f.owner.connection.lastText()).toContain("not the session's active attempt");
    }
    expect(f.db.listCodingArtifacts("b").filter((a) => a.kind === "observation")).toEqual([]);
    await f.send("code observe current", { sessionId: "b", runId: replacement.id });
    expect(f.db.listCodingRunArtifacts(replacement.id).map((a) => a.content_text)).toContain(
      "current",
    );
  });

  it("refuses conflicting IDs, selection-changing operations, bare modal input and world commands", async () => {
    for (const command of [
      "code status a",
      "code history a",
      "code resume a",
      "code start surprise",
      "code exit",
      "code workspace use /tmp",
      "code",
      "status",
      "say misdirected",
    ]) {
      const completion: Perception[] = [];
      await withCommandResponse(
        f.owner.connection.id,
        command,
        () => f.send(command),
        (p) => completion.push(p),
      );
      expect(completion[0]?.data.command_result).toMatchObject({ ok: false });
    }
    expect(f.entity.properties.coding_session_id).toBe("a");
    expect(f.entity.properties.active_modal).toBe("code");
    expect(f.db.listCodingSessions()).toHaveLength(2);
  });

  function installWorkspace(
    read?: () => Promise<{ path: string; content: string; size: number; truncated: boolean }>,
    protocol = "websocket",
  ) {
    const writes: string[] = [];
    const workspace = Object.assign(new LocalWorkspace("/tmp"), {
      ...(read ? { read } : {}),
      writeFile: async (path: string) => {
        writes.push(path);
        return { ok: true, output: "wrote", created: true };
      },
    });
    const registry = {
      hostExecAllowed: true,
      workspaceForRoot: () => workspace,
    } as unknown as WorkspaceRegistry;
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        workspaceRegistry: registry,
        getConnectionProtocol: () => protocol as "websocket" | "telnet",
      }),
    );
    return writes;
  }

  it("keeps delayed evidence on its original attempt while other participants and ordinary messages progress", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    installWorkspace(async () => {
      entered.resolve();
      await release.promise;
      return { path: "file.ts", content: "evidence", size: 8, truncated: false };
    });
    const pending = f.send("code read file.ts");
    try {
      await entered.promise;
      endCodingRun(f.db, f.runB.id, "interrupted", "fixture");
      const next = f.begin("b");
      await f.engine.processCommand(f.stranger.entityId, "say world still moving");
      await f.engine.processCommand(f.worker.entityId, "code observe next attempt", {
        codingTarget: { sessionId: "b", runId: next.id },
      });
      expect(f.owner.connection.allText().join("\n")).toContain("world still moving");
      release.resolve();
      await pending;
      const read = f.db.listCodingEvents("b").find((e) => e.kind === "file_read")!;
      expect(JSON.parse(read.payload_json).runId).toBe(f.runB.id);
      expect(f.entity.properties.coding_session_id).toBe("a");
      expect(f.entity.properties.code_context).toEqual({ sessionId: "a" });
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("preserves telnet refusal, competence gates and the writer lock", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
    });
    f.entity.properties.rank = 0;
    let writes = installWorkspace(undefined, "telnet");
    grant(f.db, f.entity.id, "code.exec");
    await f.send("code write file.ts\ncontent");
    expect(f.owner.connection.lastText()).toContain("telnet");
    expect(writes).toEqual([]);
    writes = installWorkspace();
    f.db.updateCodingSession("b", { writer: "Worker" });
    await f.send("code write file.ts\ncontent");
    expect(f.owner.connection.lastText()).toContain("write lock");
    expect(writes).toEqual([]);
  });

  it("holds distinct targeted challenges and replays approval against its original session", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "on", MARINA_CHALLENGE_JUDGE: "off" },
    });
    f.entity.properties.rank = 0;
    const writes = installWorkspace();
    const raw = "code write file.ts\ncontent";
    await f.send(raw);
    await f.send(raw, { sessionId: "a", runId: f.runA.id });
    const held = listRaisedBy(f.entity.id);
    expect(held).toHaveLength(2);
    expect(writes).toEqual([]);
    const approver = f.engine.entities.get(f.stranger.entityId)!;
    approver.properties.rank = 9;
    const selected = held.find((c) => c.codingTarget?.sessionId === "b")!;
    expect(selected.summary).toContain(f.runB.id);
    expect(settleChallenge(selected.token, approver, "once").ok).toBe(true);
    await until(() => writes.length === 1);
    await f.engine.drainCommands();
    expect(f.db.listCodingArtifacts("b").find((a) => a.kind === "file_write")).toBeDefined();
    expect(f.db.listCodingArtifacts("a").find((a) => a.kind === "file_write")).toBeUndefined();
    expect(f.entity.properties.coding_session_id).toBe("a");
    // The second approval cannot follow a stale attempt into its replacement.
    endCodingRun(f.db, f.runA.id, "interrupted", "fixture");
    f.begin("a");
    expect(
      settleChallenge(held.find((c) => c.codingTarget?.sessionId === "a")!.token, approver, "once")
        .ok,
    ).toBe(true);
    await f.engine.drainCommands();
    expect(writes).toHaveLength(1);
  });

  it("cannot spend an approved pass on the same command aimed at another session", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
    });
    f.entity.properties.rank = 0;
    const writes = installWorkspace();
    const raw = "code write approved.ts\ncontent";
    grantCommandPass(f.entity.id, raw, {
      codingTarget: { sessionId: "b", runId: f.runB.id },
      gateIds: ["code.exec"],
      rankWaived: false,
      approverName: "Witness",
      token: "test-target-pass",
    });
    await f.send(raw, { sessionId: "a", runId: f.runA.id });
    expect(writes).toEqual([]);
    await f.send(raw);
    expect(writes).toEqual(["approved.ts"]);
    await f.send(raw);
    expect(writes).toHaveLength(1);
  });

  it("does not let a room override consume a targeted coding request", async () => {
    const room = f.engine.rooms.get(f.entity.room)!;
    let ran = false;
    room.module.commands = {
      code: () => {
        ran = true;
      },
    };
    await f.send("code status");
    expect(ran).toBe(false);
    expect(f.owner.connection.lastText()).toContain("explicit built-in code command");
  });
});

it("rejects malformed targets and freezes a defensive copy", () => {
  for (const value of [
    null,
    [],
    "b",
    {},
    { sessionId: "" },
    { sessionId: "../b" },
    { sessionId: "b", runId: 1 },
    { sessionId: "b", owner: "Owner" },
    { sessionId: "x".repeat(129) },
  ])
    expect(() => parseCodingCommandTarget(value)).toThrow("Invalid coding target");
  const input = { sessionId: "b" };
  const target = parseCodingCommandTarget(input);
  input.sessionId = "a";
  expect(target.sessionId).toBe("b");
  expect(Object.isFrozen(target)).toBe(true);
});
