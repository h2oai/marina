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
import { completionGap, forecastTyped, type ModelPart } from "../src/forecast/typed";

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

  it("repairs a run whose answer missed the JSON shape, labelled, without changing it", async () => {
    const briefs: ResearchBrief[] = [];
    const repairPrompts: string[] = [];
    const prose = "The latest reading favours option A because the trend held.";
    const a = await forecastTyped(
      { question: "Which option?", answer: choice },
      {
        retriever: fakeRetriever(briefs),
        analysts: [
          part("fenced", () => '```json\n{"answer": "A", "confidence": 0.7,}\n```'),
          part("prose", (system) => {
            if (system.includes("You re-encode text")) {
              repairPrompts.push(system);
              return '{"answer": "A"}';
            }
            return prose;
          }),
          part("inventing", (system) =>
            system.includes("You re-encode text") ? '{"answer": "B"}' : "I cannot decide.",
          ),
        ],
        planner: planner({ done: true }),
        now,
        options: { runs: 3, researchRounds: 1, critique: false },
      },
    );
    expect(a.runs[0]?.repaired).toBe("repaired:parse");
    expect(a.runs[0]?.value).toBe("A");
    expect(a.runs[1]?.repaired).toBe("repaired:shot");
    expect(a.runs[1]?.value).toBe("A");
    expect(repairPrompts).toHaveLength(1);
    // The third run's shot answered instead of re-encoding: it stays invalid.
    expect(a.runs[2]?.repaired).toBeUndefined();
    expect(a.runs[2]?.status).toContain("invalid");
    expect(a.prediction).toBe("A");
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

  it("tells the runs they forecast AS OF the cutoff, so 'no result yet' is never the answer", async () => {
    let system = "";
    let user = "";
    await forecastTyped(
      { question: "Who wins?", answer: choice, endTime: "2026-10-09T00:00:00Z" },
      {
        retriever: fakeRetriever([]),
        analysts: [
          part("m", (s, u) => {
            system = s;
            user = u;
            return '{"answer":"A"}';
          }),
        ],
        planner: planner(),
        now,
        options: { runs: 1, researchRounds: 1, critique: false },
      },
    );
    expect(system).toContain("AS OF the evidence cutoff");
    expect(system).toContain("rarely the case");
    expect(user).toContain("the event itself happens later");
  });

  it("still answers, with a caveat, when every research round fails", async () => {
    let seen = "";
    const a = await forecastTyped(
      { question: "Q?", answer: choice },
      {
        retriever: async () => {
          throw new Error("offline");
        },
        analysts: [
          part("m", (_s, u) => {
            seen = u;
            return '{"answer":"A"}';
          }),
        ],
        planner: planner(),
        now,
        options: { runs: 1, researchRounds: 2, critique: false },
      },
    );
    expect(a.research.every((r) => r.error)).toBe(true);
    expect(a.prediction).toBe("A");
    expect(a.caveat).toContain("research failed");
    expect(seen).toContain("research unavailable");
  });
});

describe("forecast lookups", () => {
  it("defaults to every available lookup; off and explicit lists win", () => {
    expect(lookupsFromSpec(undefined, {}).map((l) => l.name)).toEqual([
      "polymarket",
      "kalshi",
      "fred",
      "bls",
    ]);
    expect(lookupsFromSpec("off", {})).toEqual([]);
    expect(lookupsFromSpec("polymarket, unknown").map((l) => l.name)).toEqual(["polymarket"]);
  });

  it("formats market prices as dossier lines and skips a past cutoff", async () => {
    const lookup = polymarketLookup(async () => ({
      ok: true,
      paper: false,
      response: [
        {
          id: "1",
          title: "Lakers NBA Championship",
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
    const q = "Will the Lakers win the NBA title?";
    const live = await lookup.lookup(q, now, now);
    expect(live.lines[0]).toContain("Will X? — Yes 65%, No 35%");
    expect(live.sources[0]?.url).toBe("https://polymarket.com/event/event");
    const past = await lookup.lookup(q, new Date("2026-09-01T00:00:00Z"), now);
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

  it("saves a typed answer (migration 151 widens the kinds) and lists it", async () => {
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

describe("completion call", () => {
  const now = () => new Date("2026-10-05T00:00:00Z");
  const ranking: AnswerSpec = { type: "ranking", size: 3, candidates: ["X", "Y", "Z", "W"] };
  const probChoice: AnswerSpec = {
    type: "choice",
    probabilities: true,
    options: [{ id: "A" }, { id: "B" }, { id: "C" }],
  };

  it("names what an incomplete answer is missing, and nothing for a wrong or complete one", () => {
    expect(completionGap(ranking, { answer: ["X", "Y"] })).toContain("rank all 3 places");
    expect(completionGap(ranking, { answer: ["X", "Y"] })).toContain("X; Y; Z; W");
    expect(completionGap(ranking, { answer: ["X", "Y", "Z"] })).toBeUndefined();
    expect(completionGap(multi, { answer: [] })).toContain("pick at least 1");
    // Wrong, not incomplete: an unknown option is never a completion.
    expect(completionGap(multi, { answer: ["E"] })).toBeUndefined();
    expect(completionGap(choice, { answer: "A, B" })).toBeUndefined();
    expect(completionGap(choice, { reason: "r" })).toContain("pick exactly ONE");
    expect(completionGap({ type: "number" }, { reason: "r" })).toContain("ONE number");
    expect(completionGap(probChoice, { answer: "A", probabilities: { A: 0.6, B: 0.4 } })).toContain(
      "missing: C",
    );
    expect(
      completionGap(probChoice, { answer: "A", probabilities: { A: 0.5, B: 0.3, C: 0.2 } }),
    ).toBeUndefined();
    // No JSON at all is output repair's job.
    expect(completionGap(choice, undefined)).toBeUndefined();
  });

  it("makes one extra call per incomplete run, with its own answer, and labels what it used", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const a = await forecastTyped(
      { question: "Top three?", answer: ranking },
      {
        retriever: fakeRetriever([]),
        analysts: [
          part("m", (_s, user) => {
            calls++;
            if (user.includes("It is INCOMPLETE")) {
              prompts.push(user);
              return '{"answer":["X","Y","Z"],"reason":"completed"}';
            }
            return '{"answer":["X","Y"],"reason":"only two known"}';
          }),
        ],
        planner: planner({ done: true }),
        now,
        options: { runs: 2, researchRounds: 1, critique: false, disagreementRound: false },
      },
    );
    expect(calls).toBe(4);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("rank all 3 places");
    expect(prompts[0]).toContain("only two known");
    expect(a.runs.every((r) => r.repaired === "repaired:completion")).toBe(true);
    expect(a.runs[0]?.completion).toMatchObject({ accepted: true });
    expect(a.prediction).toEqual(["X", "Y", "Z"]);
  });

  it("falls back as before when the extra call is still incomplete, and never asks twice", async () => {
    let completions = 0;
    const a = await forecastTyped(
      { question: "Top three?", answer: ranking },
      {
        retriever: fakeRetriever([]),
        analysts: [
          part("m", (_s, user) => {
            if (user.includes("It is INCOMPLETE")) completions++;
            return '{"answer":["X","Y"],"reason":"two"}';
          }),
        ],
        planner: planner({ done: true }),
        now,
        options: { runs: 1, researchRounds: 1, critique: false },
      },
    );
    expect(completions).toBe(1);
    expect(a.runs[0]?.status).toContain("invalid");
    expect(a.runs[0]?.completion).toMatchObject({
      accepted: false,
      error: "still invalid: a ranking of 3 needs 3 items",
    });
    expect(a.runs[0]?.repaired).toBeUndefined();
    expect(a.formatted).toBeUndefined();
  });

  it("completes a probability missing for an option, keeping the valid answer if it cannot", async () => {
    const a = await forecastTyped(
      { question: "Which?", answer: probChoice },
      {
        retriever: fakeRetriever([]),
        analysts: [
          part("m", (_s, user) =>
            user.includes("It is INCOMPLETE")
              ? '{"answer":"A","probabilities":{"A":0.6,"B":0.3,"C":0.1},"reason":"r"}'
              : '{"answer":"A","probabilities":{"A":0.6,"B":0.4},"reason":"r"}',
          ),
          part("refused", (_s, user) => {
            if (user.includes("It is INCOMPLETE")) throw new Error("daily spend cap reached");
            return '{"answer":"A","probabilities":{"A":0.7,"B":0.3},"reason":"r"}';
          }),
        ],
        planner: planner({ done: true }),
        now,
        options: { runs: 2, researchRounds: 1, critique: false },
      },
    );
    expect(a.runs[0]?.repaired).toBe("repaired:completion");
    expect(a.runs[0]?.distribution?.C).toBeCloseTo(0.1, 2);
    // The refused call (a spend cap) leaves the run as it was.
    expect(a.runs[1]?.completion).toMatchObject({ accepted: false });
    expect(a.runs[1]?.completion?.error).toContain("spend cap");
    expect(a.runs[1]?.value).toBe("A");
    expect(a.runs[1]?.repaired).toBeUndefined();
  });

  it("is skipped when turned off and in the budget's final phase", async () => {
    let completions = 0;
    const analyst = part("m", (_s, user) => {
      if (user.includes("It is INCOMPLETE")) completions++;
      return '{"answer":["X","Y"],"reason":"two"}';
    });
    const off = await forecastTyped(
      { question: "Top three?", answer: ranking },
      {
        retriever: fakeRetriever([]),
        analysts: [analyst],
        planner: planner({ done: true }),
        now,
        options: { runs: 1, researchRounds: 1, critique: false, completion: false },
      },
    );
    expect(off.runs[0]?.completion).toBeUndefined();
    const slow: ModelPart = {
      name: "slow",
      complete: async (_s, user) => {
        if (user.includes("It is INCOMPLETE")) completions++;
        await new Promise((r) => setTimeout(r, 40));
        return '{"answer":["X","Y"],"reason":"two"}';
      },
    };
    const forced = await forecastTyped(
      { question: "Top three?", answer: ranking },
      {
        retriever: fakeRetriever([]),
        analysts: [slow],
        planner: planner({ done: true }),
        now,
        options: { runs: 1, researchRounds: 1, critique: false, plan: false, budgetMs: 20 },
      },
    );
    expect(completions).toBe(0);
    expect(forced.budget?.skipped).toContain("completion");
  });
});
