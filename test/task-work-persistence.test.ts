// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWork } from "../src/coordination/task-work";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { MarinaDB } from "../src/persistence/database";
import { exportState, importState } from "../src/persistence/export-import";
import { migrateEmptyTo } from "./schema-replay";

test("schema-184 tasks upgrade without adopting work records; revisions and receipts survive reopen and export/import", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-task-work-"));
  const path = join(directory, "world.db");
  const imported = join(directory, "imported.db");
  let db: MarinaDB | undefined;
  try {
    const legacy = new Database(path);
    migrateEmptyTo(legacy, 184);
    legacy.run(
      "INSERT INTO tasks(id,title,creator_id,creator_name,created_at,updated_at) VALUES(1,'Legacy task','owner','Owner',1,1)",
    );
    legacy.close();
    db = new MarinaDB(path);
    expect(db.getTask(1)!.title).toBe("Legacy task");
    expect(db.getTaskWorkRevision(1)).toBeUndefined();
    const actor = { id: "owner", name: "Owner" };
    const make = () => new TaskWork(db!, (who, ref) => resolveEvidenceSource(db!, who, ref));
    let work = make();
    work.apply(1, actor, 0, { kind: "patch", patch: { traffic: 10 } });
    const quote = "Maximum traffic is 10 percent.";
    const ref = `note:${db.createNote("Owner", `${"Background. ".repeat(200)}\n${quote}`)}`;
    work.apply(1, actor, 1, { kind: "cite", field: "traffic", ref, quote });
    work.apply(1, actor, 2, {
      kind: "expect",
      field: "traffic",
      op: "lte",
      expected: 10,
      citation: "c2",
    });
    const first = work.check(1, actor);
    expect(first.report.outcome).toBe("consistent");
    expect(work.show(1, actor).citations[0]!.quote).toBe(quote); // Full source, beyond the old judge excerpt limit.
    work.editArtifact(1, actor, 3, [
      { op: "set", path: "", value: { items: [{ value: 10, citations: [{ quote }] }] } },
    ]);
    work.declareArtifactRule(1, actor, 4, {
      id: "maximum",
      path: "/items/0/value",
      op: "lte",
      expected: 10,
      source: { ref, quote },
    });
    const artifactCheck = work.checkArtifact(1, actor);
    db.close();
    db = new MarinaDB(path);
    work = make();
    expect(work.checkArtifact(1, actor)).toMatchObject({
      reused: true,
      receiptId: artifactCheck.receiptId,
    });
    expect(work.check(1, actor).report.outcome).toBe(first.report.outcome);
    expect(JSON.parse(work.renderArtifact(1, actor).content).items[0].citations[0].quote).toBe(
      quote,
    );
    expect(work.show(1, actor, 1).fields).toEqual({ traffic: 10 });
    expect(work.show(1, actor).citations[0]!.quote).toBe(quote);
    db.close();
    db = undefined;
    const snapshot = exportState(path);
    expect(snapshot.tables.task_work_revisions).toHaveLength(5);
    expect(snapshot.tables.task_work_checks).toHaveLength(3);
    const target = new MarinaDB(imported);
    target.close();
    expect(importState(imported, snapshot).errors).toEqual([]);
    db = new MarinaDB(imported);
    work = make();
    expect(work.show(1, actor).fields).toEqual({ traffic: 10 });
    expect(JSON.parse(work.renderArtifact(1, actor).content).items[0].value).toBe(10);
    expect(work.checkArtifact(1, actor).report.outcome).toBe("matches-declared-checks");
    expect(work.show(1, actor).citations[0]!.quote).toBe(quote);
    expect(work.check(1, actor).report.outcome).toBe("consistent");
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverage, scoped history and assessment receipts survive reopen and export/import", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-evidence-work-"));
  const path = join(directory, "world.db");
  const imported = join(directory, "imported.db");
  let db: MarinaDB | undefined = new MarinaDB(path);
  const actor = { id: "owner", name: "Owner" };
  const make = () => new TaskWork(db!, (who, ref) => resolveEvidenceSource(db!, who, ref));
  try {
    const taskId = db.createTask({ title: "Review", creatorId: actor.id, creatorName: actor.name });
    const statement = "No candidate has passed technical validation.";
    const ref = `note:${db.createNote(actor.name, JSON.stringify({ doc_id: "technical", statements: [statement] }))}`;
    let work = make();
    work.editArtifact(taskId, actor, 0, [
      { op: "set", path: "", value: { phase: 1, choice: "none", citations: [], superseded: [] } },
    ]);
    work.editArtifact(taskId, actor, 1, [
      {
        op: "source",
        path: "/citations",
        ref,
        pick: { doc_id: "/doc_id", quote: "/statements/0" },
      },
      {
        op: "project",
        path: "/superseded",
        scopePath: "/phase",
        entries: [{ old: "a", new: "b" }],
        reason: "Phase changes",
      },
    ]);
    work.declareArtifactRule(taskId, actor, 2, {
      id: "technical",
      path: "/citations",
      op: "includesSource",
      when: { path: "/phase", equals: 1 },
      selection: { ref, pick: { doc_id: "/doc_id", quote: "/statements/0" } },
    });
    const check = work.checkArtifact(taskId, actor);
    const questions = [
      { id: "eligible", path: "/choice", question: "Which candidate is eligible?", refs: [ref] },
    ];
    const packet = work.reviewArtifact(taskId, actor, questions);
    const assessment = {
      fingerprint: packet.fingerprint,
      questions,
      answers: [
        {
          id: "eligible",
          status: "answered" as const,
          value: "none",
          reason: "No validated candidate",
          citations: [{ ref, quote: statement }],
        },
      ],
    };
    const receipt = work.assessArtifact(taskId, actor, assessment);
    db.close();
    db = new MarinaDB(path);
    work = make();
    expect(work.checkArtifact(taskId, actor)).toMatchObject({
      reused: true,
      receiptId: check.receiptId,
      report: { coverage: { complete: true } },
    });
    expect(work.assessArtifact(taskId, actor, assessment)).toMatchObject({
      reused: true,
      receiptId: receipt.receiptId,
    });
    db.close();
    db = undefined;
    const snapshot = exportState(path);
    const target = new MarinaDB(imported);
    target.close();
    expect(importState(imported, snapshot).errors).toEqual([]);
    db = new MarinaDB(imported);
    work = make();
    expect(work.renderArtifact(taskId, actor).projections[0]!.batches[0]!.entries).toEqual([
      { old: "a", new: "b" },
    ]);
    expect(work.checkArtifact(taskId, actor).report.coverage!.complete).toBe(true);
    expect(work.assessArtifact(taskId, actor, assessment).report.outcome).toBe(
      "agrees-with-assessment",
    );
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
