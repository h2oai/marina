// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ArtifactEdit, ArtifactRuleInput } from "../src/coordination/task-artifact";
import type { ArtifactReviewAnswer } from "../src/coordination/task-artifact-review";
import { TaskWork, type WorkActor } from "../src/coordination/task-work";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

describe("evidence coverage and separate assessment", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  let work: TaskWork;
  let owner: WorkActor;
  let peer: WorkActor;
  let taskId: number;
  const revision = () => fixture.db.getTaskWorkRevision(taskId)!.revision;
  const edit = (edits: ArtifactEdit[], base = revision()) =>
    work.editArtifact(taskId, owner, base, edits);
  const value = () => JSON.parse(work.renderArtifact(taskId, owner).content);
  const source = (doc: string, statement: string, shared = true) =>
    `note:${fixture.db.createNote(
      owner.name,
      JSON.stringify({ doc_id: doc, statements: [statement] }),
      undefined,
      shared ? { poolId: "evidence-pool" } : undefined,
    )}`;
  const coverage = (id: string, ref: string): ArtifactRuleInput => ({
    id,
    path: "/citations",
    op: "includesSource",
    when: { path: "/phase", equals: 1 },
    selection: { ref, pick: { doc_id: "/doc_id", quote: "/statements/0" } },
  });

  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: { MARINA_DECISION_VERIFY: "off" } });
    fixture = createTestEngine();
    owner = { id: fixture.login("Owner").entityId, name: "Owner" };
    peer = { id: fixture.login("Peer").entityId, name: "Peer" };
    fixture.db.createMemoryPool("evidence-pool", "evidence", owner.name);
    taskId = fixture.engine.taskManager!.create({
      title: "Choose an eligible candidate",
      creatorId: owner.id,
      creatorName: owner.name,
    }).id;
    fixture.engine.taskManager!.claim(taskId, peer.id, peer.name);
    work = new TaskWork(fixture.db, (actor, ref) => resolveEvidenceSource(fixture.db, actor, ref));
    work.editArtifact(taskId, owner, 0, [
      {
        op: "set",
        path: "",
        value: { phase: 1, choice: "unsigned-hotfix", citations: [], superseded: [] },
      },
    ]);
  });
  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      state.dispose();
    }
  });

  test("valid approval evidence cannot substitute for a missing technical source", () => {
    const approval = source("approval", "Permission is granted, subject to technical validation.");
    const technical = source(
      "technical",
      "No candidate is eligible; the unsigned hotfix has not passed validation.",
    );
    work.declareArtifactRules(taskId, owner, revision(), [
      coverage("approval", approval),
      coverage("technical", technical),
    ]);
    edit([
      {
        op: "source",
        path: "/citations",
        ref: approval,
        pick: { doc_id: "/doc_id", quote: "/statements/0" },
      },
    ]);
    expect(work.checkArtifact(taskId, peer).report).toMatchObject({
      outcome: "discrepancies",
      coverage: { active: 2, matched: 1, complete: false },
    });
    // Mixing the right doc ID with a different source's quote cannot satisfy coverage.
    edit([
      {
        op: "append",
        path: "/citations",
        value: {
          doc_id: "technical",
          quote: "Permission is granted, subject to technical validation.",
        },
      },
    ]);
    expect(work.checkArtifact(taskId, peer).report.coverage!.complete).toBe(false);
    edit([
      {
        op: "source",
        path: "/citations",
        ref: technical,
        pick: { doc_id: "/doc_id", quote: "/statements/0" },
      },
    ]);
    expect(work.checkArtifact(taskId, peer).report.coverage).toMatchObject({
      matched: 2,
      complete: true,
    });
    expect(value().choice).toBe("unsigned-hotfix"); // Complete declared citations do not certify the wrong interpretation.
    expect(value().citations).toHaveLength(3);
    expect(work.checkArtifact(taskId, peer).reused).toBe(true);
    fixture.db.reviseNote(
      owner.name,
      Number(technical.slice(5)),
      "The technical record has changed.",
    );
    expect(work.checkArtifact(taskId, peer)).toMatchObject({
      reused: false,
      report: { outcome: "unverified", coverage: { complete: false } },
    });
  });

  test("source selections and review packets recheck access, including historical views", () => {
    const ref = source("private", "Private validation has not passed.", false);
    work.declareArtifactRule(taskId, owner, revision(), coverage("private", ref));
    const old = revision();
    expect(work.checkArtifact(taskId, peer).report.checks[0]).toMatchObject({
      evidence: "unavailable",
      status: "unverified",
    });
    const shown = JSON.stringify(work.show(taskId, peer, old));
    expect(shown).not.toContain("Private validation");
    expect(shown).not.toContain("selectionVersion");
    const questions = [
      { id: "choice", path: "/choice", question: "Which candidate is eligible?", refs: [ref] },
    ];
    const packet = work.reviewArtifact(taskId, peer, questions);
    expect(packet.sources).toEqual([{ ref, status: "unavailable" }]);
    expect(() =>
      work.assessArtifact(taskId, peer, {
        fingerprint: packet.fingerprint,
        questions,
        answers: [
          {
            id: "choice",
            status: "answered",
            value: "none",
            reason: "Private evidence",
            citations: [{ ref, quote: "Private validation" }],
          },
        ],
      }),
    ).toThrow("accessible");
    expect(
      work.assessArtifact(taskId, peer, {
        fingerprint: packet.fingerprint,
        questions,
        answers: [
          {
            id: "choice",
            status: "unknown",
            reason: "Required source is unavailable",
            citations: [],
          },
        ],
      }).report.outcome,
    ).toBe("unverified");
  });

  test("rule batches are atomic and old-context checks cannot contradict a new decision", async () => {
    const before = revision();
    expect(() =>
      work.declareArtifactRules(taskId, owner, before, [
        {
          id: "old",
          path: "/choice",
          op: "eq",
          expected: "unsigned-hotfix",
          when: { path: "/phase", equals: 1 },
        },
        coverage("bad", "note:999999"),
      ]),
    ).toThrow("accessible");
    expect(revision()).toBe(before);
    const rules: ArtifactRuleInput[] = [
      {
        id: "old",
        path: "/choice",
        op: "eq",
        expected: "unsigned-hotfix",
        when: { path: "/phase", equals: 1 },
      },
      {
        id: "new",
        path: "/choice",
        op: "eq",
        expected: "validated",
        when: { path: "/phase", equals: 2 },
      },
    ];
    await fixture.engine.dispatchCommand(
      owner.id as never,
      `task work ${taskId} artifact-rules ${before} ${JSON.stringify(rules)}`,
    );
    expect(work.checkArtifact(taskId, owner).report.checks.map((check) => check.status)).toEqual([
      "matches",
      "inactive",
    ]);
    edit([
      { op: "set", path: "/phase", value: 2 },
      { op: "set", path: "/choice", value: "validated" },
    ]);
    expect(work.checkArtifact(taskId, owner).report.checks.map((check) => check.status)).toEqual([
      "inactive",
      "matches",
    ]);
    const current = revision();
    expect(work.declareArtifactRules(taskId, owner, current, rules)).toEqual({
      revision: current,
      changed: false,
    });
    edit([{ op: "set", path: "/phase", value: 3 }]);
    expect(work.checkArtifact(taskId, owner).report.outcome).toBe("unverified");
  });

  test("current-context projection excludes historical supersessions without erasing history", () => {
    const one = { old_doc_id: "policy-0", new_doc_id: "policy-1", reason: "New policy" };
    const two = {
      old_doc_id: "validation-1",
      new_doc_id: "validation-2",
      reason: "New measurement",
    };
    edit([
      {
        op: "project",
        path: "/superseded",
        scopePath: "/phase",
        entries: [one, one],
        reason: "Current phase",
      },
    ]);
    const first = revision();
    expect(value().superseded).toEqual([one]);
    expect(work.checkArtifact(taskId, owner).report.outcome).toBe("matches-declared-checks");
    edit([{ op: "set", path: "/phase", value: 2 }]);
    expect(work.checkArtifact(taskId, owner).report.projections![0]!.status).toBe("unverified");
    expect(() =>
      edit([
        {
          op: "project",
          path: "/superseded",
          scopePath: "/phase",
          reason: "Unknown current entries",
        },
      ]),
    ).toThrow("No entries");
    edit([
      {
        op: "project",
        path: "/superseded",
        scopePath: "/phase",
        entries: [two],
        reason: "Current phase",
      },
    ]);
    expect(value().superseded).toEqual([two]);
    expect(work.renderArtifact(taskId, owner).projections[0]!.batches).toHaveLength(2);
    expect(JSON.parse(work.renderArtifact(taskId, owner, first).content).superseded).toEqual([one]);
    edit([{ op: "append", path: "/superseded", value: one }]);
    expect(work.checkArtifact(taskId, owner).report.projections![0]!.status).toBe("discrepancy");
    edit([
      {
        op: "project",
        path: "/superseded",
        scopePath: "/phase",
        reason: "Restore only current entries",
      },
    ]);
    expect(value().superseded).toEqual([two]);
    const current = revision();
    edit([{ op: "project", path: "/superseded", scopePath: "/phase", reason: "Already current" }]);
    expect(revision()).toBe(current);
  });

  test("projection refuses stale scopes and rolls back its history on failed edits", () => {
    const base = revision();
    edit([{ op: "set", path: "/phase", value: 2 }]);
    expect(() =>
      edit(
        [{ op: "project", path: "/superseded", scopePath: "/phase", entries: [], reason: "Empty" }],
        base,
      ),
    ).toThrow("scope changed");
    const current = revision();
    expect(() =>
      edit([
        { op: "project", path: "/superseded", scopePath: "/phase", entries: [], reason: "Empty" },
        { op: "remove", path: "/absent", reason: "Bad edit" },
      ]),
    ).toThrow("existing");
    expect(revision()).toBe(current);
    expect(work.renderArtifact(taskId, owner).projections).toEqual([]);
    expect(() =>
      edit([
        { op: "project", path: "/phase", scopePath: "/phase", entries: [], reason: "Bad overlap" },
      ]),
    ).toThrow("overlap");
  });

  test("object and array scopes are snapshots even when changed in the same batch", () => {
    for (const context of [{ phase: 1 }, [1]]) {
      edit([
        { op: "replace", path: "/context", value: null, reason: "Initialize next scope case" },
      ]);
      edit([{ op: "set", path: "/context", value: context }]);
      const target = Array.isArray(context) ? "/arrayHistory" : "/objectHistory";
      edit([
        {
          op: "project",
          path: target,
          scopePath: "/context",
          entries: [{ old: "a", new: "b" }],
          reason: "Current context",
        },
        { op: "set", path: Array.isArray(context) ? "/context/0" : "/context/phase", value: 2 },
      ]);
      const projection = work
        .renderArtifact(taskId, owner)
        .projections.find((entry) => entry.path === target)!;
      expect(projection.batches[0]!.scope).toEqual(context);
      expect(
        work
          .checkArtifact(taskId, owner)
          .report.projections!.find((entry) => entry.path === target)!.status,
      ).toBe("unverified");
    }
  });

  test("answer-free review exposes a wrong choice even when authored checks agree with it", async () => {
    const statement = "No candidate is eligible; the unsigned hotfix has not passed validation.";
    const ref = source("technical", statement);
    work.declareArtifactRule(taskId, owner, revision(), {
      id: "circular",
      path: "/choice",
      op: "eq",
      expected: "unsigned-hotfix",
    });
    expect(work.checkArtifact(taskId, owner).report.outcome).toBe("matches-declared-checks");
    const questions = [
      {
        id: "eligible",
        path: "/choice",
        question:
          "Which candidate is eligible for deployment now, given technical validation? Return none if none is eligible.",
        refs: [ref],
      },
    ];
    const packet = work.reviewArtifact(taskId, peer, questions);
    expect(packet).not.toHaveProperty("value");
    expect(packet).not.toHaveProperty("rules");
    expect(packet).not.toHaveProperty("expected");
    expect(JSON.stringify(packet)).not.toContain('"unsigned-hotfix"');
    const answers: ArtifactReviewAnswer[] = [
      {
        id: "eligible",
        status: "answered",
        value: "none",
        reason: "The technical record rules out every candidate.",
        citations: [{ ref, quote: statement }],
      },
    ];
    const result = work.assessArtifact(taskId, peer, {
      fingerprint: packet.fingerprint,
      questions,
      answers,
    });
    expect(result.report).toMatchObject({
      outcome: "disagreements",
      checks: [
        { actual: "unsigned-hotfix", assessed: "none", reviewerHasRecordedContribution: false },
      ],
    });
    expect(
      work.assessArtifact(taskId, peer, { fingerprint: packet.fingerprint, questions, answers })
        .reused,
    ).toBe(true);
    expect(() =>
      work.assessArtifact(taskId, peer, {
        fingerprint: packet.fingerprint,
        questions,
        answers: [],
      }),
    ).toThrow("exactly once");
    const mine = work.reviewArtifact(taskId, owner, questions);
    expect(
      work.assessArtifact(taskId, owner, { fingerprint: mine.fingerprint, questions, answers })
        .report.checks[0]!.reviewerHasRecordedContribution,
    ).toBe(true);
    edit([{ op: "set", path: "/choice", value: "none" }]);
    expect(() =>
      work.assessArtifact(taskId, peer, { fingerprint: packet.fingerprint, questions, answers }),
    ).toThrow("context changed");
    const updated = work.reviewArtifact(taskId, peer, questions);
    const assessment = { fingerprint: updated.fingerprint, questions, answers };
    await fixture.engine.dispatchCommand(
      peer.id as never,
      `task work ${taskId} artifact-review ${JSON.stringify(questions)}`,
    );
    await fixture.engine.dispatchCommand(
      peer.id as never,
      `task work ${taskId} artifact-assess ${JSON.stringify(assessment)}`,
    );
    expect(work.assessArtifact(taskId, peer, assessment)).toMatchObject({
      reused: true,
      report: { outcome: "agrees-with-assessment" },
    });
    fixture.db.reviseNote(owner.name, Number(ref.slice(5)), "The candidate is now validated.");
    expect(() => work.assessArtifact(taskId, peer, assessment)).toThrow("context changed");
    await fixture.engine.dispatchCommand(peer.id as never, `task submit ${taskId} Deliberate plan`);
    await fixture.engine.dispatchCommand(owner.id as never, `task approve ${taskId} Peer`);
    expect(fixture.db.getTask(taskId)!.status).toBe("completed");
  });
});
