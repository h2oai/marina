// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAssumptions, terminalCodeLifecycle } from "../scripts/code";
import type { AgentHandle } from "../src/agent/agent-types";
import { CodeSessionDriver } from "../src/coding/code-session-driver";
import {
  beginCodingRun,
  codingRunMetadata,
  UNATTENDED_BLOCK_ANSWERS,
} from "../src/coding/task-run";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { checkGate, grant } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

let f: ReturnType<typeof createTestEngine>;
let root: string;
let owner: ReturnType<typeof f.login>;
let run: CodingArtifactRow;
let state: DisposableStack;
const current = () => f.db.getCodingArtifact(run.id)!;
const meta = () => codingRunMetadata(current());
const send = async (command: string) => {
  await f.engine.dispatchCommand(owner.entityId, command, {
    codingTarget: { sessionId: "headless", runId: run.id },
  });
  await f.engine.drainCommands();
};
const lastText = () => owner.connection.allTextJoined();
/** The terminal lifecycle payload, as the headless CLI receives it. */
const lifecycle = () =>
  f.db
    .listCodingEvents("headless")
    .filter((event) => event.kind === "code_lifecycle")
    .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
    .findLast((payload) => payload.terminal === true);
const asPerception = (metadata: Record<string, unknown>, phase: string): Perception =>
  ({
    kind: "message",
    data: { code: { event: "code_lifecycle", sessionId: "headless", phase, metadata } },
    timestamp: Date.now(),
  }) as Perception;

function begin(ownerMode?: "unattended") {
  const actor = f.engine.entities.get(owner.entityId)!;
  run = beginCodingRun(f.db, {
    session: f.db.getCodingSession("headless")!,
    owner: actor,
    worker: actor,
    prompt: "Ship the report; keep the output stable and also change its format",
    profile: "marina",
    verificationRequirement: "checks",
    ...(ownerMode ? { ownerMode } : {}),
  });
}

beforeEach(() => {
  state = scopeProcessState({
    trustProfile: "shared",
    rateLimitBypass: true,
    env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
  });
  root = mkdtempSync(join(tmpdir(), "marina-unattended-block-"));
  writeFileSync(join(root, "report.ts"), "export const amount = 11;");
  writeFileSync(
    join(root, "report.test.ts"),
    'import {expect,test} from "bun:test"; import {amount} from "./report"; test("report",()=>expect(amount).toBe(11));',
  );
  f = createTestEngine();
  owner = f.login("Owner");
  const actor = f.engine.entities.get(owner.entityId)!;
  grant(f.db, owner.entityId, "code.exec");
  f.db.createCodingSession({
    id: "headless",
    title: "Headless",
    workspaceRoot: root,
    createdBy: actor.name,
  });
  f.db.updateCodingSession("headless", { agent: actor.name, writer: actor.name });
  f.engine.commands.registerBuiltin(
    codeCommand({
      db: f.db,
      workspaceRegistry: new WorkspaceRegistry({ roots: [root] }),
      getEntity: (id) => f.engine.entities.get(id as EntityId),
      getConnectionProtocol: () => "websocket",
    }),
  );
});
afterEach(async () => {
  await f.dispose();
  rmSync(root, { recursive: true, force: true });
  state.dispose();
});

it("answers an unattended requirements-conflict block at once and completes with the assumption recorded", async () => {
  begin("unattended");
  await send(
    "code blocked Requirements conflict: keep the output stable vs change its format; need an explicit exemption",
  );
  expect(current().status).toBe("active");
  expect(lastText()).toContain("answered now");
  expect(lastText()).toContain("grants no authority");
  expect(meta().blocksAnswered).toBe(1);
  expect(meta().assumptions?.[0]).toMatchObject({ source: "block" });
  expect(meta().assumptions?.[0]?.text).toContain("Requirements conflict");
  expect(f.db.getTask(meta().taskId)?.status).toBe("claimed");

  await send("code assume The new format is the goal; the stable output means stable values");
  expect(meta().assumptions?.map((a) => a.source)).toEqual(["block", "worker"]);
  await send("code recipe save default bun test report.test.ts");
  await send("code verify");
  await send("code summary Report shipped in the new format");
  expect(current().status, lastText()).toBe("submitted");
  expect(meta().verification).toBe("passed");

  const submitted = f.db.getTaskClaim(meta().taskId, owner.entityId);
  expect(submitted?.submission_text).toContain("Assumptions (no person could answer):");
  expect(submitted?.submission_text).toContain("the stable output means stable values");
  const payload = lifecycle()!;
  expect(payload.phase).toBe("completed");
  const end = terminalCodeLifecycle(asPerception(payload, "completed"))!;
  expect(end.assumptions).toEqual([
    expect.objectContaining({ source: "block" }),
    { source: "worker", text: "The new format is the goal; the stable output means stable values" },
  ]);
  expect(formatAssumptions(end.assumptions)).toContain("[answered block] Unanswered");
});

it("ends a worker that keeps blocking after the bound, with a clear reason and its work kept", async () => {
  begin("unattended");
  writeFileSync(join(root, "report.ts"), "export const amount = 11; // partial");
  for (let i = 0; i < UNATTENDED_BLOCK_ANSWERS; i++) {
    await send(`code blocked Still unsure which format to use (${i})`);
    expect(current().status).toBe("active");
  }
  await send("code blocked Still unsure which format to use (final)");
  expect(current().status).toBe("interrupted");
  expect(meta().reason).toBe(
    `Blocked: Still unsure which format to use (final) (after ${UNATTENDED_BLOCK_ANSWERS} automatic answers)`,
  );
  expect(readFileSync(join(root, "report.ts"), "utf8")).toContain("partial");
  const end = terminalCodeLifecycle(asPerception(lifecycle()!, "failed"))!;
  expect(end).toMatchObject({ phase: "failed", reason: "blocked", runId: run.id });
  expect(end.detail).toContain("after 2 automatic answers");
  expect(end.assumptions).toHaveLength(UNATTENDED_BLOCK_ANSWERS);
});

it("ends an unattended task at once on a declared impossibility", async () => {
  begin("unattended");
  await send("code blocked kind:impossible Private registry credentials unavailable");
  expect(current().status).toBe("interrupted");
  expect(meta().reason).toBe("Blocked: Private registry credentials unavailable");
  expect(meta().blocksAnswered).toBeUndefined();
});

it("keeps today's behavior for an attended task: the block ends the attempt and notifies", async () => {
  begin();
  await send("code blocked Requirements conflict between two rules");
  expect(current().status).toBe("interrupted");
  expect(meta().reason).toBe("Blocked: Requirements conflict between two rules");
  expect(meta().assumptions).toBeUndefined();
  expect(f.db.getTask(meta().taskId)?.status).toBe("open");
});

it("never grants authority when an unattended block asks for it", async () => {
  begin("unattended");
  const before = checkGate(f.db, owner.entityId, "code.exec.unrestricted");
  expect(before.ok).toBe(false);
  await send(
    "code blocked Need permission to install a dependency and code.exec.unrestricted to run it",
  );
  expect(current().status).toBe("active");
  expect(lastText()).toContain("grants no authority");
  expect(checkGate(f.db, owner.entityId, "code.exec.unrestricted").ok).toBe(false);
  expect(checkGate(f.db, owner.entityId, "shell.exec").ok).toBe(false);
  // The command policy is unchanged: a non-allowlisted install is still refused.
  await send("code run npm install left-pad");
  expect(lastText()).not.toContain("added 1 package");
  expect(f.db.listCodingArtifacts("headless", 50).some((a) => a.kind === "exec_decision")).toBe(
    false,
  );
});

it("states the unattended block contract in the worker's assignment", async () => {
  const actor = f.engine.entities.get(owner.entityId)!;
  let attention = "";
  const handle = {
    name: "worker",
    getStatus: () => ({ entityId: actor.id }),
    sendAttention: async (text: string) => {
      attention = text;
    },
  } as unknown as AgentHandle;
  const driver = new CodeSessionDriver({
    db: f.db,
    agentRuntime: { get: () => handle },
    getEntity: (id) => f.engine.entities.get(id as EntityId),
  });
  await driver.assignAgent({
    actor: actor.name,
    actorEntity: actor,
    agentName: "worker",
    profile: "marina",
    prompt: "Ship the report",
    session: f.db.getCodingSession("headless")!,
    verificationRequirement: "checks",
    ownerMode: "unattended",
  });
  expect(attention).toContain("code assume <text>");
  expect(attention).toContain("code blocked kind:impossible");
});
