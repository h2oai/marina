// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ArtifactReviewAnswer,
  ArtifactReviewQuestion,
} from "../src/coordination/task-artifact-review";
import { TaskWork, type WorkActor } from "../src/coordination/task-work";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { createTestEngine } from "./engine-fixture";

describe("source-derived set membership review", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let work: TaskWork;
  let owner: WorkActor;
  let taskId: number;
  let contract: string;
  let evidence: string;
  const criterion =
    "Only currently unanswered requests; exclude future prerequisites and completed work.";
  const facts = [
    "An inspection request is currently unanswered.",
    "A permit cannot be requested until the inspection passes; no permit request has been filed.",
    "The receipt request was answered yesterday.",
  ];
  const questions = (): ArtifactReviewQuestion[] => [
    {
      id: "pending",
      path: "/pending",
      answerType: "array",
      refs: [contract, evidence],
      set: { ref: contract, criterionPath: "/criterion", candidatesPath: "/allowed" },
    },
  ];
  const answers = (): ArtifactReviewAnswer[] => [
    {
      id: "pending",
      status: "answered",
      value: ["inspection"],
      reason: facts[0]!,
      citations: [{ ref: evidence, quote: facts[0]! }],
      membership: ["inspection", "permit", "receipt"].map((value, index) => ({
        value,
        status: index === 0 ? "include" : "exclude",
        reason: facts[index]!,
        citations: [{ ref: evidence, quote: facts[index]! }],
      })),
    },
  ];
  const assess = (answer = answers()) => {
    const packet = work.reviewArtifact(taskId, owner, questions());
    return work.assessArtifact(taskId, owner, {
      fingerprint: packet.fingerprint,
      questions: questions(),
      answers: answer,
    });
  };
  beforeEach(() => {
    fixture = createTestEngine();
    owner = { name: "Owner", id: fixture.login("Owner").entityId };
    contract = `note:${fixture.db.createNote(owner.name, JSON.stringify({ criterion, allowed: ["inspection", "permit", "receipt"] }))}`;
    evidence = `note:${fixture.db.createNote(owner.name, facts.join("\n"))}`;
    taskId = fixture.engine.taskManager!.create({
      title: "Report currently pending requests",
      creatorId: owner.id,
      creatorName: owner.name,
    }).id;
    work = new TaskWork(fixture.db, (actor, ref) => resolveEvidenceSource(fixture.db, actor, ref));
    work.editArtifact(taskId, owner, 0, [
      {
        op: "set",
        path: "",
        value: { pending: ["inspection", "permit"], dependencies: ["inspect-before-permit"] },
      },
    ]);
  });
  afterEach(async () => {
    await fixture.dispose();
  });

  test("a matching authored list still exposes its unverified membership and source-first review finds the future request", () => {
    work.declareArtifactRule(taskId, owner, 1, {
      id: "pending",
      path: "/pending",
      op: "setEquals",
      expected: ["inspection", "permit"],
      requirement: criterion,
    });
    const check = work.checkArtifact(taskId, owner);
    expect(check.report.outcome).toBe("matches-declared-checks");
    expect(check.feedback.notices?.some((f) => f.id === "membership:pending")).toBe(true);
    expect(check.feedback.findings.some((f) => f.id === "membership:pending")).toBe(false);
    const packet = work.reviewArtifact(taskId, owner, questions());
    expect(packet.questions[0]!.membership).toEqual({
      criterion,
      candidates: ["inspection", "permit", "receipt"],
    });
    expect(packet).not.toHaveProperty("value");
    expect(packet).not.toHaveProperty("rules");
    const before = work.renderArtifact(taskId, owner).content;
    const result = assess();
    expect(result.report.outcome).toBe("disagreements");
    expect(result.report.checks[0]!.membership?.find((m) => m.value === "permit")?.status).toBe(
      "exclude",
    );
    expect(work.renderArtifact(taskId, owner).content).toBe(before);
    expect(fixture.db.getTask(taskId)!.status).toBe("open");
  });

  test("missing, invented, duplicated or contradictory membership cannot yield an answered assessment", () => {
    for (const change of [
      (a: ArtifactReviewAnswer) => {
        a.membership = undefined;
      },
      (a: ArtifactReviewAnswer) => {
        a.membership!.pop();
      },
      (a: ArtifactReviewAnswer) => {
        a.membership!.push(a.membership![0]!);
      },
      (a: ArtifactReviewAnswer) => {
        a.membership![1]!.value = "invented";
      },
      (a: ArtifactReviewAnswer) => {
        a.membership![1]!.status = "unknown";
      },
      (a: ArtifactReviewAnswer) => {
        a.membership![1]!.citations = [];
      },
      (a: ArtifactReviewAnswer) => {
        a.membership![1]!.citations[0]!.quote = "A permit is pending now.";
      },
      (a: ArtifactReviewAnswer) => {
        a.value = ["inspection", "permit"];
      },
      (a: ArtifactReviewAnswer) => {
        a.value = ["inspection", "inspection"];
      },
    ]) {
      const answer = answers();
      change(answer[0]!);
      expect(() => assess(answer)).toThrow();
    }
    const uncertain = answers();
    uncertain[0]!.status = "unknown";
    uncertain[0]!.value = undefined;
    uncertain[0]!.membership![1]!.status = "unknown";
    expect(assess(uncertain).report.outcome).toBe("unverified");
  });

  test("a source-selected set compares unordered members but never accepts duplicate artifact entries", () => {
    const updatedFacts = [facts[0]!, facts[1]!, "The receipt request is currently unanswered."];
    evidence = `note:${fixture.db.createNote(owner.name, updatedFacts.join("\n"))}`;
    const answer = answers();
    answer[0]!.value = ["inspection", "receipt"];
    answer[0]!.membership![2] = {
      value: "receipt",
      status: "include",
      reason: updatedFacts[2]!,
      citations: [{ ref: evidence, quote: updatedFacts[2]! }],
    };
    answer[0]!.membership!.reverse();
    work.editArtifact(taskId, owner, 1, [
      {
        op: "replace",
        path: "/pending",
        value: ["receipt", "inspection"],
        reason: "Apply the source-derived current list",
      },
    ]);
    expect(assess(answer).report.outcome).toBe("agrees-with-assessment");
    work.editArtifact(taskId, owner, 2, [
      {
        op: "replace",
        path: "/pending",
        value: ["receipt", "inspection", "inspection"],
        reason: "An accidental duplicate",
      },
    ]);
    expect(assess(answer).report.outcome).toBe("disagreements");
  });

  test("contract access and changes invalidate review without a model call or artifact edit", async () => {
    let calls = 0;
    work = new TaskWork(
      fixture.db,
      (actor, ref) => resolveEvidenceSource(fixture.db, actor, ref),
      async () => {
        calls++;
        return { answers: answers(), model: "test" };
      },
    );
    await work.reviewFreshArtifact(taskId, owner, { questions: questions() });
    expect((await work.reviewFreshArtifact(taskId, owner, { questions: questions() })).reused).toBe(
      true,
    );
    expect(calls).toBe(1);
    const outsider = { name: "Outsider", id: fixture.login("Outsider").entityId };
    await expect(
      work.reviewFreshArtifact(taskId, outsider, { questions: questions() }),
    ).rejects.toThrow("current source");
    const packet = work.reviewArtifact(taskId, owner, questions());
    const successor = fixture.db.reviseNote(
      owner.name,
      Number(contract.slice(5)),
      JSON.stringify({
        criterion: "Updated criterion",
        allowed: ["inspection", "permit", "receipt"],
      }),
    );
    expect(() =>
      work.assessArtifact(taskId, owner, {
        fingerprint: packet.fingerprint,
        questions: questions(),
        answers: answers(),
      }),
    ).toThrow("current source");
    expect(successor).toBeNumber();
    contract = `note:${successor}`;
    expect(() =>
      work.assessArtifact(taskId, owner, {
        fingerprint: packet.fingerprint,
        questions: questions(),
        answers: answers(),
      }),
    ).toThrow("context changed");
    expect(calls).toBe(1);
  });

  test("type mismatches remain strict and explain why weakening checks does not fix them", () => {
    work.editArtifact(taskId, owner, 1, [{ op: "set", path: "/phase", value: 1 }]);
    work.declareArtifactRules(taskId, owner, 2, [
      { id: "phase", path: "/phase", op: "eq", expected: "1" },
      {
        id: "conditional",
        path: "/pending",
        op: "required",
        when: { path: "/phase", equals: "1" },
      },
    ]);
    const report = work.checkArtifact(taskId, owner);
    expect(report.report.checks.map((c) => c.status)).toEqual(["discrepancy", "inactive"]);
    expect(report.feedback.findings.filter((f) => f.id.startsWith("type:")).length).toBe(2);
    expect(JSON.parse(work.renderArtifact(taskId, owner).content).phase).toBe(1);
  });

  test("the contract must supply a criterion and a distinct candidate array", () => {
    for (const value of [
      { criterion: "", allowed: ["inspection"] },
      { criterion, allowed: "inspection" },
      { criterion, allowed: ["inspection", "inspection"] },
      { criterion },
    ]) {
      contract = `note:${fixture.db.createNote(owner.name, JSON.stringify(value))}`;
      expect(() => work.reviewArtifact(taskId, owner, questions())).toThrow();
    }
  });

  test("an explicitly empty universe can be reviewed without inventing candidates", () => {
    const text = JSON.stringify({ criterion, allowed: [] });
    contract = `note:${fixture.db.createNote(owner.name, text)}`;
    work.editArtifact(taskId, owner, 1, [
      { op: "replace", path: "/pending", value: [], reason: "The contract has no candidates" },
    ]);
    const result = assess([
      {
        id: "pending",
        status: "answered",
        value: [],
        reason: "The current contract enumerates no candidate requests.",
        citations: [{ ref: contract, quote: text }],
        membership: [],
      },
    ]);
    expect(result.report.outcome).toBe("agrees-with-assessment");
  });
});
