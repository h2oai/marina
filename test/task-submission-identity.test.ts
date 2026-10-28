// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "../src/coordination/task-manager";
import { recordTaskOpinion, recordTaskVerdict } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { migrateEmptyTo } from "./schema-replay";

test("same-clock replacement submissions keep distinct opinions through reclaim and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-submission-clock-"));
  const path = join(directory, "world.db");
  let db = new MarinaDB(path);
  const clock = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  try {
    let tasks = new TaskManager(db);
    const task = tasks.create({
      title: "Exact work",
      creatorId: "creator",
      creatorName: "Creator",
    });
    expect(tasks.claim(task.id, "worker", "Worker")).toBeTruthy();
    expect(tasks.submit(task.id, "worker", "First answer")).toBe(true);
    const first = tasks.getClaim(task.id, "worker")!.submittedAt!;
    recordTaskOpinion(db, {
      taskId: task.id,
      claimant: "Worker",
      judge: "first",
      opinion: "pass",
      submittedAt: first,
    });
    expect(tasks.rejectSubmission(task.id, "worker", "creator")).toBe(true);
    recordTaskVerdict(db, {
      taskId: task.id,
      claimant: "Worker",
      approved: false,
      at: Date.now(),
    });
    expect(tasks.claim(task.id, "worker", "Worker")).toBeTruthy();
    expect(tasks.getClaim(task.id, "worker")!.submittedAt).toBeNull();
    await settleDelivery(db);
    db.close();
    db = new MarinaDB(path);
    tasks = new TaskManager(db);
    expect(tasks.submit(task.id, "worker", "Replacement answer")).toBe(true);
    const second = tasks.getClaim(task.id, "worker")!.submittedAt!;
    expect(second).toBe(first + 1);
    recordTaskOpinion(db, {
      taskId: task.id,
      claimant: "Worker",
      judge: "replacement",
      opinion: "fail",
      submittedAt: second,
    });
    expect(db.listOutcomes({ basis: "judged" })).toHaveLength(2);
    expect(tasks.rejectSubmission(task.id, "worker", "creator")).toBe(true);
    recordTaskVerdict(db, {
      taskId: task.id,
      claimant: "Worker",
      approved: false,
      at: Date.now(),
    });
    expect(db.listOutcomes({ basis: "mechanical" })).toHaveLength(2);
    expect(tasks.claim(task.id, "worker", "Worker")).toBeTruthy();
    clock.mockReturnValue(first - 1_000);
    expect(tasks.submit(task.id, "worker", "Clock moved backward")).toBe(true);
    expect(tasks.getClaim(task.id, "worker")!.submittedAt).toBe(second + 1);
  } finally {
    clock.mockRestore();
    await settleDelivery(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("submission-clock migration retains the identity of an existing submission", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-submission-upgrade-"));
  const path = join(directory, "world.db");
  const clock = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  try {
    const legacy = new Database(path);
    migrateEmptyTo(legacy, 182);
    legacy.run(
      "INSERT INTO tasks(id,title,creator_id,creator_name,created_at,updated_at) VALUES(1,'Existing','creator','Creator',1,1)",
    );
    legacy.run(
      "INSERT INTO task_claims(task_id,entity_id,entity_name,status,claimed_at,submitted_at,submission_text) VALUES(1,'worker','Worker','submitted',1,1900000000000,'Existing answer')",
    );
    legacy.close();
    const db = new MarinaDB(path);
    try {
      expect(db.getTaskClaim(1, "worker")).toMatchObject({
        submitted_at: 1_900_000_000_000,
        submission_text: "Existing answer",
      });
      db.updateTaskClaimStatus(1, "worker", "rejected");
      db.createTaskClaim(1, "worker", "Worker");
      db.updateTaskClaimStatus(1, "worker", "submitted", "Replacement answer");
      expect(db.getTaskClaim(1, "worker")!.submitted_at).toBe(1_900_000_000_001);
    } finally {
      db.close();
    }
  } finally {
    clock.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
