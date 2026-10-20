// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Arbiter core (`src/orchestration/arbiter.ts`): free disagreement
 * detection per answer type, the cap, the contract, the overrule bar (domain
 * independence, confidence, citations per item, grounding), abstain, observe
 * and earned trust — every model mocked. Also the in-world `arbiter` command.
 */

import { describe, expect, it } from "bun:test";
import { NO_ANSWER, replayCounts, typedReplay } from "../benchmarks/transfer/arbiter-replay";
import { runCheck, runContested } from "../src/engine/commands/arbiter";
import {
  type ArbiterItem,
  ArbiterQuota,
  type ArbiterVerdict,
  applyOverruleBar,
  arbiterPolicyFromEnv,
  arbiterTrackRecord,
  arbitrate,
  DEFAULT_ARBITER_POLICY,
  detectDisagreement,
  overruleAllowed,
  overruleRight,
  parseArbiterMode,
  parseArbiterVerdict,
  selectForArbiter,
  sourceKey,
} from "../src/orchestration/arbiter";
import { stripAnsi } from "./helpers";

const runs = (...answers: Array<string | number | string[]>) =>
  answers.map((answer) => ({ answer }));

describe("disagreement detection (free signals)", () => {
  it("choice: unanimous runs are not contested; a split is", () => {
    const same = detectDisagreement({ type: "choice", runs: runs("A", "A", "A") });
    expect(same.contested).toBe(false);
    expect(same.agreement).toBe(1);
    expect(same.majority).toBe("A");
    const split = detectDisagreement({ type: "choice", runs: runs("A", "A", "B") });
    expect(split.contested).toBe(true);
    expect(split.reasons).toEqual(["runs-disagree"]);
    expect(split.agreement).toBeCloseTo(0.667, 3);
    expect(split.hasMajority).toBe(true);
    expect(split.answers.map((a) => a.answer)).toEqual(["A", "B"]);
  });

  it("text: case, accents and punctuation fold away before comparing", () => {
    const d = detectDisagreement({
      type: "text",
      runs: runs("Matthew Arnum Barnor", "matthew arnum barnor.", "Mátthew  Arnum Barnor"),
    });
    expect(d.contested).toBe(false);
    const e = detectDisagreement({ type: "text", runs: runs("Barnor", "Evans") });
    expect(e.contested).toBe(true);
    expect(e.hasMajority).toBe(false);
  });

  it("number: values within the relative tolerance agree; a far one contests", () => {
    const d = detectDisagreement({ type: "number", runs: runs(100, 101, 100.5) });
    expect(d.contested).toBe(false);
    expect(d.majority).toBe(100.5);
    const e = detectDisagreement({ type: "number", runs: runs(100, 101, 140) });
    expect(e.contested).toBe(true);
    expect(e.agreement).toBeCloseTo(0.667, 3);
  });

  it("multi is order-insensitive; ranking is order-sensitive", () => {
    const m = detectDisagreement({ type: "multi", runs: runs(["A", "C"], ["C", "A"]) });
    expect(m.contested).toBe(false);
    const r = detectDisagreement({ type: "ranking", runs: runs(["A", "C"], ["C", "A"]) });
    expect(r.contested).toBe(true);
  });

  it("a dissenting reviewer contests an otherwise unanimous item; agreeing dissent does not", () => {
    const d = detectDisagreement({
      type: "choice",
      runs: runs("A", "A", "A"),
      dissent: [{ by: "critic", answer: "B" }],
    });
    expect(d.contested).toBe(true);
    expect(d.reasons).toEqual(["dissent"]);
    const agreeing = detectDisagreement({
      type: "choice",
      runs: runs("A", "A"),
      dissent: [{ by: "critic", answer: "A" }],
    });
    expect(agreeing.contested).toBe(false);
    const flagOnly = detectDisagreement({
      type: "text",
      runs: runs("Paris"),
      dissent: [{ by: "checker", reason: "unsupported" }],
    });
    expect(flagOnly.contested).toBe(true);
  });

  it("a wide judge-score spread contests", () => {
    const d = detectDisagreement({ type: "choice", runs: runs("A", "A"), judgeScores: [0.9, 0.2] });
    expect(d.reasons).toEqual(["judge-spread"]);
    const narrow = detectDisagreement({
      type: "choice",
      runs: runs("A", "A"),
      judgeScores: [0.9, 0.6],
    });
    expect(narrow.contested).toBe(false);
  });

  it("CONTESTED_BELOW relaxes what counts as contested", () => {
    const policy = arbiterPolicyFromEnv({ MARINA_ARBITER_CONTESTED_BELOW: "0.6" });
    const d = detectDisagreement({ type: "choice", runs: runs("A", "A", "B") }, policy);
    expect(d.contested).toBe(false);
  });
});

describe("the cap", () => {
  const item = (id: string, answers: string[], dissent = 0) => ({
    id,
    disagreement: detectDisagreement({
      type: "choice",
      runs: runs(...answers),
      dissent: Array.from({ length: dissent }, () => ({ by: "critic", answer: "Z" })),
    }),
  });

  it("only contested items reach the Arbiter, most contested first, at most `cap`", () => {
    const items = [
      item("calm", ["A", "A", "A"]),
      item("split", ["A", "A", "B"]),
      item("chaos", ["A", "B", "C"]),
      item("disputed", ["A", "A", "B"], 2),
    ];
    const r = selectForArbiter(items, 2);
    expect(r.selected.map((i) => i.id)).toEqual(["disputed", "chaos"]);
    expect(r.capped.map((i) => i.id)).toEqual(["split"]);
    expect(r.uncontested.map((i) => i.id)).toEqual(["calm"]);
    expect(selectForArbiter(items, 0).selected).toHaveLength(3);
  });

  it("the daily quota stops at the cap and resets on a new UTC day", () => {
    const q = new ArbiterQuota(2);
    const day = new Date("2026-10-20T10:00:00Z");
    expect([q.take(day), q.take(day), q.take(day)]).toEqual([true, true, false]);
    expect(q.take(new Date("2026-10-21T00:00:01Z"))).toBe(true);
    const unlimited = new ArbiterQuota(0);
    for (let i = 0; i < 5; i++) expect(unlimited.take(day)).toBe(true);
  });
});

describe("domain independence", () => {
  it("normalises URLs to registrable domains", () => {
    expect(sourceKey("https://en.wikipedia.org/wiki/X")).toBe("wikipedia.org");
    expect(sourceKey("https://de.wikipedia.org/wiki/Y")).toBe("wikipedia.org");
    expect(sourceKey("http://www.bbc.co.uk/news/1")).toBe("bbc.co.uk");
    expect(sourceKey("https://news.bbc.co.uk/2")).toBe("bbc.co.uk");
    expect(sourceKey("https://www.reuters.com/a")).toBe("reuters.com");
    expect(sourceKey("apnews.com/article/b")).toBe("apnews.com");
    expect(sourceKey("https://192.168.1.4/x")).toBe("192.168.1.4");
  });

  it("a non-URL source (a corpus document id) is its own key", () => {
    expect(sourceKey("33294")).toBe("33294");
    expect(sourceKey("note:12")).toBe("note:12");
  });
});

const EVIDENCE = [
  "[1] https://www.reuters.com/a — The final score was 3-1 to Brazil.",
  "[2] https://apnews.com/b — Brazil beat Spain 3-1 on Sunday.",
  "[3] https://en.wikipedia.org/wiki/Match — Brazil won the match 3-1.",
  "[4] https://de.wikipedia.org/wiki/Spiel — Brazil won 3-1 in the final.",
].join("\n");

const verdict = (over: Partial<ArbiterVerdict> = {}): ArbiterVerdict => ({
  verdict: "overrule",
  answer: "Brazil",
  items: [
    {
      item: "Brazil",
      citations: [
        { source: "https://www.reuters.com/a", quote: "The final score was 3-1 to Brazil." },
        { source: "https://apnews.com/b", quote: "Brazil beat Spain 3-1 on Sunday." },
      ],
    },
  ],
  sourceQuality: 0.8,
  reasoningQuality: 0.8,
  confidence: 0.8,
  ...over,
});

describe("the overrule bar", () => {
  const majority = detectDisagreement({
    type: "text",
    runs: runs("Spain", "Spain", "Brazil"),
  });

  it("an overrule of a majority with two independent domains and confidence ≥ 0.7 stands", () => {
    const bar = applyOverruleBar(verdict(), {
      type: "text",
      disagreement: majority,
      evidence: EVIDENCE,
    });
    expect(bar.verdict).toBe("overrule");
    expect(bar.answer).toBe("Brazil");
    expect(bar.domains).toEqual(["apnews.com", "reuters.com"]);
    expect(bar.downgraded).toEqual([]);
  });

  it("two pages of one registrable domain are ONE domain: downgraded to keep", () => {
    const v = verdict({
      items: [
        {
          item: "Brazil",
          citations: [
            { source: "https://en.wikipedia.org/wiki/Match", quote: "Brazil won the match 3-1." },
            {
              source: "https://de.wikipedia.org/wiki/Spiel",
              quote: "Brazil won 3-1 in the final.",
            },
          ],
        },
      ],
    });
    const bar = applyOverruleBar(v, { type: "text", disagreement: majority, evidence: EVIDENCE });
    expect(bar.verdict).toBe("keep");
    expect(bar.domains).toEqual(["wikipedia.org"]);
    expect(bar.downgraded[0]).toContain("1 independent domain(s), 2 required");
  });

  it("confidence below 0.7 is downgraded to abstain", () => {
    const bar = applyOverruleBar(verdict({ confidence: 0.6 }), {
      type: "text",
      disagreement: majority,
      evidence: EVIDENCE,
    });
    expect(bar.verdict).toBe("abstain");
    expect(bar.downgraded.join(" ")).toContain("confidence 0.6 < 0.7");
  });

  it("a quote that is not in the evidence is ungrounded and does not count", () => {
    const v = verdict({
      items: [
        {
          item: "Brazil",
          citations: [
            { source: "https://www.reuters.com/a", quote: "The final score was 3-1 to Brazil." },
            { source: "https://apnews.com/b", quote: "Brazil lifted the trophy." },
          ],
        },
      ],
    });
    const bar = applyOverruleBar(v, { type: "text", disagreement: majority, evidence: EVIDENCE });
    expect(bar.ungrounded).toBe(1);
    expect(bar.verdict).toBe("keep");
  });

  it("every item of a list answer needs its own citation", () => {
    const d = detectDisagreement({ type: "multi", runs: runs(["A"], ["A"], ["A", "B"]) });
    const v = verdict({
      answer: ["A", "B"],
      items: [
        {
          item: "A",
          citations: [
            { source: "https://www.reuters.com/a", quote: "The final score was 3-1 to Brazil." },
            { source: "https://apnews.com/b", quote: "Brazil beat Spain 3-1 on Sunday." },
          ],
        },
      ],
    });
    const bar = applyOverruleBar(v, { type: "multi", disagreement: d, evidence: EVIDENCE });
    expect(bar.verdict).toBe("keep");
    expect(bar.uncited).toEqual(["B"]);
  });

  it("without a majority the domain floor is lower (MIN_DOMAINS_NO_MAJORITY)", () => {
    const d = detectDisagreement({ type: "text", runs: runs("Spain", "Brazil", "Italy") });
    expect(d.hasMajority).toBe(false);
    const v = verdict({
      items: [
        {
          item: "Brazil",
          citations: [
            { source: "https://www.reuters.com/a", quote: "The final score was 3-1 to Brazil." },
          ],
        },
      ],
    });
    expect(applyOverruleBar(v, { type: "text", disagreement: d, evidence: EVIDENCE }).verdict).toBe(
      "overrule",
    );
  });

  it("thresholds are configurable", () => {
    const policy = arbiterPolicyFromEnv({
      MARINA_ARBITER_MIN_DOMAINS: "3",
      MARINA_ARBITER_MIN_CONFIDENCE: "0.9",
    });
    expect(policy.minDomains).toBe(3);
    expect(policy.minConfidence).toBe(0.9);
    const bar = applyOverruleBar(verdict(), {
      type: "text",
      disagreement: majority,
      evidence: EVIDENCE,
      policy,
    });
    expect(bar.verdict).toBe("abstain");
    expect(bar.requiredDomains).toBe(3);
    // Junk keeps the defaults.
    expect(arbiterPolicyFromEnv({ MARINA_ARBITER_MIN_DOMAINS: "many" }).minDomains).toBe(2);
  });

  it("an overrule to the majority's own answer is a keep; keep and abstain pass through", () => {
    expect(
      applyOverruleBar(verdict({ answer: "spain" }), { type: "text", disagreement: majority })
        .verdict,
    ).toBe("keep");
    expect(
      applyOverruleBar(verdict({ verdict: "abstain" }), { type: "text", disagreement: majority })
        .verdict,
    ).toBe("abstain");
  });
});

describe("the contract", () => {
  it("parses a verdict leniently, with citations and both quality axes", () => {
    const v = parseArbiterVerdict(
      `Here: {"verdict":"Overrule","answer":"B","items":[{"item":"B","citations":[{"source":"https://a.org/x","quote":"q"},"https://b.org"]}],"source_quality":0.9,"reasoning_quality":2,"confidence":"0.75","reason":"r"}`,
    )!;
    expect(v.verdict).toBe("overrule");
    expect(v.answer).toBe("B");
    expect(v.items[0]!.citations).toEqual([
      { source: "https://a.org/x", quote: "q" },
      { source: "https://b.org" },
    ]);
    expect(v.sourceQuality).toBe(0.9);
    expect(v.reasoningQuality).toBe(1);
    expect(v.confidence).toBe(0.75);
    expect(parseArbiterVerdict("no json")).toBeUndefined();
    expect(parseArbiterVerdict('{"verdict":"maybe"}')).toBeUndefined();
  });

  it("parses modes", () => {
    expect(parseArbiterMode(undefined)).toBe("off");
    expect(parseArbiterMode(" Observe ")).toBe("observe");
    expect(parseArbiterMode("on")).toBe("on");
    expect(parseArbiterMode("junk")).toBe("off");
  });
});

describe("arbitrate", () => {
  const contested: ArbiterItem = {
    id: "q1",
    question: "Who won the final?",
    type: "text",
    runs: runs("Spain", "Spain", "Brazil"),
    evidence: EVIDENCE,
  };
  const replying = (reply: unknown) => {
    const calls: string[] = [];
    return {
      calls,
      complete: async (system: string, user: string) => {
        calls.push(`${system}\n${user}`);
        if (reply instanceof Error) throw reply;
        return typeof reply === "string" ? reply : JSON.stringify(reply);
      },
    };
  };
  const overrule = {
    verdict: "overrule",
    answer: "Brazil",
    items: verdict().items,
    source_quality: 0.8,
    reasoning_quality: 0.7,
    confidence: 0.85,
  };

  it("an uncontested item never reaches the Arbiter", async () => {
    const m = replying(overrule);
    const r = await arbitrate(
      { ...contested, runs: runs("Spain", "Spain") },
      { mode: "on", complete: m.complete, evaluator: "arb" },
    );
    expect(r.status).toBe("uncontested");
    expect(r.final).toBe("Spain");
    expect(m.calls).toHaveLength(0);
  });

  it("on: an overrule that clears the bar changes the answer", async () => {
    const m = replying(overrule);
    const r = await arbitrate(contested, { mode: "on", complete: m.complete, evaluator: "arb" });
    expect(r.status).toBe("adjudicated");
    expect(r.applied).toBe(true);
    expect(r.final).toBe("Brazil");
    expect(m.calls[0]).toContain("You are the Arbiter");
    expect(m.calls[0]).toContain("(MAJORITY)");
  });

  it("observe: records the same verdict and never changes the answer", async () => {
    const m = replying(overrule);
    const r = await arbitrate(contested, {
      mode: "observe",
      complete: m.complete,
      evaluator: "arb",
    });
    expect(r.bar?.verdict).toBe("overrule");
    expect(r.applied).toBe(false);
    expect(r.final).toBe("Spain");
  });

  it("abstain keeps the majority answer", async () => {
    const m = replying({ ...overrule, verdict: "abstain", confidence: 0.3 });
    const r = await arbitrate(contested, { mode: "on", complete: m.complete, evaluator: "arb" });
    expect(r.bar?.verdict).toBe("abstain");
    expect(r.final).toBe("Spain");
    expect(r.applied).toBe(false);
  });

  it("an outage or unreadable reply is unavailable and keeps the majority", async () => {
    const down = await arbitrate(contested, {
      mode: "on",
      complete: replying(new Error("503")).complete,
      evaluator: "arb",
    });
    expect(down.status).toBe("unavailable");
    expect(down.final).toBe("Spain");
    const junk = await arbitrate(contested, {
      mode: "on",
      complete: replying("I think Brazil").complete,
      evaluator: "arb",
    });
    expect(junk.status).toBe("unavailable");
  });

  it("the quota caps calls: a capped item keeps the majority without a call", async () => {
    const m = replying(overrule);
    const quota = new ArbiterQuota(1);
    await arbitrate(contested, { mode: "on", complete: m.complete, evaluator: "arb", quota });
    const second = await arbitrate(contested, {
      mode: "on",
      complete: m.complete,
      evaluator: "arb",
      quota,
    });
    expect(second.status).toBe("capped");
    expect(second.final).toBe("Spain");
    expect(m.calls).toHaveLength(1);
  });

  it("earned trust: with UNEARNED=observe an unearned Arbiter records but does not act", async () => {
    const policy = arbiterPolicyFromEnv({ MARINA_ARBITER_UNEARNED: "observe" });
    const m = replying(overrule);
    const young = arbiterTrackRecord([], "arb", policy);
    const r = await arbitrate(contested, {
      mode: "on",
      complete: m.complete,
      evaluator: "arb",
      policy,
      track: young,
    });
    expect(r.bar?.verdict).toBe("overrule");
    expect(r.applied).toBe(false);
    expect(r.trust).toContain("not yet earned");
    const seasoned = arbiterTrackRecord(
      Array.from({ length: 20 }, (_, i) => ({ evaluator: "arb", right: i < 15 })),
      "arb",
      policy,
    );
    expect(seasoned).toMatchObject({ resolved: 20, right: 15, precision: 0.75, earned: true });
    const r2 = await arbitrate(contested, {
      mode: "on",
      complete: m.complete,
      evaluator: "arb",
      policy,
      track: seasoned,
    });
    expect(r2.applied).toBe(true);
  });
});

describe("earned trust", () => {
  it("counts resolved overrules per evaluator; pending ones wait", () => {
    const rec = arbiterTrackRecord(
      [
        { evaluator: "a", right: true },
        { evaluator: "a", right: false },
        { evaluator: "a" },
        { evaluator: "b", right: true },
      ],
      "a",
    );
    expect(rec).toMatchObject({ resolved: 2, right: 1, precision: 0.5, pending: 1, earned: false });
    expect(overruleAllowed(rec).allowed).toBe(true); // strict (default): the bar decides
    expect(
      overruleAllowed(rec, {
        ...DEFAULT_ARBITER_POLICY,
        earn: { ...DEFAULT_ARBITER_POLICY.earn, unearned: "observe" },
      }).allowed,
    ).toBe(false);
  });

  it("an overrule is right only when it beats a wrong majority", () => {
    expect(overruleRight("choice", "A", "B", "B")).toBe(true);
    expect(overruleRight("choice", "A", "B", "A")).toBe(false);
    expect(overruleRight("choice", "A", "B", "C")).toBe(false);
    expect(overruleRight("number", 100, 120, 118)).toBe(true);
    expect(overruleRight("number", 100, 120, 101)).toBe(false);
    expect(overruleRight("multi", ["A"], ["A", "B"], ["B", "A"])).toBe(true);
  });
});

describe("the arbiter command", () => {
  const policy = DEFAULT_ARBITER_POLICY;
  it("contested reports agreement and the majority", () => {
    const out = stripAnsi(runContested("type:choice -- A | A | B", policy).join("\n"));
    expect(out).toContain("contested (runs-disagree)");
    expect(out).toContain("majority: A");
    const calm = stripAnsi(runContested("-- Paris | paris", policy).join("\n"));
    expect(calm).toContain("not contested");
  });

  it("check applies the bar to a verdict JSON", () => {
    const json = JSON.stringify({
      verdict: "overrule",
      answer: "Brazil",
      items: [
        {
          item: "Brazil",
          citations: [
            { source: "https://en.wikipedia.org/a", quote: "x" },
            { source: "https://de.wikipedia.org/b", quote: "y" },
          ],
        },
      ],
      confidence: 0.9,
    });
    const out = stripAnsi(runCheck(`majority:Spain -- ${json}`, policy).join("\n"));
    expect(out).toContain("after the bar: keep");
    expect(out).toContain("independent domains: wikipedia.org (2 required)");
    expect(out).toContain("the majority answer stands");
    expect(() => runCheck("majority:Spain", policy)).toThrow("after `--`");
  });
});

describe("offline replay (no model calls)", () => {
  it("counts reach under the cap and verifier overrules of a correct majority", () => {
    const right = (key: string) => ({ key, correct: true });
    const wrong = (key: string) => ({ key, correct: false });
    const c = replayCounts(
      [
        // Unanimous, verify agrees: never contested.
        { id: "1", plain: [right("a"), right("a"), right("a")], verify: [right("a")] },
        // Correct majority overruled by the verifier.
        { id: "2", plain: [right("a"), right("a"), wrong("b")], verify: [wrong("b")] },
        // Wrong majority fixed by the verifier.
        { id: "3", plain: [wrong("x"), wrong("x"), wrong("x")], verify: [right("y")] },
        // The verify arm ran out of turns: no answer.
        { id: "4", plain: [right("a"), right("a")], verify: [wrong(NO_ANSWER)] },
      ],
      2,
    );
    expect(c).toMatchObject({
      items: 4,
      contested: 3,
      reachUnderCap: 2,
      capped: 1,
      withMajority: 4,
      verifyDissents: 3,
      overruledCorrectMajority: 2,
      overruledByNoAnswer: 1,
      fixedWrongMajority: 1,
    });
  });

  it("reads typed drafts, verifier corrections and critic revisions", () => {
    const t = typedReplay(
      [
        { answer: { type: "choice" }, runs: [{ formatted: "A" }, { formatted: "A" }] },
        {
          answer: { type: "choice" },
          formatted: "B",
          runs: [
            { formatted: "B", verified: { verdict: "correct", draft: "A" } },
            { formatted: "A" },
            { formatted: "A" },
          ],
        },
        { answer: { type: "number" }, runs: [{ formatted: "4.2" }, { formatted: "4.21" }] },
      ],
      10,
    );
    expect(t).toMatchObject({
      withRuns: 3,
      contested: 1,
      verifierDissent: 1,
      verifierBrokeUnanimity: 1,
      // The drafts agreed on A; the verifier's correction made the answer B.
      verifierFlippedMajority: 1,
    });
  });
});
