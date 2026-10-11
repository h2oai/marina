// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
  freezePortfolioResearch,
  validatePortfolioResearch,
} from "../src/arena/portfolio-research";
import type { ArenaRound } from "../src/arena/types";
import { WorkBudget } from "../src/coordination/work-budget";
import { captureEvidence } from "../src/research/evidence";
import { researchHypotheses } from "../src/research/hypotheses";

test("paired research replays exact independent captures and rejects missing or corrupted sources", async () => {
  const now = "2026-10-10T12:00:00Z";
  const round: ArenaRound = {
    round_id: "r",
    tracker: "test",
    target_type: "continuous_normal",
    question: "Test",
    lock_at: "2026-10-11T12:00:00Z",
    release_at: "2026-10-12T12:00:00Z",
  };
  let calls = 0;
  const paths = await researchHypotheses(
    { roundId: "r", since: "2026-10-01", untilAt: now, request: "Test", queries: ["facts"] },
    async (brief) => {
      calls++;
      const report = {
        report: "- The measured approval was 38 percent [source](https://example.org/source)",
        sources: [
          { url: "https://example.org/source", text: "The measured approval was 38 percent" },
        ],
        searches: brief.queries!.length,
        costUsd: 0.1,
        retriever: "fixture",
      };
      return {
        ...report,
        evidence: await captureEvidence(brief, report, async () => undefined, {
          now: () => new Date(now),
        }),
      };
    },
    new WorkBudget({ calls: 3, concurrency: 3, timeoutMs: 1000 }),
    6,
  );
  const frozen = freezePortfolioResearch({
    round,
    lock: { round_id: "r" },
    start: { topline: { mean: 38, sd: 1 }, rules: {}, note: "fixture" },
    paths,
    capturedAt: now,
  });
  const checked = validatePortfolioResearch(frozen, round, "2026-10-10T13:00:00Z");
  expect(calls).toBe(3);
  expect(Object.values(paths.plans).reduce((s, p) => s + p.queries!.length, 0)).toBe(6);
  expect(checked.start.topline).toEqual(frozen.start.topline);
  expect(checked.paths.paths.challenge?.report?.evidence?.hash).toBe(
    frozen.paths.paths.challenge?.report?.evidence?.hash,
  );
  expect(() => validatePortfolioResearch(frozen, round, round.lock_at)).toThrow("expired");
  checked.paths.paths.challenge!.report!.evidence!.sources[0]!.text = "corrupted";
  expect(() => validatePortfolioResearch(checked, round, now)).toThrow();
});
