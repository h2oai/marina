// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * "Ungated local, but host shell asks": under the IMPLICIT local profile
 * (local, autonomy neither `guarded` nor `sovereign`) the loopback PERSON runs
 * host commands with no prompt, while an AGENT's host shell and arbitrary
 * (non-allowlisted) host commands are held for a person to approve.
 * `MARINA_AUTONOMY=sovereign` lifts the hold for agents too.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dirname } from "node:path";
import { clearSessionExecState, getPendingExecApproval } from "../src/coding/exec-approver";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { codeCommand } from "../src/engine/commands/code";
import { shellExecRefusal } from "../src/engine/commands/run";
import { setPrincipalResolver } from "../src/engine/gate-context";
import type { Entity, EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

describe("run raw without a gate ledger", () => {
  afterEach(() => setPrincipalResolver(undefined));
  const agent = { id: "e_agent", name: "Agent", properties: { rank: 0 } } as unknown as Entity;

  it("implicit local holds an agent and passes the loopback person", () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_AUTONOMY: undefined },
    });
    // No resolver wired ⇒ fail closed (agent).
    expect(shellExecRefusal(undefined, agent, "run raw ls")).toContain("sovereign rank");
    setPrincipalResolver(() => "person");
    expect(shellExecRefusal(undefined, agent, "run raw ls")).toBeUndefined();
  });

  it("sovereign lifts it for an agent", () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_AUTONOMY: "sovereign" },
    });
    expect(shellExecRefusal(undefined, agent, "run raw ls")).toBeUndefined();
  });
});

describe("Code Mode arbitrary exec under the implicit local profile", () => {
  let f: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  let owner: ReturnType<typeof f.login>;
  let coder: ReturnType<typeof f.login>;
  const ownerOut: Perception[] = [];

  function setup(autonomy: string | undefined) {
    state = scopeProcessState({
      trustProfile: "local",
      rateLimitBypass: true,
      env: { MARINA_AUTONOMY: autonomy, MARINA_CHALLENGE_JUDGE: "off" },
    });
    f = createTestEngine({ storage: "disk" });
    f.db.saveAgentConfig({ name: "Coder", model: "x", spawnedBy: "Owner" });
    owner = f.login("Owner");
    coder = f.login("Coder");
    ownerOut.length = 0;
    const send = owner.connection.send.bind(owner.connection);
    owner.connection.send = (p) => {
      ownerOut.push(p);
      send(p);
    };
    const connections = new Map([
      [owner.entityId, owner.connection],
      [coder.entityId, coder.connection],
    ]);
    const root = dirname(f.path);
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        workspace: new LocalWorkspace(root),
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        findEntityExact: (name) => f.engine.entities.all().find((e) => e.name === name),
        getConnection: (id) => connections.get(id as EntityId),
        getConnectionProtocol: () => "websocket",
        notify: (id, text, metadata) =>
          f.engine.sendToEntity(id as EntityId, text, "code", metadata),
      }),
    );
    f.db.createCodingSession({ id: "s", title: "s", workspaceRoot: root, createdBy: "Owner" });
    f.db.updateCodingSession("s", { agent: "Coder" });
  }

  const commandOutputs = () =>
    f.db.listCodingArtifacts("s").filter((a) => a.kind === "command_output");
  const heldToken = () =>
    (ownerOut.findLast((p) => p.data.execApproval)?.data.execApproval as { token: string })?.token;

  beforeEach(() => {
    clearSessionExecState("s");
  });
  afterEach(async () => {
    clearSessionExecState("s");
    await f.dispose();
    state.dispose();
  });

  it("the person's own arbitrary command runs; the bound agent's is held for the person", async () => {
    setup(undefined);
    expect(f.engine.entities.get(owner.entityId)?.properties.rank).toBe(9);
    await f.engine.processCommand(owner.entityId, "code resume s");
    await f.engine.processCommand(owner.entityId, "code run echo owner-ran");
    expect(commandOutputs()).toHaveLength(1);
    expect(heldToken()).toBeUndefined();

    await f.engine.processCommand(coder.entityId, "code resume s");
    await f.engine.processCommand(coder.entityId, "code run echo agent-ran");
    expect(commandOutputs()).toHaveLength(1);
    const token = heldToken();
    expect(token).toBeDefined();
    expect(getPendingExecApproval(token!)?.sessionId).toBe("s");

    await f.engine.processCommand(owner.entityId, `code exec-approve ${token} once`);
    await f.engine.drainCommands();
    expect(commandOutputs()).toHaveLength(2);
    expect(commandOutputs().some((a) => a.content_text?.includes("agent-ran"))).toBe(true);
  });

  it("sovereign runs the bound agent's arbitrary command with no prompt", async () => {
    setup("sovereign");
    await f.engine.processCommand(coder.entityId, "code resume s");
    await f.engine.processCommand(coder.entityId, "code run echo agent-ran");
    expect(heldToken()).toBeUndefined();
    expect(commandOutputs()).toHaveLength(1);
  });
});
