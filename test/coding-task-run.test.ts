// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentHandle } from "../src/agent/agent-types";
import type { AgentOperatorStatus } from "../src/agent/lean-agent-adapter";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  beginCodingRun,
  canReclaimCodingWriter,
  codingRunMetadata,
  endCodingRun,
  recoverCodingRuns,
  submitCodingRun,
} from "../src/coding/task-run";
import { VerificationRunner } from "../src/coding/verification-runner";
import { codingWorkerState } from "../src/coding/worker-state";
import { TaskManager } from "../src/coordination/task-manager";
import { codeCommand } from "../src/engine/commands/code";
import { parseCodingTask } from "../src/engine/commands/code/driver";
import { status as codingStatus } from "../src/engine/commands/code/session";
import { observeCodingRun } from "../src/engine/commands/code/task-run";
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
  function begin(
    sessionId = "s",
    verificationRequirement?: "candidate" | "checks",
    ownerMode?: "unattended",
  ) {
    return beginCodingRun(db, {
      session: db.getCodingSession(sessionId)!,
      owner,
      worker,
      prompt: "Fix the bug",
      profile: "marina",
      verificationRequirement,
      ownerMode,
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

  it("projects budget pauses and recovery without terminating, renewing or completing the task", async () => {
    const run = begin("s", "candidate");
    const listeners = new Set<(event: AgentEvent) => void>();
    const notices: Record<string, unknown>[] = [];
    let pause: AgentOperatorStatus["paused"] = null;
    let error = false;
    const handle = {
      name: worker.name,
      getStatus: () => ({
        entityId: worker.id,
        state: error ? "error" : "autonomous",
        healthState: "busy",
        modelCalls: 7,
        budgetCalls: 7,
      }),
      getOperatorStatus: () => ({ paused: pause }),
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as AgentHandle;
    const deps = {
      db,
      getEntity: (id: string) => (id === owner.id ? owner : id === worker.id ? worker : undefined),
      agentRuntime: { get: () => handle },
      notify: (_id: string, _text: string, metadata?: Record<string, unknown>) => {
        if (metadata) notices.push(metadata);
      },
    };
    const claimBefore = db.getTaskClaim(codingRunMetadata(run).taskId, worker.id);
    observeCodingRun(deps, run, handle);
    const emit = () => {
      for (const listener of listeners) listener({ type: "operator_status_change" });
    };
    pause = { kind: "budget", reason: "7 model calls used", since: Date.now() };
    emit();
    emit();
    expect(notices.at(-1)?.code).toMatchObject({
      event: "worker_state_changed",
      status: "active",
      metadata: { runId: run.id, workerState: "paused", workerPauseKind: "budget" },
    });
    expect(
      db.listCodingEvents("s").filter((event) => event.kind === "worker_state_changed"),
    ).toHaveLength(1);
    const status: Record<string, unknown>[] = [];
    const context = {
      send: (_id: string, _text: string, _tag?: string, metadata?: Record<string, unknown>) => {
        if (metadata) status.push(metadata);
      },
      codingTarget: { sessionId: "s", runId: run.id },
    } as unknown as RoomContext;
    await codeCommand(deps).handler(context, {
      entity: owner.id,
      room: owner.room,
      verb: "code",
      raw: "code status",
      args: "status",
      tokens: ["status"],
    });
    expect(status.at(-1)?.code).toMatchObject({
      event: "session_status",
      metadata: { workerState: "paused", workerReason: "7 model calls used", workerBudgetCalls: 7 },
    });
    error = true;
    pause = { kind: "upstream-errors", reason: "Provider backoff", since: Date.now() };
    emit();
    expect(notices.at(-1)?.code).toMatchObject({ metadata: { workerState: "recovering" } });
    expect(db.getCodingArtifact(run.id)?.status).toBe("active");
    pause = null;
    error = false;
    emit();
    expect(notices.at(-1)?.code).toMatchObject({ metadata: { workerState: "working" } });
    expect(db.getTaskClaim(codingRunMetadata(run).taskId, worker.id)).toEqual(claimBefore);
    expect(db.getCodingArtifact(run.id)?.metadata_json).toBe(run.metadata_json);
    endCodingRun(db, run.id, "cancelled", "operator stopped");
    const replacement = begin();
    const count = notices.length;
    pause = { kind: "budget", reason: "late old pause", since: Date.now() };
    emit();
    expect(notices).toHaveLength(count);
    expect(db.getCodingArtifact(replacement.id)?.status).toBe("active");
    expect(listeners.size).toBe(0);
  });

  it("does not infer work or zero cost from missing worker telemetry", () => {
    expect(codingWorkerState(undefined)).toMatchObject({ workerState: "unavailable" });
    const handle = { getStatus: () => ({ state: "autonomous" }) } as unknown as AgentHandle;
    expect(codingWorkerState(handle)).toMatchObject({ workerState: "unknown" });
    expect(codingWorkerState(handle).workerBudgetCalls).toBeUndefined();
  });

  it("refuses to publish superseded task status after asynchronous evidence assessment", async () => {
    const prior = begin();
    endCodingRun(db, prior.id, "cancelled", "operator stopped");
    const sent: unknown[] = [];
    const context = {
      codingTarget: { sessionId: "s" },
      send: (...args: unknown[]) => sent.push(args),
    } as unknown as RoomContext;
    const pending = codingStatus(context, owner.id, owner, {
      db,
      getEntity: (id: string) => (id === owner.id ? owner : worker),
    });
    const replacement = begin();
    await expect(pending).rejects.toThrow("Task evidence changed during status");
    expect(sent).toHaveLength(0);
    expect(db.getCodingArtifact(replacement.id)?.status).toBe("active");
  });

  it("persists owner intent, preserves it during steering, and refuses changing an existing contract", () => {
    const run = begin("s", "candidate");
    expect(codingRunMetadata(begin()).verificationRequirement).toBe("candidate");
    db.close();
    db = new MarinaDB(join(dir, "world.db"));
    expect(codingRunMetadata(db.getCodingArtifact(run.id)!).verificationRequirement).toBe(
      "candidate",
    );
    endCodingRun(db, run.id, "cancelled", "new task");
    begin();
    expect(() => begin("s", "candidate")).toThrow("already set");
    expect(db.listCodingRuns()).toHaveLength(2);
  });

  it("parses explicit leading requirements without interpreting task prose", () => {
    for (const raw of [
      "verification:candidate -- fix this",
      "--verification candidate fix this",
      "verification=candidate fix this",
    ])
      expect(parseCodingTask(raw)).toEqual({
        verificationRequirement: "candidate",
        ownerMode: undefined,
        prompt: "fix this",
      });
    expect(parseCodingTask("-- explain verification:candidate")).toEqual({
      prompt: "explain verification:candidate",
      verificationRequirement: undefined,
      ownerMode: undefined,
    });
    expect(
      parseCodingTask("explain verification:candidate").verificationRequirement,
    ).toBeUndefined();
    expect(() => parseCodingTask("verification:none task")).toThrow("Usage");
    expect(() => parseCodingTask("--verification")).toThrow("Usage");
  });

  it("limits unattended write recovery to the live designated worker and the owner-held lock", () => {
    const run = begin("s", "checks", "unattended");
    db.updateCodingSession("s", { writer: owner.name });
    const allowed = (actor = worker, target = worker.name) =>
      canReclaimCodingWriter(db, db.getCodingSession("s")!, actor, target);
    expect(allowed()).toBe(true);
    expect(allowed(owner)).toBe(false);
    expect(allowed(worker, "Collaborator")).toBe(false);
    db.updateCodingSession("s", { writer: "Collaborator" });
    expect(allowed()).toBe(false);
    db.updateCodingSession("s", { writer: owner.name });
    endCodingRun(db, run.id, "cancelled", "owner stopped it");
    expect(allowed()).toBe(false);
    begin();
    expect(allowed()).toBe(false);
    expect(() => begin("s", undefined, "unattended")).toThrow("owner contract");
  });

  it("keeps live checks bound to their task, workspace and last execution event", async () => {
    const run = begin("s", "checks");
    const summarize = () => submitCodingRun(db, "s", worker, artifact("summary"));
    expect((await summarize())?.status).toBe("active");
    const receipt = (command: string, workspace = dir) =>
      db.createCodingArtifact({
        sessionId: "s",
        kind: "verification",
        status: "complete",
        title: "Checks",
        contentText: "Measured checks",
        createdBy: worker.name,
        metadata: { executionTarget: "local", workspace, steps: [{ command, outcome: "passed" }] },
      });
    receipt("git diff --check");
    expect((await summarize())?.status).toBe("active");
    receipt("bun test", "/wrong/workspace");
    expect((await summarize())?.status).toBe("active");
    receipt("bun test");
    db.createCodingEvent({ sessionId: "s", actor: worker.name, kind: "file_written", payload: {} });
    expect(codingRunMetadata((await summarize())!).verification).toBe("stale");
    receipt("bun test");
    const submitted = (await summarize())!;
    expect(submitted.id).toBe(run.id);
    expect(submitted.status).toBe("submitted");
    expect(codingRunMetadata(submitted).verification).toBe("passed");
  });

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

  it("stores unbound live checks separately from submission and explicit approval", async () => {
    const run = begin();
    const verify = artifact("verification");
    const summary = artifact("summary");
    const submitted = (await submitCodingRun(db, "s", worker, summary))!;
    expect(submitted.status).toBe("submitted");
    const meta = codingRunMetadata(submitted);
    expect(meta).toMatchObject({
      verification: "unbound",
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

  it("does not treat an operator note, failed check, or changed workspace as verified work", async () => {
    begin();
    artifact("verification", "failed");
    const humanSummary = artifact("summary");
    expect(await submitCodingRun(db, "s", owner, humanSummary)).toBeUndefined();
    const failed = (await submitCodingRun(db, "s", worker, artifact("summary")))!;
    expect(codingRunMetadata(failed).verification).toBe("failed");
    begin();
    artifact("verification");
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "patch_applied",
      payload: {},
    });
    const changed = (await submitCodingRun(db, "s", worker, artifact("summary")))!;
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
    expect(await submitCodingRun(db, "s", worker, summary)).toBeUndefined();
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

  it.each([undefined, "checks", "candidate"] as const)(
    "runs Code Mode with real checks, owner review, and required=%s",
    async (required) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      writeFileSync(
        join(dir, "sample.test.ts"),
        'import { expect, test } from "bun:test"; test("check", () => expect(2 + 2).toBe(4));',
      );
      if (required === "candidate") {
        writeFileSync(join(dir, ".gitignore"), "world.db*\n");
        for (const args of [
          ["init", "--quiet", "--template="],
          ["add", "."],
          ["commit", "--quiet", "-m", "base"],
        ]) {
          const result = Bun.spawnSync(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
            { cwd: dir },
          );
          expect(result.exitCode).toBe(0);
        }
      }
      const pending: Promise<void>[] = [];
      const listeners = new Set<(event: AgentEvent) => void>();
      const messages: string[] = [];
      const attention: string[] = [];
      const handle = {
        name: "Worker",
        getStatus: () => ({ entityId: worker.id, role: "coder", state: "idle" }),
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
        verificationRunner: new VerificationRunner(db, (p) => pending.push(p)),
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
      if (required) {
        db.createCodingSession({
          id: "other",
          title: "Other",
          workspaceRoot: dir,
          createdBy: owner.name,
        });
        owner.properties.coding_session_id = "other";
      }
      const ctx = {
        send: (_id: string, message: string) => {
          messages.push(message);
        },
      } as unknown as RoomContext;
      const send = async (actor: Entity, text: string) =>
        command.handler(required ? { ...ctx, codingTarget: { sessionId: "s" } } : ctx, {
          entity: actor.id,
          room: actor.room,
          verb: "code",
          raw: `code ${text}`,
          args: text,
          tokens: text.split(/\s+/),
        });
      const request = required
        ? `Check the arithmetic test. ${"Additional task detail. ".repeat(80)}Keep the final constraint.`
        : "Check the arithmetic test";
      await send(
        owner,
        `do ${required ? `verification:${required} ${required === "checks" ? "owner:unattended " : ""}-- ` : ""}${request}`,
      );
      expect(attention[0]).toContain("Task #");
      if (required === "checks") {
        await send(worker, "handoff to:Owner -- progress for review");
        expect(db.getCodingSession("s")!.writer, messages.join("\n")).toBe(owner.name);
        await send(worker, "writer Worker");
        expect(db.getCodingSession("s")!.writer).toBe(worker.name);
        expect(
          db
            .listCodingEvents("s")
            .some(
              (event) =>
                event.kind === "writer_changed" &&
                JSON.parse(event.payload_json).reason === "owner_authorized_reclaim",
            ),
        ).toBe(true);
      }
      if (required) expect(owner.properties.coding_session_id).toBe("other");
      expect(db.listCodingRuns({ sessionId: "s", status: "active" })).toHaveLength(1);
      for (const listener of listeners)
        listener({ type: "tool_call", toolName: "marina_code", args: { action: "summary" } });
      expect(db.listCodingRuns({ status: "active" })).toHaveLength(1);
      const initial = db.listCodingRuns({ sessionId: "s", status: "active" })[0]!;
      if (required) {
        expect(attention[0]).toContain(
          required === "candidate"
            ? "Completion requires current candidate verification"
            : "Completion requires current task checks",
        );
        const reminder = String(worker.properties.coding_task).slice(0, 800);
        expect(reminder).toContain(`code show ${initial.id}`);
        expect(reminder).toContain(
          required === "candidate"
            ? "Completion requires current candidate verification"
            : "Completion requires current task checks",
        );
        expect(initial.content_text).toBe(request);
        expect(attention[0]).toContain("Finish source and regression-test edits before");
        await send(worker, "summary I forgot the verification");
        expect(db.getCodingArtifact(initial.id)?.status).toBe("active");
        expect(db.getTaskClaim(codingRunMetadata(initial).taskId, worker.id)?.status).toBe(
          "claimed",
        );
        expect(messages.join("\n")).toContain("Summary saved as progress; task remains active");
        expect(worker.properties.coding_task).toBeString();
        await send(worker, `review accept-unverified ${initial.id} I accept my own work`);
        expect(db.getCodingArtifact(initial.id)?.status).toBe("active");
        expect(
          codingRunMetadata(db.getCodingArtifact(initial.id)!).unverifiedAcceptance,
        ).toBeUndefined();
        expect(db.listCodingEvents("s").some((e) => e.kind === "verification_required")).toBe(true);
      }
      await send(worker, required === "candidate" ? "verify candidate" : "verify");
      await Promise.all(pending);
      if (required === "candidate") await send(worker, "run git status --short");
      await send(worker, "summary Arithmetic check passed");
      const run = db.listCodingRuns({ sessionId: "s", limit: 1 })[0]!;
      expect(run.status).toBe("submitted");
      expect(codingRunMetadata(run).verification).toBe(required ? "passed" : "unbound");
      expect(run.id).toBe(initial.id);
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
    },
  );
});
