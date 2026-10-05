// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionAnswer, DecisionProvider, DecisionRequest } from "../src/decisions/types";
import { lessonAdmission } from "../src/learning/admission";
import {
  type Lesson,
  type LessonSink,
  memoryLessonSink,
  type Outcome,
  recordOutcome,
  selectServed,
} from "../src/learning/outcomes";
import { rankPass } from "../src/learning/rank-pass";
import { replayRecall } from "../src/learning/replay";
import {
  enableOutcomeLearning,
  lessonSinkFor,
  noteOutcome,
  recallLessons,
  settleOutcomes,
} from "../src/learning/service";
import { admitMemoryWrite, memoryRankingMode, rankWeights } from "../src/memory/admission";
import {
  type AdmissionCandidate,
  type AdmissionNeighbour,
  admissionQuestions,
  decideAdmission,
  evidenceStrength,
  prescreen,
  RANK_FLOOR,
  RANK_WEIGHTS_V1,
  rankScore,
  readRankWeights,
} from "../src/memory/admission-policy";
import { MarinaDB } from "../src/persistence/database";

const ENV_ON = { MARINA_MEMORY_RANKING: "on" } as NodeJS.ProcessEnv;
const ENV_OBSERVE = { MARINA_MEMORY_RANKING: "observe" } as NodeJS.ProcessEnv;

interface Script {
  relation?: string;
  relationP?: number;
  value?: number;
  generality?: number;
  novelty?: number;
  evidence_fit?: number;
  lessonNoul?: number;
}

/**
 * A provider that answers lesson-judge noul questions with `lessonNoul` and
 * admission questions from `script` (a function of the request, so tests can
 * pick a neighbour by its text).
 */
function provider(
  script: Script | ((req: DecisionRequest) => Script),
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
      const s = typeof script === "function" ? script(request) : script;
      const answers: Record<string, DecisionAnswer> = {};
      for (const [k, q] of Object.entries(request.questions)) {
        if (q.type === "noul") answers[k] = { type: "noul", noul: s.lessonNoul ?? 0.9 };
        else if (q.type === "choice") {
          const choice = s.relation ?? "new";
          answers[k] = {
            type: "choice",
            choice,
            probabilities: { [choice]: s.relationP ?? 0.9 },
          };
        } else {
          const top = q.criteria.length - 1;
          const v = (s as Record<string, number | undefined>)[k] ?? top;
          answers[k] = { type: "score", score: Math.min(top, v) };
        }
      }
      return {
        answers,
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: opts.calibrated ?? true,
      };
    },
  };
}

const lesson = (text: string, over: Partial<Lesson> = {}): Lesson => ({
  domain: "code",
  text,
  kind: "failure",
  trust: "trusted",
  resolvedAt: "2026-09-01T00:00:00.000Z",
  source: "code:verify",
  scope: "method",
  ...over,
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  domain: "code",
  source: "code:verify",
  succeeded: false,
  resolvedAt: "2026-09-10T00:00:00.000Z",
  attempted: "verify a change with pytest",
  detail: "pytest collection fails when run outside the repository root",
  scope: "method",
  ...over,
});

const candidate = (text: string, over: Partial<AdmissionCandidate> = {}): AdmissionCandidate => ({
  text,
  kind: "lesson",
  trust: "trusted",
  scope: "method",
  evidence: 0.2,
  ...over,
});

const neighbour = (id: string, text: string, over: Partial<AdmissionNeighbour> = {}) =>
  ({
    id,
    version: 1,
    text,
    trust: "trusted",
    scope: "method",
    evidence: 0.2,
    actionable: true,
    ...over,
  }) as AdmissionNeighbour;

/** The facade's underlying SQLite handle, read-only use in assertions. */
const rawDb = (db: MarinaDB) => (db as unknown as { db: Database }).db;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The writer-free candidate text recordOutcome builds from `outcome()`.
const CANDIDATE_TEXT =
  "[lesson:code] failure · pytest collection fails when run outside the repository root";

describe("admission policy (pure)", () => {
  it("reads the mode switch: default off, observe, on", () => {
    expect(memoryRankingMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(memoryRankingMode({ MARINA_MEMORY_RANKING: "observe" } as NodeJS.ProcessEnv)).toBe(
      "observe",
    );
    expect(memoryRankingMode(ENV_ON)).toBe("on");
    expect(memoryRankingMode({ MARINA_MEMORY_RANKING: "junk" } as NodeJS.ProcessEnv)).toBe("off");
  });

  it("pre-screens exact and near duplicates mechanically, only within the same scope and families", () => {
    const text = "Run pytest from the repository root before reading collection errors";
    const relevant = () => true;
    const exact = prescreen(candidate(text), [neighbour("n1", `${text}.`)], relevant);
    expect(exact).toMatchObject({ kind: "duplicate", exact: true });
    const near = prescreen(candidate(`${text} always`), [neighbour("n1", text)], relevant);
    expect(near.kind).toBe("duplicate");
    // Same words, another family: not a mechanical duplicate.
    const otherFamily = prescreen(
      candidate(`${text} always`, { families: ["code"] }),
      [neighbour("n1", text, { families: ["forecast"] })],
      relevant,
    );
    expect(otherFamily.kind).toBe("judge");
    // A context-only neighbour is never a merge target.
    expect(
      prescreen(candidate(text), [neighbour("n1", text, { actionable: false })], relevant).kind,
    ).toBe("judge");
    expect(prescreen(candidate(text), [neighbour("n1", "unrelated")], () => false).kind).toBe(
      "novel",
    );
  });

  it("asks five questions with at most 25 relation options, and only the value questions when novel", () => {
    const q = admissionQuestions(8);
    expect(Object.keys(q).sort()).toEqual(
      ["evidence_fit", "generality", "novelty", "relation", "value"].sort(),
    );
    expect(Object.keys((q.relation as { criteria: object }).criteria)).toHaveLength(25);
    expect(Object.keys(admissionQuestions(0)).sort()).toEqual(
      ["evidence_fit", "generality", "value"].sort(),
    );
  });

  const n1 = neighbour("n1", "Run pytest from the repository root");
  const decide = (
    relation: string,
    p: number,
    calibrated = true,
    over: Partial<AdmissionCandidate> = {},
    nb = n1,
  ) => {
    const m = relation.match(/^(same_as|refines|contradicts)_N1$/);
    return decideAdmission({
      candidate: candidate("Run pytest from the repository root, not a subdirectory", over),
      neighbours: [nb],
      relation: m ? { kind: m[1] as never, index: 0, p } : { kind: "new", p },
      calibrated,
    });
  };

  it("same_as merges; a higher-trust duplicate supersedes instead", () => {
    expect(decide("same_as_N1", 0.8)).toMatchObject({ action: "merge", target: { id: "n1" } });
    expect(
      decide("same_as_N1", 0.8, true, { trust: "trusted" }, { ...n1, trust: "unverified" }).action,
    ).toBe("supersede");
  });

  it("uncalibrated: one cut at 0.5, and a merge also needs mechanical similarity", () => {
    expect(decide("same_as_N1", 0.55, false).action).toBe("merge"); // Jaccard ≥ 0.6
    const dissimilar = decideAdmission({
      candidate: candidate("Always pin the interpreter version in CI"),
      neighbours: [n1],
      relation: { kind: "same_as", index: 0, p: 0.95 },
      calibrated: false,
    });
    expect(dissimilar.action).toBe("new");
    expect(dissimilar.reason).toContain("uncalibrated");
  });

  it("refines supersedes, but never a higher-trust record", () => {
    expect(decide("refines_N1", 0.7).action).toBe("supersede");
    expect(decide("refines_N1", 0.7, true, { trust: "unverified" }).action).toBe("new");
  });

  it("contradicting a trusted record contests; auto-resolve needs a calibrated judge and an evidence gap", () => {
    expect(decide("contradicts_N1", 0.8)).toMatchObject({ action: "contest", autoResolve: false });
    expect(decide("contradicts_N1", 0.8, true, { evidence: 0.6 }).autoResolve).toBe(true);
    // Uncalibrated never auto-resolves.
    expect(decide("contradicts_N1", 0.8, false, { evidence: 0.9 })).toMatchObject({
      action: "contest",
      autoResolve: false,
    });
    // Contradicting an unverified record is just new.
    expect(decide("contradicts_N1", 0.8, true, {}, { ...n1, trust: "unverified" }).action).toBe(
      "new",
    );
  });

  it("an unsure relation, a context-only target or `new` writes new", () => {
    expect(decide("same_as_N1", 0.55).action).toBe("new");
    expect(decide("new", 0.9).action).toBe("new");
    expect(decide("same_as_N1", 0.9, true, {}, { ...n1, actionable: false }).action).toBe("new");
  });

  it("ranks by the fixed v1 formula times trust; weights come from a valid slot only", () => {
    const comp = (e: number) => ({ e });
    const components = {
      value: comp(1),
      generality: comp(1),
      novelty: comp(1),
      evidence_fit: comp(1),
      evidence: 1,
    };
    expect(rankScore(components, "trusted")).toBe(1);
    expect(rankScore(components, "imported")).toBe(0.6);
    expect(rankScore(components, "unverified")).toBe(0.4);
    expect(rankScore({ ...components, value: comp(0) }, "trusted")).toBe(0.65);
    expect(readRankWeights(RANK_WEIGHTS_V1)).toEqual(RANK_WEIGHTS_V1);
    expect(readRankWeights({ ...RANK_WEIGHTS_V1, value: 0.9 })).toBeUndefined();
    expect(rankWeights().source).toBe("builtin");
  });

  it("evidence strength is mechanical: supports, precision, and invalidated refs", () => {
    const single = evidenceStrength({ supports: 1 });
    expect(evidenceStrength({ supports: 4 })).toBeGreaterThan(single);
    expect(evidenceStrength({ supports: 1, n: 300 })).toBeGreaterThan(single);
    expect(evidenceStrength({ supports: 1, intervalWidth: 0.05 })).toBeGreaterThan(
      evidenceStrength({ supports: 1, intervalWidth: 0.35 }),
    );
    expect(evidenceStrength({ supports: 4, invalidShare: 1 })).toBe(0);
  });

  it("ranked serving: trust, then rank with below-floor last, then recency; contested never served", () => {
    const asOf = "2026-12-01T00:00:00.000Z";
    const ls = [
      lesson("low rank newest", {
        id: "a",
        resolvedAt: "2026-09-05T00:00:00Z",
        rank: { score: 0.1 },
      }),
      lesson("high rank oldest", {
        id: "b",
        resolvedAt: "2026-09-01T00:00:00Z",
        rank: { score: 0.9 },
      }),
      lesson("unranked middle", { id: "c", resolvedAt: "2026-09-03T00:00:00Z" }),
      lesson("held", { id: "d", contested: true }),
    ];
    expect(selectServed(ls, asOf).map((l) => l.id)).toEqual(["a", "c", "b"]);
    expect(selectServed(ls, asOf, { rankOrder: true }).map((l) => l.id)).toEqual(["b", "c", "a"]);
    expect(RANK_FLOOR).toBe(0.25);
  });
});

describe("admitMemoryWrite: degraded modes", () => {
  const set = (neighbours: AdmissionNeighbour[]) => ({
    neighbours,
    mode: "lexical" as const,
    degraded: [],
  });

  it("no backend: mechanical duplicates still merge; anything else is skipped as off", async () => {
    const text = "Run pytest from the repository root";
    expect(
      (await admitMemoryWrite(candidate(text), { neighbours: set([neighbour("n1", text)]) }))
        .action,
    ).toBe("merge");
    const r = await admitMemoryWrite(candidate("Pin the interpreter in CI"), {
      neighbours: set([neighbour("n1", text)]),
    });
    expect(r).toMatchObject({ action: "new", skipped: "no_backend" });
  });

  it("the daily spend cap skips the call; an outage is labelled, never thrown", async () => {
    const p = provider({});
    const capped = await admitMemoryWrite(candidate("Pin the interpreter in CI"), {
      neighbours: set([]),
      provider: p,
      spendCheck: () => "daily spend cap reached",
    });
    expect(capped.skipped).toBe("spend_cap");
    expect(p.requests).toHaveLength(0);
    const down = await admitMemoryWrite(candidate("Pin the interpreter in CI"), {
      neighbours: set([]),
      provider: provider({}, { fail: true }),
      spendCheck: () => undefined,
    });
    expect(down).toMatchObject({ action: "new", skipped: "judge_unavailable" });
  });

  it("novel by construction asks only the value questions and stores rank provenance", async () => {
    const p = provider({ value: 2, generality: 1, evidence_fit: 2 });
    const r = await admitMemoryWrite(candidate("Pin the interpreter in CI"), {
      neighbours: set([neighbour("n1", "Completely different words entirely")]),
      provider: p,
      spendCheck: () => undefined,
    });
    expect(Object.keys(p.requests[0]!.questions)).not.toContain("relation");
    expect(r.action).toBe("new");
    expect(r.rank).toMatchObject({
      method: "v1",
      judge: "test:test/jev",
      calibrated: true,
      weights: "builtin",
    });
    expect(r.rank!.components.novelty.e).toBe(1);
    expect(r.rank!.neighbours).toEqual([]);
  });

  it("an uncalibrated backend's rank is labelled uncalibrated", async () => {
    const r = await admitMemoryWrite(candidate("Run pytest from the repository root, always"), {
      neighbours: set([neighbour("n1", "Run pytest from the repository root")]),
      provider: provider({ relation: "contradicts_N1", relationP: 0.9 }, { calibrated: false }),
      spendCheck: () => undefined,
    });
    expect(r.rank?.calibrated).toBe(false);
    expect(r.action).toBe("contest");
    expect(r.autoResolve).toBeUndefined();
  });
});

describe("the lesson admission hook", () => {
  const base = lesson(
    "[lesson:code] failure · pytest collection fails outside the repository root",
    {
      id: "old",
      refs: ["trace:a"],
    },
  );

  it("is absent when off or with no decision backend", () => {
    expect(lessonAdmission({ env: {} as NodeJS.ProcessEnv, judge: provider({}) })).toBeUndefined();
    expect(lessonAdmission({ env: ENV_ON })).toBeUndefined();
  });

  it("observe stores the rank and the proposed action, and writes as today", async () => {
    const sink = memoryLessonSink([base]);
    const judge = provider({ relation: "same_as_N1", relationP: 0.9 });
    const admit = lessonAdmission({ env: ENV_OBSERVE, judge })!;
    const r = await recordOutcome({ sink, judge, admit }, outcome());
    expect(r.lessonId).toBeDefined();
    expect(sink.all()).toHaveLength(2);
    const written = sink.all()[1]!;
    expect(written.admission).toMatchObject({
      mode: "observe",
      action: "merge",
      applied: false,
      target: "old",
    });
    expect(written.rank?.score).toBeGreaterThan(0);
  });

  it("on: a judged duplicate merges (support, refs) and nothing new is written", async () => {
    const sink = memoryLessonSink([base]);
    const judge = provider({ relation: "same_as_N1", relationP: 0.9 });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const r = await recordOutcome({ sink, judge, admit }, outcome({ refs: ["trace:b"] }));
    expect(r).toMatchObject({ mergedInto: "old", admission: "merge" });
    expect(r.lessonId).toBeUndefined();
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0]).toMatchObject({ support: 2, refs: ["trace:a", "trace:b"] });
    expect(sink.all()[0]!.merged?.[0]).toMatchObject({ source: "code:verify", trust: "trusted" });
  });

  it("on: an exact duplicate merges without any decision call", async () => {
    const sink = memoryLessonSink([lesson(CANDIDATE_TEXT, { id: "old" })]);
    const judge = provider({});
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const r = await recordOutcome({ sink, judge, admit }, outcome());
    expect(r.mergedInto).toBe("old");
    // Only the lesson judge asked; admission made no call.
    expect(judge.requests.every((q) => !("value" in q.questions))).toBe(true);
  });

  it("on: a refinement is written and supersedes the neighbour (later resolvedAt kept)", async () => {
    const sink = memoryLessonSink([{ ...base, resolvedAt: "2026-09-20T00:00:00.000Z" }]);
    const judge = provider({ relation: "refines_N1", relationP: 0.8 });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const r = await recordOutcome({ sink, judge, admit }, outcome());
    expect(r.admission).toBe("supersede");
    expect(sink.retirements().get("old")).toMatchObject({ supersededBy: r.lessonId });
    const written = sink.all().find((l) => l.id === r.lessonId)!;
    expect(written.resolvedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("on: contradicting a trusted lesson holds the new one unserved and opens a case", async () => {
    const sink = memoryLessonSink([base]);
    const judge = provider({ relation: "contradicts_N1", relationP: 0.85 });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const r = await recordOutcome({ sink, judge, admit, meta: true }, outcome());
    expect(r.admission).toBe("contest");
    expect(r.metaId).toBeUndefined(); // a held lesson is not mirrored
    expect(sink.cases()).toEqual([expect.objectContaining({ against: "old", resolved: false })]);
    const asOf = "2026-12-01T00:00:00.000Z";
    const served = await sink.recall("code", "pytest collection repository", asOf);
    expect(served.map((l) => l.id)).toEqual(["old"]);
    // Resolving the case for the new lesson (the old one retired) releases it.
    await sink.retire!("code", "old", { reason: "resolved", by: "curator" });
    const after = await sink.recall("code", "pytest collection repository", asOf);
    expect(after.map((l) => l.id)).toEqual([r.lessonId]);
  });

  it("on: a calibrated judge with an evidence gap resolves the contradiction at once", async () => {
    const sink = memoryLessonSink([base]);
    const judge = provider({ relation: "contradicts_N1", relationP: 0.85 });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    // Strong mechanical evidence: four supports and a precise ledger interval.
    const strong = await admit(
      {
        ...lesson("[lesson:code] failure · pytest collection fails inside the repository root too"),
        support: 4,
        provenance: { confirmations: "3" },
      },
      {
        outcome: outcome(),
        verdict: { trust: "trusted", reason: "passed" },
        target: "lesson",
        sink,
      },
    );
    const decision = strong as { lesson: Lesson; afterWrite?: (id: string) => Promise<void> };
    expect(decision.lesson.admission?.state).toBeUndefined();
    const { id } = await sink.write(decision.lesson);
    await decision.afterWrite!(id!);
    expect(sink.cases()[0]).toMatchObject({ resolved: true });
    expect(sink.retirements().has("old")).toBe(true);
  });

  it("an uncalibrated judge never auto-resolves", async () => {
    const sink = memoryLessonSink([base]);
    const judge = provider({ relation: "contradicts_N1", relationP: 0.9 }, { calibrated: false });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const d = (await admit(
      {
        ...lesson("[lesson:code] failure · pytest collection fails inside the repository root too"),
        support: 4,
      },
      {
        outcome: outcome(),
        verdict: { trust: "trusted", reason: "passed" },
        target: "lesson",
        sink,
      },
    )) as { lesson: Lesson };
    expect(d.lesson.admission).toMatchObject({ action: "contest", state: "contested" });
  });

  it("a rejected candidate is written unranked as an audit record", async () => {
    const sink = memoryLessonSink([base]);
    const judge = provider({ lessonNoul: 0.1, relation: "same_as_N1" });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const r = await recordOutcome({ sink, judge, admit }, outcome());
    expect(r.trust).toBe("rejected");
    expect(r.lesson.rank).toBeUndefined();
    expect(sink.all()).toHaveLength(2);
  });

  it("a judge outage under on writes as off would, labelled", async () => {
    const sink = memoryLessonSink([base]);
    const judge = provider({}, { fail: true });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const r = await recordOutcome({ sink, admit }, outcome());
    expect(r.lessonId).toBeDefined();
    expect(r.lesson.admission).toMatchObject({ skipped: "judge_unavailable", applied: false });
  });

  it("a meta mirror is admitted against the meta pool, never against its own original", async () => {
    const sink = memoryLessonSink();
    const judge = provider({ relation: "new", relationP: 0.9 });
    const admit = lessonAdmission({ env: ENV_ON, judge })!;
    const r = await recordOutcome({ sink, judge, admit, meta: true }, outcome());
    expect(r.metaId).toBeDefined();
    const mirror = sink.all().find((l) => l.id === r.metaId)!;
    expect(mirror.admission?.action).toBe("new");
    expect(mirror.admission?.target).toBeUndefined();
  });
});

describe("rank pass and offline replay", () => {
  it("the rank pass compares each lesson with EARLIER lessons only and writes nothing", async () => {
    const t = (d: number) => `2026-09-${String(d).padStart(2, "0")}T00:00:00.000Z`;
    const sink = memoryLessonSink([
      lesson("Run pytest from the repository root", { id: "a", resolvedAt: t(1) }),
      lesson("Run pytest from the repository root", { id: "b", resolvedAt: t(2) }),
      lesson("Pin the interpreter version in CI builds", { id: "c", resolvedAt: t(3) }),
      lesson("rejected one", { id: "d", trust: "rejected", resolvedAt: t(4) }),
    ]);
    const judge = provider({ relation: "new" });
    const report = await rankPass(sink, { domains: ["code"], judge });
    const byId = new Map(report.rows.map((r) => [r.id, r]));
    expect(byId.get("a")?.action).toBe("new"); // nothing before it
    expect(byId.get("b")).toMatchObject({ action: "merge", target: "a", mechanical: true });
    expect(report.domains.code).toMatchObject({ lessons: 4, rejected: 1, mechanicalMerges: 1 });
    expect(sink.all()).toHaveLength(4);
  });

  it("replay scores both arms over the same frozen pool", () => {
    const t = (d: number) => `2026-09-${String(d).padStart(2, "0")}T00:00:00.000Z`;
    const pool: Lesson[] = [];
    for (let i = 1; i <= 20; i++)
      pool.push(
        lesson(`Run pytest from the repository root variant ${i % 2 ? "x" : "x"}`, {
          id: `p${i}`,
          category: "python test run",
          resolvedAt: t(i),
        }),
      );
    for (let i = 0; i < 40; i++)
      pool.push(
        lesson(`held-out python test run lesson ${i}`, {
          id: `h${i}`,
          category: "python test run",
          resolvedAt: t(25),
        }),
      );
    const rows = pool
      .filter((l) => l.id!.startsWith("p") && l.id !== "p1")
      .map((l) => ({
        id: l.id!,
        domain: "code" as const,
        trust: "trusted" as const,
        kind: "failure" as const,
        resolvedAt: l.resolvedAt,
        action: "merge" as const,
        target: "p1",
        mechanical: true,
        reason: "exact duplicate",
      }));
    const report = replayRecall(pool, rows, { cutoff: t(21) });
    expect(report.pool).toBe(20);
    expect(report.clusters).toBe(1);
    expect(report.tasks).toBeGreaterThan(0);
    expect(report.baseline.duplicateRate).toBeGreaterThan(0.5);
    expect(report.ranked.duplicateRate).toBe(0);
    expect(report.labels).toBe("mechanical-proxy");
  });
});

describe("durable lessons: merge, resolve cases and serving", () => {
  function freshDb() {
    const dir = mkdtempSync(join(tmpdir(), "marina-admission-"));
    dirs.push(dir);
    return new MarinaDB(join(dir, "m.db"));
  }

  it("merges into the stored record, opens a pending resolve case, and holds the new lesson", async () => {
    const db = freshDb();
    try {
      const sink: LessonSink = lessonSinkFor(db);
      const { id: oldId } = await sink.write(
        lesson("[lesson:code] failure · pytest collection fails outside the repository root", {
          refs: ["trace:a"],
        }),
      );
      // A judged duplicate merges into the stored record.
      const merging = provider({ relation: "same_as_N1", relationP: 0.9 });
      const merged = await recordOutcome(
        { sink, judge: merging, admit: lessonAdmission({ env: ENV_ON, judge: merging })! },
        outcome({ refs: ["trace:b"] }),
      );
      expect(merged.mergedInto).toBe(oldId);
      const [stored] = await sink.find!("code", { id: oldId! }, 1);
      expect(stored).toMatchObject({ support: 2, refs: ["trace:a", "trace:b"] });
      expect(stored!.version).toBe(2);

      // A contradiction opens a pending resolve case and holds the new lesson.
      const contra = provider({ relation: "contradicts_N1", relationP: 0.9 });
      const held = await recordOutcome(
        { sink, judge: contra, admit: lessonAdmission({ env: ENV_ON, judge: contra })! },
        outcome({ detail: "pytest collection also fails inside the repository root" }),
      );
      expect(held.admission).toBe("contest");
      const cases = rawDb(db)
        .query<{ status: string; policy: string }, []>(
          "SELECT status, policy FROM memory_resolutions",
        )
        .all();
      expect(cases).toEqual([{ status: "pending", policy: "await_confirmation" }]);
      const asOf = "2026-12-01T00:00:00.000Z";
      const served = await recallLessons(db, "code", "pytest collection repository root", {
        env: ENV_ON,
        asOf,
        sink,
      });
      expect(served.recalled.map((l) => l.id)).toEqual([oldId]);
      // Retiring the contradicted lesson releases the held one.
      await sink.retire!("code", oldId!, { reason: "resolved by curator", by: "curator" });
      const after = await recallLessons(db, "code", "pytest collection repository root", {
        env: ENV_ON,
        asOf,
        sink,
      });
      expect(after.recalled.map((l) => l.id)).toEqual([held.lessonId]);
    } finally {
      db.close();
    }
  });

  it("auto-resolves through the resolve operator with an audit row", async () => {
    const db = freshDb();
    try {
      const sink = lessonSinkFor(db);
      const { id: oldId } = await sink.write(
        lesson("[lesson:code] failure · pytest collection fails outside the repository root"),
      );
      const judge = provider({ relation: "contradicts_N1", relationP: 0.9 });
      const admit = lessonAdmission({ env: ENV_ON, judge })!;
      const d = (await admit(
        {
          ...lesson(
            "[lesson:code] failure · pytest collection fails inside the repository root too",
          ),
          support: 4,
          refs: ["trace:x"],
          provenance: { confirmations: "3" },
        },
        {
          outcome: outcome(),
          verdict: { trust: "trusted", reason: "passed" },
          target: "lesson",
          sink,
        },
      )) as { lesson: Lesson; afterWrite: (id: string) => Promise<void> };
      expect(d.lesson.admission?.state).toBeUndefined();
      const { id } = await sink.write(d.lesson);
      await d.afterWrite(id!);
      const rows = rawDb(db)
        .query<{ status: string; policy: string }, []>(
          "SELECT status, policy FROM memory_resolutions",
        )
        .all();
      expect(rows).toEqual([{ status: "applied", policy: "last_writer_wins" }]);
      expect(await sink.find!("code", { id: oldId! }, 1)).toHaveLength(0);
      expect(await sink.find!("code", { id: id! }, 1)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("enableOutcomeLearning arms admission from MARINA_MEMORY_RANKING with the given backend", async () => {
    const db = freshDb();
    try {
      const sink = lessonSinkFor(db);
      const judge = provider({ relation: "new" });
      enableOutcomeLearning(db, { env: ENV_OBSERVE, sink, writer: null, judge });
      noteOutcome(db, outcome(), ENV_OBSERVE);
      await settleOutcomes(db);
      const [written] = await sink.find!("code", {}, 5);
      expect(written?.rank?.score).toBeGreaterThan(0);
      expect(written?.admission).toMatchObject({ mode: "observe", applied: false });
    } finally {
      db.close();
    }
  });
});
