// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pairedBootstrap as selectPairedBootstrap } from "../benchmarks/forecasting/select";
import {
  adapterFor,
  arenaEvaluateAdapter,
  arenaPairedAdapter,
  browsecompAdapter,
  collapseTrials,
  futurexAdapter,
  harnessAdapter,
  itemsAdapter,
  ledgerAdapter,
  loadRuns,
  longmemevalAdapter,
  pairedRunAdapter,
  tau2Adapter,
} from "../benchmarks/transfer/adapters";
import {
  analyzeSuite,
  bootstrapMean,
  type ItemScore,
  pairItems,
  renderMarkdown,
  type SuiteData,
  signTest,
  transferVerdict,
  twoStageBootstrap,
} from "../benchmarks/transfer/core";
import { buildInventory, renderInventory } from "../benchmarks/transfer/inventory";
import {
  listLedgerRuns,
  openReadOnly,
  runVariant,
  selectRuns,
} from "../benchmarks/transfer/ledger";
import { applySplit, loadSuites, parseSpec, type TransferSpec } from "../benchmarks/transfer/spec";
import { itemSplit } from "../src/engine/benchmark-promotion";
import { mulberry32 } from "../src/stats";

const dir = mkdtempSync(join(tmpdir(), "eval-transfer-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Synthetic paired suite: baseline ~ U(0,1), candidate = baseline + shift + noise. */
function synth(
  name: string,
  opts: { n?: number; shift: number; noise?: number; seed?: number; group?: string },
): SuiteData {
  const rand = mulberry32(opts.seed ?? 7);
  const n = opts.n ?? 60;
  const noise = opts.noise ?? 0.1;
  const base: ItemScore[] = [];
  const cand: ItemScore[] = [];
  for (let i = 0; i < n; i++) {
    const b = rand();
    base.push({ id: `${name}-${i}`, score: b });
    cand.push({ id: `${name}-${i}`, score: b + opts.shift + (rand() - 0.5) * 2 * noise });
  }
  return {
    name,
    group: opts.group ?? name,
    baseline: [base],
    candidate: [cand],
    split: "all items (not held out)",
  };
}

describe("sign test (exact two-sided binomial)", () => {
  test("exact p-values", () => {
    expect(signTest([...Array(9).fill(1), -1]).p).toBeCloseTo(22 / 1024, 12);
    expect(signTest(Array(10).fill(0.5)).p).toBeCloseTo(2 / 1024, 12);
    expect(signTest([...Array(8).fill(1), -1, -1]).p).toBeCloseTo(112 / 1024, 12);
    expect(signTest([...Array(6).fill(1), -2, 0, 0, 0]).p).toBeCloseTo(16 / 128, 12);
    expect(signTest([...Array(5).fill(1), ...Array(5).fill(-1)]).p).toBe(1);
  });
  test("ties are dropped and counted; no discordant pair ⇒ p = 1", () => {
    expect(signTest([0, 0, 1e-15, -1e-15])).toEqual({ wins: 0, losses: 0, ties: 4, p: 1 });
    expect(signTest([])).toEqual({ wins: 0, losses: 0, ties: 0, p: 1 });
    const s = signTest([1, -1, 0, 2]);
    expect([s.wins, s.losses, s.ties]).toEqual([2, 1, 1]);
  });
});

describe("bootstrap of the mean delta", () => {
  test("reproducible for a seed, different across seeds", () => {
    const d = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 0.3 + 0.05);
    const a = bootstrapMean(d, { seed: 3, resamples: 2000 });
    expect(bootstrapMean(d, { seed: 3, resamples: 2000 })).toEqual(a);
    expect(bootstrapMean(d, { seed: 4, resamples: 2000 })).not.toEqual(a);
    expect(a.low).toBeLessThanOrEqual(a.mean);
    expect(a.high).toBeGreaterThanOrEqual(a.mean);
  });

  test("matches an independent re-implementation of the percentile bootstrap", () => {
    const d = [0.1, -0.2, 0.3, 0.05, 0, 0.4, -0.1, 0.2];
    const got = bootstrapMean(d, { seed: 11, resamples: 500, level: 0.9 });
    const rand = mulberry32(11);
    const means: number[] = [];
    for (let r = 0; r < 500; r++) {
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]!;
      means.push(s / d.length);
    }
    means.sort((x, y) => x - y);
    expect(got.mean).toBeCloseTo(0.0938, 4);
    expect(got.low).toBeCloseTo(means[Math.floor(0.05 * 500)]!, 12);
    expect(got.high).toBeCloseTo(means[Math.floor(0.95 * 500)]!, 12);
  });

  test("constant deltas give a degenerate interval; empty input gives zeros", () => {
    expect(bootstrapMean([0.25, 0.25, 0.25], { resamples: 100 })).toEqual({
      mean: 0.25,
      low: 0.25,
      high: 0.25,
      resamples: 100,
    });
    expect(bootstrapMean([])).toEqual({ mean: 0, low: 0, high: 0, resamples: 0 });
  });

  test("covers the true mean in most synthetic draws", () => {
    let covered = 0;
    for (let t = 0; t < 40; t++) {
      const rand = mulberry32(100 + t);
      const d = Array.from({ length: 50 }, () => 0.1 + (rand() - 0.5));
      const b = bootstrapMean(d, { seed: t + 1, resamples: 1000 });
      if (b.low <= 0.1 && 0.1 <= b.high) covered++;
    }
    expect(covered).toBeGreaterThanOrEqual(34);
  });
});

describe("pairing", () => {
  test("ids in every run of both arms only; excluded ids leave both arms", () => {
    const suite: SuiteData = {
      name: "s",
      group: "s",
      split: "all",
      baseline: [
        [
          { id: "a", score: 1 },
          { id: "b", score: 0 },
          { id: "c", score: 0, exclude: "leak" },
        ],
        [
          { id: "a", score: 0 },
          { id: "b", score: 0 },
          { id: "c", score: 1 },
        ],
      ],
      candidate: [
        [
          { id: "a", score: 1 },
          { id: "c", score: 1 },
          { id: "d", score: 1 },
        ],
      ],
    };
    expect(pairItems(suite)).toEqual({ ids: ["a"], unpaired: 2, excluded: { leak: 1 } });
    const r = analyzeSuite(suite, { minItems: 1 });
    // Baseline replicates average to 0.5 on "a".
    expect(r.baselineMean).toBe(0.5);
    expect(r.candidateMean).toBe(1);
    expect(r.removed).toEqual({ leak: 1 });
  });
});

describe("suite outcomes and the transfer verdict", () => {
  test("clear improvement on two independent groups transfers", () => {
    const r = transferVerdict([
      synth("a", { shift: 0.1, seed: 1 }),
      synth("b", { shift: 0.1, seed: 2 }),
      synth("c", { shift: 0, noise: 0.05, seed: 3 }),
    ]);
    expect(r.suites.map((s) => s.outcome)).toEqual(["improves", "improves", "no-difference"]);
    expect(r.verdict).toBe("transfers");
    expect(r.improvedGroups).toEqual(["a", "b"]);
  });

  test("two improving suites in ONE group count once", () => {
    const r = transferVerdict([
      synth("a1", { shift: 0.1, seed: 1, group: "futurex" }),
      synth("a2", { shift: 0.1, seed: 2, group: "futurex" }),
      synth("b", { shift: 0, noise: 0.05, seed: 3 }),
    ]);
    expect(r.verdict).toBe("does-not-transfer");
    expect(r.improvedGroups).toEqual(["futurex"]);
  });

  test("any significant regression vetoes", () => {
    const r = transferVerdict([
      synth("a", { shift: 0.1, seed: 1 }),
      synth("b", { shift: 0.1, seed: 2 }),
      synth("c", { shift: -0.08, seed: 3 }),
    ]);
    expect(r.suites[2]!.outcome).toBe("regresses");
    expect(r.verdict).toBe("regresses");
    expect(r.regressedSuites).toEqual(["c"]);
  });

  test("a sign-test-only loss is a regression; a sign-test-only gain is not an improvement", () => {
    // Many tiny losses and one large gain: the mean is positive, the signs are not.
    const mk = (big: number, tiny: number): SuiteData => {
      const base = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, score: 0.5 }));
      const cand = base.map((x, i) => ({ ...x, score: x.score + (i === 0 ? big : tiny) }));
      return { name: "s", group: "s", split: "all", baseline: [base], candidate: [cand] };
    };
    const losing = analyzeSuite(mk(5, -0.01));
    expect(losing.delta.mean).toBeGreaterThan(0);
    expect(losing.sign.p).toBeLessThan(0.05);
    expect(losing.outcome).toBe("regresses");
    // Many tiny gains with one huge loss: signs agree on a gain, the interval does not.
    const gaining = analyzeSuite(mk(-5, 0.01));
    expect(gaining.sign.p).toBeLessThan(0.05);
    expect(gaining.delta.low).toBeLessThan(0);
    expect(gaining.outcome).toBe("no-difference");
  });

  test("too few paired items is insufficient, and too few judged groups is insufficient", () => {
    const r = transferVerdict([synth("a", { shift: 0.2, n: 5 }), synth("b", { shift: 0.2 })]);
    expect(r.suites[0]!.outcome).toBe("insufficient");
    expect(r.verdict).toBe("insufficient");
  });

  test("the margin raises the bar on the interval's low end", () => {
    const s = synth("a", { shift: 0.05, seed: 5 });
    expect(analyzeSuite(s).outcome).toBe("improves");
    expect(analyzeSuite(s, { margin: 0.2 }).outcome).toBe("no-difference");
  });

  test("adding a suite never moves an earlier suite's interval", () => {
    const a = synth("a", { shift: 0.05, seed: 5 });
    const one = transferVerdict([a]).suites[0]!.delta;
    const two = transferVerdict([a, synth("b", { shift: 0 })]).suites[0]!.delta;
    expect(two).toEqual(one);
  });

  test("markdown names the verdict, the overlays and every suite", () => {
    const r = transferVerdict([synth("a", { shift: 0.1 }), synth("b", { shift: 0.1, seed: 9 })]);
    const md = renderMarkdown(r, {
      baseline: { label: "base" },
      candidate: { label: "cand", env: { MARINA_FORECAST_VERIFY: "on" } },
    });
    expect(md).toContain("**Verdict: transfers**");
    expect(md).toContain("`MARINA_FORECAST_VERIFY=on`");
    expect(md).toContain("| a | a |");
    expect(md).toContain("| b | b |");
  });
});

describe("adapters", () => {
  const write = (name: string, body: unknown) => {
    const p = join(dir, name);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };

  test("items: JSON array, {items}, and JSONL", () => {
    const rows = [
      { id: "a", score: 1, at: "2026-01-01T00:00:00Z" },
      { id: "b", score: 0.5, exclude: "dup" },
    ];
    const expected = [
      { id: "a", score: 1, at: "2026-01-01T00:00:00Z" },
      { id: "b", score: 0.5, exclude: "dup" },
    ];
    const one = (path: string) => loadRuns(itemsAdapter, { path });
    expect(one(write("i.json", rows))).toEqual([expected]);
    expect(one(write("i2.json", { items: rows }))).toEqual([expected]);
    const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
    expect(one(write("i.jsonl", jsonl))).toEqual([expected]);
    // Records without an id or a score are not items.
    expect(one(write("bad.json", [{ id: 1 }, { score: 2 }]))).toEqual([]);
  });

  test("harness: score, else correct", () => {
    const p = write("h.json", {
      config: {},
      items: [
        { id: "q1", correct: true },
        { id: "q2", correct: false },
        { id: "q3", correct: false, score: 0.4 },
      ],
    });
    expect(harnessAdapter.load!({ path: p })).toEqual([
      { id: "q1", score: 1 },
      { id: "q2", score: 0 },
      { id: "q3", score: 0.4 },
    ]);
  });

  test("harness: <task>#<trial> items collapse to one item per task (mean over trials)", () => {
    const p = write("h-trials.json", {
      config: {},
      items: [
        { id: "13#0", correct: true },
        { id: "13#1", correct: false },
        { id: "13#2", correct: true },
        { id: "13#3", correct: true },
        { id: "8#0", correct: false },
        { id: "8#1", correct: false },
      ],
    });
    expect(harnessAdapter.load!({ path: p })).toEqual([
      { id: "13", score: 0.75 },
      { id: "8", score: 0 },
    ]);
    // Opt-out keeps the trial rows; a run with any other id shape is left alone.
    expect(harnessAdapter.load!({ path: p, options: { trials: "keep" } })).toHaveLength(6);
    expect(
      collapseTrials([
        { id: "a#1", score: 1 },
        { id: "b", score: 0 },
      ]),
    ).toEqual([
      { id: "a#1", score: 1 },
      { id: "b", score: 0 },
    ]);
  });

  test("trial collapse keeps one task on one side of the held-out split", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => String(i));
    const items = tasks.flatMap((t) =>
      [0, 1, 2, 3].map((k) => ({ id: `${t}#${k}`, correct: (Number(t) + k) % 2 === 0 })),
    );
    const p = write("h-split.json", { config: {}, items });
    const removed = new Map<string, Set<string>>();
    const kept = applySplit(harnessAdapter.load!({ path: p }), { kind: "hash" }, "tau2", removed);
    expect(kept.length).toBeGreaterThan(0);
    for (const x of kept) {
      expect(x.id).not.toContain("#");
      expect(itemSplit("transfer:tau2", x.id, 0.5)).toBe("holdout");
    }
    expect(kept.length + removed.get("not in holdout split")!.size).toBe(tasks.length);
  });

  test("futurex: run dir with cutoffs and leak-audit exclusions", () => {
    const run = join(dir, "fx", "cheap-date-filtered-lessons-off-r1");
    write("fx/cheap-date-filtered-lessons-off-r1/score.json", {
      overall: 0.5,
      byLevel: {},
      items: [
        { id: "r1", level: 1, score: 1, metric: "exact" },
        { id: "r2", level: 3, score: 0.25, metric: "string" },
      ],
    });
    write("fx/cheap-date-filtered-lessons-off-r1/answers.json", {
      variant: "cheap",
      results: [
        { id: "r1", cutoff: "2026-08-01T00:00:00.000Z" },
        { id: "r2", cutoff: "2026-08-02T00:00:00.000Z" },
      ],
    });
    write("fx/cheap-date-filtered-lessons-off-r1/audit.json", [
      { id: "r1", suspicious: false },
      { id: "r2", suspicious: true },
    ]);
    const expected = [
      { id: "r1", score: 1, at: "2026-08-01T00:00:00.000Z" },
      { id: "r2", score: 0.25, at: "2026-08-02T00:00:00.000Z", exclude: "leak-audit flag" },
    ];
    expect(futurexAdapter.load!({ path: run })).toEqual(expected);
    expect(futurexAdapter.load!({ path: join(run, "score.json") })).toEqual(expected);
    expect(futurexAdapter.load!({ path: run, options: { audit: "off" } })[1]).not.toHaveProperty(
      "exclude",
    );
  });

  test("arena-evaluate: one column per arm, shapes included, tracker filter", () => {
    const p = write("arena-eval.json", {
      rounds: [
        {
          roundId: "civiqs-w1",
          tracker: "civiqs",
          results: { baseline: { skill: 0.1 }, x: { skill: 0.2 } },
        },
        {
          roundId: "yougov-w1",
          tracker: "yougov",
          results: { baseline: { skill: -0.1 }, x: { skill: 0 } },
        },
      ],
      shapes: { rounds: [{ roundId: "wiki-w1", results: { baseline: { skill: 0.3 } } }] },
    });
    expect(arenaEvaluateAdapter.load!({ path: p, arm: "x" })).toEqual([
      { id: "civiqs-w1", score: 0.2 },
      { id: "yougov-w1", score: 0 },
    ]);
    expect(arenaEvaluateAdapter.load!({ path: p, arm: "baseline" })).toHaveLength(3);
    expect(
      arenaEvaluateAdapter.load!({ path: p, arm: "baseline", options: { tracker: "civiqs" } }),
    ).toEqual([{ id: "civiqs-w1", score: 0.1 }]);
    expect(() => arenaEvaluateAdapter.load!({ path: p })).toThrow(/needs "arm"/);
    expect(() => arenaEvaluateAdapter.load!({ path: p, arm: "nope" })).toThrow(/no round/);
  });

  test("arena-paired: eligible batches only", () => {
    const p = write("paired.json", [
      {
        roundId: "r1",
        variant: "v",
        eligible: true,
        results: { start: { skill: 0.1 }, delphi: { skill: 0.3 } },
      },
      { roundId: "r2", variant: "v", eligible: false, results: { start: {}, delphi: {} } },
    ]);
    expect(arenaPairedAdapter.load!({ path: p, arm: "delphi" })).toEqual([
      { id: "r1/v", score: 0.3 },
    ]);
  });

  test("unknown adapters are refused with the known list", () => {
    expect(() => adapterFor("nope")).toThrow(/known: items, harness, futurex/);
    expect(() => adapterFor("__proto__")).toThrow(/unknown adapter/);
  });
});

describe("spec: splits, ingest and run", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: `q${i}`, score: i % 2 }));

  test("hash split is the promotion itemSplit, and holdout ∪ selection is everything", () => {
    const removed = new Map<string, Set<string>>();
    const hold = applySplit(items, { kind: "hash", slot: "transfer:x" }, "x", removed);
    const sel = applySplit(
      items,
      { kind: "hash", slot: "transfer:x", part: "selection" },
      "x",
      removed,
    );
    expect(hold.length + sel.length).toBe(items.length);
    for (const x of hold) expect(itemSplit("transfer:x", x.id, 0.5)).toBe("holdout");
    expect(hold.length).toBeGreaterThan(70);
    expect(hold.length).toBeLessThan(130);
    // Default slot is transfer:<group>.
    expect(applySplit(items, { kind: "hash" }, "x", new Map())).toEqual(hold);
  });

  test("time split keeps items at or after the date and drops untimed ones", () => {
    const removed = new Map<string, Set<string>>();
    const kept = applySplit(
      [
        { id: "a", score: 1, at: "2026-01-01T00:00:00Z" },
        { id: "b", score: 1, at: "2026-03-01T00:00:00Z" },
        { id: "c", score: 1 },
      ],
      { kind: "time", after: "2026-02-01" },
      "g",
      removed,
    );
    expect(kept.map((x) => x.id)).toEqual(["b"]);
    expect(removed.get("before the time split")?.size).toBe(1);
    expect(removed.get("no timestamp (time split)")?.size).toBe(1);
  });

  test("parseSpec refuses malformed specs", () => {
    expect(() => parseSpec({})).toThrow(/baseline.label/);
    const arms = { baseline: { label: "a" }, candidate: { label: "b" } };
    expect(() => parseSpec({ ...arms, suites: [] })).toThrow(/non-empty/);
    expect(() =>
      parseSpec({ ...arms, suites: [{ name: "s", adapter: "x", baseline: [] }] }),
    ).toThrow(/unknown adapter/);
    expect(() => parseSpec({ ...arms, suites: [{ name: "s", adapter: "items" }] })).toThrow(
      /sources or a run/,
    );
    expect(() =>
      parseSpec({ baseline: { label: "a", env: { X: 1 } }, candidate: { label: "b" }, suites: [] }),
    ).toThrow(/strings/);
  });

  test("ingest resolves paths against the spec directory and counts split removals per item", () => {
    const sub = join(dir, "spec1");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "b.json"), JSON.stringify(items));
    writeFileSync(join(sub, "c.json"), JSON.stringify(items.map((x) => ({ ...x, score: 1 }))));
    const spec: TransferSpec = {
      baseline: { label: "b" },
      candidate: { label: "c" },
      suites: [
        { name: "s", adapter: "items", baseline: ["b.json", "b.json"], candidate: ["c.json"] },
      ],
    };
    const [s] = loadSuites(spec, { baseDir: sub });
    expect(s!.baseline).toHaveLength(2);
    const held = s!.baseline[0]!.length;
    expect(s!.removed).toEqual({ "not in holdout split": items.length - held });
    expect(s!.split).toBe("holdout 50 % of transfer:s");
    const [all] = loadSuites(spec, { baseDir: sub, split: "all" });
    expect(all!.baseline[0]).toHaveLength(items.length);
  });

  test("run suites are refused unless allowed, then run per arm and replicate with the overlay", () => {
    const spec: TransferSpec = {
      baseline: { label: "base", env: { KNOB: "0" } },
      candidate: { label: "cand", env: { KNOB: "1" } },
      suites: [
        {
          name: "sim",
          adapter: "items",
          run: {
            command: ["sim", "--out", "{out}", "--arm", "{arm}", "{replicate}"],
            replicates: 2,
          },
        },
      ],
    };
    expect(() => loadSuites(spec, { baseDir: dir })).toThrow(/running is off/);
    const calls: Array<{ argv: string[]; knob?: string }> = [];
    const suites = loadSuites(spec, {
      baseDir: dir,
      allowRun: true,
      outDir: join(dir, "runs"),
      split: "all",
      env: { PATH: "/bin", KNOB: "stale" },
      runner: (argv, { env }) => {
        calls.push({ argv, knob: env.KNOB });
        const out = argv[2]!;
        const knob = Number(env.KNOB);
        writeFileSync(out, JSON.stringify(items.map((x) => ({ id: x.id, score: x.score + knob }))));
        return 0;
      },
    });
    expect(calls.map((c) => [c.argv[4], c.argv[5], c.knob])).toEqual([
      ["base", "1", "0"],
      ["base", "2", "0"],
      ["cand", "1", "1"],
      ["cand", "2", "1"],
    ]);
    expect(calls[0]!.argv[2]).toBe(join(dir, "runs", "sim", "base-r1.json"));
    const r = transferVerdict(suites);
    expect(r.suites[0]!.delta.mean).toBe(1);
    expect(() =>
      loadSuites(spec, {
        baseDir: dir,
        allowRun: true,
        outDir: join(dir, "runs"),
        runner: () => 3,
      }),
    ).toThrow(/exited 3/);
  });
});

describe("CLI", () => {
  test("writes markdown and JSON and exits 0 only on transfers", () => {
    const sub = join(dir, "cli");
    mkdirSync(sub, { recursive: true });
    const suites = [synth("a", { shift: 0.1, seed: 1 }), synth("b", { shift: 0.1, seed: 2 })];
    // Both arms stamped with one clean commit: the version guard lets them count.
    const marina = { commit: "a".repeat(40), dirty: false, describe: "aaaaaaa" };
    for (const s of suites) {
      writeFileSync(
        join(sub, `${s.name}-base.json`),
        JSON.stringify({ marina, items: s.baseline[0] }),
      );
      writeFileSync(
        join(sub, `${s.name}-cand.json`),
        JSON.stringify({ marina, items: s.candidate[0] }),
      );
    }
    const spec = {
      baseline: { label: "base" },
      candidate: { label: "cand", env: { SOME_KNOB: "on" } },
      split: "all",
      stats: { resamples: 2000 },
      suites: suites.map((s) => ({
        name: s.name,
        adapter: "items",
        baseline: [`${s.name}-base.json`],
        candidate: [`${s.name}-cand.json`],
      })),
    };
    writeFileSync(join(sub, "spec.json"), JSON.stringify(spec));
    const out = join(sub, "report");
    const run = (extra: string[]) =>
      Bun.spawnSync(
        [
          "bun",
          "run",
          resolve(import.meta.dir, "../scripts/eval-transfer.ts"),
          "--spec",
          join(sub, "spec.json"),
          "--out",
          out,
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    const ok = run([]);
    expect(ok.exitCode).toBe(0);
    expect(existsSync(`${out}.md`)).toBe(true);
    const json = JSON.parse(readFileSync(`${out}.json`, "utf8"));
    expect(json.verdict).toBe("transfers");
    expect(json.candidate.env).toEqual({ SOME_KNOB: "on" });
    expect(json.suites).toHaveLength(2);
    // A margin no suite clears: the verdict is not "transfers", exit 2.
    expect(run(["--margin", "0.5"]).exitCode).toBe(2);
    expect(run(["--split", "sideways"]).exitCode).toBe(1);
  });
});

describe("two-stage replicate bootstrap", () => {
  const runs = (seed: number, n: number, reps: number, shift: number) => {
    const rand = mulberry32(seed);
    return Array.from({ length: reps }, () => {
      const m = new Map<string, number>();
      for (let i = 0; i < n; i++)
        m.set(`q${i}`, Math.min(1, Math.max(0, 0.5 + shift + (rand() - 0.5))));
      return m;
    });
  };

  test("matches benchmarks/forecasting/select.ts pairedBootstrap for the same seed", () => {
    const cand = runs(1, 30, 3, 0.1);
    const base = runs(2, 30, 2, 0);
    const ids = [...cand[0]!.keys()];
    const ours = twoStageBootstrap(cand, base, ids, { seed: 11, resamples: 2000 });
    const theirs = selectPairedBootstrap(cand, base, ids, 2000, 11);
    expect(Math.round(ours.mean * 1e4) / 1e4).toBe(theirs.diff);
    expect(Math.round(ours.low * 1e4) / 1e4).toBe(theirs.ci[0]);
    expect(Math.round(ours.high * 1e4) / 1e4).toBe(theirs.ci[1]);
  });

  test("one replicate per arm reduces to an item bootstrap; replicate noise widens it", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `q${i}`);
    const one = (f: (i: number) => number) => [new Map(ids.map((id, i) => [id, f(i)]))];
    const flat = twoStageBootstrap(
      one(() => 1),
      one(() => 0),
      ids,
      { resamples: 500 },
    );
    expect(flat).toEqual({ mean: 1, low: 1, high: 1, resamples: 500 });
    const noisy = twoStageBootstrap(
      [new Map(ids.map((id) => [id, 1])), new Map(ids.map((id) => [id, 0]))],
      one(() => 0),
      ids,
      { resamples: 500 },
    );
    expect(noisy.mean).toBe(0.5);
    expect(noisy.low).toBe(0);
    expect(noisy.high).toBe(1);
  });

  test("selected through the options, and named in the report", () => {
    const s: SuiteData = {
      name: "s",
      group: "s",
      split: "all",
      baseline: [0, 1].map((r) =>
        Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, score: 0.4 + r * 0.01 })),
      ),
      candidate: [0, 1].map((r) =>
        Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, score: 0.6 + r * 0.01 })),
      ),
    };
    const r = transferVerdict([s], { bootstrap: "two-stage", minGroups: 1 });
    expect(r.suites[0]!.delta.mean).toBeCloseTo(0.2, 12);
    expect(r.options.bootstrap).toBe("two-stage");
    expect(renderMarkdown(r, { baseline: { label: "a" }, candidate: { label: "b" } })).toContain(
      "two-stage (replicate runs, then items)",
    );
  });
});

describe("items adapter: variants, replicates and field maps", () => {
  const w = (name: string, body: string) => {
    const p = join(dir, "items2", name);
    mkdirSync(join(dir, "items2"), { recursive: true });
    writeFileSync(p, body);
    return p;
  };

  test("one JSONL file splits into arms by variant and runs by replicate", () => {
    const lines = [
      { id: "a", score: 1, variant: "base", replicate: 1 },
      { id: "b", score: 0, variant: "base", replicate: 1 },
      { id: "a", score: 0, variant: "base", replicate: 2 },
      { id: "a", score: 1, variant: "cand" },
      { id: "b", score: true, variant: "cand" },
    ];
    const p = w("multi.jsonl", lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(() => loadRuns(itemsAdapter, { path: p })).toThrow(/variants base, cand: give "arm"/);
    expect(loadRuns(itemsAdapter, { path: p, arm: "base" })).toEqual([
      [
        { id: "a", score: 1 },
        { id: "b", score: 0 },
      ],
      [{ id: "a", score: 0 }],
    ]);
    expect(loadRuns(itemsAdapter, { path: p, arm: "cand" })).toEqual([
      [
        { id: "a", score: 1 },
        { id: "b", score: 1 },
      ],
    ]);
    expect(() => loadRuns(itemsAdapter, { path: p, arm: "nope" })).toThrow(/no scored record/);
  });

  test("field options remap nested records; duplicates average; unscored records drop", () => {
    const p = w(
      "nested.json",
      JSON.stringify({
        data: {
          rows: [
            { q: { key: 7 }, r: { ok: 0.5 } },
            { q: { key: 7 }, r: { ok: 1 } },
            { q: { key: 8 }, r: { alt: 0.2 } },
            { q: { key: 9 }, r: {} },
          ],
        },
      }),
    );
    expect(
      loadRuns(itemsAdapter, {
        path: p,
        options: { records: "data.rows", id: "q.key", score: "r.ok|r.alt" },
      }),
    ).toEqual([
      [
        { id: "7", score: 0.75 },
        { id: "8", score: 0.2 },
      ],
    ]);
  });

  test("presets: tau2 trials, browsecomp evals directory, LongMemEval, paired-run attempts", () => {
    const tau = w(
      "tau.json",
      JSON.stringify({
        info: { environment_info: { domain_name: "airline" } },
        simulations: [
          { task_id: "1", trial: 0, reward_info: { reward: 1 } },
          { task_id: "2", trial: 0, reward_info: { reward: 0 } },
          { task_id: "1", trial: 1, reward_info: { reward: 0 } },
        ],
      }),
    );
    expect(loadRuns(tau2Adapter, { path: tau })).toEqual([
      [
        { id: "1", score: 1 },
        { id: "2", score: 0 },
      ],
      [{ id: "1", score: 0 }],
    ]);
    const evals = join(dir, "items2", "evals");
    mkdirSync(evals, { recursive: true });
    writeFileSync(
      join(evals, "run_1_eval.json"),
      JSON.stringify({ query_id: "11", judge_result: { correct: true } }),
    );
    writeFileSync(
      join(evals, "run_2_eval.json"),
      JSON.stringify({ query_id: "12", judge_result: { correct: false } }),
    );
    expect(loadRuns(browsecompAdapter, { path: evals })).toEqual([
      [
        { id: "11", score: 1 },
        { id: "12", score: 0 },
      ],
    ]);
    const lme = w("per_question.jsonl", `${JSON.stringify({ question_id: "x", score: 1 })}\n`);
    expect(loadRuns(longmemevalAdapter, { path: lme })).toEqual([[{ id: "x", score: 1 }]]);
    const pr = w(
      "analysis.json",
      JSON.stringify({
        arms: {},
        terminal: {
          attempts: [
            { task: "t1", arm: "bare", model: "gpt", reward: 1 },
            { task: "t1", arm: "on", model: "gpt", reward: 0 },
          ],
        },
      }),
    );
    expect(
      loadRuns(pairedRunAdapter, { path: pr, arm: "on/gpt", options: { suite: "terminal" } }),
    ).toEqual([[{ id: "t1", score: 0 }]]);
    expect(() => loadRuns(pairedRunAdapter, { path: pr, arm: "on/gpt" })).toThrow(/options.suite/);
  });
});

/** A minimal benchmark ledger (the columns the reader uses). */
function makeLedger(path: string, wal = false) {
  const db = new Database(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE benchmark_runs (id TEXT PRIMARY KEY, benchmark TEXT NOT NULL, config_json TEXT NOT NULL,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, label TEXT,
    source TEXT NOT NULL DEFAULT 'in-world', replicate_group TEXT);
  CREATE TABLE benchmark_items (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, item_id TEXT NOT NULL,
    correct INTEGER NOT NULL, score REAL);
  CREATE TABLE benchmark_run_validity (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, action TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE TABLE benchmark_run_regroups (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, to_group TEXT NOT NULL,
    created_at INTEGER NOT NULL);`);
  const run = db.prepare(
    "INSERT INTO benchmark_runs (id, benchmark, config_json, status, started_at, label, replicate_group) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const item = db.prepare(
    "INSERT INTO benchmark_items (run_id, item_id, correct, score) VALUES (?, ?, ?, ?)",
  );
  const add = (
    id: string,
    label: string,
    day: string,
    shift: number,
    extra: Partial<{ group: string; status: string; bench: string }> = {},
  ) => {
    run.run(
      id,
      extra.bench ?? "fb-backtest",
      JSON.stringify({ model: "m" }),
      extra.status ?? "completed",
      Date.parse(day),
      label,
      extra.group ?? null,
    );
    for (let i = 0; i < 12; i++)
      item.run(id, `q${i}`, 0, i % 3 === 0 ? null : Math.min(1, 0.5 + shift + i / 100));
  };
  add("r1", "base r1", "2026-09-01", 0, { group: "g:base" });
  add("r2", "base r2", "2026-09-02", 0, { group: "g:base" });
  add("r3", "cand r1", "2026-09-03", 0.2, { group: "g:cand" });
  add("r4", "cand r2", "2026-09-20", 0.2, { group: "g:cand" });
  add("r5", "cand r3", "2026-09-21", 0.2);
  add("r6", "running", "2026-09-22", 0, { status: "running" });
  db.prepare(
    "INSERT INTO benchmark_run_validity (run_id, action, created_at) VALUES (?, ?, ?)",
  ).run("r5", "invalidate", 1);
  db.prepare(
    "INSERT INTO benchmark_run_regroups (run_id, to_group, created_at) VALUES (?, ?, ?)",
  ).run("r4", "g:moved", 1);
  return db;
}

describe("ledger adapter (read-only)", () => {
  const ldir = join(dir, "ledger");
  mkdirSync(ldir, { recursive: true });
  const path = join(ldir, "world.db");
  makeLedger(path).close();

  test("never creates sidecar files on a DB without a write-ahead log", () => {
    const before = readdirSync(ldir).sort();
    const h = openReadOnly(path);
    expect(listLedgerRuns(h.db)).toHaveLength(6);
    h.close();
    expect(readdirSync(ldir).sort()).toEqual(before);
  });

  test("runs carry effective group, validity and variant; filters select them", () => {
    const h = openReadOnly(path);
    const runs = listLedgerRuns(h.db);
    h.close();
    const r4 = runs.find((r) => r.id === "r4")!;
    expect(r4.group).toBe("g:moved");
    expect(runs.find((r) => r.id === "r5")!.invalid).toBe(true);
    expect(runVariant(r4)).toBe("cand");
    expect(runVariant({ id: "x", label: "mech-verify+P r12" })).toBe("mech-verify+P");
    expect(runVariant({ id: "x", model: "m" })).toBe("m");
    const ids = (f: Parameters<typeof selectRuns>[1]) => selectRuns(runs, f).map((r) => r.id);
    expect(ids({ label: "cand" })).toEqual(["r3", "r4"]);
    expect(ids({ label: "cand", includeInvalid: true })).toEqual(["r3", "r4", "r5"]);
    expect(ids({ label: "c*", since: "2026-09-10" })).toEqual(["r4"]);
    expect(ids({ group: "g:*", until: "2026-09-03" })).toEqual(["r1", "r2"]);
    expect(ids({ run: "r1,r6" })).toEqual(["r1"]);
    expect(ids({ run: "r1,r6", status: "any" })).toEqual(["r1", "r6"]);
    expect(ids({ label: "*", benchmark: "nope" })).toEqual([]);
  });

  test("loads one replicate per selected run; score else correct", () => {
    const base = loadRuns(ledgerAdapter, { path, arm: "base" });
    expect(base).toHaveLength(2);
    expect(base[0]!.find((x) => x.id === "q0")!.score).toBe(0);
    expect(base[0]!.find((x) => x.id === "q1")!.score).toBeCloseTo(0.51, 12);
    expect(loadRuns(ledgerAdapter, { path, options: { run: "r3" } })).toHaveLength(1);
    expect(() => loadRuns(ledgerAdapter, { path })).toThrow(/select runs/);
    expect(() => loadRuns(ledgerAdapter, { path, arm: "zzz" })).toThrow(/no ledger run matches/);
  });

  test("τ²-style <task>#<trial> ledger items collapse to tasks", () => {
    const tpath = join(ldir, "tau.db");
    const db = makeLedger(tpath);
    db.prepare(
      "INSERT INTO benchmark_runs (id, benchmark, config_json, status, started_at, label) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t1", "tau2-airline", "{}", "completed", Date.parse("2026-10-03"), "sig-A");
    const add = db.prepare(
      "INSERT INTO benchmark_items (run_id, item_id, correct, score) VALUES (?, ?, ?, ?)",
    );
    for (const [id, ok] of [
      ["13#0", 1],
      ["13#1", 0],
      ["16#0", 1],
      ["16#1", 1],
    ] as const)
      add.run("t1", id, ok, ok);
    db.close();
    expect(loadRuns(ledgerAdapter, { path: tpath, arm: "sig-A" })).toEqual([
      [
        { id: "13", score: 0.5 },
        { id: "16", score: 1 },
      ],
    ]);
    expect(
      loadRuns(ledgerAdapter, { path: tpath, arm: "sig-A", options: { trials: "keep" } })[0],
    ).toHaveLength(4);
  });

  test("reads rows still in the write-ahead log through a temporary copy", () => {
    const walPath = join(ldir, "live.db");
    const writer = makeLedger(walPath, true);
    expect(existsSync(`${walPath}-wal`)).toBe(true);
    const h = openReadOnly(walPath);
    expect(listLedgerRuns(h.db)).toHaveLength(6);
    h.close();
    const capped = openReadOnly(walPath, { maxCopyBytes: 1 });
    expect(capped.note).toMatch(/not read/);
    capped.close();
    writer.close();
  });

  test("a suite pairs ledger arms end to end", () => {
    const spec: TransferSpec = {
      baseline: { label: "base" },
      candidate: { label: "cand" },
      split: "all",
      suites: [
        {
          name: "fb",
          adapter: "ledger",
          arms: { baseline: "base", candidate: "cand" },
          baseline: ["world.db"],
          candidate: ["world.db"],
        },
      ],
    };
    const [s] = loadSuites(spec, { baseDir: ldir });
    expect(s!.baseline).toHaveLength(2);
    expect(s!.candidate).toHaveLength(2);
    const r = analyzeSuite(s!, { minItems: 5 });
    expect(r.paired).toBe(12);
    expect(r.sign.wins).toBe(8);
    expect(r.sign.ties).toBe(4);
  });
});

describe("inventory", () => {
  test("finds files and ledgers, merges replicates, lists pairs and drops identical ones", () => {
    const root = join(dir, "inv");
    mkdirSync(join(root, "run", "src"), { recursive: true });
    mkdirSync(join(root, "harness"), { recursive: true });
    const items = (shift: number) =>
      Array.from({ length: 12 }, (_, i) => ({
        id: `q${i}`,
        correct: i % 2 === 0,
        score: 0.3 + shift + i / 100,
      }));
    const harness = (model: string, shift: number) =>
      JSON.stringify({ config: { dataset: "fb-backtest", model }, items: items(shift) });
    writeFileSync(join(root, "harness", "a.json"), harness("base", 0));
    writeFileSync(join(root, "harness", "b.json"), harness("cand", 0.1));
    // A byte-identical copy counts once; a file under src/ is never read.
    mkdirSync(join(root, "copy"), { recursive: true });
    writeFileSync(join(root, "copy", "a.json"), harness("base", 0));
    writeFileSync(join(root, "run", "src", "c.json"), harness("hidden", 0.5));
    const jsonl = ["x", "y"]
      .flatMap((v, k) =>
        Array.from({ length: 11 }, (_, i) => ({
          id: `z${i}`,
          score: k ? 1 : i % 2,
          variant: v,
          suite: "zz",
        })),
      )
      .map((r) => JSON.stringify(r))
      .join("\n");
    writeFileSync(join(root, "run", "arms.jsonl"), jsonl);
    makeLedger(join(root, "w.db")).close();
    const before = readdirSync(root).sort();

    const inv = buildInventory({ roots: [root] });
    expect(readdirSync(root).sort()).toEqual(before);
    expect(inv.duplicates).toBe(1);
    const fb = inv.suites.find((s) => s.suite === "fb")!;
    expect(fb.group).toBe("fb");
    const labels = fb.variants.map((v) => v.label).sort();
    expect(labels).toContain("base");
    expect(labels).toContain("cand");
    expect(labels).not.toContain("hidden");
    const cand = fb.variants.find((v) => v.adapter === "ledger" && v.label.startsWith("cand"))!;
    expect(cand.recordedFrom).toBe("2026-09-03");
    // Ledger base r1/r2 are replicates of one variant.
    expect(
      fb.variants.find((v) => v.adapter === "ledger" && v.label.startsWith("base"))!.replicates,
    ).toBe(2);
    const pair = fb.pairs.find((p) => p.baseline === "base" && p.candidate === "cand")!;
    expect(pair.overlap).toBe(12);
    expect(pair.suite.adapter).toBe("harness");
    // Mixed-format pairs tag each source with its adapter.
    const mixed = fb.pairs.find(
      (p) => p.suite.baseline[0]!.adapter !== p.suite.candidate[0]!.adapter,
    );
    expect(mixed).toBeDefined();
    const zz = inv.suites.find((s) => s.suite === "zz")!;
    expect(zz.variants.map((v) => v.sources[0]!.arm).sort()).toEqual(["x", "y"]);
    expect(zz.pairs).toHaveLength(1);
    expect(renderInventory(inv)).toContain("| fb |");
  });

  test("a pair entry runs through the transfer report as is", () => {
    const root = join(dir, "inv");
    const inv = buildInventory({ roots: [root] });
    const pair = inv.suites.find((s) => s.suite === "fb")!.pairs[0]!;
    const [s] = loadSuites(
      { baseline: { label: "a" }, candidate: { label: "b" }, split: "all", suites: [pair.suite] },
      { baseDir: root },
    );
    expect(analyzeSuite(s!, { minItems: 5 }).paired).toBe(pair.overlap);
  });
});
