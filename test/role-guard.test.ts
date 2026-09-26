// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import { agentCommand } from "../src/engine/commands/agent";
import { roleCommand } from "../src/engine/commands/role";
import { traitCommand } from "../src/engine/commands/trait";
import { boundRoleOf, refuseOwnRole } from "../src/engine/role-guard";
import { grant } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { cleanupDb, stripAnsi } from "./helpers";

const DB = `test_role_guard_${process.pid}.db`;
let db: MarinaDB;
let out: string[];
const ctx = { send: (_e: string, t: string) => out.push(stripAnsi(t)) } as unknown as RoomContext;
const input = (entity: string, line: string) => {
  const tokens = line.split(/\s+/).slice(1);
  return { entity: entity as EntityId, tokens, args: tokens.join(" "), raw: line } as never;
};
const entity = (id: string, name: string, rank: number) =>
  ({ id, name, kind: "agent", properties: { rank } }) as unknown as Entity;

// Scout runs on role "scout"; Ops is an operator with no role of its own.
const scout = entity("e_scout", "Scout", 4);
const ops = entity("e_ops", "Ops", 4);
const agents = [{ name: "Scout", role: "scout", state: "autonomous" }];
const byId = (id: EntityId) => ({ e_scout: scout, e_ops: ops })[id as string];

beforeEach(() => {
  db = new MarinaDB(DB);
  out = [];
  db.saveTrait({ name: "curious", category: "cognitive", prompt: "Ask why.", createdBy: "seed" });
  db.saveTrait({ name: "terse", category: "style", prompt: "Be brief.", createdBy: "seed" });
  db.saveRole({ name: "scout", traits: ["curious"], createdBy: "seed" });
  db.saveRole({ name: "writer", traits: ["terse"], createdBy: "seed" });
});
afterEach(() => {
  db.close();
  cleanupDb(DB);
});

describe("an agent improves by spawning a successor, never by rewriting itself", () => {
  const role = () =>
    roleCommand({
      db,
      getEntity: byId,
      listAgents: () => agents,
      reconfigureAgent: async () => {},
    });

  it("finds the role an entity runs on", () => {
    expect(boundRoleOf(scout, agents)).toBe("scout");
    expect(boundRoleOf(ops, agents)).toBeUndefined();
    expect(boundRoleOf({ name: "Chron", properties: { role: "chronicler" } } as never)).toBe(
      "chronicler",
    );
    expect(refuseOwnRole(scout, "SCOUT", agents)).toContain("role create scout-v2");
  });

  it("refuses editing, deleting or reloading your own role — even with the gate", async () => {
    grant(db, "e_scout", "role.edit");
    for (const line of ["role edit scout tone blunt", "role delete scout", "role reload scout"]) {
      out = [];
      await role().handler(ctx, input("e_scout", line));
      expect(out.join("\n")).toContain("no one changes the role they are running on");
      expect(out.join("\n")).toContain("agent spawn");
    }
    expect(db.getRole("scout")).toBeDefined();
  });

  it("lets anyone of rank 3+ create a successor role — nothing runs on it yet", async () => {
    await role().handler(ctx, input("e_scout", "role create scout-v2 traits curious,terse"));
    expect(out.join("\n")).toContain('Role "scout-v2" created');
  });

  it("gates changing someone else's existing role behind role.edit", async () => {
    await role().handler(ctx, input("e_ops", "role edit writer tone warm"));
    expect(out.join("\n")).toMatch(/role\.edit|witness|standing/);
    out = [];
    grant(db, "e_ops", "role.edit");
    await role().handler(ctx, input("e_ops", "role edit writer tone warm"));
    expect(out.join("\n")).toContain('Role "writer" updated');
  });

  it("refuses deleting a trait your own role is built from; gates other deletions", async () => {
    const trait = traitCommand({ db, getEntity: byId, listAgents: () => agents });
    grant(db, "e_scout", "role.edit");
    await trait.handler(ctx, input("e_scout", "trait delete curious"));
    expect(out.join("\n")).toContain('part of your role "scout"');
    expect(db.getTrait("curious")).toBeDefined();
    out = [];
    await trait.handler(ctx, input("e_ops", "trait delete terse"));
    expect(db.getTrait("terse")).toBeDefined();
    grant(db, "e_ops", "role.edit");
    await trait.handler(ctx, input("e_ops", "trait delete terse"));
    expect(db.getTrait("terse")).toBeUndefined();
  });

  it("refuses `agent config <self> role`, pointing at the successor path", async () => {
    let reconfigured = 0;
    const runtime = {
      get: () => ({}),
      list: () => agents,
      reconfigure: async () => {
        reconfigured++;
      },
    } as unknown as AgentRuntime;
    const cmd = agentCommand({ agentRuntime: runtime, getEntity: byId, db } as never);
    await cmd.handler(ctx, input("e_scout", "agent config Scout role writer"));
    expect(out.join("\n")).toContain("No one changes the role they are running on");
    expect(reconfigured).toBe(0);
  });
});
