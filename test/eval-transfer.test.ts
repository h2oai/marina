// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mulberry32 } from "../benchmarks/stats";
import {
  adapterFor,
  arenaEvaluateAdapter,
  arenaPairedAdapter,
  futurexAdapter,
  harnessAdapter,
  itemsAdapter,
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
} from "../benchmarks/transfer/core";
import { applySplit, loadSuites, parseSpec, type TransferSpec } from "../benchmarks/transfer/spec";
import { itemSplit } from "../src/engine/benchmark-promotion";

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
    expect(itemsAdapter.load({ path: write("i.json", rows) })).toEqual(expected);
    expect(itemsAdapter.load({ path: write("i2.json", { items: rows }) })).toEqual(expected);
    const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
    expect(itemsAdapter.load({ path: write("i.jsonl", jsonl) })).toEqual(expected);
    expect(() => itemsAdapter.load({ path: write("bad.json", [{ id: 1 }]) })).toThrow(/needs/);
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
    expect(harnessAdapter.load({ path: p })).toEqual([
      { id: "q1", score: 1 },
      { id: "q2", score: 0 },
      { id: "q3", score: 0.4 },
    ]);
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
    expect(futurexAdapter.load({ path: run })).toEqual(expected);
    expect(futurexAdapter.load({ path: join(run, "score.json") })).toEqual(expected);
    expect(futurexAdapter.load({ path: run, options: { audit: "off" } })[1]).not.toHaveProperty(
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
    expect(arenaEvaluateAdapter.load({ path: p, arm: "x" })).toEqual([
      { id: "civiqs-w1", score: 0.2 },
      { id: "yougov-w1", score: 0 },
    ]);
    expect(arenaEvaluateAdapter.load({ path: p, arm: "baseline" })).toHaveLength(3);
    expect(
      arenaEvaluateAdapter.load({ path: p, arm: "baseline", options: { tracker: "civiqs" } }),
    ).toEqual([{ id: "civiqs-w1", score: 0.1 }]);
    expect(() => arenaEvaluateAdapter.load({ path: p })).toThrow(/needs "arm"/);
    expect(() => arenaEvaluateAdapter.load({ path: p, arm: "nope" })).toThrow(/no round/);
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
    expect(arenaPairedAdapter.load({ path: p, arm: "delphi" })).toEqual([
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
    for (const s of suites) {
      writeFileSync(join(sub, `${s.name}-base.json`), JSON.stringify(s.baseline[0]));
      writeFileSync(join(sub, `${s.name}-cand.json`), JSON.stringify(s.candidate[0]));
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
