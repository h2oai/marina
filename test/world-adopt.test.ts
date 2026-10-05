// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evolveCommand, resetEvolveTrialForTests } from "../src/engine/commands/evolve";
import { worldCommand } from "../src/engine/commands/world";
import type { TrialDeps } from "../src/engine/evolution-trial";
import { grant } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { adoptionLog } from "../src/world/adoption";
import { WorldCollectiveManager } from "../src/world/world-collective-manager";
import { stripAnsi, until } from "./helpers";
import { scopeProperty } from "./process-state";

const person = (id: string, name: string) =>
  ({ id, name, properties: { rank: 9 } }) as unknown as Entity;
const alice = person("e_alice", "Alice");
const bob = person("e_bob", "Bob");

let dir: string;
let parent: MarinaDB;
let child: MarinaDB;
let out: string[];
const ctx = { send: (_e: string, t: string) => out.push(stripAnsi(t)) } as unknown as RoomContext;
const line = (who: Entity, text: string) => {
  const tokens = text.split(/\s+/).slice(1);
  return { entity: who.id as EntityId, tokens, args: tokens.join(" "), raw: text } as never;
};
const saved = {
  child: process.env.MARINA_COLLECTIVE_CHILD,
  proto: process.env.MARINA_EVOLUTION_PROTOCOLS,
};

/** A trial runtime that answers at once: the candidate 90/100, the incumbent 70/100. */
function trialDeps(): TrialDeps {
  let n = 0;
  return {
    spawn: async () => {},
    entityIdOf: (name) => `e_${name}`,
    subjectOf: (name) => ({ agent: name }),
    createModelChannel: () => {},
    deleteModelChannel: () => {},
    startBenchmark: (model) => {
      const id = `br_t${++n}`;
      const score = model.endsWith("cand") ? 0.9 : 0.7;
      child.insertBenchmarkRun({
        id,
        benchmark: "arc-challenge",
        config_hash: id,
        config_json: JSON.stringify({ benchmark: "arc-challenge", partition: "holdout" }),
        status: "running",
        started_at: 0,
      });
      child.completeBenchmarkRun(id, {
        score,
        breakdown_json: null,
        answered: 100,
        total: 100,
        status: "completed",
        completed_at: 1,
        duration_ms: 1,
      });
      return id;
    },
    runStatus: (id) => {
      const r = child.getBenchmarkRun(id)!;
      return { status: r.status, score: r.score, answered: r.answered, total: r.total };
    },
    stop: async () => {},
    sleep: async () => {},
    now: () => Date.now(),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "adopt-"));
  parent = new MarinaDB(join(dir, "parent.db"));
  child = new MarinaDB(join(dir, "child.db"));
  process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
  process.env.MARINA_COLLECTIVE_CHILD = "1";
  resetEvolveTrialForTests();
  out = [];
  // Child world: scout-v2 earns a held-out win over scout, accepted by review.
  child.saveRole({ name: "scout", traits: [], tone: "casual", createdBy: "seed" });
  child.saveRole({
    name: "scout-v2",
    traits: [],
    tone: "precise",
    guidelines: ["Cite sources"],
    createdBy: "seed",
  });
  const exp = child.createExperiment({
    name: "ScoutTrial",
    creatorName: "Alice",
    requiredAgents: 1,
  });
  child.addParticipant(exp, "Alice");
  grant(child, "e_alice", "agent.spawn");
  const evolve = evolveCommand({ getEntity: () => alice, db: child, trialDeps: () => trialDeps() });
  evolve.handler(ctx, line(alice, "evolve create ScoutTrial | sharper answers"));
  evolve.handler(ctx, line(alice, "evolve start ScoutTrial"));
  evolve.handler(ctx, line(alice, "evolve propose ScoutTrial | precise tone | role:scout-v2"));
  evolve.handler(
    ctx,
    line(alice, "evolve trial ScoutTrial 1 incumbent:scout benchmark:arc-challenge"),
  );
  await until(() => out.some((t) => t.includes("Trial for run 1")));
  evolve.handler(ctx, line(alice, "evolve evaluate ScoutTrial 1 | held-out win"));
  evolve.handler(ctx, line(alice, "evolve decide ScoutTrial 1 accept"));
  // Parent world: already has a `scout` role of its own.
  parent.saveRole({ name: "scout", traits: [], tone: "old", createdBy: "seed" });
  out = [];
});
afterEach(() => {
  for (const [k, v] of [
    ["MARINA_COLLECTIVE_CHILD", saved.child],
    ["MARINA_EVOLUTION_PROTOCOLS", saved.proto],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  parent.close();
  child.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The parent's `world` command, bridged to the child's REAL `evolve adoption` handler. */
function parentWorld(agents: { name: string; role: string }[] = []) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), "");
  const manager = new WorldCollectiveManager(parent, dir);
  const childEvolve = evolveCommand({ getEntity: () => alice, db: child });
  const fetcher = async (_url: string, init: RequestInit) => {
    const { command } = JSON.parse(String(init.body)) as { command: string };
    const captured: string[] = [];
    const childCtx = {
      send: (_e: string, t: string) => captured.push(t),
    } as unknown as RoomContext;
    await childEvolve.handler(childCtx, line(alice, command));
    return Response.json({ text: captured.join("\n") });
  };
  const byId = (id: string) => (id === "e_bob" ? bob : alice);
  const cmd = worldCommand({
    db: parent,
    manager: () => manager,
    getEntity: byId,
    fetcher,
    listAgents: () => agents,
  });
  const v = manager.create({ name: "trial2", worldTemplate: "empty", createdBy: "e_alice" });
  parent.updateWorldVariant(v.id, { status: "running", pid: null, lastError: null });
  return cmd;
}

const run = async (cmd: ReturnType<typeof worldCommand>, who: Entity, text: string) => {
  out = [];
  await cmd.handler(ctx, line(who, text));
  return out.join("\n");
};

describe("world adopt — bringing an earned winner home", () => {
  it("requests with the child's evidence; only someone else approves; creates the role", async () => {
    using _clock = scopeProperty(Date, "now", () => 1_800_000_000_000);
    const cmd = parentWorld();
    const req = await run(cmd, alice, "world adopt trial2 scout-v2");
    expect(req).toContain("Adoption #1 requested: scout-v2");
    expect(req).toContain("90.0% vs scout 70.0% on 100 held-out arc-challenge items");
    expect(parent.getRole("scout-v2")).toBeUndefined(); // pending changes nothing
    expect(await run(cmd, alice, "world adopt approve 1")).toContain("cannot approve their own");
    expect(await run(cmd, bob, "world adopt approve 1")).toContain("Adoption #1 applied");
    expect(JSON.parse(parent.getRole("scout-v2")!.guidelines)).toEqual(["Cite sources"]);
    expect(adoptionLog(parent)[0]?.status).toBe("applied");
  });

  it("replacing an existing role needs role.edit, saves the old definition, and rolls back", async () => {
    const cmd = parentWorld();
    await run(cmd, alice, "world adopt trial2 scout-v2 into:scout");
    expect(await run(cmd, bob, "world adopt approve 1")).toMatch(/role\.edit|witness|standing/);
    expect(parent.getRole("scout")!.tone).toBe("old");
    grant(parent, "e_bob", "role.edit");
    expect(await run(cmd, bob, "world adopt approve 1")).toContain(
      'role "scout" now holds scout-v2',
    );
    expect(parent.getRole("scout")!.tone).toBe("precise");
    expect(await run(cmd, bob, "world adopt rollback 1")).toContain("rolled-back");
    expect(parent.getRole("scout")!.tone).toBe("old");
  });

  it("never replaces the role the approver runs on, and refuses a win that was not earned", async () => {
    const cmd = parentWorld([{ name: "Bob", role: "scout" }]);
    grant(parent, "e_bob", "role.edit");
    await run(cmd, alice, "world adopt trial2 scout-v2 into:scout");
    expect(await run(cmd, bob, "world adopt approve 1")).toContain(
      "no one changes the role they are running on",
    );
    // A role with no accepted, earned run in the child is not adoptable.
    expect(await run(cmd, alice, "world adopt trial2 scout")).toContain("Not adoptable");
  });
});
