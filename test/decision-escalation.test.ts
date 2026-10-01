// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `marina/auto` second opinions: a caller's decision boundary (the gate asks
// only when an answer could flip its verdict), the second-opinion deadline,
// and the recorded outcome.

import { describe, expect, it } from "bun:test";
import {
  autoEngine,
  SECOND_OPINION_TIMEOUT_MS,
  secondOpinionTimeoutMs,
} from "../src/decisions/engines";
import { gateNeedsSecondOpinion, gateToolCall } from "../src/decisions/gate";
import {
  DEFAULT_GATE_POLICY,
  decideGate,
  GATE_QUESTIONS,
  GATE_QUESTIONS_WITH_AUTHORIZATION,
} from "../src/decisions/policy";
import { noul } from "../src/decisions/questions";
import type { DecisionAnswer, DecisionProvider, DecisionRequest } from "../src/decisions/types";

type Scores = Record<string, number>;

/** A fake backend answering every noul question with `scores[id] ?? fallback`. */
function backend(
  name: string,
  scores: Scores | (() => Scores),
  opts: { calibrated?: boolean; fail?: boolean; delayMs?: number } = {},
) {
  const calls: Array<{ request: DecisionRequest; signal?: AbortSignal }> = [];
  const provider: DecisionProvider = {
    kind: name,
    model: name,
    ...(opts.calibrated === undefined ? {} : { calibrated: opts.calibrated }),
    async ask(request, signal) {
      calls.push({ request, signal });
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }
      if (opts.fail) throw new Error(`${name} down`);
      const s = typeof scores === "function" ? scores() : scores;
      const answers: Record<string, DecisionAnswer> = {};
      for (const id of Object.keys(request.questions)) {
        if (s[id] !== undefined) answers[id] = { type: "noul", noul: s[id]! };
      }
      return { answers, model: name, provider: name, latencyMs: 1 };
    },
  };
  return { provider, calls };
}

const all = (p: number): Scores => ({
  destructive: p,
  irreversible: p,
  outsideScope: p,
  unauthorized: p,
});

describe("secondOpinionTimeoutMs", () => {
  it("defaults, accepts 0 as no bound, and ignores junk", () => {
    expect(secondOpinionTimeoutMs({})).toBe(SECOND_OPINION_TIMEOUT_MS);
    expect(secondOpinionTimeoutMs({ MARINA_DECISION_SECOND_OPINION_TIMEOUT_MS: "0" })).toBe(0);
    expect(secondOpinionTimeoutMs({ MARINA_DECISION_SECOND_OPINION_TIMEOUT_MS: "750" })).toBe(750);
    expect(secondOpinionTimeoutMs({ MARINA_DECISION_SECOND_OPINION_TIMEOUT_MS: "soon" })).toBe(
      SECOND_OPINION_TIMEOUT_MS,
    );
    expect(secondOpinionTimeoutMs({ MARINA_DECISION_SECOND_OPINION_TIMEOUT_MS: "-5" })).toBe(
      SECOND_OPINION_TIMEOUT_MS,
    );
  });
});

describe("marina/auto without a caller boundary (router, verifier, /v1/decisions)", () => {
  const Q = { urgent: noul("Is this urgent?") };

  it("a sure primary answers alone", async () => {
    const jev = backend("jev", { urgent: 0.95 });
    const second = backend("second", { urgent: 0.1 });
    const r = await autoEngine(jev.provider, second.provider, 1000).ask({
      state: "s",
      questions: Q,
    });
    expect(second.calls).toHaveLength(0);
    expect(r.escalated).toBe(false);
    expect(r.secondOpinion).toBeUndefined();
  });

  it("any unsure answer escalates, as before", async () => {
    const jev = backend("jev", { urgent: 0.45 });
    const second = backend("second", { urgent: 0.9 });
    const r = await autoEngine(jev.provider, second.provider, 1000).ask({
      state: "s",
      questions: Q,
    });
    expect(second.calls).toHaveLength(1);
    expect(r).toMatchObject({ escalated: true, secondOpinion: "used" });
    expect(r.members).toEqual(["jev", "second"]);
  });
});

describe("the second-opinion deadline", () => {
  const Q = { urgent: noul("Is this urgent?") };

  it("a slow second opinion is cut off and aborted; the primary's answer stands", async () => {
    const jev = backend("jev", { urgent: 0.45 });
    const slow = backend("slow", { urgent: 0.9 }, { delayMs: 5_000 });
    const started = performance.now();
    const r = await autoEngine(jev.provider, slow.provider, 30).ask({ state: "s", questions: Q });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(r).toMatchObject({ escalated: true, secondOpinion: "timeout" });
    expect((r.answers.urgent as { noul: number }).noul).toBe(0.45);
    expect(r.members).toEqual(["jev"]);
    expect(slow.calls[0]!.signal?.aborted).toBe(true);
  });

  it("0 means no bound", async () => {
    const jev = backend("jev", { urgent: 0.45 });
    const slow = backend("slow", { urgent: 0.9 }, { delayMs: 60 });
    const r = await autoEngine(jev.provider, slow.provider, 0).ask({ state: "s", questions: Q });
    expect(r.secondOpinion).toBe("used");
  });

  it("a failed second opinion leaves the primary's answer", async () => {
    const jev = backend("jev", { urgent: 0.45 });
    const down = backend("down", {}, { fail: true });
    const r = await autoEngine(jev.provider, down.provider, 1000).ask({ state: "s", questions: Q });
    expect(r).toMatchObject({ escalated: true, secondOpinion: "failed" });
    expect(r.members).toEqual(["jev"]);
  });

  it("a primary outage is NOT cut short: the fallback is then the only judge", async () => {
    const jev = backend("jev", {}, { fail: true });
    const slow = backend("slow", { urgent: 0.2 }, { delayMs: 80 });
    const r = await autoEngine(jev.provider, slow.provider, 10).ask({ state: "s", questions: Q });
    expect(r).toMatchObject({ escalated: true, secondOpinion: "outage" });
    expect(r.members).toEqual(["slow"]);
  });

  it("the caller's own abort still reaches the second opinion", async () => {
    const jev = backend("jev", { urgent: 0.45 });
    const slow = backend("slow", { urgent: 0.9 }, { delayMs: 5_000 });
    const controller = new AbortController();
    const pending = autoEngine(jev.provider, slow.provider, 0).ask(
      { state: "s", questions: Q },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    const r = await pending;
    // Aborted ⇒ the second opinion failed ⇒ the primary's answer stands.
    expect(r.secondOpinion).toBe("failed");
    expect(slow.calls[0]!.signal?.aborted).toBe(true);
  });
});

describe("gateNeedsSecondOpinion", () => {
  const action = (a: Record<string, DecisionAnswer>, risk?: "mutate") =>
    decideGate(a, DEFAULT_GATE_POLICY, GATE_QUESTIONS_WITH_AUTHORIZATION, risk ? { risk } : {})
      .action;
  const answers = (s: Scores) =>
    Object.fromEntries(
      Object.entries(s).map(([id, p]) => [id, { type: "noul" as const, noul: p }]),
    );

  it("far from every cut point ⇒ no second opinion, even near 0.5", () => {
    expect(
      gateNeedsSecondOpinion(answers(all(0.4)), GATE_QUESTIONS_WITH_AUTHORIZATION, action),
    ).toBe(false);
  });

  it("near the hold threshold ⇒ a second opinion", () => {
    expect(
      gateNeedsSecondOpinion(
        answers({ ...all(0.1), destructive: 0.58 }),
        GATE_QUESTIONS_WITH_AUTHORIZATION,
        action,
      ),
    ).toBe(true);
  });

  it("an unanswered question ⇒ a second opinion", () => {
    const { unauthorized: _skip, ...three } = all(0.1);
    expect(gateNeedsSecondOpinion(answers(three), GATE_QUESTIONS_WITH_AUTHORIZATION, action)).toBe(
      true,
    );
  });

  it("on a routine call the context question only matters near its stricter bar", () => {
    const routine = (a: Record<string, DecisionAnswer>) => action(a, "mutate");
    const at = (p: number) => answers({ ...all(0.1), unauthorized: p });
    expect(gateNeedsSecondOpinion(at(0.55), GATE_QUESTIONS_WITH_AUTHORIZATION, routine)).toBe(
      false,
    );
    expect(gateNeedsSecondOpinion(at(0.8), GATE_QUESTIONS_WITH_AUTHORIZATION, routine)).toBe(true);
  });
});

describe("the gate on marina/auto, end to end", () => {
  const call = (jevScores: Scores, secondScores: Scores = all(0.05), ms = 1000) => {
    const jev = backend("jev", jevScores);
    const second = backend("second", secondScores, { calibrated: false });
    const provider = autoEngine(jev.provider, second.provider, ms);
    return { second, run: () => gateToolCall(provider, "marina_command", { command: "note x" }) };
  };

  it("an unsure Jev far from the cut points is allowed without waiting", async () => {
    const { second, run } = call(all(0.4));
    const d = await run();
    expect(d.action).toBe("allow");
    expect(second.calls).toHaveLength(0);
    expect(d.escalated).toBe(false);
  });

  it("an unsure Jev near the hold threshold gets a second opinion", async () => {
    const { second, run } = call({ ...all(0.1), destructive: 0.6 });
    const d = await run();
    expect(second.calls).toHaveLength(1);
    expect(d.escalated).toBe(true);
    expect(d.secondOpinion).toBe("used");
  });

  it("a confident Jev block is never second-guessed", async () => {
    const { second, run } = call({ ...all(0.1), destructive: 0.95 });
    const d = await run();
    expect(d.action).toBe("block");
    expect(second.calls).toHaveLength(0);
  });

  it("the escalation boundary is never sent to a backend", async () => {
    const { second, run } = call({ ...all(0.1), destructive: 0.6 });
    await run();
    const sent = JSON.parse(JSON.stringify(second.calls[0]!.request)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["questions", "state"]);
  });

  it("without intent the three risk questions decide (no unauthorized)", async () => {
    const { run } = call(all(0.4));
    const d = await run();
    expect(Object.keys(d.signals).sort()).toEqual(Object.keys(GATE_QUESTIONS).sort());
  });
});
