// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ResearchBrief } from "../src/arena/research/briefs";
import type { Retriever } from "../src/arena/research/retrieve";
import type { DecisionProvider } from "../src/decisions/types";
import {
  type AnswerSpec,
  combineAnswers,
  formatAnswer,
  parseAnswerSpec,
  validateAnswer,
} from "../src/forecast/answer-types";
import { lookupsFromSpec, polymarketLookup } from "../src/forecast/lookups";
import { forecastTyped, type ModelPart } from "../src/forecast/typed";

const choice: AnswerSpec = {
  type: "choice",
  options: [
    { id: "A", label: "Yes" },
    { id: "B", label: "No" },
    { id: "C", label: "No official result" },
  ],
};
const multi: AnswerSpec = {
  type: "multi",
  options: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
};

describe("answer types", () => {
  it("parses and rejects specs", () => {
    expect(parseAnswerSpec({ type: "choice", options: ["A", "B"] })).toEqual({
      spec: { type: "choice", options: [{ id: "A" }, { id: "B" }] },
    });
    expect("error" in parseAnswerSpec({ type: "choice", options: ["A"] })).toBe(true);
    expect("error" in parseAnswerSpec({ type: "choice", options: ["A", "a"] })).toBe(true);
    expect("error" in parseAnswerSpec({ type: "guess" })).toBe(true);
    expect(parseAnswerSpec({ type: "ranking", size: 3 })).toEqual({
      spec: { type: "ranking", size: 3 },
    });
  });

  it("validates each type", () => {
    expect(validateAnswer(choice, "b")).toEqual({ value: "B" });
    expect(validateAnswer(choice, "No official result")).toEqual({ value: "C" });
    expect("error" in validateAnswer(choice, "A, B")).toBe(true);
    expect(validateAnswer(multi, "C, A")).toEqual({ value: ["A", "C"] });
    expect(validateAnswer(multi, ["D", "D"])).toEqual({ value: ["D"] });
    expect("error" in validateAnswer(multi, "E")).toBe(true);
    expect(validateAnswer({ type: "number" }, "1,234.5 $bn")).toEqual({ value: 1234.5 });
    expect(validateAnswer({ type: "number", integer: true }, 7.6)).toEqual({ value: 8 });
    expect("error" in validateAnswer({ type: "number" }, "unknown")).toBe(true);
    expect(validateAnswer({ type: "ranking", size: 2 }, "X, Y, Z")).toEqual({ value: ["X", "Y"] });
    expect("error" in validateAnswer({ type: "ranking", size: 3 }, "X, Y")).toBe(true);
    expect(validateAnswer({ type: "text" }, "  Jane Doe ")).toEqual({ value: "Jane Doe" });
  });

  it("formats numbers without separators and lists comma-separated", () => {
    expect(formatAnswer(1234567)).toBe("1234567");
    expect(formatAnswer(0.1 + 0.2)).toBe("0.3");
    expect(formatAnswer(["A", "C"])).toBe("A, C");
  });

  it("combines choices by weighted plurality and reports agreement", () => {
    const c = combineAnswers(choice, [
      { value: "A", weight: 1 },
      { value: "B", weight: 1 },
      { value: "A", weight: 1 },
    ]);
    expect(c?.value).toBe("A");
    expect(c?.agreement).toBeCloseTo(0.667, 3);
    // Ties break on stated confidence.
    const t = combineAnswers(choice, [
      { value: "A", weight: 1, confidence: 0.4 },
      { value: "B", weight: 1, confidence: 0.9 },
    ]);
    expect(t?.value).toBe("B");
  });

  it("combines sets by per-option frequency", () => {
    const c = combineAnswers(multi, [
      { value: ["A", "B"], weight: 1 },
      { value: ["A"], weight: 1 },
      { value: ["A", "C"], weight: 1 },
    ]);
    expect(c?.value).toEqual(["A"]);
    expect(c?.support?.A).toBe(1);
  });

  it("combines numbers by median, then trimmed mean from five runs", () => {
    expect(
      combineAnswers({ type: "number" }, [
        { value: 10, weight: 1 },
        { value: 11, weight: 1 },
        { value: 100, weight: 1 },
      ])?.value,
    ).toBe(11);
    expect(
      combineAnswers(
        { type: "number" },
        [1, 10, 11, 12, 1000].map((v) => ({ value: v, weight: 1 })),
      )?.value,
    ).toBe(11);
  });

  it("combines rankings by Borda count", () => {
    const c = combineAnswers({ type: "ranking", size: 2 }, [
      { value: ["X", "Y", "Z"], weight: 1 },
      { value: ["Y", "X", "Z"], weight: 1 },
      { value: ["X", "Z", "Y"], weight: 1 },
    ]);
    expect(c?.value).toEqual(["X", "Y"]);
  });

  it("returns undefined when nothing is usable", () => {
    expect(combineAnswers(choice, [{ value: "A", weight: 0 }])).toBeUndefined();
  });
});

function fakeRetriever(seen: ResearchBrief[]): Retriever {
  return async (brief) => {
    seen.push(brief);
    return {
      report: `- 2026-09-20 — the reading was 42.5% ([src](https://example.org/${seen.length}))`,
      sources: [
        { url: `https://example.org/${seen.length}` },
        { url: "https://late.example/x", published: "2099-01-01" },
      ],
      costUsd: 0.01,
      searches: 1,
      retriever: "fake",
    };
  };
}

const part = (name: string, reply: (system: string, user: string) => string): ModelPart => ({
  name,
  complete: async (s, u) => reply(s, u),
});

/** A planner/critic that answers by which prompt it was given. */
function planner(opts: { critic?: string; done?: boolean } = {}): ModelPart {
  return part("planner", (system) => {
    if (system.startsWith("You plan research")) {
      return JSON.stringify({
        restatement: "Will it be 42?",
        resolutionSource: "the bureau",
        queries: ["reading latest"],
      });
    }
    if (system.startsWith("You review a research dossier")) {
      return JSON.stringify(
        opts.done ? { done: true } : { done: false, missing: "x", queries: ["second query"] },
      );
    }
    return opts.critic ?? JSON.stringify({ verdict: "keep", confidence: 0.5, reason: "fine" });
  });
}

describe("forecastTyped", () => {
  const now = () => new Date("2026-10-05T00:00:00Z");

  it("plans, researches in rounds, runs K times, combines and keeps every stage", async () => {
    const briefs: ResearchBrief[] = [];
    const a = await forecastTyped(
      { question: "Which option?", answer: choice, endTime: "2026-10-08T00:00:00Z" },
      {
        retriever: fakeRetriever(briefs),
        analysts: [
          part("m1", () => '{"answer":"A","confidence":0.7,"reason":"r"}'),
          part("m2", () => '{"answer":"B","confidence":0.6,"reason":"r"}'),
        ],
        planner: planner(),
        now,
        options: { runs: 3, researchRounds: 2 },
      },
    );
    expect(a.prediction).toBe("A");
    expect(a.formatted).toBe("A");
    expect(a.runs.map((r) => r.model)).toEqual(["m1", "m2", "m1"]);
    expect(a.confidence).toBeCloseTo(0.667, 3);
    expect(a.plan?.resolutionSource).toBe("the bureau");
    expect(a.research).toHaveLength(2);
    expect(a.research[1]?.queries).toEqual(["second query"]);
    // A source published after the cutoff is dropped.
    expect(a.sources.some((s) => s.url.includes("late.example"))).toBe(false);
    expect(a.cutoff.basis).toBe("now");
    // Research briefs carry the cutoff; the critique brief came last.
    expect(briefs.every((b) => b.until === "2026-10-05")).toBe(true);
    expect(a.critique?.verdict).toBe("keep");
  });

  it("stops researching when the planner says the dossier is complete", async () => {
    const briefs: ResearchBrief[] = [];
    const a = await forecastTyped(
      { question: "Q?", answer: { type: "number" } },
      {
        retriever: fakeRetriever(briefs),
        analysts: [part("m", () => '{"answer": 41, "sd": 2, "confidence": 0.5}')],
        planner: planner({ done: true }),
        now,
        options: { runs: 1, researchRounds: 4, critique: false },
      },
    );
    expect(a.research).toHaveLength(1);
    expect(a.prediction).toBe(41);
    expect(a.critique).toBeUndefined();
  });

  it("freezes evidence at a past end time and says so", async () => {
    const briefs: ResearchBrief[] = [];
    const a = await forecastTyped(
      { question: "Q?", answer: { type: "text" }, endTime: "2026-09-01T12:00:00Z" },
      {
        retriever: fakeRetriever(briefs),
        analysts: [part("m", () => '{"answer":"Jane"}')],
        planner: planner(),
        now,
        options: { runs: 1, researchRounds: 1, critique: false },
      },
    );
    expect(a.cutoff).toEqual({
      at: "2026-09-01T12:00:00.000Z",
      basis: "endTime",
      pastCutoff: true,
    });
    expect(briefs[0]?.until).toBe("2026-09-01");
    expect(a.caveat).toContain("cutoff is in the past");
  });

  it("lets the critic revise only when it is surer than the runs agree", async () => {
    const run = (analysts: ModelPart[], conf: number) =>
      forecastTyped(
        { question: "Q?", answer: choice },
        {
          retriever: fakeRetriever([]),
          analysts,
          planner: planner({
            critic: JSON.stringify({
              verdict: "revise",
              answer: "C",
              confidence: conf,
              reason: "x",
            }),
          }),
          now,
          options: { runs: 3, researchRounds: 1 },
        },
      );
    const split = [
      part("a", () => '{"answer":"A"}'),
      part("b", () => '{"answer":"B"}'),
      part("c", () => '{"answer":"A"}'),
    ];
    const revised = await run(split, 0.9);
    expect(revised.critique?.applied).toBe(true);
    expect(revised.prediction).toBe("C");
    const kept = await run(split, 0.5);
    expect(kept.critique?.verdict).toBe("revise");
    expect(kept.critique?.applied).toBe(false);
    expect(kept.prediction).toBe("A");
  });

  it("drops invalid runs and reports when none is usable", async () => {
    const a = await forecastTyped(
      { question: "Q?", answer: choice },
      {
        retriever: fakeRetriever([]),
        analysts: [part("m", () => '{"answer":"Z"}')],
        planner: planner(),
        now,
        options: { runs: 2, researchRounds: 1 },
      },
    );
    expect(a.prediction).toBeUndefined();
    expect(a.runs.every((r) => r.status.startsWith("invalid"))).toBe(true);
    expect(a.caveat).toContain("no run produced a usable answer");
  });

  it("weights runs by the judge and records an outage as no opinion", async () => {
    const down: DecisionProvider = {
      kind: "fake",
      model: "fake-jev",
      ask: async () => {
        throw new Error("judge down");
      },
    };
    const a = await forecastTyped(
      { question: "Q?", answer: choice },
      {
        retriever: fakeRetriever([]),
        analysts: [part("m", () => '{"answer":"A"}')],
        planner: planner(),
        judge: down,
        pageText: async () => "On 2026-09-20 the reading was 42.5%.",
        now,
        options: { runs: 1, researchRounds: 1, critique: false },
      },
    );
    expect(a.runs[0]?.weight).toBe(0);
    expect(a.runs[0]?.judgeError).toBeDefined();
    expect(a.caveat).toContain("judge failed");
  });

  it("returns a caveat, not a throw, when research fails", async () => {
    const a = await forecastTyped(
      { question: "Q?", answer: choice },
      {
        retriever: async () => {
          throw new Error("offline");
        },
        analysts: [part("m", () => '{"answer":"A"}')],
        planner: planner(),
        now,
        options: { runs: 1, researchRounds: 1 },
      },
    );
    expect(a.caveat).toContain("research failed");
    expect(a.prediction).toBeUndefined();
  });
});

describe("forecast lookups", () => {
  it("is opt-in by name", () => {
    expect(lookupsFromSpec(undefined)).toEqual([]);
    expect(lookupsFromSpec("polymarket, unknown").map((l) => l.name)).toEqual(["polymarket"]);
  });

  it("formats market prices as dossier lines and skips a past cutoff", async () => {
    const lookup = polymarketLookup(async () => ({
      ok: true,
      paper: false,
      response: [
        {
          id: "1",
          title: "Event",
          slug: "event",
          markets: [
            {
              id: "m",
              question: "Will X?",
              outcomePrices: '["0.65","0.35"]',
              volume: 1,
              active: true,
              closed: false,
            },
          ],
        },
      ],
    }));
    const now = new Date("2026-10-05T00:00:00Z");
    const live = await lookup.lookup("x", now, now);
    expect(live.lines[0]).toContain("Will X? — Yes 65%, No 35%");
    expect(live.sources[0]?.url).toBe("https://polymarket.com/event/event");
    const past = await lookup.lookup("x", new Date("2026-09-01T00:00:00Z"), now);
    expect(past.skipped).toBe("cutoff in the past");
    expect(past.lines).toEqual([]);
  });
});

describe("forecast command: typed questions", () => {
  it("parses type:/options:/size:/ends: into a spec", async () => {
    const { typedSpec } = await import("../src/engine/commands/forecast");
    expect(typedSpec({})).toBeUndefined();
    expect(typedSpec({ type: "choice", options: "Yes,No" })).toEqual({
      spec: { type: "choice", options: [{ id: "Yes" }, { id: "No" }] },
    });
    expect(typedSpec({ type: "ranking", size: "3", ends: "2026-10-07T16:00:00Z" })).toEqual({
      spec: { type: "ranking", size: 3 },
      endTime: "2026-10-07T16:00:00.000Z",
    });
    expect("error" in (typedSpec({ type: "multi", options: "A" }) ?? {})).toBe(true);
    expect("error" in (typedSpec({ type: "guess" }) ?? {})).toBe(true);
    expect("error" in (typedSpec({ type: "text", ends: "soon" }) ?? {})).toBe(true);
  });

  it("saves a typed answer (migration 149 widens the kinds) and lists it", async () => {
    const { saveTypedAnswer, renderHistory } = await import("../src/engine/commands/forecast");
    const { MarinaDB } = await import("../src/persistence/database");
    const db = new MarinaDB(":memory:");
    try {
      const id = saveTypedAnswer(db, "Ada", {
        question: "Which?",
        answer: multi,
        prediction: ["A", "C"],
        formatted: "A, C",
        confidence: 0.67,
        runs: [],
        research: [],
        cutoff: { at: "2026-10-05T00:00:00.000Z", basis: "now", pastCutoff: false },
        sources: [],
        costUsd: 0.1,
        latencyMs: 5,
      });
      const row = db.listForecastAnswers("Ada")[0]!;
      expect(row.id).toBe(id!);
      expect(row.kind).toBe("multi");
      expect(row.prediction).toBe("A, C");
      expect(renderHistory([row])).toContain("A, C");
    } finally {
      db.close();
    }
  });
});
