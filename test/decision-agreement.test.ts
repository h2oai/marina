// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { judgeAgreement } from "../src/decisions/agreement";
import { judgeOpinion } from "../src/decisions/policy";
import type { JudgeObservationRow } from "../src/persistence/db-decisions";

describe("judgeOpinion — the judge's own view, not the policy's action", () => {
  it("passes only when quality and every support question clear the bar", () => {
    expect(judgeOpinion({ quality: 1.8, delivered: 0.9 }, ["delivered"])).toBe("pass");
    expect(judgeOpinion({ quality: 1.8, delivered: 0.2 }, ["delivered"])).toBe("fail");
    expect(judgeOpinion({ quality: 0.4, delivered: 0.9 }, ["delivered"])).toBe("fail");
  });
  it("gives no opinion without usable numbers — an outage is never a pass", () => {
    expect(judgeOpinion({}, ["delivered"])).toBe("none");
    expect(judgeOpinion({ quality: 1.9 }, ["delivered", "grounded"])).toBe("none");
  });
});

describe("judgeAgreement", () => {
  let id = 0;
  const row = (over: Partial<JudgeObservationRow>): JudgeObservationRow => ({
    id: ++id,
    task_id: 1,
    claimant_name: "Bob",
    evaluator: "decisions-api:typesafe/jev-1.13",
    calibrated: 1,
    mode: "observe",
    opinion: "pass",
    signals: "{}",
    error: null,
    created_at: 0,
    outcome: "approved",
    ...over,
  });

  it("measures each backend on its own record, latest opinion per submission", () => {
    const stats = judgeAgreement([
      row({ task_id: 1, opinion: "fail", outcome: "approved" }), // superseded by the resubmission
      row({ task_id: 1, opinion: "pass", outcome: "approved" }),
      row({ task_id: 2, opinion: "pass", outcome: "rejected" }),
      row({ task_id: 3, opinion: "none", outcome: "approved" }),
      row({ task_id: 4, opinion: "fail", outcome: "submitted" }),
      row({ task_id: 1, evaluator: "decisions-api:openjev-local", opinion: "fail" }),
      row({ task_id: 1, evaluator: "chat-classifier:gpt-6-luna", calibrated: 0, opinion: "pass" }),
    ]);
    const jev = stats.find((s) => s.evaluator === "decisions-api:typesafe/jev-1.13")!;
    expect(jev).toMatchObject({
      compared: 2,
      agreed: 1,
      falsePass: 1,
      falseFail: 0,
      noOpinion: 1,
      awaitingVerdict: 1,
    });
    expect(stats.find((s) => s.evaluator === "decisions-api:openjev-local")).toMatchObject({
      compared: 1,
      falseFail: 1,
    });
    expect(stats.find((s) => s.evaluator.startsWith("chat-classifier"))?.calibrated).toBe(false);
  });
});
