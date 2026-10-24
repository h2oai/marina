// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A user-created crew serves `marina:<name>` through its own name, a crew
 * dispatch binds the work to a task, and that task (not mere membership in
 * some crew) is what tags the work `crew:<formation>` — all with no model
 * provider configured.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewManager, crewEndpointChannel } from "../src/coordination/crew-manager";
import type { BenchmarkRunOptions } from "../src/engine/benchmark-runner";
import { verificationApproach } from "../src/engine/commands/code/exec";
import { Engine } from "../src/engine/engine";
import { benchmarkMethod, benchmarkModelMethod } from "../src/outcomes/benchmark";
import { TASK_APPROACH_OWNER, taskApproach, taskCrewBinding } from "../src/outcomes/live";
import { MarinaDB } from "../src/persistence/database";
import { entityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";
import { providerEnvironmentKeys } from "./hermetic-env";

describe("crews serve through their own name and tag their work", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let carol: MockConnection;
  let dave: MockConnection;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-crew-serve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    // bob, carol and dave are agents (an agent config); alice is a person.
    for (const name of ["bob", "carol", "dave"])
      db.saveAgentConfig({ name, model: "vendor/m", role: "coder", spawnedBy: "alice" });
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    bob = new MockConnection("c-bob");
    carol = new MockConnection("c-carol");
    dave = new MockConnection("c-dave");
    for (const [conn, name] of [
      [alice, "alice"],
      [bob, "bob"],
      [carol, "carol"],
      [dave, "dave"],
    ] as const) {
      engine.addConnection(conn);
      engine.spawnEntity(conn.id, name);
    }
    engine.entities.get(alice.entity!)!.properties.rank = 4;
  });

  afterEach(async () => {
    engine.stop();
    await engine.drainCommands();
    await engine.shutdown();
    db.close();
    cleanupDb(dbPath);
  });

  const run = (conn: MockConnection, raw: string): string => {
    conn.clear();
    engine.processCommand(conn.entity!, raw);
    return stripAnsi(conn.allTextJoined());
  };
  const endpointMembers = (name: string): string[] => {
    const cm = engine.channelManager!;
    const channel = cm.getChannelByName(crewEndpointChannel(name));
    return channel ? cm.getMembers(channel.id) : [];
  };

  it("runs create → dispatch → claim → approach tag with no model provider", () => {
    expect(providerEnvironmentKeys().filter((k) => process.env[k])).toEqual([]);
    run(alice, "crew create alpha bob,carol formation:debate -- review the plan");
    run(bob, "crew join alpha");
    const out = run(alice, "crew dispatch alpha check the rollout steps");
    const taskId = Number(/as task #(\d+)/.exec(out)?.[1]);
    expect(taskId).toBeGreaterThan(0);
    const task = engine.taskManager!.get(taskId)!;
    expect(task.standing).toBe(0);
    expect(task.creatorName).toBe("alice");
    expect(taskCrewBinding(db, taskId)).toMatchObject({ name: "alpha", formation: "debate" });
    // The dispatch tells members which task to claim.
    expect(stripAnsi(bob.allTextJoined())).toContain(`task claim ${taskId}`);

    run(bob, `task claim ${taskId}`);
    expect(taskApproach(db, "bob", taskId)).toEqual(["crew:debate"]);
    expect(db.getCoreMemory(TASK_APPROACH_OWNER, `task:${taskId}:bob`)?.value).toBe(
      JSON.stringify(["crew:debate"]),
    );
  });

  it("a crew's model-<name> endpoint follows its agent members, never a person", () => {
    run(alice, "crew create alpha bob,carol formation:delphi -- g");
    // Created with the crew; alice (a person, the owner) is not a responder.
    expect(endpointMembers("alpha")).toEqual([]);
    run(bob, "crew join alpha");
    run(carol, "crew join alpha");
    expect(new Set(endpointMembers("alpha"))).toEqual(new Set([bob.entity!, carol.entity!]));
    run(carol, "crew leave alpha");
    expect(endpointMembers("alpha")).toEqual([bob.entity!]);
    run(alice, "crew dissolve alpha done");
    expect(endpointMembers("alpha")).toEqual([]);
  });

  it("benchmark run crew:<name> resolves the crew with its formation, or names the real step", () => {
    let started: BenchmarkRunOptions | undefined;
    engine.benchmarkRunner!.start = (opts) => {
      started = opts;
      return { id: "br_test", configHash: "h" };
    };
    run(alice, "crew create alpha bob formation:debate -- g");
    // Nobody but the person owner yet: refused, saying how an agent serves it.
    const refused = run(alice, "benchmark run smoke crew:alpha");
    expect(refused).toContain("crew alpha is not serving");
    expect(refused).toContain("crew join alpha");
    expect(started).toBeUndefined();
    expect(run(alice, "benchmark run smoke crew:ghost")).toContain("there is no crew named ghost");

    run(bob, "crew join alpha");
    const ok = run(alice, "benchmark run smoke crew:alpha");
    expect(ok).toContain("crew alpha (residents, formation debate)");
    expect(started).toMatchObject({ model: "marina:alpha", formation: "debate" });

    // No member online: the precise refusal again.
    engine.removeConnection(bob.id);
    started = undefined;
    expect(run(alice, "benchmark run smoke crew:alpha")).toContain("crew alpha is not serving");
    expect(started).toBeUndefined();
  });

  it("binds an existing task, and only for its creator or a claimant", () => {
    run(alice, "crew create alpha bob formation:verification -- g");
    run(bob, "crew join alpha");
    run(alice, "task create Fix the importer");
    const taskId = engine.taskManager!.list()[0]!.id;
    expect(run(bob, `crew dispatch alpha task:${taskId}`)).toContain(
      `Only task #${taskId}'s creator or a claimant`,
    );
    expect(run(alice, `crew dispatch alpha task:${taskId}`)).toContain(`as task #${taskId}`);
    expect(engine.taskManager!.list()).toHaveLength(1);
    expect(taskCrewBinding(db, taskId)?.formation).toBe("verification");
  });

  it("a member claiming an unrelated task gets the membership fallback only when unbound", () => {
    run(alice, "crew create alpha bob formation:debate -- g");
    run(bob, "crew join alpha");
    run(alice, "crew create beta dave formation:delphi -- g");
    run(dave, "crew join beta");
    // Unrelated, unbound task: bob's live crew stands in.
    run(alice, "task create Unrelated work");
    const unrelated = engine.taskManager!.list()[0]!.id;
    run(bob, `task claim ${unrelated}`);
    expect(taskApproach(db, "bob", unrelated)).toEqual(["crew:debate"]);
    // A task dispatched to beta is beta's work, whoever claims it.
    const out = run(alice, "crew dispatch beta forecast the release date");
    const bound = Number(/as task #(\d+)/.exec(out)?.[1]);
    run(bob, `task claim ${bound}`);
    expect(taskApproach(db, "bob", bound)).toEqual(["crew:delphi"]);
    // A claimant in no crew, unbound: solo.
    run(alice, "task create Solo work");
    const solo = engine.taskManager!.list().find((t) => t.title === "Solo work")!.id;
    run(carol, `task claim ${solo}`);
    expect(taskApproach(db, "carol", solo)).toEqual(["solo"]);
  });
});

describe("internal crews and the manager without an engine", () => {
  it("a Code Mode style crew (serves: false) has no endpoint", () => {
    const db = new MarinaDB(":memory:");
    const channels = new ChannelManager(db, () => true);
    const crews = new CrewManager({ channels, db, resolveAgentId: (n) => `e_${n}` });
    crews.create({
      name: "code-s1-abc",
      goal: "g",
      owner: entityId("e_owner"),
      members: [{ agentName: "bob" }],
      serves: false,
    });
    crews.create({
      name: "open",
      goal: "g",
      owner: entityId("e_owner"),
      members: [{ agentName: "bob" }],
    });
    expect(channels.getChannelByName("model-code-s1-abc")).toBeUndefined();
    const open = channels.getChannelByName("model-open")!;
    expect(channels.getMembers(open.id)).toEqual(["e_bob"]);
    crews.stop();
    db.close();
  });
});

describe("benchmark method keys", () => {
  it("never puts a model id under crew:", () => {
    expect(
      benchmarkMethod({
        target_kind: "crew",
        target_json: JSON.stringify({ model: "openrouter/vendor/m", crew: "x" }),
      }),
    ).toBe("crew:unknown");
    expect(
      benchmarkMethod({ target_kind: "crew", target_json: '"openrouter/vendor/m"', label: "x" }),
    ).toBe("crew:unknown");
    expect(
      benchmarkMethod({
        target_kind: "crew",
        target_json: JSON.stringify({ model: "marina:x", crew: "x", formation: "debate" }),
      }),
    ).toBe("crew:debate");
    expect(
      benchmarkModelMethod({
        target_kind: "crew",
        target_json: JSON.stringify({ model: "openrouter/vendor/m", crew: "x" }),
      }),
    ).toBe("model:openrouter/vendor/m");
    expect(
      benchmarkModelMethod({
        target_kind: "crew",
        target_json: JSON.stringify({ model: "marina:x", crew: "x" }),
      }),
    ).toBeUndefined();
  });
});

describe("Code Mode verification approach", () => {
  const session = { id: "s1", driver: "", execution_target: "sandbox-x" } as never;
  const dispatched = (crewId: string) => ({
    listCodingArtifacts: () => [
      { kind: "crew_dispatched", status: "active", metadata_json: JSON.stringify({ crewId }) },
    ],
  });
  const crews = {
    get: (id: string) =>
      id === "crew-live"
        ? { state: "active", formation: "swarm" }
        : id === "crew-gone"
          ? { state: "dissolved", formation: "swarm" }
          : undefined,
  };

  it("adds crew:<formation> while the session's code crew is live", () => {
    const approach = (crewId: string) =>
      verificationApproach({ db: dispatched(crewId), crewManager: crews } as never, session);
    expect(approach("crew-live")).toEqual([
      "driver:none",
      "runner:sandbox-x",
      "verify:live",
      "crew:swarm",
    ]);
    expect(approach("crew-gone")).not.toContain("crew:swarm");
    expect(approach("crew-unknown")).toEqual(["driver:none", "runner:sandbox-x", "verify:live"]);
  });
});
