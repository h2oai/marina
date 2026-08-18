// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { createEvolutionProtocol, evolutionBudgetState } from "../src/engine/evolution-protocol";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

describe("native evolution deterministic recovery", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0)) cleanupDb(path);
  });

  it("recovers authoritative session, budget, lineage, and decisions after restart", () => {
    const path = `/tmp/marina-evolution-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    paths.push(path);
    let db = new MarinaDB(path);
    const experimentId = db.createExperiment({
      name: "recovery",
      creatorName: "Alice",
      requiredAgents: 1,
    });
    db.addParticipant(experimentId, "Alice");
    const sessionId = db.createEvolutionSession({
      experimentId,
      objective: "survive a restart",
      createdBy: "Alice",
      protocol: createEvolutionProtocol({ options: ["max-runs=3"] }),
    });
    db.updateEvolutionSessionStatus(sessionId, "active");
    const firstId = db.createEvolutionRun({
      sessionId,
      hypothesis: "first",
      candidateRef: "note:first",
      proposedBy: "Alice",
    });
    db.evaluateEvolutionRun(firstId, "Bob", "benchmark:one");
    db.decideEvolutionRun(firstId, "Cara", "reject");
    const secondId = db.createEvolutionRun({
      sessionId,
      parentRunId: firstId,
      hypothesis: "second",
      candidateRef: "note:second",
      proposedBy: "Alice",
    });
    db.close();

    db = new MarinaDB(path);
    const recovered = db.getEvolutionSession(sessionId)!;
    const runs = db.listEvolutionRuns(sessionId);
    expect(recovered.status).toBe("active");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.decision).toBe("reject");
    expect(runs[1]?.id).toBe(secondId);
    expect(runs[1]?.parent_run_id).toBe(firstId);
    expect(evolutionBudgetState(recovered, runs.length).runsRemaining).toBe(1);
    db.close();
  });
});
