// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dirname } from "node:path";
import {
  clearSessionExecState,
  getPendingExecApproval,
  OPERATOR_APPROVED_REASON,
  settleExecApproval,
} from "../src/coding/exec-approver";
import { LocalWorkspace } from "../src/coding/local-workspace";
import type { CommandExecutionOptions } from "../src/engine/command-phase-coordinator";
import { correlateCommandPerception, withCommandResponse } from "../src/engine/command-response";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

describe("coding exec approval replay", () => {
  let f: ReturnType<typeof createTestEngine>;
  let owner: ReturnType<typeof f.login>;
  let scope: DisposableStack;
  const output: Perception[] = [];
  let runId: string;
  beforeEach(async () => {
    scope = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGE_JUDGE: "off" },
    });
    f = createTestEngine({ storage: "disk" });
    owner = f.login("Owner");
    const entity = f.engine.entities.get(owner.entityId)!;
    entity.properties.rank = 9;
    grant(f.db, entity.id, "code.exec");
    const root = dirname(f.path);
    output.length = 0;
    owner.connection.send = (p) => {
      output.push(correlateCommandPerception(owner.connection.id, p));
    };
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        workspace: new LocalWorkspace(root),
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        findEntityExact: (name) => f.engine.entities.all().find((e) => e.name === name),
        getConnection: () => owner.connection,
        getConnectionProtocol: () => "websocket",
        notify: (id, text, metadata) =>
          f.engine.sendToEntity(id as EntityId, text, "code", metadata),
      }),
    );
    for (const id of ["a", "b"]) {
      f.db.createCodingSession({ id, title: id, workspaceRoot: root, createdBy: entity.name });
      await f.engine.processCommand(entity.id, `code resume ${id}`);
      await f.engine.processCommand(entity.id, "code exec-mode prompt");
    }
    runId = f.db.createCodingArtifact({
      sessionId: "b",
      kind: "task_run",
      title: "Attempt",
      status: "active",
      contentText: "",
      metadata: { taskId: 1 },
      createdBy: entity.name,
    }).id;
    await f.engine.processCommand(entity.id, "code resume a");
    output.length = 0;
  });
  afterEach(async () => {
    clearSessionExecState("a");
    clearSessionExecState("b");
    await f.dispose();
    scope.dispose();
  });
  function execute(raw: string, options?: CommandExecutionOptions): Promise<void> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const admitted = f.engine.submitCommand(owner.entityId, raw, async () => {
        try {
          await withCommandResponse(
            owner.connection.id,
            id,
            () => f.engine.processCommand(owner.entityId, raw, options),
            (p) => owner.connection.send(p),
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      if (!admitted) reject(new Error("fixture admission failed"));
    });
  }
  const target = () => ({ codingTarget: { sessionId: "b", runId } });
  function token(): string {
    const p = output.findLast((p) => p.data.execApproval);
    return (p!.data.execApproval as { token: string }).token;
  }
  function commands(session = "b") {
    return f.db.listCodingArtifacts(session).filter((a) => a.kind === "command_output");
  }

  for (const explicit of [true, false])
    it(`${explicit ? "targeted" : "legacy"} held exec keeps its session/run and releases the operator for communication`, async () => {
      if (!explicit) await execute("code resume b");
      await execute("code run echo replay-original", explicit ? target() : undefined);
      const held = token();
      expect(getPendingExecApproval(held)?.sessionId).toBe("b");
      expect(commands()).toHaveLength(0);
      await execute("/say still here while approval is pending");
      expect(output.some((p) => String(p.data.text).includes("still here"))).toBe(true);
      await execute("code resume a");
      const before = output.length;
      await execute(`code exec-approve ${held} once`);
      await f.engine.drainCommands();
      expect(commands()).toHaveLength(1);
      expect(commands()[0]?.content_text).toContain("replay-original");
      expect(JSON.parse(commands()[0]!.metadata_json).runId).toBe(runId);
      expect(commands("a")).toEqual([]);
      expect(f.engine.entities.get(owner.entityId)?.properties.coding_session_id).toBe("a");
      const replayOutput = output
        .slice(before)
        .find((p) => (p.data.code as { event?: string })?.event === "command_ran");
      expect(replayOutput).toBeDefined();
      expect(replayOutput?.command_request_id).toBeUndefined();
      const approval = f.db
        .listCodingArtifacts("b")
        .find(
          (a) =>
            a.kind === "exec_decision" &&
            JSON.parse(a.metadata_json).reason === OPERATOR_APPROVED_REASON,
        )!;
      expect(JSON.parse(approval.metadata_json).runId).toBe(runId);
      await execute("code run echo replay-original", target());
      expect(token()).not.toBe(held);
      expect(commands()).toHaveLength(1); // once really is once
    });

  it("queues a replay behind existing work and discards approval when its run becomes stale", async () => {
    await execute("code run echo must-not-run", target());
    const held = token();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.engine.commands.registerOwned("fixture", {
      name: "replaybarrier",
      help: "Test barrier",
      async handler() {
        entered.resolve();
        await release.promise;
      },
    });
    const pending = execute("/replaybarrier");
    try {
      await entered.promise;
      expect(
        settleExecApproval(held, {
          approved: true,
          scope: "once",
          reason: OPERATOR_APPROVED_REASON,
        }),
      ).toBe(true);
      expect(f.engine.commandAdmission.pending).toBeGreaterThan(1);
      f.db.updateCodingArtifact(runId, { status: "interrupted" });
      release.resolve();
      await pending;
      await f.engine.drainCommands();
      expect(commands()).toEqual([]);
      expect(
        output.some((p) => String(p.data.text).includes("not the session's active attempt")),
      ).toBe(true);
      runId = f.db.createCodingArtifact({
        sessionId: "b",
        kind: "task_run",
        title: "Replacement",
        status: "active",
        contentText: "",
        metadata: { taskId: 2 },
        createdBy: "Owner",
      }).id;
      await execute("code run echo must-not-run", target());
      expect(token()).not.toBe(held);
      expect(commands()).toEqual([]); // no leftover ambient grant for the replacement
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("revalidates a bound worker's session access before replay", async () => {
    const worker = f.login("Worker");
    grant(f.db, worker.entityId, "code.exec");
    f.db.updateCodingSession("b", { agent: "Worker" });
    await f.engine.processCommand(worker.entityId, "code run echo revoked-worker", target());
    const held = token();
    f.db.updateCodingSession("b", { agent: null });
    await execute(`code exec-approve ${held} once`);
    await f.engine.drainCommands();
    expect(commands()).toEqual([]);
    expect(worker.connection.allText().join("\n")).toContain("not authorized");
  });

  it("does not let an identical queued request consume the approved replay's authority", async () => {
    const raw = "code run echo once-only";
    await execute(raw, target());
    const held = token();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.engine.commands.registerOwned("fixture", {
      name: "replaybarrier",
      help: "Test barrier",
      async handler() {
        entered.resolve();
        await release.promise;
      },
    });
    const blocked = execute("/replaybarrier");
    let identical: Promise<void> | undefined;
    try {
      await entered.promise;
      identical = execute(raw, target());
      settleExecApproval(held, { approved: true, scope: "once", reason: OPERATOR_APPROVED_REASON });
      release.resolve();
      await Promise.all([blocked, identical]);
      await f.engine.drainCommands();
      expect(commands()).toHaveLength(1);
      expect(token()).not.toBe(held);
      expect(getPendingExecApproval(token())).toBeDefined();
    } finally {
      release.resolve();
      await Promise.all([blocked, identical]);
    }
  });

  it("clearing a session revokes a queued once approval even without a task attempt", async () => {
    f.db.updateCodingArtifact(runId, { status: "interrupted" });
    await execute("code run echo closed-session", { codingTarget: { sessionId: "b" } });
    const held = token();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.engine.commands.registerOwned("fixture", {
      name: "replaybarrier",
      help: "Test barrier",
      async handler() {
        entered.resolve();
        await release.promise;
      },
    });
    const blocked = execute("/replaybarrier");
    try {
      await entered.promise;
      settleExecApproval(held, { approved: true, scope: "once", reason: OPERATOR_APPROVED_REASON });
      clearSessionExecState("b");
      release.resolve();
      await blocked;
      await f.engine.drainCommands();
      expect(commands()).toEqual([]);
      expect(token()).toBe(held); // a revoked replay must not open a replacement prompt
      const denial = f.db
        .listCodingArtifacts("b")
        .find(
          (a) =>
            a.kind === "exec_decision" &&
            JSON.parse(a.metadata_json).reason === "session execution authority cleared",
        );
      expect(denial?.status).toBe("denied");
    } finally {
      release.resolve();
      await blocked;
    }
  });

  it("explicit exec-mode off revokes pending approvals and overrides local automatic execution", async () => {
    await execute("code run echo pending-off", target());
    const held = token();
    using _local = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_AUTONOMY: undefined },
    });
    await execute("code resume b");
    await execute("code exec-mode off");
    await execute("code resume a");
    expect(getPendingExecApproval(held)).toBeUndefined();
    await execute("code run echo pending-off", target());
    await f.engine.drainCommands();
    expect(commands()).toEqual([]);
    expect(token()).toBe(held);
    expect(settleExecApproval(held, { approved: true, scope: "once" })).toBe(false);
  });
});
