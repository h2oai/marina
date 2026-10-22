// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CONVERGE_WINDOW_MS,
  judgeEarned,
  judgeReportedWakes,
  observeAttentionJudgeEvent,
  recordWakeOutcomes,
  reviewJudgeLines,
  setAttentionJudgeProviderForTests,
  settleAttentionJudges,
  sweepConverge,
} from "../src/agent/attention-judge";
import type { DecisionProvider, DecisionRequest } from "../src/decisions/types";
import { judgeAgreement } from "../src/outcomes/agreement";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";

/** A decision backend that answers every question with fixed numbers, recorded. */
function fakeProvider(answer: { noul?: number; score?: number } = {}) {
  const asked: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    kind: "fake",
    model: "fake-judge",
    async ask(request) {
      asked.push(request);
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(request.questions))
        answers[key] =
          q.type === "score"
            ? { type: "score", score: answer.score ?? 3 }
            : { type: "noul", noul: answer.noul ?? 0.9 };
      return { answers: answers as never, model: "fake-judge", provider: "fake", latencyMs: 1 };
    },
  };
  return { provider, asked };
}

let db: MarinaDB;
const prior = process.env.MARINA_ATTENTION_JUDGE;

beforeEach(() => {
  db = new MarinaDB(":memory:");
  db.saveAgentConfig({ name: "Wren", model: "m", spawnedBy: "jeff" });
  db.saveAgentConfig({ name: "Fern", model: "m", spawnedBy: "jeff" });
});

afterEach(() => {
  setAttentionJudgeProviderForTests(undefined);
  if (prior === undefined) delete process.env.MARINA_ATTENTION_JUDGE;
  else process.env.MARINA_ATTENTION_JUDGE = prior;
  db.close();
});

function tellRow(from: string, to: string, content: string, extra: { cause?: string } = {}) {
  return db.createDirectMessage({
    correlationId: crypto.randomUUID(),
    dedupeKey: crypto.randomUUID(),
    senderId: `e_${from}`,
    senderName: from,
    targetId: `e_${to}`,
    targetName: to,
    content,
    ...extra,
  });
}

function tellSent(from: string, to: string, id: number, depth: number, cause?: string) {
  return {
    type: "tell_sent" as const,
    entity: `e_${from}` as EntityId,
    from,
    to,
    messageRef: `tell:${id}`,
    ...(cause ? { cause } : {}),
    depth,
    timestamp: Date.now(),
  };
}

describe("off", () => {
  it("makes no calls and records nothing", async () => {
    process.env.MARINA_ATTENTION_JUDGE = "off";
    const { provider, asked } = fakeProvider();
    setAttentionJudgeProviderForTests(() => provider);
    const m = tellRow("Wren", "Fern", "done, thanks");
    judgeReportedWakes(db, "Fern", [
      { perceptionRef: `tell:${m.id}`, decision: "now", reason: "information" },
    ]);
    recordWakeOutcomes(db, "Fern", [{ ref: `tell:${m.id}`, worked: false }]);
    observeAttentionJudgeEvent(db, tellSent("Wren", "Fern", m.id, 4));
    await settleAttentionJudges(db);
    expect(asked).toHaveLength(0);
    expect(db.listOutcomes({ limit: 100 })).toHaveLength(0);
  });
});

describe("wake judge", () => {
  it("judges a borderline wake and records its truth on the outcome path", async () => {
    const { provider, asked } = fakeProvider({ noul: 0.2 });
    setAttentionJudgeProviderForTests(() => provider);
    const m = tellRow("Wren", "Fern", "fyi the build is green");
    const ref = `tell:${m.id}`;
    judgeReportedWakes(db, "Fern", [
      { perceptionRef: ref, decision: "now", reason: "information" },
      // A request it must answer, or a context item, is never judged.
      { perceptionRef: ref, decision: "now", reason: "request" },
      { perceptionRef: ref, decision: "context", reason: "information" },
    ]);
    await settleAttentionJudges(db);
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0]!.state)).toContain("<untrusted>");
    const opinion = db.getOutcomeBySubject(`judged:attention:wake:Fern:${ref}`);
    expect(opinion).toMatchObject({ basis: "judged", succeeded: 0, kind: "request" });
    expect(opinion?.judge).toBe("attention-wake:fake-judge");
    // Rows hold numbers and refs, never the message text.
    expect(JSON.stringify(db.listOutcomes({ limit: 10 }))).not.toContain("build is green");

    recordWakeOutcomes(db, "Fern", [{ ref, worked: false }]);
    const [agreement] = judgeAgreement(db, { judge: "attention-wake:fake-judge" });
    expect(agreement).toMatchObject({ judged: 1, compared: 1, agreed: 1, earned: false });
  });

  it("under on, only an earned judge feeds the attention counters", async () => {
    process.env.MARINA_ATTENTION_JUDGE = "on";
    const { provider } = fakeProvider({ noul: 0.1 });
    setAttentionJudgeProviderForTests(() => provider);
    const first = tellRow("Wren", "Fern", "ok");
    judgeReportedWakes(db, "Fern", [
      { perceptionRef: `tell:${first.id}`, decision: "now", reason: "reply" },
    ]);
    await settleAttentionJudges(db);
    expect(db.getAgentConfig("Fern")?.attention_noise).toBe(0);

    // 30 agreeing comparisons earn it.
    for (let i = 0; i < 30; i++) {
      const m = tellRow("Wren", "Fern", `ok ${i}`);
      judgeReportedWakes(db, "Fern", [
        { perceptionRef: `tell:${m.id}`, decision: "now", reason: "reply" },
      ]);
      await settleAttentionJudges(db);
      recordWakeOutcomes(db, "Fern", [{ ref: `tell:${m.id}`, worked: false }]);
    }
    expect(judgeEarned(db, "attention-wake:fake-judge")).toBe(true);
    const noiseBefore = db.getAgentConfig("Fern")!.attention_noise;
    const next = tellRow("Wren", "Fern", "ok again");
    judgeReportedWakes(db, "Fern", [
      { perceptionRef: `tell:${next.id}`, decision: "now", reason: "reply" },
    ]);
    await settleAttentionJudges(db);
    expect(db.getAgentConfig("Fern")!.attention_noise).toBe(noiseBefore + 1);
  });
});

describe("converge judge", () => {
  it("judges a deep reply and settles it after the window from what people did", async () => {
    const { provider, asked } = fakeProvider({ noul: 0.3 });
    setAttentionJudgeProviderForTests(() => provider);
    const a = tellRow("Fern", "Wren", "agreed, as I said");
    const b = tellRow("Wren", "Fern", "yes, agreed", { cause: `tell:${a.id}` });
    observeAttentionJudgeEvent(db, tellSent("Wren", "Fern", b.id, 2, `tell:${a.id}`));
    observeAttentionJudgeEvent(db, tellSent("Wren", "Fern", b.id, 3, `tell:${a.id}`));
    await settleAttentionJudges(db);
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0]!.state as object)).toEqual(["answers", "reply", "depth"]);
    const subject = `attention:converge:tell:${b.id}`;
    expect(db.getOutcomeBySubject(`judged:${subject}`)?.succeeded).toBe(0);

    // A person (no agent config) tells the sender to stop within the window.
    db.createDirectMessage({
      correlationId: "c",
      dedupeKey: "d",
      senderId: "e_jeff",
      senderName: "jeff",
      targetId: "e_Wren",
      targetName: "Wren",
      content: "stop going around in circles",
    });
    sweepConverge(db, Date.now() + CONVERGE_WINDOW_MS / 2);
    expect(db.getOutcomeBySubject(subject)).toBeUndefined();
    sweepConverge(db, Date.now() + CONVERGE_WINDOW_MS + 120_000);
    expect(db.getOutcomeBySubject(subject)).toMatchObject({ basis: "mechanical", succeeded: 0 });
  });
});

describe("review judges", () => {
  function review(verdicts: { round: number; verdict: "approve" | "rework" }[]) {
    db.createCodingSession({ id: "s1", title: "t", workspaceRoot: "w", createdBy: "Wren" });
    const findings = db.createCodingArtifact({
      sessionId: "s1",
      kind: "review_findings",
      title: "f",
      contentText: "ran the parser tests; the empty-input case fails",
      createdBy: "Fern",
    });
    return db.createCodingArtifact({
      sessionId: "s1",
      kind: "review",
      title: "Review",
      contentText: "",
      metadata: {
        round: verdicts.length,
        snapshots: [],
        verdicts: verdicts.map((v) => ({ ...v, by: "Fern", at: 1, findingsId: findings.id })),
      },
      createdBy: "jeff",
    });
  }

  it("judges an approval twice, a rework once, and settles both at the close", async () => {
    const { provider, asked } = fakeProvider({ noul: 0.8, score: 3 });
    setAttentionJudgeProviderForTests(() => provider);
    const row = review([
      { round: 1, verdict: "rework" },
      { round: 2, verdict: "approve" },
    ]);
    const verdict = (round: number, v: "approve" | "rework") => ({
      type: "review_verdict" as const,
      entity: "e_Fern" as EntityId,
      reviewId: row.id,
      author: "Wren",
      reviewer: "Fern",
      verdict: v,
      round,
      timestamp: Date.now(),
    });
    observeAttentionJudgeEvent(db, verdict(1, "rework"));
    observeAttentionJudgeEvent(db, verdict(2, "approve"));
    await settleAttentionJudges(db);
    expect(asked).toHaveLength(3);
    const base = `review:${row.id}`;
    expect(db.getOutcomeBySubject(`judged:${base}:2:sycophancy`)?.succeeded).toBe(1);
    expect(db.getOutcomeBySubject(`judged:${base}:1:value`)?.quality).toBe(0.75);

    db.updateCodingArtifact(row.id, {
      status: "merged",
      metadata: { ...JSON.parse(row.metadata_json), closed: { outcome: "merged" } },
    });
    observeAttentionJudgeEvent(db, {
      type: "review_closed",
      entity: "e_jeff" as EntityId,
      reviewId: row.id,
      author: "Wren",
      outcome: "merged",
      override: false,
      timestamp: Date.now(),
    });
    expect(db.getOutcomeBySubject(`${base}:2:sycophancy`)?.succeeded).toBe(1);
    expect(db.getOutcomeBySubject(`${base}:1:value`)?.succeeded).toBe(1);
    expect(db.getOutcomeBySubject(`${base}:2:value`)?.succeeded).toBe(1);
    // Advice shows only under `on`, and only from an earned judge.
    expect(reviewJudgeLines(db, row.id)).toEqual([]);
    process.env.MARINA_ATTENTION_JUDGE = "on";
    expect(reviewJudgeLines(db, row.id)).toEqual([]);
  });
});
