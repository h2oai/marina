// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { DecisionProvider } from "../src/decisions/types";
import { AgentObligations } from "../src/obligations/agent";
import { applyExtraction, newLedger } from "../src/obligations/ledger";
import {
  capReviewMode,
  MAX_REVIEWS,
  markNamed,
  obligationsReviewMode,
  parseReviewMode,
  REVIEW_QUESTION,
  type ReviewQuestions,
  recentToolResults,
  recordReview,
  reviewEngaged,
  reviewFlagCount,
  reviewLabel,
  reviewNote,
  reviewQuestions,
  reviewRuleBytes,
  reviewRules,
  reviewState,
  reviewWrite,
  selectReview,
} from "../src/obligations/review";

const q = (p: Partial<ReviewQuestions>): ReviewQuestions => ({
  order: false,
  evidence: false,
  requested: false,
  permitted: false,
  ...p,
});

function ledgerWith(...what: string[]) {
  const l = newLedger("k", 0);
  if (what.length)
    applyExtraction(l, 1, { add: what.map((w) => ({ what: w })), cancel: [] }, new Set(), 0);
  return l;
}

const call = { name: "close_card", args: { card_id: "4417" } };

describe("pre-write review (pure)", () => {
  it("reads MARINA_OBLIGATIONS_REVIEW and its rule budget", () => {
    expect(obligationsReviewMode({})).toBe("off");
    expect(obligationsReviewMode({ MARINA_OBLIGATIONS_REVIEW: "junk" })).toBe("off");
    expect(obligationsReviewMode({ MARINA_OBLIGATIONS_REVIEW: "Observe" })).toBe("observe");
    expect(obligationsReviewMode({ MARINA_OBLIGATIONS_REVIEW: "on" })).toBe("on");
    expect(reviewRuleBytes({})).toBe(3000);
    expect(reviewRuleBytes({ MARINA_OBLIGATIONS_REVIEW_RULE_BYTES: "0" })).toBe(0);
    expect(reviewRuleBytes({ MARINA_OBLIGATIONS_REVIEW_RULE_BYTES: "-5" })).toBe(3000);
  });

  it("picks the questions that apply: order ≥ 2 open, requested only with requests, permitted only with rules", () => {
    const self = ledgerWith(); // a self-directed agent: no requests at all
    expect(reviewQuestions(reviewState(self), self, { hasRules: false })).toEqual(
      q({ evidence: true }),
    );
    const one = ledgerWith("Close card 4417");
    expect(reviewQuestions(reviewState(one), one, { hasRules: true })).toEqual(
      q({ evidence: true, requested: true, permitted: true }),
    );
    const two = ledgerWith("Close card 4417", "Refund fee");
    const s2 = reviewState(two);
    expect(reviewQuestions(s2, two, { hasRules: false })).toEqual(
      q({ order: true, evidence: true, requested: true }),
    );
    markNamed(s2, q({ order: true, evidence: true, requested: true }));
    expect(reviewQuestions(s2, two, { hasRules: false })).toBeUndefined();
    const s3 = reviewState(two);
    s3.reviews = MAX_REVIEWS;
    expect(reviewQuestions(s3, two, { hasRules: true })).toBeUndefined();
  });

  it("answers through a decision provider (noul) or the chat model (JSON); a missing answer is undefined", async () => {
    const l = ledgerWith("Close card 4417", "Refund fee");
    const input = { requests: l.obligations, calls: [call], draft: "", recent: [] };
    const provider: DecisionProvider = {
      kind: "test",
      model: "t",
      ask: async (req) => ({
        answers: Object.fromEntries(
          Object.keys(req.questions).map((k) => [
            k,
            { type: "noul" as const, noul: k === "requested" ? 0.9 : 0.1 },
          ]),
        ),
        model: "t",
        provider: "test",
        latencyMs: 1,
      }),
    };
    expect(await reviewWrite(input, q({ order: true, requested: true }), { provider })).toEqual(
      q({ requested: true }),
    );
    expect(
      await reviewWrite(input, q({ permitted: true, evidence: true }), {
        complete: async () => '{"permitted":"yes","evidence":"no"}',
      }),
    ).toEqual(q({ permitted: true }));
    expect(
      await reviewWrite(input, q({ order: true, evidence: true }), {
        complete: async () => '{"order":"yes"}',
      }),
    ).toBeUndefined();
    expect(
      await reviewWrite(input, q({ evidence: true }), {
        complete: async () => {
          throw new Error("down");
        },
      }),
    ).toBeUndefined();
  });

  it("records verdicts, names each kind once, and labels", () => {
    const s = reviewState(newLedger("k", 0));
    expect(recordReview(s, undefined)).toEqual(q({}));
    expect(s).toMatchObject({ reviews: 1, unjudged: 1 });
    expect(recordReview(s, q({ order: true, permitted: true }))).toEqual(
      q({ order: true, permitted: true }),
    );
    markNamed(s, q({ order: true, permitted: true }));
    expect(recordReview(s, q({ order: true, requested: true }))).toEqual(q({ requested: true }));
    expect(reviewFlagCount(s)).toBe(4);
    expect(s.nudges).toBe(1);
    expect(reviewLabel(undefined)).toBe("review-unjudged");
    expect(reviewLabel(q({}))).toBe("review-clear");
    expect(reviewLabel(q({ evidence: true, permitted: true }))).toBe("review-evidence+permitted");
  });

  it("writes a note that names each concern, never a fix, and allows the same call", () => {
    const l = ledgerWith("Close card 4417", "Refund fee");
    const input = { requests: l.obligations, calls: [call], draft: "", recent: [] };
    const note = reviewNote(input, q({ order: true, requested: true }));
    expect(note).toContain('close_card({"card_id":"4417"})');
    expect(note).toContain("o2 [open]: Refund fee");
    expect(note).toContain("does not appear to be something the user asked for or approved");
    expect(note).not.toContain("Rules:");
    expect(note).toContain("make it again unchanged");
  });

  it("selects rule passages that name the call, within the budget", () => {
    const transcript = [
      {
        role: "system",
        content:
          "Cards may be closed only after any balance is paid. A card with a pending dispute cannot be closed.",
      },
      { role: "system", content: "Orders ship within two business days of payment." },
      { role: "user", content: "Please close card 4417." },
    ];
    const rules = reviewRules(transcript, [call], 3000);
    expect(rules.join(" ")).toContain("closed");
    expect(rules.join(" ")).not.toContain("ship");
    expect(reviewRules(transcript, [call], 0)).toEqual([]);
    expect(REVIEW_QUESTION.permitted).toContain("RULE PASSAGES");
  });

  it("reads recent tool results from OpenAI-style and pi transcripts", () => {
    const openai = recentToolResults([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "a", function: { name: "get_card" } }],
      },
      { role: "tool", tool_call_id: "a", content: '{"status":"active"}' },
    ]);
    expect(openai).toEqual([{ name: "get_card", ok: true, result: '{"status":"active"}' }]);
    const pi = recentToolResults([
      {
        role: "toolResult",
        toolName: "get_balance",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      },
    ]);
    expect(pi).toEqual([{ name: "get_balance", ok: false, result: "boom" }]);
  });
});

describe("pre-write review (agent loop)", () => {
  async function agentWith(review: "off" | "observe" | "on", answer: string) {
    const replies = [
      '{"add":[{"request":1,"what":"Close card 4417","tools":["close_card"]}],"cancel":[]}',
      answer,
    ];
    let i = 0;
    const ob = new AgentObligations({
      complete: async () => replies[Math.min(i++, replies.length - 1)]!,
      mode: () => "on",
      reviewMode: () => review,
      reviewRuleBytes: () => 0,
      now: () => 0,
    });
    ob.noteRequest("Please close card 4417.");
    await ob.refresh([{ name: "close_card", write: true }]);
    return ob;
  }

  it("is inert when off", async () => {
    const ob = await agentWith("off", '{"evidence":"yes","requested":"no"}');
    expect(await ob.reviewWrite("close_card", { card_id: "4417" }, [])).toBeUndefined();
  });

  it("counts in observe without refusing", async () => {
    const ob = await agentWith("observe", '{"evidence":"yes","requested":"no"}');
    expect(await ob.reviewWrite("close_card", { card_id: "4417" }, [])).toEqual({
      label: "review-evidence",
    });
    expect(ob.summary().reviews).toBe(1);
  });

  it("refuses once under on; named kinds are not asked again", async () => {
    const ob = await agentWith("on", '{"evidence":"yes","requested":"yes"}');
    const first = await ob.reviewWrite("close_card", { card_id: "4417" }, []);
    expect(first?.refusal).toContain("[Marina pre-write review");
    expect(first?.label).toBe("review-evidence+requested");
    const second = await ob.reviewWrite("close_card", { card_id: "4417" }, []);
    expect(second).toBeUndefined(); // both named, one open request, no rules: nothing left to ask
    expect(ob.summary().reviewNudges).toBe(1);
  });
});

describe("review selection (auto) and ceilings", () => {
  it("parses modes and caps a choice at the operator's ceiling", () => {
    expect(parseReviewMode(" Auto ")).toBe("auto");
    expect(parseReviewMode("max")).toBeUndefined();
    expect(obligationsReviewMode({ MARINA_OBLIGATIONS_REVIEW: "auto" })).toBe("auto");
    expect(capReviewMode(undefined, "auto")).toBe("auto");
    expect(capReviewMode("observe", "on")).toBe("observe");
    expect(capReviewMode("on", "auto")).toBe("auto");
    expect(capReviewMode("auto", "observe")).toBe("observe");
    expect(capReviewMode("on", "off")).toBe("off");
  });

  it("decides once per conversation: shape skips with no requests and no rules; else one question", async () => {
    let asked = 0;
    const judge = (answer: string) => ({
      complete: async () => {
        asked++;
        return answer;
      },
    });
    const empty = reviewState(newLedger("k", 0));
    expect(
      await selectReview(
        empty,
        { requests: [], calls: [call], rules: [] },
        judge('{"warranted":"yes"}'),
      ),
    ).toEqual({ engaged: false, by: "shape" });
    expect(asked).toBe(0);
    const l = ledgerWith("Close card 4417");
    const s = reviewState(l);
    const input = { requests: l.obligations, calls: [call], rules: [] };
    expect(await selectReview(s, input, judge('{"warranted":"yes"}'))).toEqual({
      engaged: true,
      by: "judge",
    });
    expect(await selectReview(s, input, judge('{"warranted":"no"}'))).toEqual({
      engaged: true,
      by: "judge",
    }); // cached
    expect(asked).toBe(1);
    const s2 = reviewState(ledgerWith("Close card 4417"));
    expect(await selectReview(s2, input, judge("not json"))).toEqual({
      engaged: false,
      by: "unjudged",
    });
    expect(reviewEngaged("on", undefined)).toBe(true);
    expect(reviewEngaged("auto", { engaged: false, by: "judge" })).toBe(false);
    expect(reviewEngaged("auto", { engaged: true, by: "judge" })).toBe(true);
    expect(reviewEngaged("observe", { engaged: true, by: "judge" })).toBe(false);
  });

  it("the agent loop stays out when auto does not select the task, and reviews when it does", async () => {
    async function agent(select: string, review: string) {
      const replies = [
        '{"add":[{"request":1,"what":"Close card 4417","tools":["close_card"]}],"cancel":[]}',
        select,
        review,
      ];
      let i = 0;
      const ob = new AgentObligations({
        complete: async () => replies[Math.min(i++, replies.length - 1)]!,
        mode: () => "on",
        reviewMode: () => "auto",
        reviewRuleBytes: () => 0,
        now: () => 0,
      });
      ob.noteRequest("Please close card 4417.");
      await ob.refresh([{ name: "close_card", write: true }]);
      return ob;
    }
    const out = await agent('{"warranted":"no"}', '{"evidence":"yes","requested":"no"}');
    expect(await out.reviewWrite("close_card", { card_id: "4417" }, [])).toEqual({
      label: "review-not-selected",
    });
    const engaged = await agent('{"warranted":"yes"}', '{"evidence":"yes","requested":"no"}');
    const r = await engaged.reviewWrite("close_card", { card_id: "4417" }, []);
    expect(r?.label).toBe("review-evidence");
    expect(r?.refusal).toContain("[Marina pre-write review");
  });
});
