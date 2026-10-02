// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The FutureX adapter (benchmarks/futurex/): every fixture here is synthetic —
// no benchmark question or answer is committed.

import { describe, expect, it } from "bun:test";
import { type FuturexRow, fetchBatch } from "../benchmarks/futurex/dataset";
import { recordScoredRun, recordSubmission } from "../benchmarks/futurex/ledger";
import {
  endTimeIso,
  listSize,
  parseOptions,
  questionText,
  requestFor,
  specFor,
} from "../benchmarks/futurex/map";
import { fallbackPrediction, runBatch, type Variant } from "../benchmarks/futurex/run";
import { parseTruth, scoreBatch, scoreItem } from "../benchmarks/futurex/score";
import {
  DEFAULT_IDENTITY,
  emailFields,
  segment,
  submissionBody,
  submissionFileName,
} from "../benchmarks/futurex/submission";
import type { ModelPart, TypedForecastDeps } from "../src/forecast/typed";
import { MarinaDB } from "../src/persistence/database";

const lettered = (
  q: string,
  options: string[],
  tail = "End with the selected option letter(s) in \\boxed{...}.",
) =>
  `You are an agent that can predict future events. The event to be predicted: "${q} (resolved around 2026-10-02T20:00:00+08:00 (GMT+8)).\n${options
    .map((o, i) => `${String.fromCharCode(65 + i)}. the outcome be ${o}`)
    .join("\n")}"\nIMPORTANT: ${tail}`;
const open = (q: string, extra = "") =>
  `You are an agent that can predict future events. The event to be predicted: "${q} (resolved around 2026-10-03T08:00:00+08:00 (GMT+8))."\nReturn exactly the source-native value required by the settlement contract, with no units or commentary.${extra}\nIMPORTANT: End with \\boxed{YOUR_PREDICTION}.`;

const row = (over: Partial<FuturexRow>): FuturexRow => ({
  id: "r1",
  prompt: "",
  end_time: "2026-10-02T20:00:00+08:00",
  level: 1,
  ...over,
});

describe("map: a row → a typed forecast request", () => {
  it("parses lettered options and the older boxed alternatives", () => {
    expect(parseOptions(lettered("Will it rain?", ["Yes", "No", "NO_OFFICIAL_RESULT"]))).toEqual([
      { id: "A", label: "Yes" },
      { id: "B", label: "No" },
      { id: "C", label: "NO_OFFICIAL_RESULT" },
    ]);
    const boxed =
      'The event to be predicted: "Team X vs. Team Y (resolved around 2026-01-17 (GMT+8)). "\nIMPORTANT: Your final answer MUST end with this exact format:\n\\boxed{Team X} or \\boxed{Team Y}';
    expect(parseOptions(boxed)).toEqual([{ id: "Team X" }, { id: "Team Y" }]);
    expect(parseOptions(open("How many?"))).toEqual([]);
  });

  it("picks the answer shape", () => {
    expect(specFor(row({ level: 1, prompt: lettered("Will it rain?", ["Yes", "No"]) })).type).toBe(
      "choice",
    );
    // Level 2 defaults to one option (ranges, winners)…
    expect(
      specFor(
        row({
          level: 2,
          en_title: "Which range will the index occupy?",
          prompt: lettered("Which range will the index occupy?", [
            "below 3.0%",
            "3.0% to 3.2%",
            "3.3% or higher",
          ]),
        }),
      ).type,
    ).toBe("choice");
    // …a set for bundles of independent outcomes and cumulative thresholds.
    expect(
      specFor(
        row({
          level: 2,
          en_title: "Best Picture nominees? (2030)",
          prompt: lettered("Best Picture nominees?", ["Film A", "Film B", "Film C"]),
        }),
      ).type,
    ).toBe("multi");
    expect(
      specFor(
        row({
          level: 2,
          en_title: "Widget cases by month end?",
          prompt: lettered("Widget cases?", ["at least 300", "at least 400", "at least 500"]),
        }),
      ).type,
    ).toBe("multi");
    expect(
      specFor(
        row({
          level: 3,
          en_title: "How many widgets will the bureau report in week 38 of 2030?",
          prompt: open("How many widgets?"),
        }),
      ),
    ).toEqual({ type: "number", integer: true });
    expect(
      specFor(
        row({
          level: 4,
          en_title:
            "What seasonally adjusted value of new widget orders will the bureau report for August 2030?",
          prompt: open("What value?", "\nReport the value in USD billions."),
        }),
      ),
    ).toEqual({ type: "number", unit: "USD billions" });
    expect(
      specFor(
        row({
          level: 4,
          en_title: "What ordered top five widgets will the chart publish for week 40 of 2030?",
          prompt: open("Top five?"),
        }),
      ),
    ).toEqual({ type: "ranking", size: 5 });
    expect(
      specFor(
        row({
          level: 3,
          en_title: "Which artist will rank No. 1 on the Widget Chart dated 10 October 2030?",
          prompt: open("No. 1?"),
        }),
      ).type,
    ).toBe("text");
    expect(
      specFor(
        row({
          level: 3,
          en_title: "What exact title will the agency publish for its picture of the day?",
          prompt: open("Title?"),
        }),
      ).type,
    ).toBe("text");
  });

  it("reads list sizes", () => {
    expect(listSize("Which two candidates will rank first and second?")).toBe(2);
    expect(listSize("Which three lists will rank first, second and third?")).toBe(3);
    expect(listSize("the five largest active regions")).toBe(5);
    expect(listSize("athletes ranked from 10 to 12 in the latest list")).toBe(3);
    expect(listSize("Which persons will be named?")).toBeUndefined();
  });

  it("reads end times (a bare date-time is UTC+8) and prefers a full question over a cut title", () => {
    expect(endTimeIso("2026-10-02T20:00:00+08:00")).toBe("2026-10-02T12:00:00.000Z");
    expect(endTimeIso("2026-01-18 00:00:00")).toBe("2026-01-17T16:00:00.000Z");
    expect(endTimeIso("2026-01-27")).toBe("2026-01-26T16:00:00.000Z");
    expect(endTimeIso("")).toBeUndefined();
    const cut = row({
      en_title: "2030-03-19, what will be the",
      prompt: open("2030-03-19, what will be the widget index reading"),
    });
    expect(questionText(cut)).toBe("2030-03-19, what will be the widget index reading");
    const req = requestFor(cut);
    expect(req.endTime).toBe("2026-10-02T12:00:00.000Z");
    expect(req.context).not.toContain("IMPORTANT: End with");
  });
});

describe("score: the published metric definitions", () => {
  it("parses list-style truths", () => {
    expect(parseTruth("['A', 'C']")).toEqual(["A", "C"]);
    expect(parseTruth('["Film A", "Film B"]')).toEqual(["Film A", "Film B"]);
    expect(parseTruth("[249.41]")).toEqual(["249.41"]);
    expect(parseTruth("['It\\'s on']")).toEqual(["It's on"]);
  });

  it("scores each kind", () => {
    const l1 = row({ level: 1, prompt: lettered("Q?", ["Yes", "No"]), ground_truth: "['A']" });
    expect(scoreItem(l1, "A").score).toBe(1);
    expect(scoreItem(l1, "Yes").score).toBe(1); // a label maps to its letter
    expect(scoreItem(l1, "A, B").score).toBe(0);
    const l2 = row({
      level: 2,
      prompt: lettered("Q?", ["a", "b", "c", "d"]),
      ground_truth: "['A', 'B']",
    });
    expect(scoreItem(l2, "A, C").score).toBe(0.5);
    const num = row({ level: 3, ground_truth: "[100]" });
    expect(scoreItem(num, "100").score).toBe(1);
    expect(scoreItem(num, "102.5").score).toBe(0.75);
    expect(scoreItem(num, "106").score).toBe(0);
    const zero = row({ level: 3, ground_truth: "[0]" });
    expect(scoreItem(zero, "0").score).toBe(1);
    const str = row({ level: 3, ground_truth: "['Jane Doe']" });
    expect(scoreItem(str, "jane doe").score).toBe(1);
    const packed = row({ level: 4, ground_truth: "['X; Y | Z']" });
    expect(scoreItem(packed, "X, Y, Z").score).toBe(1);
    const list = row({ level: 4, ground_truth: "['X', 'Y', 'Z']" });
    expect(scoreItem(list, "X, Y, Z").score).toBe(1);
    expect(scoreItem(list, "Y, X, Q").score).toBeCloseTo(0.5333, 3);
    expect(scoreItem(list, undefined).metric).toBe("missing");
  });

  it("weights levels 10/20/30/40 over the levels present, counting missing as 0", () => {
    const rows = [
      row({ id: "a", level: 1, prompt: lettered("Q?", ["Yes", "No"]), ground_truth: "['A']" }),
      row({ id: "b", level: 4, ground_truth: "[10]" }),
    ];
    const s = scoreBatch(rows, new Map([["a", "A"]]));
    expect(s.byLevel[1]?.mean).toBe(1);
    expect(s.byLevel[4]?.mean).toBe(0);
    expect(s.overall).toBeCloseTo(0.1 / 0.5, 4);
  });
});

describe("submission", () => {
  it("names the file org-…-agent-…-model-… with Marina under h2o.ai by default", () => {
    expect(DEFAULT_IDENTITY).toEqual({ org: "h2o.ai", agent: "Marina" });
    expect(submissionFileName({ ...DEFAULT_IDENTITY, model: "deepseek-v4-pro" })).toBe(
      "org-h2o.ai-agent-Marina-model-deepseek-v4-pro.json",
    );
    // Dashes inside org/agent would make the name ambiguous; the model keeps them.
    expect(segment("my-agent")).toBe("my_agent");
    expect(segment("claude opus/5.5", { dashes: true })).toBe("claude_opus_5.5");
    expect(() => segment("  ")).toThrow();
  });

  it("writes {id, prediction} records and describes (never sends) the email", () => {
    expect(JSON.parse(submissionBody([{ id: "x", prediction: "A, C" }]))).toEqual([
      { id: "x", prediction: "A, C" },
    ]);
    const mail = emailFields(
      { ...DEFAULT_IDENTITY, model: "m", framework: "Marina" },
      "abc123",
      "/tmp/f.json",
      "2026-10-05",
    );
    expect(mail.to).toBe("FutureX-ai@outlook.com");
    expect(mail.body).toContain("Dataset commit: abc123");
    expect(mail.body).toContain("Organization: h2o.ai");
  });
});

describe("dataset fetch", () => {
  it("pages rows and retries when the sha moves mid-read", async () => {
    let shaCalls = 0;
    const shas = ["s1", "s2", "s2", "s2"];
    const fetcher = async (url: string) => {
      if (url.includes("/api/datasets/")) {
        return new Response(JSON.stringify({ sha: shas[shaCalls++] }));
      }
      return new Response(
        JSON.stringify({
          num_rows_total: 1,
          rows: [{ row: { id: "x", prompt: "p", end_time: "2026-10-01", level: 1, title: "T" } }],
        }),
      );
    };
    const b = await fetchBatch("org/ds", { fetcher });
    expect(b.sha).toBe("s2");
    expect(b.rows).toEqual([
      { id: "x", prompt: "p", end_time: "2026-10-01", level: 1, en_title: "T" },
    ]);
  });
});

const fakeDeps = (answer: string): (() => { deps: TypedForecastDeps; costUsd: () => number }) => {
  const part = (reply: (system: string) => string): ModelPart => ({
    name: "fake",
    complete: async (s) => reply(s),
  });
  return () => ({
    deps: {
      retriever: async () => ({
        report: "- 2026-09-20 — a fact",
        sources: [],
        costUsd: 0,
        searches: 1,
        retriever: "fake",
      }),
      analysts: [part(() => answer)],
      planner: part((s) =>
        s.startsWith("You plan") ? '{"queries":["q"]}' : '{"verdict":"keep","done":true}',
      ),
      options: { runs: 1, researchRounds: 1, critique: false },
    },
    costUsd: () => 0.01,
  });
};

const variant: Variant = { label: "test", model: "fake-model", analysts: ["fake"] };

describe("run", () => {
  it("answers every row, freezing late rows at their end time, with a fallback when needed", async () => {
    const rows = [
      row({ id: "ok", level: 1, prompt: lettered("Q?", ["Yes", "No"]) }),
      row({
        id: "late",
        level: 1,
        end_time: "2026-09-01T00:00:00+08:00",
        prompt: lettered("Q?", ["Yes", "No"]),
      }),
    ];
    const now = () => new Date("2026-09-30T00:00:00Z");
    const good = await runBatch(rows, variant, fakeDeps('{"answer":"B"}'), { now });
    expect(good.results.map((r) => r.prediction)).toEqual(["B", "B"]);
    expect(good.results[1]?.late).toBe(true);
    expect(good.results[1]?.cutoff).toBe("2026-08-31T16:00:00.000Z");
    expect(good.costUsd).toBe(0.02);
    const bad = await runBatch(rows.slice(0, 1), variant, fakeDeps('{"answer":"Z"}'), { now });
    expect(bad.results[0]?.fallback).toBe(true);
    expect(bad.results[0]?.prediction).toBe("A");
  });

  it("moves a backtest's cutoff horizonDays before each end time", async () => {
    const rows = [row({ id: "p", level: 1, prompt: lettered("Q?", ["Yes", "No"]) })];
    const r = await runBatch(rows, variant, fakeDeps('{"answer":"A"}'), {
      horizonDays: 7,
      now: () => new Date("2026-12-01T00:00:00Z"),
    });
    expect(r.results[0]?.cutoff).toBe("2026-09-25T12:00:00.000Z");
    expect(r.results[0]?.late).toBe(false);
  });

  it("skips no-result options when falling back", () => {
    expect(
      fallbackPrediction(
        {
          type: "choice",
          options: [
            { id: "A", label: "NO_OFFICIAL_RESULT" },
            { id: "B", label: "Yes" },
          ],
        },
        { runs: [] } as never,
      ),
    ).toBe("B");
  });
});

describe("ledger", () => {
  it("records a submission once per file (append-only) and a scored run in the benchmark ledger", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const rows = [
        row({ id: "a", level: 1, prompt: lettered("Q?", ["Yes", "No"]), ground_truth: "['A']" }),
      ];
      const run = await runBatch(rows, variant, fakeDeps('{"answer":"A"}'), {
        now: () => new Date("2026-09-30T00:00:00Z"),
      });
      const input = {
        batchSha: "sha1",
        variant,
        identity: { ...DEFAULT_IDENTITY, model: "fake-model" },
        fileName: "org-h2o.ai-agent-Marina-model-fake-model.json",
        fileSha256: "f".repeat(64),
        run,
        now: 1,
      };
      const first = recordSubmission(db, input);
      expect(first.created).toBe(true);
      expect(recordSubmission(db, input)).toEqual({ id: first.id, created: false });
      const listed = db.listExternalSubmissions("futurex-online");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.answered).toBe(1);
      // The table refuses updates (the trigger), whatever the caller.
      const raw = (db as unknown as { db: { run(sql: string): unknown } }).db;
      expect(() => raw.run("UPDATE external_submissions SET items = 9")).toThrow("append-only");

      const score = scoreBatch(rows, new Map([["a", "A"]]));
      const rec = recordScoredRun(db, {
        benchmark: "futurex-past",
        batchSha: "sha1",
        variant,
        run,
        score,
        horizonDays: 7,
      });
      expect(rec.created).toBe(true);
      const items = db.getBenchmarkItems(rec.id);
      expect(items.map((i) => [i.item_id, i.correct, i.score])).toEqual([["a", 1, 1]]);
    } finally {
      db.close();
    }
  });
});
