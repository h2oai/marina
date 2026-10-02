// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  commonItems,
  comparePooled,
  poolGroup,
  type Replicate,
  seedFromIds,
} from "../benchmarks/replicate-stats";
import {
  defaultReplicateGroup,
  formatPooled,
  parseReplicates,
  poolResults,
  replicateFilePath,
  validGroupKey,
} from "../benchmarks/replicates";
import { tier0HarnessArgs } from "../benchmarks/tier0";
import type { BenchmarkResult } from "../benchmarks/types";
import { sliceHash } from "../src/engine/benchmark-ledger";
import {
  autoReplicateGroup,
  loadReplicateGroup,
  promotionMinReplicates,
  replicateGroupOf,
  replicatesOf,
} from "../src/engine/benchmark-replicates";
import { pooledCompareLines } from "../src/engine/commands/benchmark";
import { Engine } from "../src/engine/engine";
import { handleBenchmarkFile } from "../src/net/benchmarks-api";
import type { PassthruAuthResult } from "../src/net/model-api/shared";
import type { BenchmarkRunRow } from "../src/persistence/database";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const N = 60;
const IDS = Array.from({ length: N }, (_, i) => `q${i}`);

/** A replicate from a predicate over item index. */
function rep(correct: (i: number) => boolean, ids: readonly string[] = IDS): Replicate {
  return new Map(ids.map((id, i) => [id, correct(i)]));
}

describe("replicate statistics", () => {
  it("pools to the mean over items, with majority, SD and agreement", () => {
    // Three replicates: identical on 50 items, they disagree on 10.
    const reps = [
      rep((i) => i < 30 || (i >= 50 && i < 55)),
      rep((i) => i < 30 || (i >= 52 && i < 57)),
      rep((i) => i < 30 || (i >= 55 && i < 60)),
    ];
    const g = poolGroup(reps);
    expect(g.replicates).toBe(3);
    expect(g.items).toBe(N);
    expect(g.replicateAccuracies).toEqual([35 / 60, 35 / 60, 35 / 60]);
    expect(g.meanAccuracy).toBeCloseTo(35 / 60, 10);
    expect(g.betweenSd).toBe(0);
    expect(g.unanimous).toBeLessThan(1);
    expect(g.pairwiseAgreement).toBeLessThan(1);
    // Majority: an item counts when ≥ 2 of 3 replicates got it.
    expect(g.majorityAccuracy).toBeGreaterThan(30 / 60);
  });

  it("uses only items every replicate answered, never counting a missing item as wrong", () => {
    const a = rep(() => true);
    const b = rep(() => true, IDS.slice(0, 40));
    expect(commonItems([[a, b]])).toHaveLength(40);
    expect(poolGroup([a, b]).meanAccuracy).toBe(1);
  });

  it("a single replicate pools to itself with no between-run variance", () => {
    const g = poolGroup([rep((i) => i % 2 === 0)]);
    expect(g.meanAccuracy).toBe(0.5);
    expect(g.betweenSd).toBe(0);
    expect(g.unanimous).toBe(1);
  });

  it("the two-stage bootstrap separates a real gain from noise and is deterministic", () => {
    const strong = [rep((i) => i < 50), rep((i) => i < 49 || i === 55), rep((i) => i < 51)];
    const weak = [rep((i) => i < 30), rep((i) => i < 31), rep((i) => i < 29 || i === 59)];
    const c = comparePooled(strong, weak, { seed: 7, resamples: 1000 });
    expect(c.replicated).toBe(true);
    expect(c.delta).toBeGreaterThan(0.3);
    expect(c.low).toBeGreaterThan(0);
    expect(c.p).toBeLessThan(0.01);
    expect(c.pairP.pairs).toBe(9);
    expect(comparePooled(strong, weak, { seed: 7, resamples: 1000 })).toEqual(c);

    // Two groups of the same configuration: the interval straddles zero.
    const same = comparePooled(strong, strong.slice().reverse(), { seed: 3, resamples: 1000 });
    expect(same.low).toBeLessThanOrEqual(0);
    expect(same.high).toBeGreaterThanOrEqual(0);
    expect(same.p).toBeGreaterThan(0.5);
  });

  it("puts run-to-run variance in the interval: a noisy group's interval is wider", () => {
    const base = [rep((i) => i < 30), rep((i) => i < 30)];
    // Same mean, but one replicate collapsed (a degraded run): runs disagree a lot.
    const steady = [rep((i) => i < 40), rep((i) => i < 40)];
    const noisy = [rep((i) => i < 56), rep((i) => i < 24)];
    const cs = comparePooled(steady, base, { seed: 1, resamples: 2000 });
    const cn = comparePooled(noisy, base, { seed: 1, resamples: 2000 });
    expect(cn.delta).toBeCloseTo(cs.delta, 10);
    expect(cn.high - cn.low).toBeGreaterThan(cs.high - cs.low);
  });

  it("flags a comparison with one replicate on a side as not replicated", () => {
    const c = comparePooled([rep((i) => i < 40)], [rep((i) => i < 30), rep((i) => i < 31)]);
    expect(c.replicated).toBe(false);
  });

  it("derives the bootstrap seed from the run ids, order-free", () => {
    expect(seedFromIds(["b", "a"])).toBe(seedFromIds(["a", "b"]));
    expect(seedFromIds(["a", "b"])).not.toBe(seedFromIds(["a", "c"]));
  });
});

describe("harness replicate helpers", () => {
  it("parses --replicates within bounds", () => {
    expect(parseReplicates(undefined)).toBe(1);
    expect(parseReplicates("3")).toBe(3);
    expect(() => parseReplicates("0")).toThrow();
    expect(() => parseReplicates("2.5")).toThrow();
    expect(() => parseReplicates("99")).toThrow();
  });

  it("keeps one result file per replicate", () => {
    expect(replicateFilePath("/out/hle.json", 1, 1)).toBe("/out/hle.json");
    expect(replicateFilePath("/out/hle.json", 2, 3)).toBe("/out/hle.rep2.json");
  });

  it("names a fresh valid group, and refuses auto: keys from users", () => {
    const g = defaultReplicateGroup("marina:answerer", 1_700_000_000_000);
    expect(validGroupKey(g)).toBe(true);
    expect(g.startsWith("rep:marina_answerer:")).toBe(true);
    expect(validGroupKey("auto:abc")).toBe(false);
    expect(validGroupKey("has space")).toBe(false);
  });

  it("pools finished results and formats the summary", () => {
    const result = (pattern: boolean[]) =>
      ({
        items: pattern.map((correct, i) => ({ id: `i${i}`, correct })),
      }) as unknown as BenchmarkResult;
    const pooled = poolResults([result([true, true, false]), result([true, false, false])]);
    expect(pooled.meanAccuracy).toBeCloseTo(0.5, 10);
    expect(formatPooled("hle", pooled)).toContain("×2 replicates");
  });

  it("tier0 passes the replicate group to every filed child", () => {
    const args = tier0HarnessArgs(
      { benchmark: "hle-verified-gold", limit: 5 },
      { endpoint: "http://x", model: "marina:answerer", label: "marina_answerer" },
      {
        seed: 42,
        concurrency: 1,
        filing: {
          fileTo: "http://x",
          targetKind: "crew",
          target: '{"crew":"answerer"}',
          label: "l",
        },
        group: "rep:g:1",
      },
    );
    expect(args.slice(args.indexOf("--group"), args.indexOf("--group") + 2)).toEqual([
      "--group",
      "rep:g:1",
    ]);
  });
});

describe("replicate groups in the ledger", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-replicates-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "Lobby", long: "Lobby." }));
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  function record(
    id: string,
    correct: (i: number) => boolean,
    extra: { target?: unknown; judge?: string; group?: string | null; started?: number } = {},
  ) {
    db.recordBenchmarkLedgerRun(
      {
        id,
        benchmark: "synthetic",
        config_hash: id,
        config_json: "{}",
        agent_id: null,
        started_at: extra.started ?? 0,
        completed_at: 1,
        duration_ms: 1,
        score: IDS.filter((_, i) => correct(i)).length / N,
        answered: N,
        total: N,
        cost_usd: null,
        n: N,
        ci_low: 0,
        ci_high: 1,
        seed: 1,
        slice_hash: sliceHash(IDS),
        judge: extra.judge ?? "judge/model",
        target_kind: "crew",
        target_json: JSON.stringify(extra.target ?? { crew: "answerer", formation: "v" }),
        label: id,
        source: "import",
        content_hash: null,
        replicate_group: extra.group ?? null,
      },
      IDS.map((item_id, i) => ({
        item_id,
        correct: correct(i),
        score: null,
        latency_ms: null,
        cost_usd: null,
        trace_id: null,
        participants_json: null,
        judge_verdict: null,
      })),
    );
    return db.getBenchmarkRun(id) as BenchmarkRunRow;
  }

  function send(cmd: string): string {
    const conn = new MockConnection(`c-${Math.random()}`);
    engine.addConnection(conn);
    engine.login(conn.id, `Viewer${Math.floor(Math.random() * 1e6)}`);
    conn.clear();
    engine.processCommand(conn.entity!, cmd);
    return stripAnsi(conn.allTextJoined());
  }

  it("auto-groups runs of the same target, slice and judge, whatever the key order", () => {
    const a = record("a1", (i) => i < 40, { target: { crew: "answerer", formation: "v" } });
    const b = record("a2", (i) => i < 38, { target: { formation: "v", crew: "answerer" } });
    const other = record("b1", (i) => i < 30, { target: { crew: "answerer", formation: "w" } });
    const judged = record("a3", (i) => i < 40, { judge: "other/judge" });
    expect(autoReplicateGroup(a)).toBe(autoReplicateGroup(b));
    expect(replicateGroupOf(a)).not.toBe(replicateGroupOf(other));
    expect(replicateGroupOf(a)).not.toBe(replicateGroupOf(judged));
    expect(replicatesOf(db, a).map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("an explicit group wins, and the operator can regroup recorded runs", () => {
    const x = record("x1", (i) => i < 40, { group: "civ" });
    record("x2", (i) => i < 39, { target: { crew: "answerer", note: "relabelled" } });
    expect(replicatesOf(db, x).map((r) => r.id)).toEqual(["x1"]);
    expect(db.setBenchmarkReplicateGroup(["x2"], "civ")).toBe(1);
    const g = loadReplicateGroup(db, x);
    expect(g.runs.map((r) => r.id)).toEqual(["x1", "x2"]);
    expect(g.warnings).toContain("replicates record different targets");
  });

  it("compare shows the pooled view with replicates, and flags single runs", () => {
    const a1 = record("s1", (i) => i < 50, { group: "strong" });
    record("s2", (i) => i < 49, { group: "strong" });
    const b1 = record("w1", (i) => i < 30, { group: "weak" });
    record("w2", (i) => i < 31, { group: "weak" });
    const out = send(`benchmark compare ${a1.id} ${b1.id}`);
    expect(out).toContain("pooled  A ×2 vs B ×2 replicates");
    expect(out).toContain("two-stage bootstrap");
    expect(out).toContain("single-pair McNemar p across 4 replicate pair(s)");

    const lone = record("lone", (i) => i < 45);
    const solo = record("solo", (i) => i < 35, { target: { crew: "other" } });
    expect(send(`benchmark compare ${lone.id} ${solo.id}`)).toContain("not replicated");
    expect(
      pooledCompareLines(loadReplicateGroup(db, a1), loadReplicateGroup(db, lone)).join("\n"),
    ).toContain("B has 1 replicate");
  });

  it("benchmark replicates and the leaderboard show the group's spread", () => {
    record("r1", (i) => i < 40, { group: "g1", started: 1 });
    record("r2", (i) => i < 34, { group: "g1", started: 2 });
    const detail = send("benchmark replicates r1");
    expect(detail).toContain("Replicates — g1");
    expect(detail).toContain("between runs: SD");
    expect(detail).toContain("unanimous on");
    const board = send("benchmark leaderboard synthetic");
    expect(board).toContain("replicate groups (pooled)");
    expect(board).toContain("×2 replicates");
    expect(send("benchmark replicates nope")).toContain("No run nope");
  });

  it("POST /v1/benchmarks/runs files into a named group and refuses bad keys", async () => {
    const keyed = { matchedKey: "k", internal: false, openMode: false } as PassthruAuthResult;
    const post = (group: unknown, seedLabel: string) =>
      handleBenchmarkFile(
        new Request("http://local/v1/benchmarks/runs", {
          method: "POST",
          body: JSON.stringify({
            targetKind: "crew",
            target: { crew: "answerer" },
            label: seedLabel,
            judge: "judge/model",
            ...(group === undefined ? {} : { replicateGroup: group }),
            result: {
              config: { dataset: "synthetic-set", seed: 1 },
              timestamp: Date.now(),
              items: [
                { id: "i1", correct: true, note: seedLabel },
                { id: "i2", correct: false },
              ],
            },
          }),
        }),
        engine,
        keyed,
      );
    const ok = await post("rep:t:1", "one");
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { runId: string; replicateGroup: string };
    expect(body.replicateGroup).toBe("rep:t:1");
    expect(db.getBenchmarkRun(body.runId)?.replicate_group).toBe("rep:t:1");
    expect((await post("auto:forged", "two")).status).toBe(400);
    expect((await post(42, "three")).status).toBe(400);
  });

  it("reads the promotion minimum from the environment, defaulting to 2", () => {
    expect(promotionMinReplicates({})).toBe(2);
    expect(promotionMinReplicates({ MARINA_PROMOTION_MIN_REPLICATES: "3" })).toBe(3);
    expect(promotionMinReplicates({ MARINA_PROMOTION_MIN_REPLICATES: "1" })).toBe(1);
    expect(promotionMinReplicates({ MARINA_PROMOTION_MIN_REPLICATES: "0" })).toBe(2);
    expect(promotionMinReplicates({ MARINA_PROMOTION_MIN_REPLICATES: "lots" })).toBe(2);
  });
});
