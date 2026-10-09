// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DecisionProvider } from "../src/decisions/types";
import { outcomeCommand } from "../src/engine/commands/outcome";
import { memoryLessonSink } from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  recallLessons,
} from "../src/learning/service";
import { deliverOutcomes } from "../src/outcomes/deliver";
import { liveEvidence } from "../src/outcomes/evidence";
import { observeOutcomeEvent, recordVerification } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomContext } from "../src/types";
import { stripAnsi } from "./helpers";

const judge = (): DecisionProvider =>
  ({
    kind: "test",
    model: "test/jev",
    calibrated: true,
    async ask(request: { questions: Record<string, unknown> }) {
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: 0.9 }]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      };
    },
  }) as unknown as DecisionProvider;

const verdict = (claimant: string, approved: boolean, taskId: number, timestamp: number) =>
  ({
    type: approved ? "task_approved" : "task_rejected",
    entity: "e_creator" as EntityId,
    taskId,
    claimantName: claimant,
    timestamp,
  }) as const;

describe("live work on the outcome path", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    db.createUser({ id: "u_jeff", name: "jeff" });
    db.saveAgentConfig({
      name: "Helper",
      model: "vendor/model-a",
      role: "coder",
      spawnedBy: "jeff",
    });
    db.saveAgentConfig({ name: "Roamer", model: "vendor/model-b", spawnedBy: "system" });
  });
  afterEach(async () => {
    await settleDelivery(db);
    disableOutcomeLearning(db);
    db.close();
  });

  it("a creator's verdict is one outcome with who did the work and on what", () => {
    observeOutcomeEvent(db, verdict("Helper", true, 7, 1_000));
    observeOutcomeEvent(db, verdict("Helper", false, 7, 2_000)); // a later attempt: its own subject
    observeOutcomeEvent(db, {
      type: "task_submitted",
      entity: "e" as EntityId,
      taskId: 7,
      timestamp: 3,
    });
    const rows = db.listOutcomes({ kind: "task" });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      subject: "task:7:Helper:1000",
      source: "task:verdict",
      domain: "tools",
      owner: "Helper",
      succeeded: 1,
      basis: "mechanical",
      resolved_at: 1_000,
    });
    expect(JSON.parse(rows[1]!.participants_json!)).toEqual([
      { agent: "Helper", model: "vendor/model-a", role: "coder" },
    ]);
  });

  it("a person's agent teaches only that person's lessons; a world agent the shared pool; unknown work nothing", async () => {
    const shared = memoryLessonSink();
    enableOutcomeLearning(db, {
      sink: shared,
      writer: null,
      judge: judge(),
      env: { MARINA_LESSONS: "on" },
    });
    const task = db.createTask({
      title: "Rename the config loader",
      description: "keep the old name as an alias",
      creatorId: "e_creator",
      creatorName: "creator",
    });
    observeOutcomeEvent(db, verdict("Helper", true, task, 1_000));
    observeOutcomeEvent(db, verdict("Roamer", false, task, 1_001));
    observeOutcomeEvent(db, verdict("Ghost", true, task, 1_002));
    await settleDelivery(db);
    await deliverOutcomes(db, { env: { MARINA_LESSONS: "on" } });
    const state = (claimant: string) => {
      const o = db.listOutcomes({ owner: claimant })[0]!;
      return db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")!;
    };
    expect(state("Helper").state).toBe("done");
    expect(state("Roamer").state).toBe("done");
    expect(state("Ghost")).toMatchObject({ state: "skipped", reason: "owner scope unresolved" });
    // Only the world agent's lesson reached the shared pool.
    // (plus at most its own `meta` mirror — Helper's lesson and mirror stay in jeff's space).
    const lessons = shared.all().filter((l) => l.domain !== "meta");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.source).toBe("task:verdict");
    expect(shared.all().filter((l) => l.domain === "meta").length).toBeLessThanOrEqual(1);
    // Helper's lesson lives in jeff's own space.
    const own = await recallLessons(db, "tools", "complete a posted task", {
      env: {},
      owner: "jeff",
    });
    expect(own.recalled.length).toBeGreaterThan(0);
  });

  it("a Code Mode verification is one outcome on the shared path", () => {
    recordVerification(db, {
      artifactId: "a1",
      actor: "Helper",
      passed: false,
      commands: [["bun", "test"]],
      detail: "failed at bun test (exit 1)",
      sessionId: "s1",
      at: 5,
    });
    expect(db.getOutcomeBySubject("artifact:a1")).toMatchObject({
      kind: "task",
      source: "code:verify",
      domain: "code",
      owner: "Helper",
      succeeded: 0,
    });
  });

  it("live evidence: success rates per kind of work, model and role, never from measurement", () => {
    observeOutcomeEvent(db, verdict("Helper", true, 1, 1));
    observeOutcomeEvent(db, verdict("Helper", true, 2, 2));
    observeOutcomeEvent(db, verdict("Helper", false, 3, 3));
    observeOutcomeEvent(db, verdict("Roamer", true, 4, 4));
    const cells = liveEvidence(db, { source: "task:" });
    const helper = cells.find((c) => c.model === "vendor/model-a")!;
    expect(helper).toMatchObject({ source: "task:verdict", role: "coder", n: 3, successes: 2 });
    expect(helper.lower).toBeGreaterThan(0);
    expect(helper.lower).toBeLessThan(2 / 3);
    expect(liveEvidence(db, { source: "task:", minN: 2 }).map((c) => c.model)).toEqual([
      "vendor/model-a",
    ]);
    expect(liveEvidence(db, { basis: "judged" })).toEqual([]);
  });

  it("outcome command: stats and evidence are aggregates; list shows only your own", () => {
    observeOutcomeEvent(db, verdict("Helper", true, 1, 1));
    observeOutcomeEvent(db, verdict("Roamer", true, 2, 2));
    const sent: string[] = [];
    const ctx = {
      send: (_e: EntityId, text: string) => sent.push(stripAnsi(text)),
    } as unknown as RoomContext;
    const cmd = outcomeCommand({ db, getEntity: () => ({ name: "Helper" }) });
    const run = (...tokens: string[]) =>
      cmd.handler(ctx, { entity: "e1" as EntityId, tokens, raw: tokens.join(" ") } as never);
    run();
    expect(sent.at(-1)).toContain("lessons:");
    run("evidence", "source:task:");
    expect(sent.at(-1)).toContain("vendor/model-a");
    run("list");
    expect(sent.at(-1)).toContain("task:1:Helper");
    expect(sent.at(-1)).not.toContain("Roamer");
    run("bogus");
    expect(sent.at(-1)).toContain("Unknown outcome subcommand");
  });
});
