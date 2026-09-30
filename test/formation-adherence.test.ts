// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
  buildJudgePacket,
  FORMATION_STEPS,
  type StepResult,
  scoreWindow,
  summarizeAdherence,
  type Transcript,
  type TranscriptEvent,
} from "../benchmarks/formation-adherence";
import { CREW_BRIEFS } from "../src/coordination/crew-formations";

const members = ["Lead", "Ann", "Bob"];

function transcript(
  events: Partial<TranscriptEvent>[],
  extra: Partial<Transcript> = {},
): Transcript {
  return {
    crew: "c",
    members,
    lead: "Lead",
    deliverablePool: "out",
    start: 0,
    end: 100_000,
    events: events.map((e, i) => ({ t: i * 1000, kind: "chan", actor: "Lead", text: "", ...e })),
    ...extra,
  };
}

const score = (tr: Transcript, formation: string, step: string) =>
  scoreWindow(tr, formation).find((r) => r.step === step)?.score;

const long = (s: string) => `${s} — ${"reasoning ".repeat(8)}`;

describe("formation adherence scorer", () => {
  test("every scored formation is a real formation with brief-layer steps", () => {
    for (const [f, steps] of Object.entries(FORMATION_STEPS)) {
      expect(CREW_BRIEFS[f as keyof typeof CREW_BRIEFS]).toBeTruthy();
      expect(steps.some((s) => s.layer === "brief")).toBe(true);
    }
  });

  test("delphi: private estimates, anonymized summary, revisions", () => {
    const good = transcript([
      { kind: "tell", actor: "Ann", target: "Lead", text: long("[estimate] 40") },
      { kind: "tell", actor: "Bob", target: "Lead", text: long("[estimate] 60") },
      { kind: "chan", actor: "Lead", text: "Round 1 summary: range 40..60, median 50" },
      { kind: "tell", actor: "Ann", target: "Lead", text: "I revise to 45" },
      { kind: "note", actor: "Lead", pool: "out", text: "T9 ESTIMATE: 50" },
    ]);
    expect(score(good, "delphi", "private-estimate-first")).toBe(1);
    expect(score(good, "delphi", "anonymized-summary")).toBe(1);
    expect(score(good, "delphi", "summary-before-delivery")).toBe(1);
    expect(score(good, "delphi", "members-revise")).toBe(0.5);
    expect(score(good, "delphi", "estimate-tag")).toBe(1);

    const anchored = transcript([
      { kind: "chan", actor: "Ann", text: long("My estimate is 40") },
      { kind: "tell", actor: "Bob", target: "Lead", text: long("60") },
      { kind: "chan", actor: "Lead", text: "Summary: Ann said 40, Bob said 60, median 50" },
    ]);
    expect(score(anchored, "delphi", "private-estimate-first")).toBe(0.5);
    expect(score(anchored, "delphi", "anonymized-summary")).toBe(0.5);
  });

  test("sharding: checker coverage, claims, unedited oracle", () => {
    const tr = transcript(
      [
        { kind: "cmd", actor: "Lead", text: "calc 2^10" },
        { kind: "cmd", actor: "Lead", text: "calc 7 * 8 * 9" },
        { kind: "chan", actor: "Lead", text: "Shards: C3 fails, C5 fails" },
        { kind: "chan", actor: "Ann", text: "claiming: C3" },
        { kind: "chan", actor: "Bob", text: "claiming: C5" },
        { kind: "cmd", actor: "Bob", text: "calc 2^10; 7*8*9" },
        { kind: "note", actor: "Lead", pool: "out", text: "T4 FIXED: C3=1024; C5=504" },
      ],
      { oracle: ["2^10", "7*8*9"], oracleOk: "C3=1024; C5=504" },
    );
    expect(score(tr, "sharding", "lead-runs-checker")).toBe(1);
    expect(score(tr, "sharding", "shards-posted")).toBe(1);
    expect(score(tr, "sharding", "members-claim")).toBe(1);
    expect(score(tr, "sharding", "full-rerun")).toBe(1);
    expect(score(tr, "sharding", "oracle-unedited")).toBe(1);
    expect(score(tr, "sharding", "lead-delivers")).toBe(1);
  });

  test("steps without an applicable condition are n/a, judged steps are deferred", () => {
    const tr = transcript([
      { kind: "note", actor: "Ann", pool: "out", text: "T2 RECOMMEND: SQLite" },
    ]);
    const results = scoreWindow(tr, "ledger");
    expect(results.find((r) => r.step === "stall-replan")?.score).toBeNull();
    expect(results.find((r) => r.step === "lead-delivers")?.score).toBe(0.5);
    const tour = scoreWindow(tr, "tournament");
    const judged = tour.filter((r) => r.method === "judge");
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((r) => r.score === null && r.question)).toBe(true);
    const packet = buildJudgePacket(tr, "tournament", CREW_BRIEFS.tournament, tour);
    expect(packet.questions.map((q) => q.step)).toEqual(judged.map((r) => r.step));
    expect(packet.transcript).toContain("T2 RECOMMEND");
  });

  test("verification counts explicit per-aspect verdicts, not loose praise", () => {
    const tr = transcript([
      { kind: "chan", actor: "Lead", text: "Draft candidate: SQLite" },
      { kind: "chan", actor: "Ann", text: "Correctness: PASS — the numbers check out" },
      { kind: "chan", actor: "Bob", text: "Verified, the answer looks correct to me" },
      { kind: "note", actor: "Lead", pool: "out", text: "T2 RECOMMEND: SQLite" },
    ]);
    expect(score(tr, "verification", "aspects-separate")).toBe(0.5);
    expect(score(tr, "verification", "deliver-after-all-pass")).toBe(1);
  });

  test("single deliverable penalizes duplicates", () => {
    const tr = transcript([
      { kind: "note", actor: "Ann", pool: "out", text: "T1 PRIMES: 83, 89, 97" },
      { kind: "note", actor: "Bob", pool: "out", text: "T1 PRIMES: 83, 89, 97" },
    ]);
    expect(score(tr, "freeform", "single-deliverable")).toBe(0.5);
  });
});

describe("summarizeAdherence", () => {
  test("the headline is brief steps only; convention markers are a separate diagnostic", () => {
    const results: StepResult[] = [
      { step: "a", layer: "brief", method: "det", score: 1, evidence: "" },
      { step: "b", layer: "brief", method: "det", score: 0.5, evidence: "" },
      { step: "c", layer: "brief", method: "judge", score: null, evidence: "" },
      { step: "d", layer: "convention", method: "det", score: 0, evidence: "" },
      { step: "e", layer: "convention", method: "det", score: 0, evidence: "" },
    ];
    expect(summarizeAdherence(results)).toEqual({ brief: 0.75, convention: 0 });
    expect(summarizeAdherence(results.filter((r) => r.layer === "convention")).brief).toBeNull();
  });

  test("the sharding brief says when to shard", () => {
    expect(CREW_BRIEFS.sharding).toContain("several independent failing cases");
    expect(CREW_BRIEFS.sharding).toContain("for one or two, just fix them");
  });
});
