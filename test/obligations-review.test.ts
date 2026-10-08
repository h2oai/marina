// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { DecisionProvider } from "../src/decisions/types";
import { AgentObligations } from "../src/obligations/agent";
import { applyExtraction, newLedger, openObligations } from "../src/obligations/ledger";
import {
  MAX_REVIEWS,
  markNamed,
  obligationsReviewMode,
  recentToolResults,
  recordReview,
  reviewLabel,
  reviewNote,
  reviewQuestions,
  reviewState,
  reviewWrite,
} from "../src/obligations/review";

function ledgerWith(...what: string[]) {
  const l = newLedger("k", 0);
  applyExtraction(l, 1, { add: what.map((w) => ({ what: w })), cancel: [] }, new Set(), 0);
  return l;
}

const call = { name: "close_card", args: { card_id: "4417" } };

describe("pre-write review (pure)", () => {
  it("reads MARINA_OBLIGATIONS_REVIEW: off by default, observe and on when set", () => {
    expect(obligationsReviewMode({})).toBe("off");
    expect(obligationsReviewMode({ MARINA_OBLIGATIONS_REVIEW: "junk" })).toBe("off");
    expect(obligationsReviewMode({ MARINA_OBLIGATIONS_REVIEW: "Observe" })).toBe("observe");
    expect(obligationsReviewMode({ MARINA_OBLIGATIONS_REVIEW: "on" })).toBe("on");
  });

  it("asks order only with two or more open requests, each kind until named, within a budget", () => {
    const one = ledgerWith("Close card 4417");
    const s1 = reviewState(one);
    expect(reviewQuestions(s1, openObligations(one))).toEqual({ order: false, evidence: true });
    const two = ledgerWith("Close card 4417", "Refund fee");
    const s2 = reviewState(two);
    expect(reviewQuestions(s2, openObligations(two))).toEqual({ order: true, evidence: true });
    markNamed(s2, { order: true, evidence: false });
    expect(reviewQuestions(s2, openObligations(two))).toEqual({ order: false, evidence: true });
    markNamed(s2, { order: false, evidence: true });
    expect(reviewQuestions(s2, openObligations(two))).toBeUndefined();
    const s3 = reviewState(ledgerWith("a", "b"));
    s3.reviews = MAX_REVIEWS;
    expect(reviewQuestions(s3, openObligations(ledgerWith("a", "b")))).toBeUndefined();
  });

  it("answers through a decision provider (noul) or the chat model (JSON); failure is undefined", async () => {
    const open = openObligations(ledgerWith("Close card 4417", "Refund fee"));
    const input = { open, calls: [call], draft: "", recent: [] };
    const provider: DecisionProvider = {
      kind: "test",
      model: "t",
      ask: async (req) => ({
        answers: Object.fromEntries(
          Object.keys(req.questions).map((k) => [
            k,
            { type: "noul" as const, noul: k === "order" ? 0.8 : 0.2 },
          ]),
        ),
        model: "t",
        provider: "test",
        latencyMs: 1,
      }),
    };
    expect(await reviewWrite(input, { order: true, evidence: true }, { provider })).toEqual({
      order: true,
      evidence: false,
    });
    expect(
      await reviewWrite(
        input,
        { order: false, evidence: true },
        { complete: async () => '{"evidence":"yes"}' },
      ),
    ).toEqual({ order: false, evidence: true });
    expect(
      await reviewWrite(
        input,
        { order: true, evidence: true },
        { complete: async () => '{"order":"maybe"}' },
      ),
    ).toBeUndefined();
    expect(
      await reviewWrite(
        input,
        { order: false, evidence: true },
        {
          complete: async () => {
            throw new Error("down");
          },
        },
      ),
    ).toBeUndefined();
  });

  it("records verdicts, names each kind once, and labels", () => {
    const s = reviewState(newLedger("k", 0));
    expect(recordReview(s, undefined)).toEqual({ order: false, evidence: false });
    expect(s).toMatchObject({ reviews: 1, unjudged: 1 });
    expect(recordReview(s, { order: true, evidence: true })).toEqual({
      order: true,
      evidence: true,
    });
    markNamed(s, { order: true, evidence: true });
    expect(recordReview(s, { order: true, evidence: true })).toEqual({
      order: false,
      evidence: false,
    });
    expect(s).toMatchObject({ reviews: 3, orderRisks: 2, evidenceGaps: 2, nudges: 1 });
    expect(reviewLabel(undefined)).toBe("review-unjudged");
    expect(reviewLabel({ order: false, evidence: false })).toBe("review-clear");
    expect(reviewLabel({ order: true, evidence: true })).toBe("review-order+evidence");
  });

  it("writes a note that names the concern, never a fix, and allows the same call", () => {
    const open = openObligations(ledgerWith("Close card 4417", "Refund fee"));
    const note = reviewNote(
      { open, calls: [call], draft: "", recent: [] },
      { order: true, evidence: false },
    );
    expect(note).toContain('close_card({"card_id":"4417"})');
    expect(note).toContain("o2: Refund fee");
    expect(note).not.toContain("Evidence:");
    expect(note).toContain("make it again unchanged");
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
      now: () => 0,
    });
    ob.noteRequest("Please close card 4417.");
    await ob.refresh([{ name: "close_card", write: true }]);
    return ob;
  }

  it("is inert when off", async () => {
    const ob = await agentWith("off", '{"evidence":"yes"}');
    expect(await ob.reviewWrite("close_card", { card_id: "4417" }, [])).toBeUndefined();
  });

  it("counts in observe without refusing", async () => {
    const ob = await agentWith("observe", '{"evidence":"yes"}');
    expect(await ob.reviewWrite("close_card", { card_id: "4417" }, [])).toEqual({
      label: "review-evidence",
    });
    expect(ob.summary().reviews).toBe(1);
  });

  it("refuses once under on; the same concern is not named again", async () => {
    const ob = await agentWith("on", '{"evidence":"yes"}');
    const first = await ob.reviewWrite("close_card", { card_id: "4417" }, []);
    expect(first?.refusal).toContain("[Marina pre-write review");
    const second = await ob.reviewWrite("close_card", { card_id: "4417" }, []);
    expect(second).toBeUndefined(); // evidence named, one open request: nothing left to ask
    expect(ob.summary().reviewNudges).toBe(1);
  });
});
