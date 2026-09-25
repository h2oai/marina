// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentHandle } from "../src/agent/agent-types";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  beginCodingRun,
  codingRunMetadata,
  endCodingRun,
  recoverCodingRuns,
  submitCodingRun,
} from "../src/coding/task-run";
import { TaskManager } from "../src/coordination/task-manager";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import { codingRunContext } from "../src/persistence/coding-run-context";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, type EntityId, type RoomContext, roomId } from "../src/types";
import { stripAnsi } from "./helpers";

function entity(id: string, name: string): Entity {
  return {
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: name,
    inventory: [],
    properties: {},
  };
}

describe("durable coding task attempts", () => {
  let db: MarinaDB;
  let dir: string;
  let owner: Entity;
  let worker: Entity;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-task-run-"));
    db = new MarinaDB(join(dir, "world.db"));
    owner = entity("owner", "Owner");
    worker = entity("worker", "Worker");
    db.saveEntity(owner);
    db.saveEntity(worker);
    db.createCodingSession({ id: "s", title: "Coding", workspaceRoot: dir, createdBy: owner.name });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function begin(sessionId = "s") {
    return beginCodingRun(db, {
      session: db.getCodingSession(sessionId)!,
      owner,
      worker,
      prompt: "Fix the bug",
      profile: "marina",
    });
  }
  function artifact(kind: string, status = "complete") {
    return db.createCodingArtifact({
      sessionId: "s",
      kind,
      status,
      title: kind,
      contentText: "recorded evidence",
      createdBy: worker.name,
    });
  }

  it("reuses one claimed canonical task when the operator steers an active attempt", () => {
    const run = begin();
    expect(begin().id).toBe(run.id);
    const meta = codingRunMetadata(run);
    expect(db.getTask(meta.taskId)?.status).toBe("claimed");
    expect(db.getTaskClaim(meta.taskId, worker.id)?.status).toBe("claimed");
    expect(db.listCodingRuns()).toHaveLength(1);
    expect(db.listCodingEvents("s").some((event) => event.kind === "task_run_steered")).toBe(true);
  });

  it("prevents a worker being rebound to a second active workspace", () => {
    begin();
    db.createCodingSession({
      id: "second",
      title: "Other",
      workspaceRoot: dir,
      createdBy: owner.name,
    });
    expect(() => begin("second")).toThrow("another session");
    expect(db.listTasks()).toHaveLength(1);
  });

  it("stores submission and verification evidence separately from approval", () => {
    const run = begin();
    const verify = artifact("verification");
    const summary = artifact("summary");
    const submitted = submitCodingRun(db, "s", worker, summary)!;
    expect(submitted.status).toBe("submitted");
    const meta = codingRunMetadata(submitted);
    expect(meta).toMatchObject({
      verification: "passed",
      verificationId: verify.id,
      summaryId: summary.id,
    });
    expect(db.getTask(meta.taskId)?.status).toBe("claimed");
    expect(db.getTaskClaim(meta.taskId, worker.id)?.status).toBe("submitted");
    expect(new TaskManager(db).approveSubmission(meta.taskId, worker.id, "stranger")).toBe(false);
    expect(new TaskManager(db).approveSubmission(meta.taskId, worker.id, owner.id)).toBe(true);
    expect(db.getTask(meta.taskId)?.status).toBe("completed");
    expect(endCodingRun(db, run.id, "cancelled", "late stop")).toBeUndefined();
    expect(db.getTask(meta.taskId)?.status).toBe("completed");
  });

  it("does not treat an operator note, failed check, or changed workspace as verified work", () => {
    begin();
    artifact("verification", "failed");
    const humanSummary = artifact("summary");
    expect(submitCodingRun(db, "s", owner, humanSummary)).toBeUndefined();
    const failed = submitCodingRun(db, "s", worker, artifact("summary"))!;
    expect(codingRunMetadata(failed).verification).toBe("failed");
    begin();
    artifact("verification");
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "patch_applied",
      payload: {},
    });
    const changed = submitCodingRun(db, "s", worker, artifact("summary"))!;
    expect(codingRunMetadata(changed).verification).toBe("stale");
  });

  it("keeps late asynchronous evidence on its original cancelled attempt", async () => {
    const old = begin();
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const late = codingRunContext.run(
      { sessionId: "s", runId: old.id, taskId: codingRunMetadata(old).taskId },
      async () => {
        await paused;
        return artifact("summary");
      },
    );
    endCodingRun(db, old.id, "cancelled", "operator stop");
    const current = begin();
    finish();
    const summary = await late;
    expect(JSON.parse(summary.metadata_json).runId).toBe(old.id);
    expect(submitCodingRun(db, "s", worker, summary)).toBeUndefined();
    expect(db.getCodingArtifact(current.id)?.status).toBe("active");
  });

  it("marks restart uncertainty and releases the claim without replaying execution", () => {
    const run = begin();
    db.close();
    db = new MarinaDB(join(dir, "world.db"));
    recoverCodingRuns(db);
    expect(db.getCodingArtifact(run.id)?.status).toBe("interrupted");
    expect(db.getTask(codingRunMetadata(run).taskId)?.status).toBe("open");
    recoverCodingRuns(db);
    expect(
      db.listCodingEvents("s").filter((event) => event.kind === "task_run_interrupted"),
    ).toHaveLength(1);
  });

  it("runs the complete Code Mode loop with real workspace checks and owner review", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    writeFileSync(
      join(dir, "sample.test.ts"),
      'import { expect, test } from "bun:test"; test("check", () => expect(2 + 2).toBe(4));',
    );
    const listeners = new Set<(event: AgentEvent) => void>();
    const messages: string[] = [];
    const attention: string[] = [];
    const handle = {
      name: "Worker",
      getStatus: () => ({ entityId: worker.id, role: "coder" }),
      sendAttention: async (text: string) => {
        attention.push(text);
      },
      setActiveCodingTask: () => {},
      reconfigure: async () => {},
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as AgentHandle;
    const command = codeCommand({
      db,
      workspace: new LocalWorkspace(dir),
      getEntity: (id) => (id === owner.id ? owner : id === worker.id ? worker : undefined),
      findAgentByName: (name) => (name === worker.name ? worker : undefined),
      agentRuntime: {
        get: (name) => (name === worker.name ? handle : undefined),
        list: () => [{ name: worker.name }],
      },
      listAgents: () => [{ name: worker.name }],
      notify: (_id, message) => {
        messages.push(message);
      },
    });
    grant(db, owner.id, "code.exec");
    owner.properties.coding_session_id = "s";
    const ctx = {
      send: (_id: string, message: string) => {
        messages.push(message);
      },
    } as unknown as RoomContext;
    const send = async (actor: Entity, text: string) =>
      command.handler(ctx, {
        entity: actor.id,
        room: actor.room,
        verb: "code",
        raw: `code ${text}`,
        args: text,
        tokens: text.split(/\s+/),
      });
    await send(owner, "do Check the arithmetic test");
    expect(attention[0]).toContain("Task #");
    expect(db.listCodingRuns({ sessionId: "s", status: "active" })).toHaveLength(1);
    for (const listener of listeners)
      listener({ type: "tool_call", toolName: "marina_code", args: { action: "summary" } });
    expect(db.listCodingRuns({ status: "active" })).toHaveLength(1);
    await send(worker, "verify");
    await send(worker, "summary Arithmetic check passed");
    const run = db.listCodingRuns({ sessionId: "s", limit: 1 })[0]!;
    expect(run.status).toBe("submitted");
    expect(codingRunMetadata(run).verification).toBe("passed");
    expect(worker.properties.coding_task).toBeUndefined();
    await send(worker, `review approve ${run.id}`);
    expect(db.getTask(codingRunMetadata(run).taskId)?.status).toBe("claimed");
    await send(owner, `review approve ${run.id}`);
    expect(db.getTask(codingRunMetadata(run).taskId)?.status).toBe("completed");
    expect(stripAnsi(messages.join("\n"))).toContain("submitted for review");
    expect(
      db
        .listCodingEvents("s", 100)
        .filter((event) => event.kind === "code_lifecycle")
        .map((event) => JSON.parse(event.payload_json))
        .filter((event) => event.terminal),
    ).toHaveLength(1);
  });
});
