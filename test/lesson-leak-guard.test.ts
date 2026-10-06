// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Benchmark outcomes teach general, trustworthy lessons, and the leak guard
 * still blocks item content:
 *   - a run's mechanical lesson is a configuration rule (kind of work, the
 *     configurations compared, aggregate evidence) that passes a deterministic
 *     rubric judge with the strict calibrated bars;
 *   - a lesson naming an item id, quoting question text or stating an answer
 *     fails the mechanical check before any judge is asked, and is stored
 *     with its text withheld; a writer rule that leaks is discarded;
 *   - aggregate scores, model names and configuration are never flagged;
 *   - `backfill --relearn-rejected` re-learns runs an earlier learner had
 *     rejected, once; a run the judge cannot decide is deferred, never
 *     written `unverified`, and the spend cap stops the pass.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import type { DecisionProvider, DecisionRequest } from "../src/decisions/types";
import { answerDigest, sliceHash } from "../src/engine/benchmark-ledger";
import { BenchmarkRunner } from "../src/engine/benchmark-runner";
import { backfillLedgerLessons } from "../src/learning/backfill";
import { BENCHMARK_LEARNER, benchmarkRunOutcome } from "../src/learning/intake";
import { caseGuardFromItems, itemLeak, ledgerCaseGuard } from "../src/learning/leak-guard";
import {
  candidateFromOutcome,
  judgeLesson,
  LESSON_JUDGE_QUESTIONS,
  type Lesson,
  memoryLessonSink,
  type Outcome,
  recordOutcome,
} from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  settleOutcomes,
} from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const QUESTIONS = [
  "Which river flows through the ancient city of Carthaginian merchants before reaching the sea?",
  "How many prime numbers lie strictly between seventy and ninety in the decimal system?",
];
const ANSWERS = ["Bagradas River", "five primes"];
const IDS = Array.from({ length: 12 }, (_, i) => `q-${i}-x`);

/**
 * A deterministic rubric judge: `leak_free` is low when the lesson contains
 * any of the given item strings (case-insensitive), high otherwise; a lesson
 * without a rule is not `general`. Calibrated, so the strict bars apply.
 */
function rubricJudge(items: string[]): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    kind: "test",
    model: "test/rubric",
    calibrated: true,
    requests,
    async ask(request) {
      requests.push(request);
      const text = String((request.state as { lesson?: string }).lesson ?? "").toLowerCase();
      const leaks = items.some((s) => text.includes(s.toLowerCase()));
      const scores: Record<string, number> = {
        grounded: 0.85,
        general: text.includes("rule: ") ? 0.85 : 0.3,
        leak_free: leaks ? 0.05 : 0.9,
        consistent: 0.9,
        transferable: 0.4,
      };
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: scores[k] ?? 0.9 }]),
        ),
        model: "test/rubric",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      } as never;
    },
  } as DecisionProvider & { requests: DecisionRequest[] };
}

let db: MarinaDB;
let dbPath: string;

beforeEach(() => {
  dbPath = `${tmpdir()}/marina-leak-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
  db = new MarinaDB(dbPath);
});

afterEach(() => {
  disableOutcomeLearning(db);
  db.close();
  cleanupDb(dbPath);
});

function recordRun(
  id: string,
  opts: { right: number; completedAt: number; target: unknown; answers?: boolean },
) {
  db.recordBenchmarkLedgerRun(
    {
      id,
      benchmark: "frames",
      config_hash: id,
      config_json: "{}",
      started_at: opts.completedAt - 1,
      completed_at: opts.completedAt,
      duration_ms: 1,
      score: opts.right / IDS.length,
      answered: IDS.length,
      total: IDS.length,
      cost_usd: 0.24,
      n: IDS.length,
      ci_low: 0,
      ci_high: 1,
      seed: 1,
      slice_hash: sliceHash(IDS),
      judge: "judge/model",
      target_kind: typeof opts.target === "string" ? "model" : "crew",
      target_json: JSON.stringify(opts.target),
      label: id,
      source: "import",
      content_hash: null,
    },
    IDS.map((item_id, i) => ({
      item_id,
      correct: i < opts.right,
      score: null,
      latency_ms: null,
      cost_usd: 0.02,
      trace_id: null,
      participants_json: null,
      judge_verdict: null,
      ...(opts.answers && i < ANSWERS.length ? { answer_digest: answerDigest(ANSWERS[i]) } : {}),
    })),
  );
}

const LEAD = {
  formation: "lead",
  lead: "openrouter/anthropic/claude-opus-5.5",
  reader: "x/reader-1",
};

describe("benchmark run lessons", () => {
  it("a run's mechanical lesson is a general configuration rule that a rubric judge trusts", async () => {
    recordRun("base", { right: 6, completedAt: 1_000, target: "openrouter/openai/gpt-6-luna" });
    recordRun("lead", { right: 10, completedAt: 2_000, target: LEAD, answers: true });
    const outcome = benchmarkRunOutcome(db, db.getBenchmarkRun("lead")!)!;
    expect(outcome.rule).toBe(
      "On answers that need searching or retrieving evidence first and short factual or exact-match answers, the lead formation (lead claude-opus-5.5, reader reader-1) outperformed model gpt-6-luna (83.3% vs 50.0% on the same items and judge, n=12); prefer the former for similar work.",
    );
    const judge = rubricJudge([...IDS, ...QUESTIONS, ...ANSWERS]);
    const sink = memoryLessonSink();
    const r = await recordOutcome({ sink, judge }, outcome);
    expect(r.trust).toBe("trusted");
    expect(r.lesson.judge).toBe("test/rubric");
    expect(
      r.lesson.text.startsWith("[lesson:benchmark] success · rule: On answers that need"),
    ).toBe(true);
    expect(r.lesson.refs).toEqual(["bench:lead", "bench:base"]);
    expect(r.lesson.provenance?.learner).toBe(BENCHMARK_LEARNER);
    for (const id of IDS) expect(r.lesson.text).not.toContain(id);
    // The judge saw the general fields only, with measurement notes kept apart.
    const state = judge.requests[0]!.state as { outcome: Outcome & { measurement?: string[] } };
    expect(state.outcome.measurement?.join(" ")).toContain("trace-linked");
    expect(JSON.stringify(state)).not.toContain("q-0-x");
  });

  it("the in-world runner's lesson passes the rubric judge and carries no item text", async () => {
    const sink = memoryLessonSink();
    const items = IDS.map((id, i) => ({
      id,
      question: QUESTIONS[i % QUESTIONS.length],
      expected: ANSWERS[i % ANSWERS.length],
      actual: ANSWERS[i % ANSWERS.length],
      correct: i % 2 === 0,
      category: "geo",
    }));
    enableOutcomeLearning(db, {
      sink,
      writer: null,
      judge: rubricJudge([...IDS, ...QUESTIONS, ...ANSWERS]),
      env: {},
    });
    db.insertBenchmarkRun({
      id: "br_rule",
      benchmark: "gsm8k",
      config_hash: "cfg",
      config_json: "{}",
      status: "running",
      started_at: Date.now(),
    });
    new BenchmarkRunner(db, () => {}).recordHarnessResult(
      "br_rule",
      { benchmark: "gsm8k" },
      Date.now(),
      {
        result: {
          scores: { overall: 0.5, breakdown: {} },
          metadata: { total: IDS.length, answered: IDS.length },
          items,
        },
      },
    );
    await settleOutcomes(db);
    const lessons = sink.all().filter((l) => l.domain === "benchmark");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.trust).toBe("trusted");
    expect(lessons[0]!.rule).toContain("On multi-step mathematical reasoning");
    for (const s of [...QUESTIONS, ...ANSWERS]) expect(JSON.stringify(lessons)).not.toContain(s);
  });

  it("describes populations and nested configurations by formation and role", () => {
    recordRun("pop", {
      right: 7,
      completedAt: 1_000,
      target: {
        configuration: {
          label: "x",
          formation: "delphi",
          analysts: ["a/deep-1", "b/gem-2"],
          critic: "c/kimi-3",
        },
      },
    });
    const o = benchmarkRunOutcome(db, db.getBenchmarkRun("pop")!)!;
    expect(o.attempted).toContain(
      "declared target: the delphi formation (analysts deep-1+gem-2, critic kimi-3)",
    );
  });
});

describe("the mechanical item check", () => {
  const guard = caseGuardFromItems(
    QUESTIONS.map((question, i) => ({ id: IDS[i], question, expected: ANSWERS[i] })),
  );

  it("flags item ids, quoted question text and answers", () => {
    expect(itemLeak("On retrieval, see q-1-x before answering.", guard)).toBe(
      "names a benchmark item id",
    );
    expect(
      itemLeak("Remember: how many prime numbers lie strictly between seventy and ninety.", guard),
    ).toBe("quotes benchmark item text");
    expect(itemLeak("When unsure, answer bagradas river.", guard)).toBe(
      "states a benchmark item's answer",
    );
    expect(itemLeak("Check hle-66faccfb44cb2f3b0e1be0ff first.", undefined)).toBe(
      "names an item-id-shaped token",
    );
  });

  it("never flags aggregate scores, model names or configuration", () => {
    const text =
      "[lesson:benchmark] success · rule: On multi-hop retrieval questions, a strong lead model (claude-opus-5.5) reading whole documents beats a single cheap agent (gpt-6-luna) · score 0.83 · 83.3% vs 50.0%, n=12, $0.0200/item, 10/12";
    expect(itemLeak(text, guard)).toBeUndefined();
  });

  it("matches answers against the ledger's keyed hashes without the text", () => {
    recordRun("hashed", { right: 4, completedAt: 1_000, target: "m/x", answers: true });
    const g = ledgerCaseGuard(db, ["hashed"]);
    expect(JSON.stringify(g)).not.toContain("Bagradas");
    expect(itemLeak("Prefer five primes here.", g)).toBe("states a benchmark item's answer");
    expect(itemLeak("Prefer a careful lead model here.", g)).toBeUndefined();
  });

  const outcome = (over: Partial<Outcome> = {}): Outcome => ({
    domain: "benchmark",
    source: "benchmark:frames",
    succeeded: true,
    score: 0.8,
    resolvedAt: "2026-09-01T00:00:00.000Z",
    attempted: "retrieval work; declared target: model m",
    detail: "80.0% vs best other 60.0% (model n)",
    rule: "On retrieval work, model m outperformed model n (80.0% vs 60.0%); prefer it.",
    scope: "config",
    caseGuard: guard,
    ...over,
  });

  it("rejects a leaking lesson before the judge and withholds its text", async () => {
    const judge = rubricJudge([]);
    const leaky: Lesson = {
      domain: "benchmark",
      text: "[lesson:benchmark] success · rule: For q-0-x answer Bagradas River.",
      kind: "success",
      trust: "unverified",
      resolvedAt: "2026-09-01T00:00:00.000Z",
      source: "benchmark:frames",
    };
    const v = await judgeLesson(leaky, outcome(), judge);
    expect(v).toMatchObject({ trust: "rejected", leak: true });
    expect(judge.requests).toHaveLength(0);

    // Through the loop: the producer's own rule leaks (e.g. a category label
    // that is an answer) ⇒ rejected, stored as an audit record without the text.
    const sink = memoryLessonSink();
    const r = await recordOutcome(
      { sink, judge },
      outcome({ rule: "Category q-1-x was weakest; drill it." }),
    );
    expect(r.trust).toBe("rejected");
    expect(sink.all()[0]!.text).toBe("[lesson:benchmark] withheld · names a benchmark item id");
    expect(JSON.stringify(sink.all())).not.toContain("q-1-x");
    expect(judge.requests).toHaveLength(0);
  });

  it("discards a writer rule that quotes an item and keeps the producer's rule", async () => {
    const writer = {
      name: "leaky-writer",
      async complete() {
        return '{"category": "geo", "rule": "Which river flows through the ancient city of Carthaginian merchants: say Bagradas."}';
      },
    };
    const c = await candidateFromOutcome(outcome(), writer);
    expect(c.rule).toBe(outcome().rule);
    expect(c.category).toBeUndefined();
    expect(c.provenance?.writer_note).toBe("writer rule discarded: quotes benchmark item text");
    expect(c.text).not.toContain("Carthaginian");
  });

  it("the leak_free question names item content and allows aggregates and configuration", () => {
    const q = LESSON_JUDGE_QUESTIONS.leak_free!;
    expect(q.instructions).toContain("item id");
    expect(q.instructions).toContain("NOT item content");
  });
});

describe("judge calibration follows what answered", () => {
  it("a composite engine whose calibrated primary answered alone is held to the calibrated bars", async () => {
    const auto: DecisionProvider = {
      kind: "marina-auto",
      model: "marina/auto",
      calibrated: false,
      async ask(request) {
        return {
          answers: Object.fromEntries(
            Object.keys(request.questions).map((k) => [
              k,
              { type: "noul", noul: k === "leak_free" ? 0.65 : 0.9 },
            ]),
          ),
          model: "marina/auto",
          provider: "test",
          latencyMs: 1,
          calibrated: true,
        } as never;
      },
    };
    const c = await candidateFromOutcome({
      domain: "benchmark",
      source: "benchmark:x",
      succeeded: true,
      resolvedAt: "2026-09-01T00:00:00.000Z",
      attempted: "x",
      rule: "On x work, model a beat model b; prefer it.",
      scope: "config",
    });
    const calibrated = await judgeLesson(
      c,
      { ...c, attempted: "x", succeeded: true } as never,
      auto,
    );
    expect(calibrated.trust).toBe("rejected"); // leak_free 0.65 < 0.7
    expect(calibrated.judge).toBe("marina/auto");
    const joined: DecisionProvider = {
      ...auto,
      async ask(request) {
        return { ...(await auto.ask(request)), calibrated: false };
      },
    };
    const uncal = await judgeLesson(c, { ...c, attempted: "x", succeeded: true } as never, joined);
    expect(uncal.trust).toBe("trusted"); // one cut at 0.5
    expect(uncal.judge).toBe("marina/auto (uncalibrated)");
  });
});

describe("backfill --relearn-rejected", () => {
  it("re-learns runs an earlier learner had rejected, once", async () => {
    recordRun("r1", { right: 6, completedAt: 1_000, target: "m/a" });
    recordRun("r2", { right: 9, completedAt: 2_000, target: "m/b" });
    const sink = memoryLessonSink([
      {
        id: "old-1",
        domain: "benchmark",
        text: "[lesson:benchmark] failure · score 0.50",
        kind: "failure",
        trust: "rejected",
        resolvedAt: new Date(1_000).toISOString(),
        source: "benchmark:frames",
        refs: ["bench:r1"],
      },
      {
        id: "old-2",
        domain: "benchmark",
        text: "[lesson:benchmark] success · score 0.75",
        kind: "success",
        trust: "trusted",
        resolvedAt: new Date(2_000).toISOString(),
        source: "benchmark:frames",
        refs: ["bench:r2"],
      },
    ]);
    const deps = { sink, judge: rubricJudge(IDS) };
    const plain = await backfillLedgerLessons(db, deps, { dryRun: true });
    expect(plain).toMatchObject({ learned: 0, existing: 2 });

    const first = await backfillLedgerLessons(db, deps, { relearnRejected: true });
    expect(first).toMatchObject({ learned: 1, relearned: 1, existing: 1, runIds: ["r1"] });
    expect(first.trust.trusted).toBe(1);
    // The earlier rejection stays as an audit record.
    expect(sink.all().some((l) => l.id === "old-1" && l.trust === "rejected")).toBe(true);

    const second = await backfillLedgerLessons(db, deps, { relearnRejected: true });
    expect(second).toMatchObject({ learned: 0, relearned: 0, existing: 2 });
  });

  it("never resurrects a run whose earlier rejected lesson was retired", async () => {
    recordRun("r1", { right: 6, completedAt: 1_000, target: "m/a" });
    const sink = memoryLessonSink([
      {
        id: "old-1",
        domain: "benchmark",
        text: "[lesson:benchmark] failure · score 0.50",
        kind: "failure",
        trust: "rejected",
        resolvedAt: new Date(1_000).toISOString(),
        source: "benchmark:frames",
        refs: ["bench:r1"],
      },
    ]);
    await sink.retire!("benchmark", "old-1", { reason: "excluded", by: "operator" });
    const deps = { sink, judge: rubricJudge(IDS) };
    for (const relearnRejected of [false, true]) {
      const r = await backfillLedgerLessons(db, deps, { relearnRejected });
      expect(r).toMatchObject({ learned: 0, relearned: 0, existing: 1, retired: 1 });
    }
    expect(sink.all()).toHaveLength(1);
  });

  it("defers runs the judge cannot decide and stops at the spend cap, writing nothing", async () => {
    recordRun("r1", { right: 6, completedAt: 1_000, target: "m/a" });
    recordRun("r2", { right: 9, completedAt: 2_000, target: "m/b" });
    const sink = memoryLessonSink();
    const down: DecisionProvider = {
      kind: "test",
      model: "test/down",
      calibrated: true,
      async ask() {
        throw new Error("spend_cap");
      },
    };
    const deferred = await backfillLedgerLessons(db, { sink, judge: down });
    expect(deferred).toMatchObject({ learned: 2, deferred: 2 });
    expect(deferred.trust).toEqual({ trusted: 0, unverified: 0, rejected: 0 });
    expect(sink.all()).toHaveLength(0);

    let calls = 0;
    const capped = await backfillLedgerLessons(
      db,
      { sink, judge: rubricJudge(IDS) },
      { refuse: () => (++calls > 1 ? "daily spend cap reached" : undefined) },
    );
    expect(capped).toMatchObject({ learned: 1, stopped: "daily spend cap reached" });
    expect(capped.runIds).toEqual(["r1"]);
    expect(sink.all()).toHaveLength(1);
    // The next pass learns what the capped one left.
    const rest = await backfillLedgerLessons(db, { sink, judge: rubricJudge(IDS) });
    expect(rest).toMatchObject({ learned: 1, existing: 1, runIds: ["r2"] });
  });
});
