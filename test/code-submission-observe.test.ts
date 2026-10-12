// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The submission verifier on a Code Mode submit (`observeCodingSubmission`):
// the judge scores the submitted summary in the background, its opinion is
// recorded beside the submission, and it never changes the submission.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCodingRun, codingRunMetadata } from "../src/coding/task-run";
import { observeCodingSubmission } from "../src/engine/commands/code/task-run";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, type Entity, type EntityId, roomId } from "../src/types";
import { scopeProcessState } from "./process-state";

function entity(id: string, name: string): Entity {
  return {
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: name,
    inventory: [],
    properties: {},
  };
}

describe("Code Mode submission verifier (observe)", () => {
  let backend: ReturnType<typeof Bun.serve>;
  const asked: Array<{ state?: { submission?: string } }> = [];
  let dir: string;
  let db: MarinaDB;
  let state: DisposableStack;

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      async fetch(req) {
        asked.push((await req.json()) as (typeof asked)[number]);
        return Response.json({
          answers: {
            quality: { type: "score", score: 0.9, confidence: 0.9 },
            delivered: { type: "noul", noul: 0.9 },
          },
        });
      },
    });
  });
  afterAll(() => backend.stop(true));

  beforeEach(() => {
    asked.length = 0;
    dir = mkdtempSync(join(tmpdir(), "marina-code-observe-"));
    db = new MarinaDB(join(dir, "world.db"));
  });
  afterEach(() => {
    state?.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function submittedRun() {
    const owner = entity("owner", "Owner");
    const worker = entity("worker", "Worker");
    db.saveEntity(owner);
    db.saveEntity(worker);
    db.createCodingSession({ id: "s", title: "Coding", workspaceRoot: dir, createdBy: owner.name });
    const run = beginCodingRun(db, {
      session: db.getCodingSession("s")!,
      owner,
      worker,
      prompt: "Fix the bug",
      profile: "marina",
    });
    return { run, worker };
  }

  function env(verify: string) {
    state = scopeProcessState({
      env: {
        MARINA_DECISIONS: "decisions-api",
        MARINA_DECISION_ENGINE: undefined,
        MARINA_DECISION_ENGINES: undefined,
        MARINA_DECISION_MODEL: "stub-jev",
        MARINA_DECISION_BASE_URL: `http://localhost:${backend.port}`,
        MARINA_DECISION_VERIFY: verify,
      },
    });
  }

  it("records the judge's opinion beside the submission without changing it", async () => {
    env("observe");
    const { run, worker } = submittedRun();
    const events: EngineEvent[] = [];
    const tracked: Promise<unknown>[] = [];
    observeCodingSubmission(
      {
        db,
        logEvent: (e: EngineEvent) => events.push(e),
        trackBackground: (p: Promise<unknown>) => tracked.push(p),
      } as never,
      run,
      worker,
      "Fixed the off-by-one and added a test.",
    );
    expect(tracked).toHaveLength(1);
    await Promise.all(tracked);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.state?.submission).toContain("off-by-one");
    const decision = events.find((e) => e.type === "agent_decision") as unknown as {
      stage: string;
      verdict: string;
      subject: string;
    };
    expect(decision).toMatchObject({ stage: "verify", verdict: "observed" });
    expect(decision.subject).toBe(`task #${codingRunMetadata(run).taskId}`);
    const [observation] = db.listJudgeObservations();
    expect(observation).toMatchObject({
      task_id: codingRunMetadata(run).taskId,
      claimant_name: "Worker",
      mode: "observe",
    });
    // Advice only: the attempt is untouched.
    expect(db.getCodingArtifact(run.id)!.status).toBe(run.status);
  });

  it("asks nothing when the verifier is off", async () => {
    env("off");
    const { run, worker } = submittedRun();
    const tracked: Promise<unknown>[] = [];
    observeCodingSubmission(
      { db, trackBackground: (p: Promise<unknown>) => tracked.push(p) } as never,
      run,
      worker,
      "done",
    );
    expect(tracked).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(db.listJudgeObservations()).toHaveLength(0);
  });
});
