// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// A spend stop ends a Code Mode attempt like every other budget: the worker's
// runtime emits SPEND_STOP_EVENT_CONTEXT and the attempt observer submits the
// work in the workspace mechanically (labelled budgetForced, reason "spend"),
// or ends the attempt blocked when there is nothing to submit. No model call:
// not for the summary, not for the submission verifier (opinion `none`).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentHandle } from "../src/agent/agent-types";
import { SPEND_STOP_EVENT_CONTEXT } from "../src/agent/budget-terminal";
import { beginCodingRun, codingRunMetadata } from "../src/coding/task-run";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { observeCodingRun } from "../src/engine/commands/code/task-run";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, type Entity, type EntityId, roomId } from "../src/types";
import { git, gitInit } from "./git-helpers";
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

describe("Code Mode spend stop", () => {
  let backend: ReturnType<typeof Bun.serve>;
  let asked = 0;
  let dir: string;
  let db: MarinaDB;
  let state: DisposableStack;
  let owner: Entity;
  let worker: Entity;

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      fetch() {
        asked++;
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
    asked = 0;
    dir = mkdtempSync(join(tmpdir(), "marina-spend-stop-"));
    db = new MarinaDB(join(dir, "world.db"));
    owner = entity("owner", "Owner");
    worker = entity("worker", "Worker");
    db.saveEntity(owner);
    db.saveEntity(worker);
    db.createCodingSession({ id: "s", title: "Coding", workspaceRoot: dir, createdBy: owner.name });
    // A configured submission verifier: a spend-forced submission must not ask it.
    state = scopeProcessState({
      env: {
        MARINA_DECISIONS: "decisions-api",
        MARINA_DECISION_ENGINE: undefined,
        MARINA_DECISION_ENGINES: undefined,
        MARINA_DECISION_MODEL: "stub-jev",
        MARINA_DECISION_BASE_URL: `http://localhost:${backend.port}`,
        MARINA_DECISION_VERIFY: "observe",
      },
    });
  });
  afterEach(() => {
    state.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function observed() {
    const run = beginCodingRun(db, {
      session: db.getCodingSession("s")!,
      owner,
      worker,
      prompt: "Fix the bug",
      profile: "marina",
      verificationRequirement: "checks",
    });
    const listeners = new Set<(event: AgentEvent) => void>();
    const handle = {
      name: worker.name,
      getStatus: () => ({ entityId: worker.id, state: "autonomous" }),
      getOperatorStatus: () => ({ paused: null }),
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as AgentHandle;
    const tracked: Promise<unknown>[] = [];
    const notices: string[] = [];
    const events: EngineEvent[] = [];
    const deps = {
      db,
      getEntity: (id: string) => (id === owner.id ? owner : id === worker.id ? worker : undefined),
      notify: (_id: string, text: string) => notices.push(text),
      logEvent: (event: EngineEvent) => events.push(event),
      trackBackground: (work: Promise<void>) => tracked.push(work),
      workspaceRegistry: new WorkspaceRegistry({ defaultRoot: dir, roots: [dir] }),
    };
    observeCodingRun(deps as never, run, handle);
    const stop = (
      error = "spend_cap_reached: daily spend cap reached",
      context = SPEND_STOP_EVENT_CONTEXT,
    ) => {
      for (const listener of listeners) listener({ type: "error", error, context });
    };
    const settle = async () => {
      // Drain the stop and anything it scheduled (the verifier observation).
      for (let seen = 0; seen < tracked.length; seen = tracked.length) {
        await Promise.all(tracked.slice(seen));
      }
    };
    return { run, stop, settle, notices, tracked };
  }

  it("submits the attempt's changes mechanically, labelled budgetForced/spend, asking no model", async () => {
    const { run, stop, settle, notices, tracked } = observed();
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "file_written",
      payload: { id: "a1", created: false, path: "src/tokenizer.ts" },
    });
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "file_edited",
      payload: { id: "a2", path: "test/tokenizer.test.ts" },
    });
    stop();
    stop(); // once per attempt
    expect(tracked).toHaveLength(1);
    await settle();

    const ended = db.getCodingArtifact(run.id)!;
    expect(ended.status).toBe("submitted");
    const meta = codingRunMetadata(ended);
    expect(meta.budgetForced).toMatchObject({ reason: "spend", source: "spend-stop" });
    // Required checks never ran: submitted with that verification, never as verified.
    expect(meta.verification).toBe("missing");
    const summary = db.getCodingArtifact(meta.summaryId!)!;
    expect(summary.content_text).toContain("no model call was made");
    expect(summary.content_text).toContain("src/tokenizer.ts");
    expect(summary.content_text).toContain("test/tokenizer.test.ts");
    expect(db.getTaskClaim(meta.taskId, worker.id)?.status).toBe("submitted");
    expect(notices.some((n) => n.includes("when the model budget ran out"))).toBe(true);

    // The verifier is an outage, not a pass: opinion none, and no request sent.
    expect(asked).toBe(0);
    const [observation] = db.listJudgeObservations();
    expect(observation).toMatchObject({ task_id: meta.taskId, opinion: "none" });
  });

  it("ends blocked (kind:impossible), labelled budgetForced/spend, when there is nothing to submit", async () => {
    const { run, stop, settle } = observed();
    stop("402 insufficient credits");
    await settle();
    const ended = db.getCodingArtifact(run.id)!;
    expect(ended.status).toBe("interrupted");
    const meta = codingRunMetadata(ended);
    expect(meta.reason).toStartWith("Blocked: BudgetForced: the model budget is exhausted");
    expect(meta.reason).toContain("nothing in the workspace to submit");
    expect(meta.budgetForced).toMatchObject({ reason: "spend" });
    expect(meta.summaryId).toBeUndefined();
    const handoff = db
      .listCodingRunArtifacts(run.id, ["handoff"])
      .find((a) => a.title === "Task blocked");
    expect(JSON.parse(handoff!.metadata_json)).toMatchObject({ blockKind: "impossible" });
    expect(db.getTask(meta.taskId)!.status).toBe("open");
    expect(asked).toBe(0);
  });

  it("counts a command's edits when the workspace diff shows them", async () => {
    gitInit(dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, ".gitignore"), "world.db*\n");
    git(dir, "add", "a.txt", ".gitignore");
    git(dir, "commit", "--quiet", "-m", "base");
    const { run, stop, settle } = observed();
    writeFileSync(join(dir, "a.txt"), "two\n"); // e.g. a formatter run through code run
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "command_ran",
      payload: { id: "c1", command: ["fmt"], exitCode: 0 },
    });
    stop();
    await settle();
    const ended = db.getCodingArtifact(run.id)!;
    expect(ended.status).toBe("submitted");
    const meta = codingRunMetadata(ended);
    expect(db.getCodingArtifact(meta.summaryId!)!.content_text).toContain(
      "Changed in this attempt: a.txt",
    );
  });

  it("counts a new untracked file a command created, but not ignored ones", async () => {
    gitInit(dir);
    writeFileSync(join(dir, ".gitignore"), "world.db*\nbuild/\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "--quiet", "-m", "base");
    const { run, stop, settle } = observed();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "new.ts"), "export const x = 1;\n"); // e.g. a generator via code run
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "out.js"), "ignored\n");
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "command_ran",
      payload: { id: "c1", command: ["gen"], exitCode: 0 },
    });
    stop();
    await settle();
    const ended = db.getCodingArtifact(run.id)!;
    expect(ended.status).toBe("submitted");
    const text = db.getCodingArtifact(codingRunMetadata(ended).summaryId!)!.content_text;
    expect(text).toContain("Changed in this attempt: src/new.ts");
    expect(text).not.toContain("build/out.js");
    expect(text).not.toContain("world.db");
  });

  it("does not count a command as a change in a clean repository", async () => {
    gitInit(dir);
    writeFileSync(join(dir, ".gitignore"), "world.db*\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "--quiet", "-m", "base");
    const { run, stop, settle } = observed();
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "command_ran",
      payload: { id: "c1", command: ["ls"], exitCode: 0 },
    });
    stop();
    await settle();
    expect(db.getCodingArtifact(run.id)!.status).toBe("interrupted");
  });

  it("does not count a command as a change without a workspace diff", async () => {
    const { run, stop, settle } = observed();
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "command_ran",
      payload: { id: "c1", command: ["ls"], exitCode: 0 },
    });
    stop();
    await settle();
    expect(db.getCodingArtifact(run.id)!.status).toBe("interrupted");
  });

  it("keeps the attempt on a rolling-hour pause and ignores other attempts' writes", async () => {
    const { run, stop, settle, tracked } = observed();
    // A rolling-hour cap pause (context spend-cap) lifts on its own: no end.
    stop("spend cap reached ($2.00 in last hour ≥ $1.00 per agent)", "spend-cap");
    expect(tracked).toHaveLength(0);
    expect(db.getCodingArtifact(run.id)!.status).toBe("active");
    // A write recorded for a different attempt does not count as this one's work.
    db.createCodingEvent({
      sessionId: "s",
      actor: worker.name,
      kind: "file_written",
      payload: { id: "x", path: "elsewhere.ts", runId: "another-run" },
    });
    stop();
    await settle();
    expect(db.getCodingArtifact(run.id)!.status).toBe("interrupted");
  });
});
