// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { PLATFORM_GUIDE_NOTES, seedGuidePool } from "../src/world/seed-guide";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("evolve command (self-improvement coach)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-evolve-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("registers the evolve command at rank 0 with a coach alias", () => {
    const cmd = engine.commands.allBuiltins().find((c) => c.name === "evolve");
    expect(cmd).toBeDefined();
    expect(cmd?.minRank ?? 0).toBe(0);
    expect(cmd?.aliases).toContain("coach");
  });

  it("`evolve loop` explains the cycle and disambiguates the two benchmark systems", () => {
    engine.login("c1", "Alice");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve loop");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("evolution loop");
    expect(text).toContain("Baseline");
    expect(text).toContain("skill store");
    // Two-systems disambiguation
    expect(text).toContain("quest start");
    expect(text).toContain("benchmark run");
  });

  it("status: no goal → next step is to set a goal", () => {
    engine.login("c1", "Bob");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Bob");
    expect(text).toContain("memory set goal");
  });

  it("status: goal set, no benchmarks → next step is to set a baseline", () => {
    engine.login("c1", "Cara");
    engine.processCommand(conn.entity!, "memory set goal master retrieval");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("master retrieval");
    expect(text.toLowerCase()).toContain("baseline");
  });

  it("status: with a benchmark score, shows it and nudges to bank a skill", () => {
    engine.login("c1", "Dora");
    const entity = engine.entities.get(conn.entity!)!;
    engine.processCommand(conn.entity!, "memory set goal improve");
    // Simulate having attempted a benchmark + accumulated notes.
    entity.properties.bench_retrieval_best = 60;
    engine.processCommand(conn.entity!, "note retrieval is about pool recall");
    engine.processCommand(conn.entity!, "note try synonyms when a keyword misses");
    engine.processCommand(conn.entity!, "note core memory helps for repeated facts");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Retrieval");
    expect(text).toContain("60");
    expect(text).toContain("skill store");
  });
});

describe("native evolution protocols", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let dbPath: string;
  let previousFlag: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.MARINA_EVOLUTION_PROTOCOLS;
    dbPath = `/tmp/marina-evolution-protocol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );
    alice = new MockConnection("c1");
    bob = new MockConnection("c2");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.login("c1", "Alice");
    engine.login("c2", "Bob");
    const experimentId = db.createExperiment({
      name: "native-loop",
      creatorName: "Alice",
      requiredAgents: 2,
    });
    db.addParticipant(experimentId, "Alice");
    db.addParticipant(experimentId, "Bob");
    alice.clear();
    bob.clear();
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.MARINA_EVOLUTION_PROTOCOLS;
    else process.env.MARINA_EVOLUTION_PROTOCOLS = previousFlag;
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("is disabled by default without changing the existing coach", () => {
    delete process.env.MARINA_EVOLUTION_PROTOCOLS;
    engine.processCommand(alice.entity!, "evolve create native-loop | improve retrieval");
    expect(stripAnsi(alice.lastText())).toContain("disabled");
    expect(db.listEvolutionSessions()).toHaveLength(0);

    alice.clear();
    engine.processCommand(alice.entity!, "evolve");
    expect(stripAnsi(alice.allTextJoined())).toContain("Evolution loop: Alice");
  });

  it("records an explicit, passive, attributed protocol lifecycle", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    engine.processCommand(alice.entity!, "evolve create native-loop | improve retrieval quality");
    expect(stripAnsi(alice.lastText())).toContain("cannot continue or promote itself");

    const session = db.listEvolutionSessions()[0]!;
    expect(session.status).toBe("draft");
    expect(JSON.parse(session.protocol)).toMatchObject({
      voluntary: true,
      metricsAreAdvisory: true,
      automaticContinuation: false,
      automaticPromotion: false,
    });

    engine.processCommand(alice.entity!, "evolve start native-loop");
    engine.processCommand(
      bob.entity!,
      "evolve propose native-loop | query expansion improves recall | note:candidate-17",
    );
    const run = db.listEvolutionRuns(session.id)[0]!;
    expect(run.proposed_by).toBe("Bob");
    expect(run.status).toBe("proposed");

    engine.processCommand(
      alice.entity!,
      `evolve evaluate native-loop ${run.id} | benchmark:retrieval score=0.84`,
    );
    engine.processCommand(bob.entity!, `evolve decide native-loop ${run.id} accept`);
    const decided = db.getEvolutionRun(run.id)!;
    expect(decided.status).toBe("accepted");
    expect(decided.evaluator_name).toBe("Alice");
    expect(decided.reviewer_name).toBe("Bob");
    expect(stripAnsi(bob.lastText())).toContain("does not activate or promote");
    expect(db.getNotesByEntity("Bob", 10)).toHaveLength(0);
  });

  it("authoritatively activates and withdraws the scoped capability for every participant", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    engine.processCommand(alice.entity!, "evolve create native-loop | improve retrieval");
    const session = db.listEvolutionSessions()[0]!;
    alice.clear();
    bob.clear();

    engine.processCommand(alice.entity!, "evolve start native-loop");
    for (const connection of [alice, bob]) {
      expect(connection.messages).toContainEqual(
        expect.objectContaining({
          kind: "system",
          tag: "marina-control",
          data: expect.objectContaining({
            controlType: "evolution_session_state",
            sessionId: session.id,
            active: true,
          }),
        }),
      );
    }
    expect(engine.getActiveEvolutionSessions("Alice")).toEqual([
      { id: session.id, experimentId: session.experiment_id },
    ]);

    alice.clear();
    bob.clear();
    engine.processCommand(alice.entity!, "evolve pause native-loop");
    for (const connection of [alice, bob]) {
      expect(connection.messages).toContainEqual(
        expect.objectContaining({
          kind: "system",
          tag: "marina-control",
          data: expect.objectContaining({ sessionId: session.id, active: false }),
        }),
      );
    }
    expect(engine.getActiveEvolutionSessions("Alice")).toEqual([]);
  });

  it("does not give non-participants an evolution-only capability", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    const charlie = new MockConnection("c3");
    engine.addConnection(charlie);
    engine.login("c3", "Charlie");
    engine.processCommand(alice.entity!, "evolve create native-loop | improve retrieval");
    engine.processCommand(alice.entity!, "evolve start native-loop");
    charlie.clear();
    engine.processCommand(
      charlie.entity!,
      "evolve propose native-loop | hidden privilege | note:should-not-exist",
    );
    expect(stripAnsi(charlie.lastText())).toContain("Join the underlying experiment");
    const session = db.listEvolutionSessions()[0]!;
    expect(db.listEvolutionRuns(session.id)).toHaveLength(0);
  });

  it("reports robust evidence without deciding or activating anything", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    const experimentId = db.createExperiment({
      name: "measured-loop",
      creatorName: "Alice",
      requiredAgents: 1,
      config: { arms: ["baseline", "candidate"], metric: "accuracy", goal: "higher" },
    });
    db.addParticipant(experimentId, "Alice");
    for (const value of [0.69, 0.7, 0.71]) {
      db.recordResult(experimentId, "Alice", "accuracy", value, "baseline");
    }
    for (const value of [0.79, 0.8, 0.81]) {
      db.recordResult(experimentId, "Alice", "accuracy", value, "candidate");
    }
    for (const value of [100, 101, 99]) {
      db.recordResult(experimentId, "Alice", "latency", value, "baseline");
    }
    for (const value of [90, 91, 89]) {
      db.recordResult(experimentId, "Alice", "latency", value, "candidate");
    }
    engine.processCommand(
      alice.entity!,
      "evolve create measured-loop | improve measured retrieval quality | guardrail=latency:lower",
    );
    alice.clear();
    engine.processCommand(alice.entity!, "evolve analyze measured-loop");
    const output = stripAnsi(alice.allTextJoined());
    expect(output).toContain("median=0.800");
    expect(output).toContain("MAD=0.010");
    expect(output).toContain("Observed leader: candidate");
    expect(output).toContain("Guardrail latency (lower): candidate");
    expect(output).toContain("cannot accept, activate, or promote");
    expect(db.listEvolutionRuns(db.listEvolutionSessions()[0]!.id)).toHaveLength(0);
  });

  it("enforces explicit budgets and preserves parent-run lineage", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    engine.processCommand(
      alice.entity!,
      "evolve create native-loop | bounded improvement | max-runs=2",
    );
    engine.processCommand(alice.entity!, "evolve start native-loop");
    engine.processCommand(alice.entity!, "evolve propose native-loop | first idea | note:first");
    const session = db.listEvolutionSessions()[0]!;
    const first = db.listEvolutionRuns(session.id)[0]!;
    engine.processCommand(
      alice.entity!,
      `evolve propose native-loop | refinement | note:second | parent=${first.id}`,
    );
    const second = db.listEvolutionRuns(session.id)[1]!;
    expect(second.parent_run_id).toBe(first.id);

    alice.clear();
    engine.processCommand(alice.entity!, "evolve propose native-loop | excess | note:third");
    expect(stripAnsi(alice.lastText())).toContain("run budget reached");
    expect(db.listEvolutionRuns(session.id)).toHaveLength(2);
    expect(db.getEvolutionSession(session.id)?.status).toBe("active");
  });

  it("rejects parent lineage forged across evolution sessions", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    const otherExperimentId = db.createExperiment({
      name: "other-loop",
      creatorName: "Alice",
      requiredAgents: 1,
    });
    db.addParticipant(otherExperimentId, "Alice");
    engine.processCommand(alice.entity!, "evolve create native-loop | first lineage");
    engine.processCommand(alice.entity!, "evolve start native-loop");
    engine.processCommand(alice.entity!, "evolve propose native-loop | first | note:first");
    const foreignParent = db.listEvolutionRuns(db.listEvolutionSessions()[0]!.id)[0]!;

    engine.processCommand(alice.entity!, "evolve create other-loop | second lineage");
    engine.processCommand(alice.entity!, "evolve start other-loop");
    alice.clear();
    engine.processCommand(
      alice.entity!,
      `evolve propose other-loop | forged child | note:child | parent=${foreignParent.id}`,
    );
    expect(stripAnsi(alice.lastText())).toContain("not part of this evolution session");
    const otherSession = db.getEvolutionSessionByExperiment(otherExperimentId)!;
    expect(db.listEvolutionRuns(otherSession.id)).toHaveLength(0);
  });

  it("enforces independent review only when the creator explicitly requests it", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    const charlie = new MockConnection("c3");
    engine.addConnection(charlie);
    engine.login("c3", "Charlie");
    const experimentId = db.createExperiment({
      name: "reviewed-loop",
      creatorName: "Alice",
      requiredAgents: 3,
    });
    for (const name of ["Alice", "Bob", "Charlie"]) db.addParticipant(experimentId, name);
    engine.processCommand(
      alice.entity!,
      "evolve create reviewed-loop | independently reviewed change | independent-review=true",
    );
    engine.processCommand(alice.entity!, "evolve start reviewed-loop");
    engine.processCommand(
      alice.entity!,
      "evolve propose reviewed-loop | hypothesis | note:candidate",
    );
    const session = db.getEvolutionSessionByExperiment(experimentId)!;
    const run = db.listEvolutionRuns(session.id)[0]!;

    alice.clear();
    engine.processCommand(alice.entity!, `evolve evaluate reviewed-loop ${run.id} | self evidence`);
    expect(stripAnsi(alice.lastText())).toContain("someone other than the proposer");
    engine.processCommand(bob.entity!, `evolve evaluate reviewed-loop ${run.id} | benchmark:42`);
    bob.clear();
    engine.processCommand(bob.entity!, `evolve decide reviewed-loop ${run.id} accept`);
    expect(stripAnsi(bob.lastText())).toContain("differ from both proposer and evaluator");
    engine.processCommand(charlie.entity!, `evolve decide reviewed-loop ${run.id} accept`);
    expect(db.getEvolutionRun(run.id)?.reviewer_name).toBe("Charlie");
  });
});

describe("evolve discoverability surfaces", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-evolve-surf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("first-login bootstrap mentions evolve", () => {
    engine.login("c1", "Newcomer");
    // Bootstrap fires on first brief/compass.
    engine.processCommand(conn.entity!, "brief");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("evolve");
  });

  it("help lists evolve under a Growth grouping", () => {
    engine.login("c1", "Helper");
    conn.clear();
    engine.processCommand(conn.entity!, "help");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Growth");
    expect(text).toContain("evolve");
  });
});

describe("platform guide notes", () => {
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-guide-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("seeds the evolve-loop notes into every world's guide pool, even with no world notes", () => {
    seedGuidePool(db, []);
    const pool = db.getMemoryPool("guide");
    expect(pool).toBeDefined();
    const notes = db.getPoolNotes(pool!.id, 50);
    const joined = notes.map((n) => n.content).join("\n");
    expect(joined).toContain("self-improvement loop");
    expect(joined).toContain("skill store");
    expect(joined).toContain("Two benchmark systems");
    expect(joined).toContain("behavior surfaces");
    expect(joined).toContain("real-time communication");
    expect(joined).toContain("faster loop");
    expect(joined).toContain("brief social");
    expect(notes.length).toBeGreaterThanOrEqual(PLATFORM_GUIDE_NOTES.length);
  });

  it("is idempotent — re-seeding does not duplicate notes", () => {
    seedGuidePool(db, []);
    const pool = db.getMemoryPool("guide");
    const first = db.getPoolNotes(pool!.id, 50).length;
    seedGuidePool(db, []);
    const second = db.getPoolNotes(pool!.id, 50).length;
    expect(second).toBe(first);
  });
});
