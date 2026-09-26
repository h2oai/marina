// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evolveCommand, resetEvolveTrialForTests } from "../src/engine/commands/evolve";
import { Engine } from "../src/engine/engine";
import { runTrial, type TrialDeps } from "../src/engine/evolution-trial";
import { grant } from "../src/engine/safety-gates";
import { liveOrchestrationChannel } from "../src/net/model-api/shared";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

/** A fake runtime: agents come online after `joinMs`, runs finish after `runMs`. */
function fakeDeps(
  over: { neverOnline?: string; runMs?: number; scores?: Record<string, number> } = {},
) {
  let clock = 0;
  const log: string[] = [];
  const online = new Map<string, number>();
  const runs = new Map<string, { startedAt: number; model: string }>();
  const channels = new Set<string>();
  const deps: TrialDeps = {
    spawn: async (name, role) => {
      log.push(`spawn ${name} ${role}`);
      if (name !== over.neverOnline) online.set(name, clock + 1_000);
    },
    entityIdOf: (name) => {
      const at = online.get(name);
      return at !== undefined && clock >= at ? `e_${name}` : undefined;
    },
    subjectOf: (name) => ({ agent: name, role: "r", promptVersion: "p" }),
    createModelChannel: (name) => {
      channels.add(name);
    },
    deleteModelChannel: (name) => {
      channels.delete(name);
    },
    startBenchmark: (model) => {
      const id = `br_${runs.size + 1}`;
      runs.set(id, { startedAt: clock, model });
      return id;
    },
    runStatus: (id) => {
      const r = runs.get(id)!;
      if (clock - r.startedAt < (over.runMs ?? 10_000)) {
        return { status: "running", score: null, answered: 0, total: 15 };
      }
      const score = over.scores?.[r.model] ?? 0.5;
      return { status: "completed", score, answered: 15, total: 15 };
    },
    stop: async (name) => {
      log.push(`stop ${name}`);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, log, channels };
}

describe("runTrial", () => {
  it("runs both arms side by side, reports the delta, and always tears down", async () => {
    const { deps, log, channels } = fakeDeps({
      scores: { "marina:trial-7-cand": 0.9, "marina:trial-7-inc": 0.7 },
    });
    const result = await runTrial(deps, {
      runId: 7,
      arms: [
        { label: "candidate", role: "scout-v2" },
        { label: "incumbent", role: "scout" },
      ],
      timeoutMs: 60_000,
    });
    expect(result.arms.map((a) => [a.label, a.status, a.score])).toEqual([
      ["candidate", "completed", 0.9],
      ["incumbent", "completed", 0.7],
    ]);
    expect(result.delta).toBeCloseTo(0.2);
    expect(log).toContain("spawn trial7c scout-v2");
    expect(log).toContain("stop trial7c");
    expect(log).toContain("stop trial7i");
    expect(channels.size).toBe(0);
  });

  it("fails an arm that never comes online, and times out a run that never finishes", async () => {
    const offline = fakeDeps({ neverOnline: "trial8i" });
    const r1 = await runTrial(offline.deps, {
      runId: 8,
      arms: [
        { label: "candidate", role: "a" },
        { label: "incumbent", role: "b" },
      ],
      timeoutMs: 60_000,
    });
    expect(r1.arms[1]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("online"),
    });
    expect(r1.delta).toBeUndefined();
    expect(offline.log).toContain("stop trial8i"); // spawned, so cleaned up

    const slow = fakeDeps({ runMs: 10 * 60_000 });
    const r2 = await runTrial(slow.deps, {
      runId: 9,
      arms: [{ label: "candidate", role: "a" }],
      timeoutMs: 60_000,
    });
    expect(r2.arms[0]).toMatchObject({ status: "timeout" });
    expect(slow.log).toContain("stop trial9c");
  });
});

describe("evolve trial — the command's guards", () => {
  let dir: string;
  let db: MarinaDB;
  let out: string[];
  const saved = {
    child: process.env.MARINA_COLLECTIVE_CHILD,
    protocols: process.env.MARINA_EVOLUTION_PROTOCOLS,
  };
  const ctx = { send: (_e: string, t: string) => out.push(stripAnsi(t)) } as unknown as RoomContext;
  const input = (line: string) => {
    const tokens = line.split(/\s+/).slice(1);
    return { entity: "e_op" as EntityId, tokens, args: tokens.join(" "), raw: line } as never;
  };
  const operator = (rank: number) =>
    ({ id: "e_op", name: "Operator", properties: { rank } }) as unknown as Entity;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evolve-trial-"));
    db = new MarinaDB(join(dir, "w.db"));
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    resetEvolveTrialForTests();
    const expId = db.createExperiment({
      name: "scout",
      creatorName: "Operator",
      requiredAgents: 1,
    });
    db.addParticipant(expId, "Operator");
    db.saveRole({ name: "scout", traits: [], createdBy: "seed" });
    db.saveRole({ name: "scout-v2", traits: [], createdBy: "seed" });
    grant(db, "e_op", "agent.spawn");
    out = [];
  });
  afterEach(() => {
    for (const [k, v] of [
      ["MARINA_COLLECTIVE_CHILD", saved.child],
      ["MARINA_EVOLUTION_PROTOCOLS", saved.protocols],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = (rank: number, trialDeps?: () => TrialDeps) => {
    const cmd = evolveCommand({ getEntity: () => operator(rank), db, trialDeps });
    cmd.handler(ctx, input("evolve create scout | a sharper scout"));
    cmd.handler(ctx, input("evolve start scout"));
    cmd.handler(ctx, input("evolve propose scout | tighter guidelines | role:scout-v2"));
    const run = db.listEvolutionRuns(db.listEvolutionSessions()[0]!.id)[0]!;
    out = [];
    return { cmd, runId: run.id };
  };

  it("refuses outside a child or parallel world", () => {
    delete process.env.MARINA_COLLECTIVE_CHILD;
    const { cmd, runId } = setup(9, () => fakeDeps().deps);
    cmd.handler(ctx, input(`evolve trial scout ${runId} incumbent:scout`));
    expect(out.join("\n")).toContain("never this one");
  });

  it("needs rank 4 and an existing incumbent role", () => {
    process.env.MARINA_COLLECTIVE_CHILD = "1";
    const low = setup(3, () => fakeDeps().deps);
    low.cmd.handler(ctx, input(`evolve trial scout ${low.runId} incumbent:scout`));
    expect(out.join("\n")).toContain("rank 4");
    out = [];
    const hi = setup(9, () => fakeDeps().deps);
    hi.cmd.handler(ctx, input(`evolve trial scout ${hi.runId} incumbent:nope`));
    expect(out.join("\n")).toContain('Role "nope" does not exist');
  });

  it("starts, replies at once, then posts both arms and the evaluate line", async () => {
    process.env.MARINA_COLLECTIVE_CHILD = "1";
    const { cmd, runId } = setup(9, () => fakeDeps({ runMs: 0 }).deps);
    cmd.handler(ctx, input(`evolve trial scout ${runId} incumbent:scout`));
    expect(out[0]).toContain("Trial started");
    await until(() => out.some((t) => t.includes(`Trial for run ${runId}`)));
    const report = out.join("\n");
    expect(report).toContain("candidate");
    expect(report).toContain("incumbent");
    expect(report).toContain(`evolve evaluate <experiment> ${runId}`);
    // Kept, so a trial started over `world run` can be read back later.
    out = [];
    cmd.handler(ctx, input(`evolve trial scout ${runId} result`));
    expect(out.join("\n")).toContain(`Trial for run ${runId}`);
  });
});

describe("liveOrchestrationChannel — explicit agent routes reach their agents", () => {
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });
  afterEach(() => {
    engine.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes marina:<name> only to a live channel, never marina/default, never back to a member", () => {
    const cm = engine.channelManager!;
    const ch = cm.createChannel({ type: "model", name: "model-trial-1-cand" });
    expect(liveOrchestrationChannel(engine, "marina:trial-1-cand")).toBeUndefined(); // nobody online
    const conn = new MockConnection("c-agent");
    engine.addConnection(conn);
    engine.spawnEntity("c-agent", "trial1c");
    const agentId = conn.entity!;
    engine.entities.get(agentId)!.kind = "agent";
    cm.addMember(ch.id, agentId);
    expect(liveOrchestrationChannel(engine, "marina:trial-1-cand")?.name).toBe(
      "model-trial-1-cand",
    );
    expect(liveOrchestrationChannel(engine, "marina/trial-1-cand")?.name).toBe(
      "model-trial-1-cand",
    );
    expect(liveOrchestrationChannel(engine, "marina:trial-1-cand", "trial1c")).toBeUndefined();
    expect(liveOrchestrationChannel(engine, "marina/default")).toBeUndefined();
    expect(liveOrchestrationChannel(engine, "marina")).toBeUndefined();
    expect(liveOrchestrationChannel(engine, "anthropic/claude-sonnet-5")).toBeUndefined();
  });
});
