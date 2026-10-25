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
  LESSON_JUDGE_QUESTIONS,
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
  rule: `rule for ${text.slice(0, 20)}`,
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
    expect(bare.rule).toBeUndefined();
    expect(bare.provenance?.no_rule).toBe("no writer");
    const ruled = await candidateFromOutcome(
      outcome(),
      writer('{"category":"python test run","rule":"Run the project runner, not bun."}'),
    );
    expect(ruled.category).toBe("python test run");
    expect(ruled.text).toContain("rule: Run the project runner, not bun.");
  });

  it("a writer with no rule is asked once more, then the candidate says why it has none", async () => {
    let calls = 0;
    const c = await candidateFromOutcome(outcome(), {
      name: "x",
      async complete() {
        calls++;
        throw new Error("down");
      },
    });
    expect(calls).toBe(2);
    expect(c.text).toContain("[lesson:code]");
    expect(c.rule).toBeUndefined();
    expect(c.provenance?.no_rule).toContain("writer unavailable");
    // No JSON, then a rule: the second answer's rule is kept.
    const replies = ["no json here", '{"category":"x","rule":"Read the runner config first."}'];
    const again = await candidateFromOutcome(outcome(), {
      name: "y",
      async complete() {
        return replies.shift() ?? "";
      },
    });
    expect(again.rule).toBe("Read the runner config first.");
    // A producer rule stands in without a second ask.
    let asked = 0;
    const producer = await candidateFromOutcome(outcome({ rule: "Run the project runner." }), {
      name: "z",
      async complete() {
        asked++;
        return "{}";
      },
    });
    expect(asked).toBe(1);
    expect(producer.rule).toBe("Run the project runner.");
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
    const v = await judgeLesson(c, outcome(), judge({ grounded: 0.4 }));
    expect(v.trust).toBe("rejected");
    expect(v.reason).toContain("grounded");
  });

  it("the judge sees the rule and scope as the lesson; case numbers only as outcome detail", async () => {
    const o = outcome({ rule: "Run the project's own test runner.", score: 0.25 });
    const c = await candidateFromOutcome(o);
    expect(c.text).toContain("score 0.25");
    const j = judge({});
    await judgeLesson(c, o, j);
    const state = j.requests[0]!.state as Record<string, unknown>;
    expect(state.lesson).toBe("rule: Run the project's own test runner.");
    expect(state.scope).toBe("method");
    expect((state.outcome as { detail?: string }).detail).toBe("failed at pytest -q (exit 1)");
  });

  it("leak_free is advisory for live outcomes and enforced for measurement", async () => {
    const live = outcome({ rule: "Check the runner." });
    const c = await candidateFromOutcome(live);
    const v = await judgeLesson(c, live, judge({ leak_free: 0.4 }));
    expect(v.trust).toBe("trusted");
    expect(v.reason).toContain("advisory leak_free 0.40");
    expect(v.judgement?.leak_free).toBe(0.4);
    for (const measured of [
      outcome({ rule: "Check the runner.", measured: true }),
      outcome({ rule: "Check the runner.", refs: ["eval:some-board"] }),
      outcome({ rule: "Check the runner.", domain: "benchmark", source: "benchmark:x" }),
    ]) {
      const m = await judgeLesson(c, measured, judge({ leak_free: 0.4 }));
      expect(m.trust).toBe("rejected");
      expect(m.reason).toContain("leak_free");
    }
    // The mechanical case check stays a hard gate for live outcomes too.
    const leaky = outcome({
      rule: "x",
      privateContext: "the secret answer is the purple elephant on the left",
    });
    const lv = await judgeLesson(
      { ...c, text: "rule: the secret answer is the purple elephant on the left" },
      leaky,
      judge({}),
    );
    expect(lv).toMatchObject({ trust: "rejected", leak: true });
  });

  it("failing only `consistent` stores the lesson contested with a resolve case", async () => {
    const sink = memoryLessonSink([
      lesson(
        "[lesson:code] failure · rule: pytest runs from the package dir",
        "2026-09-01T00:00:00Z",
        {
          id: "old",
          rule: "Run pytest from the package directory.",
        },
      ),
    ]);
    const r = await recordOutcome(
      { sink, judge: judge({ consistent: 0.2 }) },
      outcome({ rule: "Run pytest from the repo root.", detail: "pytest collection failed" }),
    );
    expect(r.trust).toBe("trusted");
    expect(r.contests).toBe("old");
    expect(r.reason).toContain("contested: consistent 0.20");
    expect(sink.cases()).toMatchObject([{ against: "old", resolved: false }]);
    const stored = sink.all().find((l) => l.id === r.lessonId)!;
    expect(stored).toMatchObject({ trust: "trusted", contested: true });
    const served = await sink.recall("code", "pytest", "2026-12-01T00:00:00.000Z");
    expect(served.map((l) => l.id)).toEqual(["old"]);
    // Another failing bar besides `consistent` is still a rejection.
    const both = await recordOutcome(
      { sink, judge: judge({ consistent: 0.2, general: 0.1 }) },
      outcome({ rule: "Run pytest twice.", detail: "pytest flaked" }),
    );
    expect(both.trust).toBe("rejected");
    expect(sink.cases()).toHaveLength(1);
  });

  it("`general` is judged within the lesson's declared scope (source shape, family)", async () => {
    const q = LESSON_JUDGE_QUESTIONS.general!;
    expect(q.instructions).toContain("WITHIN its declared scope");
    expect(q.instructions).toContain("one round's numbers is not");
    const o = outcome({ rule: "Anchor daily trackers on persistence.", scopeFamily: "yougov" });
    const j = judge({});
    await judgeLesson(await candidateFromOutcome(o), o, j);
    expect(j.requests[0]!.state).toMatchObject({
      applies_to: { source: "code:verify", family: "yougov" },
    });
    // Served only to work that names its family.
    const scoped = lesson("scoped rule", "2026-09-01T00:00:00Z", { scopeFamily: "yougov" });
    expect(selectServed([scoped], "2026-10-01T00:00:00Z")).toHaveLength(0);
    expect(selectServed([scoped], "2026-10-01T00:00:00Z", { families: ["civiqs"] })).toHaveLength(
      0,
    );
    expect(selectServed([scoped], "2026-10-01T00:00:00Z", { families: ["yougov"] })).toHaveLength(
      1,
    );
  });

  it("with no existing lesson, `consistent` is not in question", async () => {
    const r = await recordOutcome(
      { sink: memoryLessonSink(), judge: judge({ consistent: 0.2 }) },
      outcome({ rule: "Run pytest from the repo root." }),
    );
    expect(r.trust).toBe("trusted");
    expect(r.contests).toBeUndefined();
    expect(r.reason).toContain("no existing lesson");
  });

  it("decisions off or an outage never promote: unverified", async () => {
    const c = await candidateFromOutcome(outcome());
    expect((await judgeLesson(c, outcome(), undefined)).trust).toBe("unverified");
    expect((await judgeLesson(c, outcome(), judge({}, { fail: true }))).trust).toBe("unverified");
  });

  it("an uncalibrated judge clears the same bars as a calibrated one, and is labelled", async () => {
    const c = await candidateFromOutcome(outcome());
    // 0.55 is below the `grounded` bar (0.6): rejected whichever engine answered.
    for (const calibrated of [true, false]) {
      const v = await judgeLesson(c, outcome(), judge({ grounded: 0.55 }, { calibrated }));
      expect(v.trust).toBe("rejected");
      expect(v.reason).toContain("grounded 0.55");
    }
    const v = await judgeLesson(c, outcome(), judge({}, { calibrated: false }));
    expect(v.trust).toBe("trusted");
    expect(v.judge).toContain("(uncalibrated)");
    // `transferable` has one bar too: 0.55 mirrors for neither engine.
    for (const calibrated of [true, false])
      expect(
        (await judgeLesson(c, outcome(), judge({ transferable: 0.55 }, { calibrated })))
          .transferable,
      ).toBe(false);
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

  it("recordOutcome writes trusted, unverified and rejected lessons; recall serves only trusted", async () => {
    const sink = memoryLessonSink();
    const rule = "Run the project's own test runner.";
    await recordOutcome({ sink, judge: judge({}) }, outcome({ rule, detail: "pytest trusted" }));
    await recordOutcome({ sink }, outcome({ rule, detail: "pytest unverified" }));
    await recordOutcome(
      { sink, judge: judge({ general: 0.1 }) },
      outcome({ rule, detail: "pytest rejected" }),
    );
    expect(sink.all().map((l) => l.trust)).toEqual(["trusted", "unverified", "rejected"]);
    const served = await sink.recall("code", "pytest", "2026-12-01T00:00:00.000Z");
    expect(served.map((l) => l.trust)).toEqual(["trusted"]);
  });

  it("a candidate with no rule is never judged or stored: it is deferred with the reason", async () => {
    const sink = memoryLessonSink();
    const j = judge({});
    const r = await recordOutcome(
      {
        sink,
        judge: j,
        writer: {
          name: "w",
          async complete() {
            return '{"category":"python test run"}';
          },
        },
      },
      outcome(),
    );
    expect(r).toMatchObject({ deferred: true, trust: "unverified" });
    expect(r.reason).toBe("no rule (writer returned no rule)");
    expect(j.requests).toHaveLength(0);
    expect(sink.all()).toHaveLength(0);
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
    const o = outcome({ rule: "Run the project runner." });
    const r = await recordOutcomes({ sink: flaky }, [o, o, o, o], {
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

  it("never serves an unverified lesson, nor any lesson without a rule", () => {
    const at = "2026-09-30T00:00:00Z";
    const ls = [
      lesson("migrated never-judged lesson", "2026-09-01T00:00:00Z", { trust: "unverified" }),
      lesson("trusted bare restatement", "2026-09-02T00:00:00Z", { rule: undefined }),
      lesson("trusted with a rule", "2026-09-03T00:00:00Z"),
      lesson("a curator's replacement", "2026-09-04T00:00:00Z", {
        trust: "unverified",
        source: "supersede:old",
        rule: "a curator's replacement",
      }),
      lesson("curated but no rule", "2026-09-05T00:00:00Z", {
        trust: "unverified",
        source: "supersede:old2",
        rule: undefined,
      }),
    ];
    expect(selectServed(ls, at).map((l) => l.text)).toEqual([
      "trusted with a rule",
      "a curator's replacement",
    ]);
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

  it("no model reachable: nothing is written and nothing throws", async () => {
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
    expect(r).toMatchObject({ trust: "unverified", deferred: true });
    expect(r.reason).toContain("writer unavailable");
    expect(sink.all()).toHaveLength(0);
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
