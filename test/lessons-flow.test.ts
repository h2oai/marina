// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lessons flow everywhere (src/learning/): scope / families / subjects, the
 * `transferable` judge question and the `lessons:meta` mirror, meta recall on
 * every work surface within a third of its budget, the leakage rule and the
 * measurement self-exclusion (`x-marina-eval`), the ledger backfill, and the
 * served lesson ids recorded per ledger item.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asJudge,
  lessonRequestHeaders,
  setTargetLessonContext,
} from "../benchmarks/modes/passthrough";
import type { DecisionProvider, DecisionRequest } from "../src/decisions/types";
import { ledgerFromHarnessResult, sliceHash } from "../src/engine/benchmark-ledger";
import { backfillLedgerLessons } from "../src/learning/backfill";
import {
  evalExclusion,
  formatEvalHeader,
  parseEvalHeader,
  parseLessonsHeader,
} from "../src/learning/eval-context";
import { familiesForRun, familiesForSource, targetSubjects } from "../src/learning/families";
import { forecastLessonsFor } from "../src/learning/forecast-bridge";
import { benchmarkRunOutcome, retireLessonsForRun } from "../src/learning/intake";
import {
  candidateFromOutcome,
  formatLesson,
  type Lesson,
  memoryLessonSink,
  metaMirror,
  type Outcome,
  recordOutcome,
} from "../src/learning/outcomes";
import {
  lessonSinkFor,
  lessonsHeaderValue,
  lessonsMetaMode,
  recallForWork,
  residentLessonsMode,
  retireLessons,
} from "../src/learning/service";
import { wantsLessons } from "../src/net/model-api/chat-completions";
import { MarinaDB } from "../src/persistence/database";

const ON = { MARINA_LESSONS: "on" } as NodeJS.ProcessEnv;
const META_OBSERVE = { MARINA_LESSONS: "on", MARINA_LESSONS_META: "observe" } as NodeJS.ProcessEnv;
const OFF = { MARINA_LESSONS: "off" } as NodeJS.ProcessEnv;
const NOW = "2026-10-01T00:00:00.000Z";

const lesson = (id: string, domain: Lesson["domain"], text: string, over: Partial<Lesson> = {}) =>
  ({
    id,
    domain,
    text,
    kind: "failure",
    trust: "trusted",
    resolvedAt: "2026-09-01T00:00:00.000Z",
    source: `${domain}:test`,
    ...over,
  }) satisfies Lesson;

/** A judge answering every noul question; `transferable` as given. */
function judge(transferable: number): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    kind: "test",
    model: "test/jev",
    calibrated: true,
    requests,
    async ask(request) {
      requests.push(request);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [
            k,
            { type: "noul", noul: k === "transferable" ? transferable : 0.9 },
          ]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      } as never;
    },
  };
}

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  domain: "benchmark",
  source: "benchmark:board-a",
  succeeded: false,
  resolvedAt: "2026-09-10T00:00:00.000Z",
  attempted: "board-a; declared target: crew in the verify formation",
  detail: "41.0% vs best other 52.0% (crew in the single formation)",
  refs: ["bench:run-a1", "bench:run-a0"],
  scope: "config",
  families: ["qa.exact"],
  ...over,
});

const dirs: string[] = [];
function freshDb(): MarinaDB {
  const dir = mkdtempSync(join(tmpdir(), "lessons-flow-"));
  dirs.push(dir);
  return new MarinaDB(join(dir, "m.db"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setTargetLessonContext(undefined);
});

// ─── Scope, families, subjects ───────────────────────────────────────────────

describe("scope, families and subjects", () => {
  it("producers get a mechanical scope; a writer may name another", async () => {
    const mech = await candidateFromOutcome(outcome({ scope: undefined }));
    expect(mech.scope).toBe("config");
    expect(
      (await candidateFromOutcome(outcome({ domain: "forecast", scope: undefined }))).scope,
    ).toBe("case");
    const written = await candidateFromOutcome(outcome({ domain: "forecast", scope: undefined }), {
      name: "w",
      complete: async () =>
        '{"category":"forecast calibration","rule":"Shrink toward the base rate.","scope":"calibration"}',
    });
    expect(written.scope).toBe("calibration");
    const bogus = await candidateFromOutcome(outcome(), {
      name: "w",
      complete: async () => '{"category":"x","rule":"y","scope":"everything"}',
    });
    expect(bogus.scope).toBe("config");
    expect(mech.families).toEqual(["qa.exact"]);
  });

  it("families come from data: harness config first, then the vocabulary map", () => {
    expect(familiesForRun({ benchmark: "hle-verified-gold-mm" })).toEqual([
      "qa.exact",
      "qa.vision",
    ]);
    expect(
      familiesForRun({
        benchmark: "brand-new-board",
        config_json: JSON.stringify({ families: ["code.patch", "not-a-family"] }),
      }),
    ).toEqual(["code.patch"]);
    expect(familiesForRun({ benchmark: "brand-new-board" })).toEqual([]);
    expect(familiesForSource("forecast:number")).toEqual(["forecast.numeric"]);
    expect(familiesForSource("futurex:cheap")).toEqual(["forecast.typed"]);
    expect(familiesForSource("benchmark:tau2-retail")).toEqual(["tool-agent.policy"]);
  });

  it("target subjects name the formation and short model ids", () => {
    expect(
      targetSubjects({
        target_json: JSON.stringify({
          formation: "verify",
          models: { lead: "openrouter/a/opus", checker: "b/mini" },
        }),
      }),
    ).toEqual(["formation:verify", "opus", "mini"]);
    expect(targetSubjects({ target_json: JSON.stringify("openrouter/x/model-1") })).toEqual([
      "model-1",
    ]);
  });
});

// ─── The transferable question and the meta mirror ───────────────────────────

describe("lessons:meta mirror", () => {
  it("the judge is asked `transferable`; it never decides trust", async () => {
    const j = judge(0.1);
    const sink = memoryLessonSink();
    const r = await recordOutcome({ sink, judge: j, meta: true }, outcome());
    expect(Object.keys(j.requests[0]!.questions)).toContain("transferable");
    expect(r.trust).toBe("trusted");
    expect(r.metaId).toBeUndefined(); // not transferable ⇒ no mirror
    expect(sink.all().filter((l) => l.domain === "meta")).toHaveLength(0);
  });

  it("a trusted, transferable, non-case lesson is mirrored with refs and provenance", async () => {
    const sink = memoryLessonSink();
    const r = await recordOutcome({ sink, judge: judge(0.9), meta: true }, outcome());
    expect(r.metaId).toBeDefined();
    const mirror = sink.all().find((l) => l.domain === "meta")!;
    expect(mirror.text).toBe(r.lesson.text);
    expect(mirror.resolvedAt).toBe(r.lesson.resolvedAt); // leakage rule unchanged
    expect(mirror.trust).toBe("trusted");
    expect(mirror.refs?.[0]).toBe(`lesson:${r.lessonId}`);
    expect(mirror.refs).toContain("bench:run-a1");
    expect(mirror.provenance).toEqual({ promoted_from: `benchmark/${r.lessonId}` });
    expect(mirror.source).toBe("benchmark:board-a");
  });

  it("never mirrors a case lesson, an unverified lesson, or with meta off", async () => {
    const caseSink = memoryLessonSink();
    await recordOutcome(
      { sink: caseSink, judge: judge(0.9), meta: true },
      outcome({ domain: "forecast", scope: undefined }),
    );
    expect(caseSink.all().some((l) => l.domain === "meta")).toBe(false);

    const noJudge = memoryLessonSink();
    const r = await recordOutcome({ sink: noJudge, meta: true }, outcome());
    expect(r.trust).toBe("unverified");
    expect(noJudge.all().some((l) => l.domain === "meta")).toBe(false);

    const off = memoryLessonSink();
    await recordOutcome({ sink: off, judge: judge(0.9) }, outcome());
    expect(off.all().some((l) => l.domain === "meta")).toBe(false);
    expect(
      metaMirror(lesson("m", "meta", "x", { scope: "config" }), "m", {
        trust: "trusted",
        transferable: true,
      }),
    ).toBeUndefined();
  });

  it("the admission hook runs after the judge and before each write", async () => {
    const sink = memoryLessonSink();
    const seen: string[] = [];
    await recordOutcome(
      {
        sink,
        judge: judge(0.9),
        meta: true,
        admit: async (l, ctx) => {
          seen.push(`${ctx.target}:${l.trust}:${ctx.verdict.transferable}`);
          return ctx.target === "meta" ? null : l;
        },
      },
      outcome(),
    );
    expect(seen).toEqual(["lesson:trusted:true", "meta:trusted:true"]);
    expect(sink.all().map((l) => l.domain)).toEqual(["benchmark"]); // mirror not admitted
  });

  it("retiring the original retires its mirror (retire follows refs)", async () => {
    const db = freshDb();
    try {
      const sink = memoryLessonSink();
      const r = await recordOutcome({ sink, judge: judge(0.9), meta: true }, outcome());
      const res = await retireLessons(
        db,
        [{ ...r.lesson, id: r.lessonId! }],
        { reason: "wrong", by: "curator" },
        { sink },
      );
      expect(res.retired.map((l) => l.domain).sort()).toEqual(["benchmark", "meta"]);
      expect(sink.retirements().has(r.metaId!)).toBe(true);
      // Invalidating a run retires lessons citing it in every domain, mirrors included.
      const r2 = await recordOutcome(
        { sink, judge: judge(0.9), meta: true },
        outcome({ refs: ["bench:run-b1"], attempted: "board-a run b" }),
      );
      const inv = await retireLessonsForRun(db, "run-b1", { reason: "outage", by: "op" }, { sink });
      expect(inv.retired.map((l) => l.id).sort()).toEqual([r2.lessonId, r2.metaId].sort());
    } finally {
      db.close();
    }
  });
});

// ─── Meta recall on work surfaces ────────────────────────────────────────────

describe("recallForWork: own domains first, meta within a third", () => {
  const meta = (id: string, text: string, over: Partial<Lesson> = {}) =>
    lesson(id, "meta", text, { scope: "method", source: "benchmark:board-b", ...over });

  it("serves trusted meta lessons, labelled, within a third of the budget", async () => {
    const sink = memoryLessonSink([
      lesson("c1", "code", "run the tests before you claim a fix to the parser"),
      meta("m1", "a strong lead beats self review on parser fixes"),
      meta("m2", "every budget ends in an answer for parser fixes"),
      meta("u1", "unverified meta parser fixes", { trust: "unverified" }),
    ]);
    const r = await recallForWork(undefined, ["code"], "parser fixes", {
      sink,
      env: ON,
      asOf: NOW,
      limit: 3,
      maxBytes: 600,
    });
    expect(r.recalled.map((l) => l.id)).toEqual(["c1", "m1"]); // limit 3 ⇒ one meta slot
    expect(r.inject).toEqual(r.recalled);
    expect(r.recalled.some((l) => l.id === "u1")).toBe(false); // meta is trusted-only
    expect(formatLesson(r.recalled[1]!)).toContain("(cross-board method)");
    expect(lessonsHeaderValue(r)).toBe("c1,m1");
  });

  it("without meta lessons the surface gets exactly its own recall", async () => {
    const sink = memoryLessonSink([lesson("c1", "code", "parser fixes need tests")]);
    const r = await recallForWork(undefined, ["code"], "parser fixes", {
      sink,
      env: ON,
      asOf: NOW,
    });
    expect(r.recalled.map((l) => l.id)).toEqual(["c1"]);
  });

  it("observe records meta ids without injecting; off recalls nothing", async () => {
    const sink = memoryLessonSink([
      lesson("c1", "code", "parser fixes need tests"),
      meta("m1", "parser fixes: a strong lead beats self review"),
    ]);
    const obs = await recallForWork(undefined, ["code"], "parser fixes", {
      sink,
      env: META_OBSERVE,
      asOf: NOW,
    });
    expect(obs.recalled.map((l) => l.id)).toEqual(["c1", "m1"]);
    expect(obs.inject.map((l) => l.id)).toEqual(["c1"]);
    expect(lessonsHeaderValue(obs)).toBe("c1;observe:m1");
    expect(parseLessonsHeader(lessonsHeaderValue(obs))).toEqual({
      served: ["c1"],
      observed: ["m1"],
    });
    const off = await recallForWork(undefined, ["code"], "parser fixes", { sink, env: OFF });
    expect(off.recalled).toEqual([]);
    expect(lessonsMetaMode(OFF)).toBe("off");
    expect(lessonsMetaMode({ MARINA_LESSONS: "observe" } as NodeJS.ProcessEnv)).toBe("observe");
    expect(lessonsMetaMode({} as NodeJS.ProcessEnv)).toBe("on");
  });

  it("leakage rule: a meta lesson resolved after the work's cutoff is never served", async () => {
    const sink = memoryLessonSink([
      meta("early", "parser fixes: keep the checker cheap", {
        resolvedAt: "2026-09-01T00:00:00.000Z",
      }),
      meta("late", "parser fixes: a later finding", { resolvedAt: "2026-09-20T00:00:00.000Z" }),
    ]);
    const r = await recallForWork(undefined, ["code"], "parser fixes", {
      sink,
      env: ON,
      asOf: "2026-09-10T00:00:00.000Z",
      limit: 6,
      maxBytes: 1_200,
    });
    expect(r.recalled.map((l) => l.id)).toEqual(["early"]);
  });

  it("a mirror whose original is already served is not served twice", async () => {
    const sink = memoryLessonSink([
      lesson("c1", "code", "parser fixes need tests", { scope: "method" }),
      meta("m1", "parser fixes need tests", { refs: ["lesson:c1"] }),
    ]);
    const r = await recallForWork(undefined, ["code"], "parser fixes", {
      sink,
      env: ON,
      asOf: NOW,
    });
    expect(r.recalled.map((l) => l.id)).toEqual(["c1"]);
  });

  it("every forecast surface reads meta through the bridge, with the cutoff", async () => {
    const sink = memoryLessonSink([
      lesson("f1", "forecast", "election polls: check the field dates"),
      meta("m1", "election polls: agreement is not confidence", { scope: "calibration" }),
    ]);
    const store = forecastLessonsFor(undefined, { sink, env: ON });
    const got = await store.recall("election polls", NOW);
    expect(got.map((l) => l.id)).toEqual(["f1", "m1"]);
    expect(got[1]!.text).toContain("cross-board calibration");
    expect(await store.recall("election polls", "2026-08-01T00:00:00.000Z")).toEqual([]);
  });
});

// ─── Leakage rule 2: self-exclusion for measurement ──────────────────────────

describe("x-marina-eval self-exclusion", () => {
  it("parses the header; mode defaults to measure; junk is no context", () => {
    expect(parseEvalHeader("benchmark=hle-verified-gold; slice=ab12; mode=live")).toEqual({
      benchmark: "hle-verified-gold",
      slice: "ab12",
      mode: "live",
    });
    expect(parseEvalHeader("benchmark=tau2-retail")).toEqual({
      benchmark: "tau2-retail",
      mode: "measure",
    });
    expect(parseEvalHeader("mode=measure")).toBeUndefined();
    expect(parseEvalHeader("benchmark=bad name")).toBeUndefined();
    const ctx = { benchmark: "Tevatron/browsecomp-plus", mode: "measure" as const };
    expect(parseEvalHeader(formatEvalHeader(ctx))).toEqual(ctx);
  });

  it("excludes lessons whose provenance names the same board; live lifts it", () => {
    const runs: Record<string, string> = { r1: "board-a", r2: "board-b" };
    const ex = evalExclusion({ benchmark: "board-a", mode: "measure" }, (id) => runs[id])!;
    expect(ex(lesson("a", "benchmark", "x", { source: "benchmark:board-a" }))).toBe(true);
    expect(
      ex(lesson("b", "meta", "x", { source: "code:verify", refs: ["lesson:z", "bench:r1"] })),
    ).toBe(true);
    expect(
      ex(lesson("c", "benchmark", "x", { source: "benchmark:board-b", refs: ["bench:r2"] })),
    ).toBe(false);
    expect(ex(lesson("d", "code", "x", { source: "code:verify" }))).toBe(false);
    // A producer label covers its boards (`futurex:` ⇒ futurex-past-clean).
    const fx = evalExclusion({ benchmark: "futurex-past-clean", mode: "measure" })!;
    expect(fx(lesson("e", "forecast", "x", { source: "futurex:cheap" }))).toBe(true);
    expect(fx(lesson("f", "forecast", "x", { source: "forecast:probability" }))).toBe(false);
    expect(evalExclusion({ benchmark: "board-a", mode: "live" })).toBeUndefined();
    expect(evalExclusion(undefined)).toBeUndefined();
  });

  it("a measurement run recalls cross-board lessons but none from its own board", async () => {
    const sink = memoryLessonSink([
      lesson("own", "benchmark", "board-a lookups: verify formation lost", {
        source: "benchmark:board-a",
      }),
      lesson("mirror", "meta", "lookups: a strong lead beats self review", {
        source: "benchmark:board-a",
        scope: "config",
      }),
      lesson("other", "meta", "lookups: every budget ends in an answer", {
        source: "benchmark:board-b",
        scope: "budget",
      }),
    ]);
    const measure = await recallForWork(undefined, ["benchmark"], "lookups", {
      sink,
      env: ON,
      asOf: NOW,
      limit: 6,
      maxBytes: 1_200,
      eval: { benchmark: "board-a", mode: "measure" },
    });
    expect(measure.recalled.map((l) => l.id)).toEqual(["other"]);
    const live = await recallForWork(undefined, ["benchmark"], "lookups", {
      sink,
      env: ON,
      asOf: NOW,
      limit: 6,
      maxBytes: 1_200,
      eval: { benchmark: "board-a", mode: "live" },
    });
    expect(live.recalled.map((l) => l.id).sort()).toEqual(["mirror", "other", "own"]);
  });

  it("the harness sends the eval context on target calls only, never on judge calls", async () => {
    expect(lessonRequestHeaders()).toEqual({});
    setTargetLessonContext({ eval: { benchmark: "board-a", mode: "measure" }, lessons: true });
    expect(lessonRequestHeaders()).toEqual({
      "x-marina-eval": "benchmark=board-a; mode=measure",
      "x-marina-lessons": "on",
    });
    expect(await asJudge(async () => lessonRequestHeaders())).toEqual({});
  });

  it("plain passthru opts in by model prefix or header only", () => {
    const req = (h: Record<string, string> = {}) => new Request("http://x/v1", { headers: h });
    expect(wantsLessons(req(), "openrouter/a/b")).toBe(false);
    expect(wantsLessons(req(), "marina/lessons:openrouter/a/b")).toBe(true);
    expect(wantsLessons(req({ "x-marina-lessons": "on" }), "openrouter/a/b")).toBe(true);
    expect(wantsLessons(req({ "x-marina-lessons": "0" }), "openrouter/a/b")).toBe(false);
  });

  it("resident agents opt in; MARINA_LESSONS caps it", () => {
    expect(residentLessonsMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(residentLessonsMode({ MARINA_LESSONS_RESIDENT: "on" } as NodeJS.ProcessEnv)).toBe("on");
    expect(
      residentLessonsMode({
        MARINA_LESSONS_RESIDENT: "on",
        MARINA_LESSONS: "observe",
      } as NodeJS.ProcessEnv),
    ).toBe("observe");
    expect(
      residentLessonsMode({
        MARINA_LESSONS_RESIDENT: "on",
        MARINA_LESSONS: "off",
      } as NodeJS.ProcessEnv),
    ).toBe("off");
  });
});

// ─── The ledger: backfill and per-item served lessons ───────────────────────

const IDS = Array.from({ length: 20 }, (_, i) => `item-${i}`);

function recordRun(
  db: MarinaDB,
  id: string,
  opts: {
    right: number;
    completedAt: number;
    invalid?: string;
    benchmark?: string;
    formation?: string;
  },
) {
  const items = IDS.map((item_id, i) => ({
    item_id,
    correct: i < opts.right,
    score: null,
    latency_ms: null,
    cost_usd: 0.01,
    trace_id: null,
    participants_json: null,
    judge_verdict: null,
  }));
  db.recordBenchmarkLedgerRun(
    {
      id,
      benchmark: opts.benchmark ?? "board-a",
      config_hash: id,
      config_json: "{}",
      started_at: opts.completedAt - 1,
      completed_at: opts.completedAt,
      duration_ms: 1,
      score: opts.right / IDS.length,
      answered: IDS.length,
      total: IDS.length,
      cost_usd: 0.2,
      n: IDS.length,
      ci_low: 0,
      ci_high: 1,
      seed: 1,
      slice_hash: sliceHash(IDS),
      judge: "judge/model",
      target_kind: "crew",
      target_json: JSON.stringify({
        formation: opts.formation ?? "single",
        models: { lead: "a/lead-1" },
      }),
      label: id,
      source: "import",
      content_hash: null,
      ...(opts.invalid ? { invalid_reason: opts.invalid } : {}),
    },
    items,
  );
}

describe("benchmark outcomes and the backfill", () => {
  it("a run's baseline is only runs completed by then (leakage rule on the outcome)", () => {
    const db = freshDb();
    try {
      recordRun(db, "early", { right: 10, completedAt: 1_000 });
      recordRun(db, "later-best", { right: 18, completedAt: 3_000 });
      const o = benchmarkRunOutcome(db, db.getBenchmarkRun("early")!)!;
      expect(o.detail).toContain("no comparable baseline");
      expect(o.refs).toEqual(["bench:early"]);
      expect(o.resolvedAt).toBe(new Date(1_000).toISOString());
      expect(o.scope).toBe("config");
      expect(o.subjects).toEqual(["formation:single", "lead-1"]);
      const l = benchmarkRunOutcome(db, db.getBenchmarkRun("later-best")!)!;
      expect(l.refs).toEqual(["bench:later-best", "bench:early"]);
    } finally {
      db.close();
    }
  });

  it("feeds every valid run once, skips invalid runs, and is idempotent", async () => {
    const db = freshDb();
    try {
      recordRun(db, "r1", { right: 10, completedAt: 1_000, formation: "verify" });
      recordRun(db, "r2", { right: 14, completedAt: 2_000 });
      recordRun(db, "bad", { right: 0, completedAt: 2_500, invalid: "spend cap hit" });
      recordRun(db, "r3", { right: 12, completedAt: 3_000, benchmark: "hle-verified-gold" });
      const sink = lessonSinkFor(db);
      const deps = { sink, judge: judge(0.9), meta: true };

      const dry = await backfillLedgerLessons(db, deps, { dryRun: true });
      expect(dry.learned).toBe(3);
      expect(dry.runIds).toEqual(["r1", "r2", "r3"]);

      const first = await backfillLedgerLessons(db, deps);
      expect(first).toMatchObject({ runs: 4, learned: 3, skipped: 1, existing: 0, failed: 0 });
      expect(first.trust.trusted).toBe(3);
      expect(first.mirrored).toBe(3);

      const lessons = await sink.find!("benchmark", {}, 100);
      expect(lessons).toHaveLength(3);
      const byRun = new Map(lessons.map((l) => [l.refs![0], l]));
      expect(byRun.get("bench:r1")!.resolvedAt).toBe(new Date(1_000).toISOString());
      expect(byRun.get("bench:r3")!.families).toEqual(["qa.exact"]);
      expect(byRun.get("bench:r1")!.subjects).toContain("formation:verify");
      expect(byRun.has("bench:bad")).toBe(false);
      expect((await sink.find!("meta", {}, 100)).length).toBe(3);

      const second = await backfillLedgerLessons(db, deps);
      expect(second).toMatchObject({ learned: 0, existing: 3, skipped: 1 });
      expect(await sink.find!("benchmark", {}, 100)).toHaveLength(3);
      expect(await sink.find!("meta", {}, 100)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("benchmark:import teaches by default; --no-learn opts out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lessons-import-"));
    dirs.push(dir);
    const result = (seed: number) => {
      const path = join(dir, `r${seed}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          config: { dataset: "board-import", seed },
          timestamp: 10_000 + seed,
          items: IDS.map((id, i) => ({ id, correct: i % 2 === 0, actual: "x" })),
        }),
      );
      return path;
    };
    const run = (dbPath: string, ...args: string[]) =>
      Bun.spawnSync(["bun", "scripts/benchmark-import.ts", ...args], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          DB_PATH: dbPath,
          MARINA_LESSONS: "on",
          MARINA_LESSONS_WRITER: "none",
          MARINA_DECISIONS: "off",
          // No model reachable: the lesson is recorded unverified, never trusted.
          WS_PORT: "9",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const learnDb = join(dir, "learn.db");
    const a = run(learnDb, result(1), "--target-kind", "model", "--target", "a/model");
    expect(a.exitCode).toBe(0);
    const optOut = join(dir, "nolearn.db");
    const b = run(optOut, result(2), "--target-kind", "model", "--target", "a/model", "--no-learn");
    expect(b.exitCode).toBe(0);
    const count = async (path: string) => {
      const db = new MarinaDB(path);
      try {
        return (await lessonSinkFor(db).find!("benchmark", {}, 100)).map((l) => l.trust);
      } finally {
        db.close();
      }
    };
    expect(await count(learnDb)).toEqual(["unverified"]);
    expect(await count(optOut)).toEqual([]);
  }, 60_000);

  it("files the lesson ids each item was served, ids only and append-only", () => {
    const db = freshDb();
    try {
      const file = {
        config: { dataset: "board-a", lessons_mode: "measure" },
        timestamp: 5_000,
        items: [
          {
            id: "q1",
            correct: true,
            actual: "A",
            lessons: ["l-1", "l-2"],
            lessonsObserved: ["l-3"],
          },
          { id: "q2", correct: false, actual: "B", lessons: ["bad id with spaces"] },
          { id: "q3", correct: true, actual: "C" },
        ],
      };
      const { run, items } = ledgerFromHarnessResult(file, {
        targetKind: "model",
        target: "a/model",
        raw: JSON.stringify(file),
        id: "bench_lessons",
        now: 5_000,
      });
      db.recordBenchmarkLedgerRun(run, items);
      expect(db.getBenchmarkItemLessons("bench_lessons")).toEqual([
        {
          run_id: "bench_lessons",
          item_id: "q1",
          lesson_id: "l-1",
          use: "served",
          regime: "measure",
        },
        {
          run_id: "bench_lessons",
          item_id: "q1",
          lesson_id: "l-2",
          use: "served",
          regime: "measure",
        },
        {
          run_id: "bench_lessons",
          item_id: "q1",
          lesson_id: "l-3",
          use: "observed",
          regime: "measure",
        },
      ]);
      const raw = (db as unknown as { db: import("bun:sqlite").Database }).db;
      expect(() => raw.run("UPDATE benchmark_item_lessons SET use = 'observed'")).toThrow(
        /append-only/,
      );
    } finally {
      db.close();
    }
  });
});
