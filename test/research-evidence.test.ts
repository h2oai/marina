// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { buildDossier } from "../src/arena/formations";
import type { ResearchBrief } from "../src/arena/research/briefs";
import { arenaSignalHints, withDataLookups } from "../src/arena/research/data-evidence";
import type { ResearchReport } from "../src/arena/research/retrieve";
import { recallForecastLessons } from "../src/forecast/lessons";
import { captureEvidence, replayEvidence, validateEvidence } from "../src/research/evidence";
import { evidenceLoopRetriever } from "../src/research/evidence-loop";

const now = () => new Date("2026-10-07T12:00:00Z");
const brief: ResearchBrief = {
  roundId: "r",
  since: "2026-10-01",
  untilAt: now().toISOString(),
  request: "What changed?",
  queries: ["initial question"],
};
const report = (value = 3.5): ResearchReport => ({
  report: `- Rate ${value}% [source](https://example.org/release)`,
  sources: [
    { url: "https://example.org/release", text: `The rate is ${value}%.`, published: "2026-10-06" },
  ],
  searches: 1,
  costUsd: 0.1,
  retriever: "fixture",
});

test("partial verified evidence does not hide a failed paid research loop", async () => {
  const dossier = await buildDossier(
    {
      round_id: "r",
      tracker: "civiqs",
      series: "civiqs_net_econ_now",
      question: "Economic sentiment?",
      target_type: "continuous_normal",
      lock_at: "2026-10-14T14:00:00Z",
      release_at: "2026-10-16T14:00:00Z",
    },
    { round_id: "r", history: [{ date: "2026-10-06", value: 3 }] },
    {
      topline: { mean: 3, sd: 1 },
      note: "fixture",
      rules: {},
    },
    async () => ({
      ...report(),
      researchLoop: { rounds: [], stop: "failed", error: "provider credits", costFinal: true },
    }),
    async () => {
      throw new Error("must use captured text");
    },
  );
  expect(dossier.verified).toContain("3.5");
  expect(dossier.status).toBe("failed");
  expect(dossier.error).toBe("provider credits");
});

test("captured text verifies and replays without network, retaining separate dates", async () => {
  let reads = 0;
  const captured = await captureEvidence(
    brief,
    report(),
    async () => {
      reads++;
      throw new Error("network forbidden");
    },
    { now },
  );
  expect(reads).toBe(0);
  expect(captured.verified).toContain("3.5%");
  expect(captured.sources[0]!.published).toBe("2026-10-06");
  expect(captured.sources[0]!.capturedAt).toBe(now().toISOString());
  const replay = replayEvidence(captured);
  captured.sources[0]!.text = "mutated after replay construction";
  expect((await replay(brief)).sources[0]!.text).toBe("The rate is 3.5%.");
  await expect(replay({ ...brief, untilAt: "2026-10-06T00:00:00Z" })).rejects.toThrow("mismatch");
  expect(() => validateEvidence(captured)).toThrow("hash mismatch");
});

test("future publications, future vintages and restricted publishers never count", async () => {
  for (const source of [
    { url: "https://example.org/release", published: "2026-10-08", text: "3.5%" },
    { url: "https://example.org/release", availableAt: "2026-10-08T00:00:00Z", text: "3.5%" },
    { url: "https://yougov.com/release", text: "3.5%" },
  ]) {
    let reads = 0;
    const r = { ...report(), report: `- Rate 3.5% [source](${source.url})`, sources: [source] };
    const captured = await captureEvidence(
      brief,
      r,
      async () => {
        reads++;
        return "3.5%";
      },
      { now },
    );
    expect(captured.verified).toBe("");
    expect(reads).toBe(0);
    expect(captured.sources[0]!.temporal).toBe("rejected");
  }
});

test("loop keeps the first source version and stops on duplicate verified evidence", async () => {
  let searches = 0;
  let reviews = 0;
  const run = evidenceLoopRetriever(
    async () => {
      searches++;
      return report(searches === 1 ? 3.5 : 9.9);
    },
    {
      now,
      pageText: async () => undefined,
      maxRounds: 3,
      review: async () => {
        reviews++;
        return '{"queries":["contradictory evidence"]}';
      },
    },
  );
  const result = await run(brief);
  expect(searches).toBe(2);
  expect(reviews).toBe(1);
  expect(result.researchLoop!.stop).toBe("no-new-evidence");
  expect(result.report).toContain("3.5");
  expect(result.report).not.toContain("9.9");
  expect(result.costUsd).toBe(0.2);
  validateEvidence(result.evidence!);
});

test("a gap round can add contrary evidence without changing the cutoff or exclusions", async () => {
  let calls = 0;
  const bounded = { ...brief, exclude: { urls: ["answers.example"] } };
  const run = evidenceLoopRetriever(
    async (b) => {
      expect(b.untilAt).toBe(brief.untilAt);
      expect(b.exclude).toEqual(bounded.exclude);
      calls++;
      if (calls === 1) return report();
      expect(b.queries).toEqual(["contradictory evidence"]);
      return {
        ...report(),
        report: "- Other rate 4.5% [other](https://example.org/other)",
        sources: [
          { url: "https://example.org/other", text: "Other rate 4.5%", published: "2026-10-07" },
        ],
      };
    },
    {
      now,
      pageText: async () => undefined,
      maxRounds: 2,
      review: async () => '{"queries":["contradictory evidence"]}',
    },
  );
  const result = await run(bounded);
  expect(result.report).toContain("3.5");
  expect(result.report).toContain("4.5");
  expect(result.evidence!.sources).toHaveLength(2);
});

test("historical capture refuses live search before a call; dated retrieval stays strict", async () => {
  let calls = 0;
  const inner = async () => {
    calls++;
    return report();
  };
  const past = { ...brief, untilAt: "2026-10-01T12:00:00Z" };
  await expect(
    evidenceLoopRetriever(inner, { now, pageText: async () => undefined })(past),
  ).rejects.toThrow("date-strict");
  expect(calls).toBe(0);
  const strict = withDataLookups(Object.assign(inner, { dateStrict: true as const }), []);
  const wrapped = evidenceLoopRetriever(strict, { now, pageText: async () => undefined });
  expect((wrapped as { dateStrict?: boolean }).dateStrict).toBe(true);
});

test("failed gap work preserves earlier evidence and records the failure", async () => {
  const run = evidenceLoopRetriever(async () => report(), {
    now,
    maxRounds: 2,
    pageText: async () => undefined,
    review: async () => {
      throw new Error("provider outage");
    },
  });
  const result = await run(brief);
  expect(result.report).toContain("3.5");
  expect(result.researchLoop?.error).toContain("provider outage");
  expect(result.costUsd).toBe(0.1);
});

test("formation specs accept shared search and strict backends", () => {
  for (const source of ["search", "search:tavily+duckduckgo", "asof:gdelt+wayback", "exa:auto"])
    expect(parseForecasterSpec(`formation:delphi:mock/one+research@${source}`)).toContain(source);
  expect(() => parseForecasterSpec("formation:delphi:mock/one+research@search:bogus")).toThrow();
});

test("source treatments leave controls unchanged and select only relevant signals", () => {
  const b = { ...brief, roundId: "civiqs-2026-w42-econ-now" };
  expect(arenaSignalHints({})(b).hints.fred).toEqual(["UMCSENT"]);
  expect(arenaSignalHints({ MARINA_ARENA_RESEARCH_SIGNALS: "consumer" })(b).hints.fred).toEqual([
    "UMCSENT",
    "GASREGW",
    "ICSA",
  ]);
  expect(
    arenaSignalHints({ MARINA_ARENA_RESEARCH_SIGNALS: "consumer" })({
      ...b,
      roundId: "civiqs-2026-w42-approval",
    }).hints.fred,
  ).toBeUndefined();
});

test("formation lessons separate observe/on/off and exclude later outcomes", async () => {
  let calls = 0;
  const store = {
    recall: async (_q: string, cutoff: string) => {
      calls++;
      expect(cutoff).toBe(brief.untilAt!);
      return [
        { text: "known", resolvedAt: "2026-10-06T00:00:00Z" },
        { text: "future", resolvedAt: "2026-10-08T00:00:00Z" },
        { text: "observe-only", observed: true, resolvedAt: "2026-10-06T00:00:00Z" },
      ];
    },
  };
  expect(
    (await recallForecastLessons(store, "q", brief.untilAt!, "observe")).injected,
  ).toHaveLength(0);
  const on = await recallForecastLessons(store, "q", brief.untilAt!, "on");
  expect(on.injected.map((l) => l.text)).toEqual(["known"]);
  expect(on.observed.map((l) => l.text)).toEqual(["observe-only"]);
  await recallForecastLessons(store, "q", brief.untilAt!, "off");
  expect(calls).toBe(2);
});
