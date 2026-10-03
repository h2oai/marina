// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing answers (src/forecast/revision.ts): revise only on a material
 * change, log every decision, and the daily + final re-forecast cadence.
 */

import { describe, expect, it } from "bun:test";
import {
  decideRevision,
  dueRun,
  evidenceOverlap,
  nextWeeklyDeadline,
  reviseStanding,
  type StandingAnswer,
} from "../src/forecast/revision";

const at = "2026-10-01T06:00:00.000Z";
const ans = (prediction: string, over: Partial<StandingAnswer> = {}): StandingAnswer => ({
  prediction,
  confidence: 0.6,
  at,
  ...over,
});

describe("decideRevision", () => {
  it("takes a first answer and replaces a fallback", () => {
    expect(decideRevision(undefined, ans("A")).revise).toBe(true);
    expect(decideRevision(ans("", { fallback: true }), ans("A")).reason).toBe(
      "replaces a fallback",
    );
  });

  it("never lets a fallback overwrite a standing answer", () => {
    const d = decideRevision(ans("A"), ans("", { fallback: true, confidence: 0.99 }));
    expect(d.revise).toBe(false);
  });

  it("keeps an unchanged answer, ignoring case, spacing and list order", () => {
    expect(decideRevision(ans("Alpha, Beta"), ans("beta,  alpha")).reason).toBe("unchanged");
  });

  it("keeps a numeric answer within tolerance", () => {
    const d = decideRevision(ans("1,000"), ans("1010", { confidence: 0.95 }));
    expect(d.revise).toBe(false);
    expect(d.reason).toContain("numeric tolerance");
  });

  it("revises on a material confidence gain", () => {
    const d = decideRevision(ans("A", { confidence: 0.5 }), ans("B", { confidence: 0.65 }));
    expect(d).toEqual({ revise: true, reason: "confidence +0.15" });
  });

  it("does not revise a changed answer with nothing behind it", () => {
    const d = decideRevision(
      ans("A", { confidence: 0.6, evidence: "poll lead widened among likely voters" }),
      ans("B", { confidence: 0.62, evidence: "poll lead widened among likely voters again" }),
    );
    expect(d.revise).toBe(false);
    expect(d.reason).toContain("not material");
  });

  it("revises on materially new evidence at similar confidence, not at lower confidence", () => {
    const prev = ans("A", { evidence: "early polls favour candidate alpha" });
    const fresh = "official count released yesterday shows beta winning districts";
    expect(decideRevision(prev, ans("B", { evidence: fresh, confidence: 0.58 })).revise).toBe(true);
    expect(decideRevision(prev, ans("B", { evidence: fresh, confidence: 0.4 })).revise).toBe(false);
  });

  it("measures evidence overlap on word sets", () => {
    expect(evidenceOverlap("same words here", "here same words")).toBe(1);
    expect(evidenceOverlap("alpha beta", "gamma delta")).toBe(0);
  });
});

describe("reviseStanding", () => {
  it("applies a run without mutating the input and logs every decision", () => {
    const standing = { q1: ans("A", { confidence: 0.5 }), q2: ans("X") };
    const before = JSON.stringify(standing);
    const { standing: next, entries } = reviseStanding(standing, [
      { id: "q1", answer: ans("B", { confidence: 0.8 }) },
      { id: "q2", answer: ans("Y", { confidence: 0.61 }) },
      { id: "q3", answer: ans("Z") },
    ]);
    expect(JSON.stringify(standing)).toBe(before);
    expect(next.q1!.prediction).toBe("B");
    expect(next.q2).toBe(standing.q2); // kept by reference
    expect(next.q3!.prediction).toBe("Z");
    expect(entries.map((e) => [e.id, e.revised, e.from])).toEqual([
      ["q1", true, "A"],
      ["q2", false, "X"],
      ["q3", true, undefined],
    ]);
  });
});

describe("cadence", () => {
  it("finds the next Wednesday 16:00 UTC strictly after now", () => {
    expect(nextWeeklyDeadline(new Date("2026-10-02T12:00:00Z"), 3, 16).toISOString()).toBe(
      "2026-10-07T16:00:00.000Z",
    );
    expect(nextWeeklyDeadline(new Date("2026-10-07T15:00:00Z"), 3, 16).toISOString()).toBe(
      "2026-10-07T16:00:00.000Z",
    );
    expect(nextWeeklyDeadline(new Date("2026-10-07T16:00:00Z"), 3, 16).toISOString()).toBe(
      "2026-10-14T16:00:00.000Z",
    );
  });

  const deadline = new Date("2026-10-07T16:00:00Z");
  const base = { deadline, finalLeadMs: 4 * 3_600_000, dailyHourUtc: 6 };

  it("runs daily once per UTC day after the daily hour", () => {
    expect(dueRun({ ...base, now: new Date("2026-10-03T05:00:00Z") })).toBeNull();
    expect(dueRun({ ...base, now: new Date("2026-10-03T07:00:00Z") })).toBe("daily");
    expect(
      dueRun({
        ...base,
        now: new Date("2026-10-03T20:00:00Z"),
        lastRunAt: "2026-10-03T07:00:00Z",
      }),
    ).toBeNull();
    expect(
      dueRun({
        ...base,
        now: new Date("2026-10-04T06:30:00Z"),
        lastRunAt: "2026-10-03T07:00:00Z",
      }),
    ).toBe("daily");
  });

  it("runs the final once inside the lead window, and nothing after the deadline", () => {
    const daily = "2026-10-07T07:00:00Z";
    expect(dueRun({ ...base, now: new Date("2026-10-07T12:30:00Z"), lastRunAt: daily })).toBe(
      "final",
    );
    expect(
      dueRun({
        ...base,
        now: new Date("2026-10-07T14:00:00Z"),
        lastRunAt: "2026-10-07T12:30:00Z",
      }),
    ).toBeNull();
    expect(dueRun({ ...base, now: new Date("2026-10-07T16:00:00Z") })).toBeNull();
  });
});
