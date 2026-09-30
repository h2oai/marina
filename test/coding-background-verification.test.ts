// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { LocalWorkspace, type WorkspaceRunResult } from "../src/coding/local-workspace";
import {
  beginCodingRun,
  codingRunMetadata,
  endCodingRun,
  submitCodingRun,
} from "../src/coding/task-run";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { correlateCommandPerception, withCommandResponse } from "../src/engine/command-response";
import { codeCommand } from "../src/engine/commands/code";
import { grant, revoke } from "../src/engine/safety-gates";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

describe("finite background verification", () => {
  let f: ReturnType<typeof createTestEngine>;
  let owner: ReturnType<typeof f.login>;
  let state: DisposableStack;
  let workspace: LocalWorkspace;
  let runner: VerificationRunner;
  let entered: ReturnType<typeof Promise.withResolvers<void>>;
  let release: ReturnType<typeof Promise.withResolvers<void>>;
  let calls: string[][];
  let output: Perception[];
  let result: Partial<WorkspaceRunResult>;
  let checkAfterWait: boolean;
  let protocol: "websocket" | "telnet";
  beforeEach(() => {
    state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
    });
    f = createTestEngine({ storage: "disk" });
    owner = f.login("Owner");
    const actor = f.engine.entities.get(owner.entityId)!;
    grant(f.db, actor.id, "code.exec");
    for (const id of ["a", "b"])
      f.db.createCodingSession({
        id,
        title: id,
        workspaceRoot: dirname(f.path),
        createdBy: actor.name,
      });
    actor.properties.coding_session_id = "a";
    actor.properties.active_modal = "code";
    actor.properties.code_context = { sessionId: "a" };
    entered = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    calls = [];
    output = [];
    result = {};
    checkAfterWait = false;
    protocol = "websocket";
    workspace = new LocalWorkspace(dirname(f.path));
    workspace.read = async () => {
      throw new Error("No package.json");
    };
    const run = async (command: string[], beforeSpawn = () => {}) => {
      if (!checkAfterWait) beforeSpawn();
      calls.push(command);
      entered.resolve();
      await release.promise;
      if (checkAfterWait) beforeSpawn();
      return {
        command,
        exitCode: 0,
        output: "checks finished",
        truncated: false,
        timedOut: false,
        durationMs: 1,
        ...result,
      };
    };
    workspace.runAllowlisted = run;
    workspace.run = (command) => run(command);
    runner = new VerificationRunner(f.db, (pending) => f.engine.trackBackgroundCommand(pending));
    const registry = new WorkspaceRegistry({ roots: [dirname(f.path)] });
    registry.workspaceForRoot = () => workspace;
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        workspace,
        workspaceRegistry: registry,
        verificationRunner: runner,
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        getConnectionProtocol: () => protocol,
      }),
    );
    owner.connection.send = (p) => output.push(correlateCommandPerception(owner.connection.id, p));
  });
  afterEach(async () => {
    release.resolve();
    await f.dispose();
    state.dispose();
  });
  const actor = () => f.engine.entities.get(owner.entityId)!;
  function send(raw: string, sessionId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const accepted = f.engine.submitCommand(owner.entityId, raw, async () => {
        try {
          await withCommandResponse(
            owner.connection.id,
            raw,
            () =>
              f.engine.processCommand(
                owner.entityId,
                raw,
                sessionId ? { codingTarget: { sessionId } } : { bypassModal: true },
              ),
            (p) => owner.connection.send(p),
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      if (!accepted) reject(new Error("admission refused"));
    });
  }
  const receipt = (id = "b") =>
    f.db.listCodingArtifacts(id).find((a) => a.kind === "verification_request")!;
  const final = (id = "b") => f.db.listCodingArtifacts(id).find((a) => a.kind === "verification");
  function recipe(commands: string[]) {
    f.db.createCodingArtifact({
      sessionId: "b",
      kind: "run_recipe",
      title: "default",
      status: "active",
      contentText: commands.join("\n"),
      metadata: { name: "default", commands },
      createdBy: "Owner",
    });
  }

  it("acknowledges admission, frees the same resident for world messages, and drains before shutdown", async () => {
    await send("code verify start", "b");
    await entered.promise;
    expect(receipt().status).toBe("running");
    expect(final()).toBeUndefined();
    expect(output.find((p) => p.data.command_result)?.data.command_result).toMatchObject({
      ok: true,
    });
    await send("say still participating");
    expect(output.some((p) => JSON.stringify(p).includes("still participating"))).toBe(true);
    let drained = false;
    const pending = f.engine.drainCommands().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await pending;
    expect(receipt().status).toBe("complete");
    expect(JSON.parse(receipt().metadata_json).resultArtifactId).toBe(final()?.id);
    const events = output.filter((p) =>
      ["verification_ran", "verification_finished"].includes(
        (p.data.code as { event?: string })?.event ?? "",
      ),
    );
    expect(events).toHaveLength(2);
    expect(events.every((p) => p.command_request_id === undefined)).toBe(true);
    expect(actor().properties.coding_session_id).toBe("a");
    expect(actor().properties.code_context).toEqual({ sessionId: "a" });
    await send(`code show ${receipt().id}`, "b");
    expect(
      output.some((p) => String(p.data.text).includes(`Result: code show ${final()?.id}`)),
    ).toBe(true);
  });

  it("preserves foreground verification completion and per-resident FIFO", async () => {
    let finished = false;
    const verification = send("code verify", "b").then(() => {
      finished = true;
    });
    await entered.promise;
    const message = send("say after verification");
    expect(finished).toBe(false);
    expect(output.some((p) => JSON.stringify(p).includes("after verification"))).toBe(false);
    expect(receipt()).toBeUndefined();
    release.resolve();
    await Promise.all([verification, message]);
    expect(final()?.status).toBe("complete");
    expect(output.some((p) => String(p.data.text).includes("after verification"))).toBe(true);
  });

  it("keeps the same resident responsive while a real local subprocess runs", async () => {
    const root = dirname(f.path);
    const finished = join(root, "finish-check");
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "bun check.ts" } }),
    );
    await Bun.write(
      join(root, "check.ts"),
      `await Bun.write("check-started", "yes");
while (!(await Bun.file("finish-check").exists())) await Bun.sleep(5);
console.log("real verification completed");`,
    );
    workspace = new LocalWorkspace(root);
    try {
      await send("code verify start", "b");
      await until(() => existsSync(join(root, "check-started")), { timeoutMs: 3000 });
      await send("say responsive during a real check");
      expect(receipt().status).toBe("running");
      expect(
        output.some((p) => String(p.data.text).includes("responsive during a real check")),
      ).toBe(true);
    } finally {
      await Bun.write(finished, "yes");
      await f.engine.drainCommands();
    }
    expect(receipt().status).toBe("complete");
    expect(
      f.db.listCodingArtifacts("b").find((a) => a.kind === "command_output")?.content_text,
    ).toContain("real verification completed");
  });

  it("keeps evidence durable but stops delivering it after bound-agent access is revoked", async () => {
    f.db.createCodingSession({
      id: "shared",
      title: "shared",
      workspaceRoot: dirname(f.path),
      createdBy: "SomeoneElse",
    });
    f.db.updateCodingSession("shared", { agent: "Owner" });
    await send("code verify start", "shared");
    await entered.promise;
    f.db.updateCodingSession("shared", { agent: null });
    const count = output.length;
    release.resolve();
    await f.engine.drainCommands();
    expect(receipt("shared").status).toBe("complete");
    expect(final("shared")?.status).toBe("complete");
    expect(output).toHaveLength(count);
    expect(actor().properties.code_context).toEqual({ sessionId: "a" });
  });

  it("rejects duplicate workspace admission without blocking messages or starting a second check", async () => {
    await send("code verify start", "b");
    await send("code verify start", "a");
    expect(calls).toHaveLength(1);
    expect(receipt("a")).toBeUndefined();
    expect(output.some((p) => String(p.data.text).includes("already running"))).toBe(true);
  });

  it("preflights the entire recipe and refuses arbitrary shell commands even with an approver", async () => {
    recipe(["git diff --check", "node -e danger"]);
    let approved = false;
    workspace.attachExecApprover(
      {
        requestApproval: async () => {
          approved = true;
          return { approved: true, reason: "test" };
        },
      },
      owner.entityId,
    );
    await send("code verify start", "b");
    expect(calls).toHaveLength(0);
    expect(approved).toBe(false);
    expect(receipt()).toBeUndefined();
    expect(output.at(-1)?.data.command_result).toMatchObject({ ok: false });
  });

  it.each(["gate", "writer", "target", "attempt", "session", "transport"])(
    "revalidates %s after a workspace wait, before spawning",
    async (change) => {
      checkAfterWait = true;
      await send("code verify start", "b");
      await entered.promise;
      if (change === "gate") revoke(f.db, owner.entityId, "code.exec");
      if (change === "writer") f.db.updateCodingSession("b", { writer: "Other" });
      if (change === "target") f.db.updateCodingSession("b", { executionTarget: "flywheel" });
      if (change === "attempt")
        beginCodingRun(f.db, {
          session: f.db.getCodingSession("b")!,
          owner: actor(),
          worker: actor(),
          prompt: "next",
          profile: "marina",
        });
      if (change === "session") f.db.updateCodingSession("b", { status: "complete" });
      if (change === "transport") protocol = "telnet";
      release.resolve();
      await f.engine.drainCommands();
      expect(receipt().status).toBe("failed");
      expect(final()).toBeUndefined();
    },
  );

  it("stops a recipe after failure or timeout", async () => {
    recipe(["git diff --check", "git status --short"]);
    result = { timedOut: true };
    await send("code verify start", "b");
    release.resolve();
    await f.engine.drainCommands();
    expect(calls).toHaveLength(1);
    expect(receipt().status).toBe("failed");
    expect(final()?.status).toBe("failed");
  });

  it("keeps late evidence on the original attempt, and does not launch remaining checks into a new attempt", async () => {
    const original = beginCodingRun(f.db, {
      session: f.db.getCodingSession("b")!,
      owner: actor(),
      worker: actor(),
      prompt: "first",
      profile: "marina",
    });
    recipe(["git diff --check", "git status --short"]);
    await send("code verify start", "b");
    await entered.promise;
    endCodingRun(f.db, original.id, "interrupted", "test");
    const next = beginCodingRun(f.db, {
      session: f.db.getCodingSession("b")!,
      owner: actor(),
      worker: actor(),
      prompt: "next",
      profile: "marina",
    });
    release.resolve();
    await f.engine.drainCommands();
    expect(calls).toHaveLength(1);
    expect(receipt().status).toBe("failed");
    const command = f.db.listCodingArtifacts("b").find((a) => a.kind === "command_output")!;
    expect(JSON.parse(command.metadata_json).runId).toBe(original.id);
    expect(f.db.listCodingRunArtifacts(next.id)).toEqual([]);
  });

  it("does not reuse an older passing verification while a newer request is running", async () => {
    const run = beginCodingRun(f.db, {
      session: f.db.getCodingSession("b")!,
      owner: actor(),
      worker: actor(),
      prompt: "work",
      profile: "marina",
    });
    f.db.createCodingArtifact({
      sessionId: "b",
      kind: "verification",
      title: "old",
      status: "complete",
      contentText: "passed",
      createdBy: "Owner",
    });
    await send("code verify start", "b");
    const summary = f.db.createCodingArtifact({
      sessionId: "b",
      kind: "summary",
      title: "summary",
      contentText: "done",
      createdBy: "Owner",
    });
    await submitCodingRun(f.db, "b", actor(), summary);
    expect(codingRunMetadata(f.db.getCodingArtifact(run.id)!).verification).toBe("missing");
  });

  it("recovers unfinished receipts as uncertain without replay and preserves completed evidence", async () => {
    release.resolve();
    await send("code verify start", "b");
    await f.engine.drainCommands();
    const completed = receipt();
    const lost = f.db.createCodingArtifact({
      sessionId: "b",
      kind: "verification_request",
      title: "lost",
      status: "running",
      contentText: "git diff --check",
      createdBy: "Owner",
    });
    f.db.recoverCodingVerifications();
    f.db.recoverCodingVerifications();
    expect(f.db.getCodingArtifact(lost.id)?.status).toBe("interrupted");
    expect(JSON.parse(f.db.getCodingArtifact(lost.id)!.metadata_json).error).toContain("unknown");
    expect(f.db.getCodingArtifact(completed.id)?.status).toBe("complete");
    expect(calls).toHaveLength(1);
  });

  it("bounds concurrent roots and recipe length; canonicalizes aliases; releases slots on error", async () => {
    const input = {
      sessionId: "b",
      actor: "Owner",
      root: dirname(f.path),
      commands: ["git diff --check"],
      execute: async () => {
        await release.promise;
        throw new Error("failed to spawn");
      },
      notify: () => {},
    };
    runner.start(input);
    const alias = join(dirname(f.path), "alias");
    symlinkSync(dirname(f.path), alias);
    expect(() => runner.start({ ...input, root: alias })).toThrow("already running");
    for (let i = 0; i < 3; i++) {
      const root = join(dirname(f.path), `root${i}`);
      mkdirSync(root);
      runner.start({ ...input, root });
    }
    const extra = join(dirname(f.path), "extra");
    mkdirSync(extra);
    expect(() => runner.start({ ...input, root: extra })).toThrow("capacity reached");
    release.resolve();
    await f.engine.drainCommands();
    expect(() => runner.start({ ...input, commands: Array(9).fill("git diff --check") })).toThrow(
      "1 and 8",
    );
    runner.start(input);
    await f.engine.drainCommands();
    expect(receipt().status).toBe("failed");
  });

  it("the real local execution path never consults an approver and rechecks authority under its root lock", async () => {
    const local = new LocalWorkspace(dirname(f.path));
    let consulted = false;
    local.attachExecApprover(
      {
        requestApproval: async () => {
          consulted = true;
          return { approved: true, reason: "test" };
        },
      },
      owner.entityId,
    );
    await expect(local.runAllowlisted(["node", "--version"], () => {})).rejects.toThrow(
      "not allowed",
    );
    await expect(
      local.runAllowlisted(["git", "diff", "--check"], () => {
        throw new Error("revoked before spawn");
      }),
    ).rejects.toThrow("revoked before spawn");
    expect(consulted).toBe(false);
    local.setHostExecForbidden(true);
    await expect(local.runAllowlisted(["git", "diff", "--check"], () => {})).rejects.toThrow(
      "telnet",
    );
  });
});
