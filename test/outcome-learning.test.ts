// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider, DecisionRequest } from "../src/decisions/types";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import {
  candidateFromOutcome,
  judgeLesson,
  type Lesson,
  leaksCase,
  memoryLessonSink,
  type Outcome,
  recordOutcome,
  recordOutcomes,
  selectServed,
  visibleAt,
} from "../src/learning/outcomes";
import {
  enableOutcomeLearning,
  lessonJudgeFromEnv,
  lessonSinkFor,
  lessonWriterFromEnv,
  noteOutcome,
  outcomeLearningEnabled,
  recallLessons,
  settleOutcomes,
} from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  domain: "code",
  source: "code:verify",
  succeeded: false,
  resolvedAt: "2026-09-10T00:00:00.000Z",
  attempted: "verify a change with pytest",
  detail: "failed at pytest -q (exit 1)",
  ...over,
});

const lesson = (text: string, resolvedAt: string, over: Partial<Lesson> = {}): Lesson => ({
  domain: "code",
  text,
  kind: "failure",
  trust: "trusted",
  resolvedAt,
  source: "code:verify",
  ...over,
});

/** A provider that answers every noul question with the given probabilities. */
function judge(
  answers: Record<string, number>,
  opts: { calibrated?: boolean; fail?: boolean } = {},
): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    kind: "test",
    model: "test/jev",
    calibrated: opts.calibrated ?? true,
    requests,
    async ask(request) {
      requests.push(request);
      if (opts.fail) throw new Error("backend down");
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: answers[k] ?? 0.9 }]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        costUsd: 0.0001,
        calibrated: opts.calibrated ?? true,
      } as never;
    },
  };
}

const writer = (reply: string) => ({
  name: "test-writer",
  async complete() {
    return reply;
  },
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("outcome learning: candidates", () => {
  it("builds a mechanical candidate and adds the writer's category and rule", async () => {
    const bare = await candidateFromOutcome(outcome());
    expect(bare.text).toContain("[lesson:code] failure");
    expect(bare.trust).toBe("unverified");
    const ruled = await candidateFromOutcome(
      outcome(),
      writer('{"category":"python test run","rule":"Run the project runner, not bun."}'),
    );
    expect(ruled.category).toBe("python test run");
    expect(ruled.text).toContain("rule: Run the project runner, not bun.");
  });

  it("a failing writer still yields the mechanical candidate", async () => {
    const c = await candidateFromOutcome(outcome(), {
      name: "x",
      async complete() {
        throw new Error("down");
      },
    });
    expect(c.text).toContain("[lesson:code]");
    expect(c.rule).toBeUndefined();
  });

  it("the leak check catches a lesson that quotes the case text", () => {
    const ctx =
      "Who will win the final between the Northfield Rovers and the Eastport Comets tomorrow";
    expect(
      leaksCase({ text: "rule: the Northfield Rovers and the Eastport Comets favour home" }, ctx),
    ).toBe(true);
    expect(leaksCase({ text: "rule: check bookmaker odds before picking a winner" }, ctx)).toBe(
      false,
    );
  });
});

describe("outcome learning: Jev gating", () => {
  it("a calibrated judge that clears every bar trusts the lesson", async () => {
    const c = await candidateFromOutcome(outcome());
    const v = await judgeLesson(c, outcome(), judge({}));
    expect(v.trust).toBe("trusted");
    expect(v.judge).toBe("test/jev");
  });

  it("one question below its bar rejects the lesson", async () => {
    const c = await candidateFromOutcome(outcome());
    const v = await judgeLesson(c, outcome(), judge({ leak_free: 0.4 }));
    expect(v.trust).toBe("rejected");
    expect(v.reason).toContain("leak_free");
  });

  it("decisions off or an outage never promote: unverified", async () => {
    const c = await candidateFromOutcome(outcome());
    expect((await judgeLesson(c, outcome(), undefined)).trust).toBe("unverified");
    expect((await judgeLesson(c, outcome(), judge({}, { fail: true }))).trust).toBe("unverified");
  });

  it("an uncalibrated judge uses one cut at 0.5 and is labelled", async () => {
    const c = await candidateFromOutcome(outcome());
    // 0.55 is below the calibrated `grounded` bar (0.6) but above the single cut.
    const v = await judgeLesson(c, outcome(), judge({ grounded: 0.55 }, { calibrated: false }));
    expect(v.trust).toBe("trusted");
    expect(v.judge).toContain("(uncalibrated)");
    expect(v.reason).toContain("uncalibrated");
  });

  it("a mechanical leak is rejected before the judge is asked", async () => {
    const o = outcome({ privateContext: "the secret answer is the purple elephant on the left" });
    const j = judge({});
    const v = await judgeLesson(
      { ...(await candidateFromOutcome(o)), text: "rule: the purple elephant on the left wins" },
      o,
      j,
    );
    expect(v.trust).toBe("rejected");
    expect(j.requests).toHaveLength(0);
  });

  it("recordOutcome writes trusted, unverified and rejected lessons; recall serves only the first two", async () => {
    const sink = memoryLessonSink();
    await recordOutcome({ sink, judge: judge({}) }, outcome({ detail: "pytest trusted" }));
    await recordOutcome({ sink }, outcome({ detail: "pytest unverified" }));
    await recordOutcome(
      { sink, judge: judge({ general: 0.1 }) },
      outcome({ detail: "pytest rejected" }),
    );
    expect(sink.all().map((l) => l.trust)).toEqual(["trusted", "unverified", "rejected"]);
    const served = await sink.recall("code", "pytest", "2026-12-01T00:00:00.000Z");
    expect(served.map((l) => l.trust)).toEqual(["trusted", "unverified"]);
    const trustedOnly = await sink.recall("code", "pytest", "2026-12-01T00:00:00.000Z", {
      includeUnverified: false,
    });
    expect(trustedOnly).toHaveLength(1);
  });

  it("recordOutcomes bounds a batch and survives one failure", async () => {
    let calls = 0;
    const sink = memoryLessonSink();
    const flaky = {
      ...sink,
      async write(l: Lesson) {
        calls++;
        if (calls === 2) throw new Error("disk");
        return sink.write(l);
      },
    };
    const r = await recordOutcomes({ sink: flaky }, [outcome(), outcome(), outcome(), outcome()], {
      maxOutcomes: 3,
      concurrency: 1,
    });
    expect(r.records).toHaveLength(2);
    expect(r.failed).toBe(1);
    expect(r.dropped).toBe(1);
  });
});

describe("outcome learning: leakage guard and recall budget", () => {
  it("a lesson is invisible to work whose cutoff precedes its resolution", () => {
    expect(visibleAt({ resolvedAt: "2026-09-10T00:00:00Z" }, "2026-09-09T23:59:59Z")).toBe(false);
    expect(visibleAt({ resolvedAt: "2026-09-10T00:00:00Z" }, "2026-09-10T00:00:00Z")).toBe(true);
  });

  it("selectServed: trusted first, newest first, within limit and bytes", () => {
    const ls = [
      lesson("a".repeat(400), "2026-09-01T00:00:00Z", { trust: "unverified" }),
      lesson("b".repeat(400), "2026-09-05T00:00:00Z"),
      lesson("c".repeat(400), "2026-09-03T00:00:00Z"),
      lesson("d".repeat(400), "2026-10-05T00:00:00Z"),
      lesson("e".repeat(10), "2026-09-04T00:00:00Z", { trust: "rejected" }),
    ];
    const out = selectServed(ls, "2026-09-30T00:00:00Z", { maxBytes: 900 });
    // d is from the future; e is rejected; two 400-byte lessons fit in 900 bytes.
    expect(out.map((l) => l.text[0])).toEqual(["b", "c"]);
    expect(selectServed(ls, "2026-09-30T00:00:00Z", { limit: 1 }).map((l) => l.text[0])).toEqual([
      "b",
    ]);
  });
});

describe("outcome learning: one local model, no vendor keys", () => {
  /** A fake Marina /v1 that answers the writer and the judge from one model. */
  function oneModel() {
    const seen: Array<{ model: string; auth: string | null }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        messages: { content: string }[];
      };
      seen.push({ model: body.model, auth: new Headers(init.headers).get("authorization") });
      expect(url).toBe("http://marina.test/v1/chat/completions");
      const system = body.messages[0]!.content;
      const content = system.includes("decision classifier")
        ? JSON.stringify({
            answers: {
              grounded: { noul: 0.8 },
              general: { noul: 0.7 },
              leak_free: { noul: 0.9 },
              consistent: { noul: 0.8 },
              transferable: { noul: 0.3 },
            },
          })
        : '{"category":"python test run","rule":"Use the repo\'s own test runner."}';
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1 } }),
        { headers: { "content-type": "application/json" } },
      );
    };
    return {
      seen,
      deps: { baseUrl: "http://marina.test/v1", token: async () => "internal", fetch },
    };
  }

  it("resolves writer and judge to marina/default through Marina's own /v1", async () => {
    const env = {} as NodeJS.ProcessEnv; // no OPENROUTER, no decisions backend
    const { seen, deps } = oneModel();
    const w = lessonWriterFromEnv(env, deps);
    const j = lessonJudgeFromEnv(env, deps);
    expect(w?.name).toBe("marina/default");
    expect(j.calibrated).toBe(false);
    const sink = memoryLessonSink();
    const r = await recordOutcome({ sink, writer: w!, judge: j }, outcome());
    expect(r.trust).toBe("trusted");
    expect(r.lesson.judge).toContain("(uncalibrated)");
    expect(r.lesson.rule).toBe("Use the repo's own test runner.");
    expect(seen.every((s) => s.model === "marina/default" && s.auth === "Bearer internal")).toBe(
      true,
    );
  });

  it("no model reachable: outcomes are still recorded, never promoted", async () => {
    const down = {
      baseUrl: "http://marina.test/v1",
      token: async () => "internal",
      fetch: async () => new Response("no model", { status: 503 }),
    };
    const env = {} as NodeJS.ProcessEnv;
    const sink = memoryLessonSink();
    const r = await recordOutcome(
      { sink, writer: lessonWriterFromEnv(env, down)!, judge: lessonJudgeFromEnv(env, down) },
      outcome(),
    );
    expect(r.trust).toBe("unverified");
    expect(sink.all()).toHaveLength(1);
  });

  it("an explicit vendor writer without its key falls back to marina/default", () => {
    const w = lessonWriterFromEnv({ MARINA_LESSONS_WRITER: "openrouter/openai/x" } as never);
    expect(w?.name).toBe("marina/default");
  });
});

describe("outcome learning: wiring", () => {
  it("noteOutcome is a no-op until learning is armed; armed outcomes land in the durable pool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-outcomes-"));
    dirs.push(dir);
    const db = new MarinaDB(join(dir, "m.db"));
    try {
      noteOutcome(db, outcome());
      expect(outcomeLearningEnabled(db)).toBe(false);
      const sink = lessonSinkFor(db);
      expect(
        enableOutcomeLearning(db, {
          env: {} as NodeJS.ProcessEnv,
          sink,
          writer: writer('{"category":"python test run","rule":"Run pytest from the repo root."}'),
          judge: judge({}),
        }),
      ).toBe(true);
      resetSpendLedgerForTests();
      noteOutcome(db, outcome({ detail: "pytest failed at collection" }));
      await settleOutcomes(db);
      // The judge reported $0.0001; a real judge records it where it is spent
      // (metered() or /v1), so the learning service must not record it again.
      expect(spentTodayUsd()).toBe(0);
      const got = await recallLessons(db, "code", "python test pytest", {
        env: {} as NodeJS.ProcessEnv,
        asOf: "2026-12-01T00:00:00.000Z",
      });
      expect(got.recalled).toHaveLength(1);
      expect(got.inject).toHaveLength(1);
      expect(got.recalled[0]!.trust).toBe("trusted");
      // Not visible before it was learned.
      const early = await recallLessons(db, "code", "python test pytest", {
        env: {} as NodeJS.ProcessEnv,
        asOf: "2026-09-01T00:00:00.000Z",
      });
      expect(early.recalled).toHaveLength(0);
      // observe records but does not inject; off returns nothing.
      const observed = await recallLessons(db, "code", "python test pytest", {
        env: { MARINA_LESSONS: "observe" } as NodeJS.ProcessEnv,
        asOf: "2026-12-01T00:00:00.000Z",
      });
      expect(observed.recalled).toHaveLength(1);
      expect(observed.inject).toHaveLength(0);
      const off = await recallLessons(db, "code", "python test pytest", {
        env: { MARINA_LESSONS: "off" } as NodeJS.ProcessEnv,
      });
      expect(off.recalled).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("MARINA_LESSONS=off never arms", () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-outcomes-"));
    dirs.push(dir);
    const db = new MarinaDB(join(dir, "m.db"));
    try {
      expect(enableOutcomeLearning(db, { env: { MARINA_LESSONS: "off" } as never })).toBe(false);
      expect(outcomeLearningEnabled(db)).toBe(false);
    } finally {
      db.close();
    }
  });
});
