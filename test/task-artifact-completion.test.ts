// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ArtifactEdit } from "../src/coordination/task-artifact";
import type {
  ArtifactReviewer,
  ArtifactReviewQuestion,
} from "../src/coordination/task-artifact-review";
import { TaskWork, type WorkActor } from "../src/coordination/task-work";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { taskCommand } from "../src/engine/commands/task";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

describe("advisory artifact completion", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  let work: TaskWork;
  let owner: WorkActor;
  let peer: WorkActor;
  let taskId: number;
  let ref: string;
  const quote = "No replacement is eligible. Retain the currently deployed version.";
  const revision = () => fixture.db.getTaskWorkRevision(taskId)!.revision;
  const edit = (edits: ArtifactEdit[], base = revision()) =>
    work.editArtifact(taskId, owner, base, edits);
  const value = () => JSON.parse(work.renderArtifact(taskId, owner).content);
  const makeWork = (reviewer?: ArtifactReviewer) =>
    new TaskWork(
      fixture.db,
      (actor, source) => resolveEvidenceSource(fixture.db, actor, source),
      reviewer,
    );
  const attach = (id = "technical"): ArtifactEdit => ({
    op: "source",
    path: "/citations",
    ref,
    pick: { doc_id: "/doc_id", quote: "/statements/0" },
    coverage: {
      id,
      requirement: "Current technical eligibility must be supported",
      scopePath: "/phase",
    },
  });
  const questions = (): ArtifactReviewQuestion[] => [
    { id: "rollback", path: "/choice", answerType: "string", refs: [ref] },
  ];
  const answers = () => [
    {
      id: "rollback",
      status: "answered" as const,
      value: "keep-current",
      reason: "No eligible replacement was deployed.",
      citations: [{ ref, quote }],
    },
  ];

  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: { MARINA_DECISION_VERIFY: "off" } });
    fixture = createTestEngine();
    owner = { name: "Owner", id: fixture.login("Owner").entityId };
    peer = { name: "Peer", id: fixture.login("Peer").entityId };
    fixture.db.createMemoryPool("completion-evidence", "evidence", owner.name);
    ref = `note:${fixture.db.createNote(owner.name, JSON.stringify({ doc_id: "technical", statements: [quote] }), undefined, { poolId: "completion-evidence" })}`;
    taskId = fixture.engine.taskManager!.create({
      title: "Select rollback from current eligibility",
      creatorId: owner.id,
      creatorName: owner.name,
    }).id;
    fixture.engine.taskManager!.claim(taskId, peer.id, peer.name);
    work = makeWork();
    work.editArtifact(taskId, owner, 0, [
      {
        op: "set",
        path: "",
        value: {
          phase: 1,
          choice: "binary-revert",
          citations: [{ doc_id: "approval", quote: "Permission only" }],
          superseded: [],
        },
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

  test("one optional edit copies exact evidence and records durable coverage atomically", () => {
    const before = revision();
    const result = edit([attach()]);
    expect(revision()).toBe(before + 1);
    expect(value().citations).toEqual([
      { doc_id: "approval", quote: "Permission only" },
      { doc_id: "technical", quote },
    ]);
    expect(result.feedback.findings).toEqual([]);
    expect(work.artifactStatus(taskId, owner).report.coverage).toMatchObject({
      active: 1,
      matched: 1,
      complete: true,
    });
    edit([attach()]);
    expect(revision()).toBe(before + 1);
    const current = revision();
    expect(() =>
      edit([
        { op: "set", path: "/phase", value: 2 },
        {
          ...attach(),
          coverage: { id: "bad", requirement: "", scopePath: "/phase" },
        } as ArtifactEdit,
      ]),
    ).toThrow("requirement");
    expect(revision()).toBe(current);
    expect(value().phase).toBe(1);
    expect(() => edit([attach(), attach()])).toThrow("distinct");
    expect(revision()).toBe(current);
    expect(() => edit([attach()], before)).toThrow("changed");
  });

  test("edit and handoff feedback finds missing support and suggests a preserving append", () => {
    edit([attach()]);
    const removed = edit([
      { op: "remove", path: "/citations/1", reason: "Simulate an accidental omission" },
    ]);
    const finding = removed.feedback.findings.find((entry) => entry.id === "technical")!;
    expect(finding.message).toContain("missing");
    expect(finding.edits![0]!.op).toBe("source");
    expect(work.show(taskId, peer).artifact!.feedback!.findings).toHaveLength(1);
    const checked = work.checkArtifact(taskId, owner);
    expect(checked.reused).toBe(false); // Reading inline feedback writes no receipt.
    expect(work.checkArtifact(taskId, owner).reused).toBe(true);
    edit(finding.edits!);
    expect(value().citations).toHaveLength(2);
    expect(work.checkArtifact(taskId, owner).feedback.findings).toEqual([]);
    expect(value().choice).toBe("binary-revert"); // Evidence presence is not a semantic oracle.
  });

  test("source and phase changes ask for reconsideration without replacing decisions", () => {
    edit([attach()]);
    const old = revision();
    const changed = edit([{ op: "set", path: "/phase", value: 2 }]);
    expect(changed.feedback.outcome).toBe("unverified");
    expect(changed.feedback.findings[0]!.message).toContain("context changed");
    edit([attach()]);
    expect(work.artifactStatus(taskId, owner).report.coverage!.complete).toBe(true);
    expect(work.renderArtifact(taskId, owner, old).rules[0]!.when!.equals).toBe(1);
    fixture.db.reviseNote(
      owner.name,
      Number(ref.slice(5)),
      JSON.stringify({ doc_id: "technical", statements: ["The replacement is now eligible."] }),
    );
    const status = work.artifactStatus(taskId, owner);
    expect(status.report.checks[0]!.evidence).toBe("superseded");
    expect(status.feedback.findings[0]!.edits).toBeUndefined();
    expect(value().choice).toBe("binary-revert");
  });

  test("renewing only part of the evidence cannot mark current-context coverage complete", () => {
    edit([attach("eligibility"), attach("capacity")]);
    edit([{ op: "set", path: "/phase", value: 2 }]);
    expect(work.artifactStatus(taskId, owner).report.coverage).toMatchObject({
      active: 0,
      needsRenewal: 2,
      complete: false,
    });
    edit([attach("eligibility")]);
    const status = work.artifactStatus(taskId, owner);
    expect(status.report.coverage).toMatchObject({
      active: 1,
      matched: 1,
      needsRenewal: 1,
      complete: false,
    });
    expect(status.report.outcome).toBe("unverified");
    edit([attach("capacity")]);
    expect(work.artifactStatus(taskId, owner).report.coverage!.complete).toBe(true);
  });

  test("unavailable evidence does not leak through feedback or repair suggestions", () => {
    ref = `note:${fixture.db.createNote(owner.name, JSON.stringify({ doc_id: "private", statements: ["Confidential eligibility fact"] }))}`;
    work.declareArtifactRule(taskId, owner, revision(), {
      id: "private",
      path: "/citations",
      op: "includesSource",
      selection: { ref, pick: { doc_id: "/doc_id", quote: "/statements/0" } },
    });
    const status = work.artifactStatus(taskId, peer);
    expect(status.report.checks[0]!.evidence).toBe("unavailable");
    expect(status.feedback.findings[0]!.edits).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("Confidential");
    expect(JSON.stringify(work.show(taskId, peer))).not.toContain("selectionVersion");
    expect(() => work.editArtifact(taskId, peer, revision(), [attach()])).toThrow("unavailable");
  });

  test("ordinary source copies retain accessible history without certifying it as current support", () => {
    fixture.db.reviseNote(owner.name, Number(ref.slice(5)), "A later technical update.");
    const historical = attach();
    if (historical.op !== "source") throw new Error("Expected source fixture");
    const { coverage: _coverage, ...copy } = historical;
    edit([copy]);
    expect(value().citations).toContainEqual({ doc_id: "technical", quote });
    expect(work.artifactStatus(taskId, owner).report.coverage!.complete).toBeNull();
    const before = revision();
    expect(() => edit([historical])).toThrow("current source evidence");
    expect(revision()).toBe(before);
  });

  test("scoped replacement follows context, keeps history and leaves unknown batches unverified", () => {
    const first = { old: "a", new: "b" };
    edit([
      {
        op: "replace",
        path: "/superseded",
        value: [first],
        scopePath: "/phase",
        reason: "Publish only current corrections",
      },
    ]);
    const initial = revision();
    const next = edit([{ op: "set", path: "/phase", value: 2 }]);
    expect(value().superseded).toEqual([]);
    expect(
      next.feedback.findings.find((entry) => entry.id === "scope:/superseded")!.message,
    ).toContain("No entries were declared");
    expect(work.artifactStatus(taskId, owner).report.projections![0]!.status).toBe("unverified");
    edit([
      {
        op: "replace",
        path: "/superseded",
        value: [],
        reason: "Confirmed there are no new corrections",
      },
    ]);
    expect(work.artifactStatus(taskId, owner).report.projections![0]!.status).toBe("matches");
    edit([{ op: "append", path: "/superseded", value: { old: "b", new: "c" } }]);
    edit([{ op: "set", path: "/phase", value: 1 }]);
    expect(value().superseded).toEqual([first]);
    edit([{ op: "set", path: "/phase", value: 2 }]);
    expect(value().superseded).toEqual([{ old: "b", new: "c" }]);
    expect(JSON.parse(work.renderArtifact(taskId, owner, initial).content).superseded).toEqual([
      first,
    ]);
    expect(work.renderArtifact(taskId, owner).projections[0]!.batches).toHaveLength(2);
  });

  test("following projections respect ordinary file adoption and refuse stale indirect edits", () => {
    edit([
      {
        op: "replace",
        path: "/superseded",
        value: ["one"],
        scopePath: "/phase",
        reason: "Scope list",
      },
    ]);
    const old = revision();
    edit([{ op: "append", path: "/superseded", value: "peer correction" }]);
    expect(() => edit([{ op: "set", path: "/phase", value: 2 }], old)).toThrow("context changed");
    const imported = { ...value(), phase: 2, superseded: ["explicit file list"] };
    edit([
      { op: "replace", path: "", value: imported, reason: "Adopt explicit ordinary file edit" },
    ]);
    expect(value()).toEqual(imported);
    edit([{ op: "set", path: "/phase", value: 1 }]);
    expect(value().superseded).toEqual(["one", "peer correction"]);
    const before = revision();
    expect(() =>
      edit([
        { op: "set", path: "/phase", value: 3 },
        { op: "remove", path: "/absent", reason: "invalid" },
      ]),
    ).toThrow("existing");
    expect(revision()).toBe(before);
    expect(value().superseded).toEqual(["one", "peer correction"]);
  });

  test("following outputs cannot become another projection's context in either declaration order", () => {
    const following: ArtifactEdit = {
      op: "replace",
      path: "/superseded",
      value: [],
      scopePath: "/phase",
      reason: "Follow the current phase",
    };
    const dependent: ArtifactEdit = {
      op: "project",
      path: "/citations",
      scopePath: "/superseded",
      entries: [],
      reason: "Attempt a coupled projection",
    };
    const before = revision();
    for (const edits of [
      [following, dependent],
      [dependent, following],
    ]) {
      expect(() => edit(edits)).toThrow("independent output and scope paths");
      expect(revision()).toBe(before);
      expect(value().citations).toHaveLength(1);
    }
  });

  test("an unavailable advisory inspection cannot roll back an edit or ordinary submission", async () => {
    work = new (class extends TaskWork {
      override artifactStatus(): never {
        throw new Error("Inspection temporarily unavailable");
      }
    })(fixture.db, (actor, source) => resolveEvidenceSource(fixture.db, actor, source));
    const result = edit([{ op: "set", path: "/choice", value: "keep-current" }]);
    expect(result.feedback.outcome).toBe("unverified");
    expect(result.feedback.findings[0]!.id).toBe("feedback-unavailable");
    expect(value().choice).toBe("keep-current");
    expect(work.show(taskId, peer).artifact!.feedback!.outcome).toBe("unverified");
    fixture.engine.commands.registerBuiltin(
      taskCommand(
        fixture.engine.taskManager!,
        (name) => fixture.engine.findEntityGlobal(name),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        work,
      ),
    );
    await fixture.engine.dispatchCommand(peer.id as never, `task submit ${taskId} Decision ready`);
    expect(fixture.db.getTaskClaim(taskId, peer.id)!.status).toBe("submitted");
    await fixture.engine.dispatchCommand(owner.id as never, `task approve ${taskId} Peer`);
    expect(fixture.db.getTask(taskId)!.status).toBe("completed");
  });

  test("typed review rejects yes/no answers for values without inventing disagreement", () => {
    const qs = questions();
    const packet = work.reviewArtifact(taskId, peer, qs);
    expect(packet.questions[0]!.question).toContain("Derive the current value");
    expect(JSON.stringify(packet)).not.toContain("binary-revert");
    expect(() =>
      work.assessArtifact(taskId, peer, {
        fingerprint: packet.fingerprint,
        questions: qs,
        answers: [{ ...answers()[0]!, value: true }],
      }),
    ).toThrow("needs a string value");
    const result = work.assessArtifact(taskId, peer, {
      fingerprint: packet.fingerprint,
      questions: qs,
      answers: answers(),
    });
    expect(result.report.outcome).toBe("disagreements");
    expect(result.report.context).toBe("caller-supplied");
    expect(value().choice).toBe("binary-revert");
    const legacy = [
      { id: "rollback", path: "/choice", question: "Is the draft right?", refs: [ref] },
    ];
    const old = work.reviewArtifact(taskId, peer, legacy);
    expect(
      work.assessArtifact(taskId, peer, {
        fingerprint: old.fingerprint,
        questions: legacy,
        answers: [{ ...answers()[0]!, value: true }],
      }).report.outcome,
    ).toBe("invalid-assessment");
  });

  test("contract answer type permits identifying a wrongly typed draft", () => {
    edit([{ op: "set", path: "/choice", value: true }]);
    const packet = work.reviewArtifact(taskId, peer, questions());
    expect(
      work.assessArtifact(taskId, peer, {
        fingerprint: packet.fingerprint,
        questions: questions(),
        answers: answers(),
      }).report.checks[0]!.status,
    ).toBe("disagrees");
  });

  test("fresh requests share work, reuse unchanged evidence and never edit or approve", async () => {
    let calls = 0;
    work = makeWork(async (packet, model) => {
      calls++;
      expect(packet).not.toHaveProperty("value");
      expect(packet).not.toHaveProperty("rules");
      expect(JSON.stringify(packet)).not.toContain("binary-revert");
      return { model, answers: answers() };
    });
    const before = revision();
    const [a, b] = await Promise.all([
      work.reviewFreshArtifact(taskId, peer, { questions: questions() }),
      work.reviewFreshArtifact(taskId, peer, { questions: questions() }),
    ]);
    expect(calls).toBe(1);
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.report.context).toBe("fresh");
    expect(a.report.outcome).toBe("disagreements");
    expect((await work.reviewFreshArtifact(taskId, peer, { questions: questions() })).reused).toBe(
      true,
    );
    expect(calls).toBe(1);
    expect(revision()).toBe(before);
    expect(fixture.db.getTask(taskId)!.status).toBe("claimed");
    edit([{ op: "set", path: "/choice", value: "keep-current" }]);
    expect(
      (await work.reviewFreshArtifact(taskId, peer, { questions: questions() })).report.outcome,
    ).toBe("agrees-with-assessment");
    expect(calls).toBe(2);
    await fixture.engine.dispatchCommand(
      peer.id as never,
      `task submit ${taskId} Authored decision`,
    );
    await fixture.engine.dispatchCommand(owner.id as never, `task approve ${taskId} Peer`);
    expect(fixture.db.getTask(taskId)!.status).toBe("completed");
  });

  test("a mistaken fresh reviewer with valid citations cannot replace a correct partial-restoration decision", async () => {
    const measured = "East service passed measured acceptance. West service still awaits wiring.";
    ref = `note:${fixture.db.createNote(owner.name, measured, undefined, { poolId: "completion-evidence" })}`;
    edit([
      { op: "set", path: "/choice", value: "partial-east" },
      {
        op: "replace",
        path: "/citations",
        value: [{ doc_id: "measurement", quote: measured }],
        reason: "Record the measured partial restoration.",
      },
    ]);
    work = makeWork(async (_packet, model) => ({
      model,
      answers: [
        {
          id: "rollback",
          status: "answered",
          value: "restoration-in-progress",
          reason: "West is incomplete, therefore treat the whole service as unmeasured.",
          citations: [{ ref, quote: measured }],
        },
      ],
    }));
    const before = work.renderArtifact(taskId, owner).content;
    const beforeRevision = revision();
    const review = await work.reviewFreshArtifact(taskId, peer, { questions: questions() });
    expect(review.report.outcome).toBe("disagreements");
    expect(review.report.checks[0]!.assessed).toBe("restoration-in-progress");
    expect(work.renderArtifact(taskId, owner).content).toBe(before);
    expect(revision()).toBe(beforeRevision);
    expect(fixture.db.getTask(taskId)!.status).toBe("claimed");
    expect((await work.reviewFreshArtifact(taskId, peer, { questions: questions() })).reused).toBe(
      true,
    );
    expect(work.renderArtifact(taskId, owner).content).toBe(before);
  });

  test("fresh review cannot publish a stale assessment after evidence changes during inference", async () => {
    work = makeWork(async () => {
      fixture.db.reviseNote(
        owner.name,
        Number(ref.slice(5)),
        "New evidence arrived during the review.",
      );
      return { model: "test", answers: answers() };
    });
    const before = revision();
    await expect(
      work.reviewFreshArtifact(taskId, peer, { questions: questions() }),
    ).rejects.toThrow("context changed");
    expect(revision()).toBe(before);
    expect(value().choice).toBe("binary-revert");
  });

  test("missing reviewer, malformed questions and provider failure leave ordinary work available", async () => {
    await expect(
      work.reviewFreshArtifact(taskId, owner, { questions: questions() }),
    ).rejects.toThrow("not configured");
    let calls = 0;
    work = makeWork(async () => {
      calls++;
      throw new Error("provider offline");
    });
    await expect(
      work.reviewFreshArtifact(taskId, owner, {
        questions: [{ id: "x", path: "/choice", refs: [ref] }],
      }),
    ).rejects.toThrow("answerType");
    expect(calls).toBe(0);
    await expect(
      work.reviewFreshArtifact(taskId, owner, { questions: questions() }),
    ).rejects.toThrow("provider offline");
    await expect(
      work.reviewFreshArtifact(taskId, owner, { questions: questions() }),
    ).rejects.toThrow("provider offline");
    expect(calls).toBe(2); // Failed requests do not poison the pending-request cache.
    edit([{ op: "set", path: "/choice", value: "keep-current" }]);
    expect(value().choice).toBe("keep-current");
  });

  test("the queued world command awaits fresh review and its receipt without imposing a submit gate", async () => {
    let calls = 0;
    work = makeWork(async () => {
      calls++;
      return { model: "test", answers: answers() };
    });
    fixture.engine.commands.registerBuiltin(
      taskCommand(
        fixture.engine.taskManager!,
        (name) => fixture.engine.findEntityGlobal(name),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        work,
      ),
    );
    await fixture.engine.dispatchCommand(
      peer.id as never,
      `task work ${taskId} artifact-review-fresh ${JSON.stringify({ questions: questions() })}`,
    );
    expect(calls).toBe(1);
    expect((await work.reviewFreshArtifact(taskId, peer, { questions: questions() })).reused).toBe(
      true,
    );
    edit([attach()]);
    edit([{ op: "remove", path: "/citations/1", reason: "Missing support" }]);
    await fixture.engine.dispatchCommand(
      peer.id as never,
      `task submit ${taskId} Deliberate incomplete proposal`,
    );
    expect(fixture.db.getTaskClaim(taskId, peer.id)!.status).toBe("submitted");
    expect(calls).toBe(1);
    await fixture.engine.dispatchCommand(owner.id as never, `task approve ${taskId} Peer`);
    expect(fixture.db.getTask(taskId)!.status).toBe("completed");
  });
});
