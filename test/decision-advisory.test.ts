// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { advisoryMode, advisoryProviders, askAdvisory } from "../src/decisions/advisory";
import { choice } from "../src/decisions/questions";
import { DecisionError, type DecisionProvider } from "../src/decisions/types";
import { recordResolved, settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";

const request = {
  state: { private: "never in a receipt" },
  questions: {
    route: choice("Next step", { read: "Read", answer: "Answer" }),
  },
};

function judge(model = "fake", ask?: DecisionProvider["ask"]): DecisionProvider {
  return {
    kind: "test",
    model,
    calibrated: false,
    ask:
      ask ??
      (async () => ({
        model,
        provider: "test",
        calibrated: false,
        latencyMs: 1,
        answers: { route: { type: "choice", choice: "read" } },
      })),
  };
}

describe("bounded advisory decisions", () => {
  it("defaults off, allows disabling the fallback, and has no required backend", async () => {
    expect(advisoryMode(undefined)).toBe("off");
    expect(advisoryMode("unknown")).toBe("off");
    expect(advisoryProviders({ env: { MARINA_ADVISORY_FALLBACK_MODEL: "none" } })).toEqual([]);
    const r = await askAdvisory("research", "observe", request, { providers: [] });
    expect(r.result).toBeUndefined();
    expect(r.receipt).toMatchObject({ status: "unavailable", attempts: 0, applied: false });
  });

  it("uses Marina's classifier without Jev and records the actual served model", async () => {
    let calls = 0;
    const r = await askAdvisory("research", "on", request, {
      env: {},
      engineDeps: {
        token: async () => "test-token",
        selfBaseUrl: "http://marina.test/v1",
        fetch: async (url, init) => {
          calls++;
          expect(url).toBe("http://marina.test/v1/chat/completions");
          const body = JSON.parse(String(init.body));
          expect(body.model).toBe("marina/default");
          return Response.json({
            model: "served-model",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    answers: { route: { type: "choice", choice: "read" } },
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.001 },
          });
        },
      },
    });
    expect(calls).toBe(1);
    expect(r.receipt).toMatchObject({
      status: "answered",
      model: "marina/classifier:served-model",
      providerCalibrated: false,
      calibration: "unmeasured",
    });
    expect(JSON.stringify(r.receipt)).not.toContain("never in a receipt");
  });

  it("falls back on a failed or incomplete primary", async () => {
    for (const primary of [
      judge("synchronous-failure", () => {
        throw new Error("private configuration error");
      }),
      judge("broken", async () => {
        throw new Error("private upstream error");
      }),
      judge("incomplete", async () => ({
        model: "incomplete",
        provider: "test",
        latencyMs: 1,
        answers: {},
      })),
    ]) {
      const r = await askAdvisory("research", "on", request, {
        providers: [primary, judge("fallback")],
      });
      expect(r.receipt).toMatchObject({
        status: "answered",
        fallback: true,
        attempts: 2,
        model: "fallback",
      });
      expect(JSON.stringify(r.receipt)).not.toContain("private upstream error");
    }
  });

  it("bounds a provider that ignores cancellation and reserves time for fallback", async () => {
    let primarySignal: AbortSignal | undefined;
    const hanging = judge("hang", async (_request, signal) => {
      primarySignal = signal;
      return new Promise(() => undefined);
    });
    const r = await askAdvisory("research", "on", request, {
      providers: [hanging, judge()],
      timeoutMs: 200,
    });
    expect(primarySignal?.aborted).toBe(true);
    expect(r.receipt).toMatchObject({ status: "answered", fallback: true, attempts: 2 });
  });

  it("cancels immediately without billing a fallback", async () => {
    const abort = new AbortController();
    let fallbackCalls = 0;
    const r = await askAdvisory("research", "on", request, {
      signal: abort.signal,
      providers: [
        judge("first", async () => {
          abort.abort();
          return new Promise(() => undefined);
        }),
        judge("fallback", async () => {
          fallbackCalls++;
          throw new Error("should not run");
        }),
      ],
    });
    expect(r.receipt.reason).toBe("aborted");
    expect(fallbackCalls).toBe(0);
  });

  it("does not bypass a spend refusal and preserves an unavailable result", async () => {
    const first = judge("first", async () => {
      throw new DecisionError("cap", "spend_cap");
    });
    const r = await askAdvisory("research", "on", request, { providers: [first, judge()] });
    expect(r.receipt).toMatchObject({ reason: "spend_cap", attempts: 1, applied: false });
    const capped = await askAdvisory("research", "on", request, {
      providers: [judge()],
      spendCheck: () => "cap",
    });
    expect(capped.receipt.attempts).toBe(0);
  });

  it("accounts for reported costs across attempts without double counting local model turns", async () => {
    let spend = 0;
    const paid = judge("paid", async () => ({
      model: "paid",
      provider: "test",
      latencyMs: 1,
      costUsd: 0.01,
      answers: { route: { type: "choice", choice: "read" } },
    }));
    const incomplete = judge("invalid", async () => ({
      model: "invalid",
      provider: "test",
      latencyMs: 1,
      costUsd: 0.02,
      answers: {},
    }));
    const r = await askAdvisory("research", "on", request, {
      providers: [incomplete, paid],
      onCost: (usd) => {
        spend += usd;
      },
    });
    expect(spend).toBeCloseTo(0.03);
    expect(r.receipt.costUsd).toBeCloseTo(0.03);
    expect(r.receipt.costComplete).toBe(true);
    await askAdvisory("research", "on", request, {
      providers: [paid],
      localFallback: paid,
      onCost: (usd) => {
        spend += usd;
      },
    });
    expect(spend).toBeCloseTo(0.03);
  });

  it("fails open when both backends fail and does not call an opinion calibrated", async () => {
    const fail = judge("broken", async () => {
      throw new Error("down");
    });
    const r = await askAdvisory("research", "observe", request, { providers: [fail, fail] });
    expect(r.receipt).toMatchObject({ status: "unavailable", action: "baseline", applied: false });
    expect(r.receipt.calibration).toBe("unmeasured");
  });
});

describe("decision receipt attribution", () => {
  it("keeps account scopes, explicitly links outcomes, and erases with the account", async () => {
    const db = new MarinaDB(":memory:");
    try {
      db.createUser({ id: "u_ada", name: "Ada" });
      db.createUser({ id: "u_bea", name: "Bea" });
      const { receipt } = await askAdvisory("research", "observe", request, {
        providers: [judge()],
      });
      receipt.createdAt = 1;
      db.recordDecisionReceipt("Ada", "request:1", receipt);
      db.recordDecisionReceipt("Ada", "request:1", receipt);
      expect(db.listDecisionReceipts("Ada")).toHaveLength(1);
      expect(db.listDecisionReceipts("Bea")).toEqual([]);
      expect(db.listDecisionReceipts("u_ada")).toEqual([]);
      const outcome = recordResolved(db, {
        subject: "request:1",
        source: "test",
        kind: "request",
        domain: "tools",
        owner: "Ada",
        succeeded: true,
        basis: "mechanical",
        resolvedAt: 2,
        decisionIds: [receipt.id],
      });
      await settleDelivery(db);
      expect(db.decisionOutcomeIds("Ada", receipt.id)).toEqual([outcome.id]);
      expect(db.decisionOutcomeIds("Bea", receipt.id)).toEqual([]);
      expect(db.linkDecisionOutcome("Bea", receipt.id, outcome.id)).toBe(false);
      db.renameUser("u_ada", "Ada2");
      expect(db.listDecisionReceipts("Ada2")).toHaveLength(1);
      db.deleteUser("u_ada");
      expect(db.listDecisionReceipts("u_ada")).toEqual([]);
      expect(
        db.memoryRepository().raw.query("SELECT count(*) AS n FROM decision_receipts").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
