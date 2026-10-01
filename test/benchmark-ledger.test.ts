// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  compareRuns,
  type HarnessResultFile,
  ledgerFromHarnessResult,
  paretoFrontier,
  participantCredit,
  redactConfig,
  sliceHash,
  summarizeItems,
} from "../src/engine/benchmark-ledger";
import { Engine } from "../src/engine/engine";
import { RETENTION_POLICIES } from "../src/engine/retention";
import type { BenchmarkItemRow, BenchmarkRunRow } from "../src/persistence/database";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

/** A synthetic harness result: `pattern[i]` says whether item i was correct. */
function harnessFile(pattern: boolean[], opts: { cost?: number; judge?: string } = {}) {
  const file: HarnessResultFile = {
    config: {
      name: "Synthetic",
      dataset: "synthetic-set",
      model: "vendor/model-x",
      apiKey: "sk-secret-should-never-land",
      seed: 7,
      judge: { model: opts.judge ?? "judge/model", endpoint: "http://judge.local" },
    },
    timestamp: 1_000_000,
    duration_ms: 5_000,
    metadata: opts.cost === undefined ? {} : { usage: { costUsd: opts.cost } },
    items: pattern.map((correct, i) => ({
      id: `item-${i}`,
      correct,
      score: correct ? 1 : 0,
      latencyMs: 100 + i,
      usage: { costUsd: opts.cost === undefined ? 0.01 : opts.cost / pattern.length },
      // Content fields the ledger must never read into its rows.
      question: `secret question ${i}`,
      expected: `secret answer ${i}`,
      rawResponse: `secret response ${i}`,
    })) as HarnessResultFile["items"],
  };
  return file;
}

function itemRow(
  runId: string,
  id: string,
  correct: boolean,
  extra: Partial<BenchmarkItemRow> = {},
) {
  return {
    id: 0,
    run_id: runId,
    item_id: id,
    correct: correct ? 1 : 0,
    score: null,
    latency_ms: null,
    cost_usd: null,
    trace_id: null,
    participants_json: null,
    judge_verdict: null,
    ...extra,
  } as BenchmarkItemRow;
}

describe("benchmark ledger — pure functions", () => {
  it("slice hash ignores item order", () => {
    expect(sliceHash(["b", "a", "c"])).toBe(sliceHash(["a", "b", "c"]));
    expect(sliceHash(["a", "b"])).not.toBe(sliceHash(["a", "c"]));
  });

  it("summarizes accuracy with a Wilson interval and prices only fully-priced runs", () => {
    const s = summarizeItems([
      { correct: true, cost_usd: 0.1 },
      { correct: false, cost_usd: 0.1 },
    ]);
    expect(s.accuracy).toBe(0.5);
    expect(s.ciLow).toBeGreaterThan(0);
    expect(s.ciHigh).toBeLessThan(1);
    expect(s.costPerItemUsd).toBeCloseTo(0.1);
    expect(
      summarizeItems([{ correct: true, cost_usd: 0.1 }, { correct: true }]).costUsd,
    ).toBeNull();
    expect(summarizeItems([{ correct: true }], 2).costPerItemUsd).toBe(2);
  });

  it("compares paired on shared items with McNemar and flags unlike pairings", () => {
    const base = { benchmark: "s", slice_hash: "x", judge: "j" } as BenchmarkRunRow;
    const a = ["1", "2", "3", "4"].map((id, i) => itemRow("A", id, i < 3));
    const b = ["1", "2", "3", "5"].map((id) => itemRow("B", id, id === "1"));
    const c = compareRuns({ ...base }, a, { ...base, judge: "other" }, b);
    expect(c.shared).toBe(3);
    expect(c.onlyA).toBe(1);
    expect(c.onlyB).toBe(1);
    expect(c.aWins).toBe(2);
    expect(c.bWins).toBe(0);
    expect(c.p).toBeCloseTo(0.5);
    expect(c.warnings.join(" ")).toContain("different judges");
  });

  it("keeps only undominated runs on the frontier, cheapest first", () => {
    const pts = [
      { id: "cheap-weak", accuracy: 0.5, costPerItemUsd: 0.01 },
      { id: "dominated", accuracy: 0.5, costPerItemUsd: 0.05 },
      { id: "strong", accuracy: 0.9, costPerItemUsd: 0.2 },
      { id: "mid", accuracy: 0.7, costPerItemUsd: 0.05 },
    ];
    expect(paretoFrontier(pts).map((p) => p.id)).toEqual(["cheap-weak", "mid", "strong"]);
  });

  it("credits each agent and model once per item it touched", () => {
    const p = (ps: object[]) => JSON.stringify(ps);
    const { credit, withParticipants } = participantCredit([
      itemRow("R", "1", true, {
        participants_json: p([
          { agent: "Answerer", model: "m1" },
          { agent: "Math", model: "m1" },
        ]),
      }),
      itemRow("R", "2", false, { participants_json: p([{ agent: "Answerer", model: "m2" }]) }),
      itemRow("R", "3", true),
    ]);
    expect(withParticipants).toBe(2);
    const get = (kind: string, name: string) =>
      credit.find((c) => c.kind === kind && c.name === name);
    expect(get("agent", "Answerer")).toMatchObject({ items: 2, correct: 1 });
    expect(get("model", "m1")).toMatchObject({ items: 1, correct: 1 });
    expect(get("agent", "Math")?.accuracy).toBe(1);
  });

  it("drops credentials from the stored config", () => {
    expect(redactConfig({ apiKey: "k", judge: { model: "m", token: "t" }, seed: 1 })).toEqual({
      judge: { model: "m" },
      seed: 1,
    });
  });

  it("builds a ledger run from a harness result without any case content", () => {
    const raw = JSON.stringify(harnessFile([true, false, true], { cost: 0.5 }));
    const { run, items } = ledgerFromHarnessResult(JSON.parse(raw), {
      targetKind: "model",
      target: "vendor/model-x",
      raw,
      id: "run-1",
      now: 2_000_000,
    });
    expect(run.benchmark).toBe("synthetic-set");
    expect(run.n).toBe(3);
    expect(run.score).toBeCloseTo(2 / 3);
    expect(run.cost_usd).toBe(0.5);
    expect(run.judge).toBe("judge/model @ http://judge.local");
    expect(run.seed).toBe(7);
    expect(run.started_at).toBe(1_000_000 - 5_000);
    const stored = JSON.stringify({ run, items });
    expect(stored).not.toContain("sk-secret");
    expect(stored).not.toContain("secret question");
    expect(stored).not.toContain("secret answer");
    expect(stored).not.toContain("secret response");
  });
});

describe("benchmark ledger — persistence and commands", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
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
    pattern: boolean[],
    opts: { cost?: number; judge?: string; participants?: boolean } = {},
  ) {
    const file = harnessFile(pattern, opts);
    if (opts.participants && file.items) {
      file.items = file.items.map((it, i) => ({
        ...it,
        participants: [{ agent: i % 2 ? "Math" : "Answerer", model: `m${i % 2}` }],
      }));
    }
    const raw = JSON.stringify({ ...file, tag: id });
    const { run, items } = ledgerFromHarnessResult(JSON.parse(raw), {
      targetKind: "crew",
      target: { crew: "answerer", formation: id },
      label: id,
      raw,
      id,
      now: Date.now(),
    });
    return db.recordBenchmarkLedgerRun(run, items);
  }

  function run(cmd: string): string {
    const conn = new MockConnection(`c-${Math.random()}`);
    engine.addConnection(conn);
    engine.login(conn.id, `Viewer${Math.floor(Math.random() * 1e6)}`);
    conn.clear();
    engine.processCommand(conn.entity!, cmd);
    return stripAnsi(conn.allTextJoined());
  }

  it("records a run once and keeps its items append-only", () => {
    expect(record("r1", [true, false])).toEqual({ id: "r1", created: true });
    const again = harnessFile([true, false]);
    const raw = JSON.stringify({ ...again, tag: "r1" });
    const { run: r, items } = ledgerFromHarnessResult(JSON.parse(raw), {
      targetKind: "crew",
      target: {},
      raw,
      id: "r1-dup",
      now: Date.now(),
    });
    expect(db.recordBenchmarkLedgerRun(r, items)).toEqual({ id: "r1", created: false });
    expect(db.getBenchmarkItems("r1")).toHaveLength(2);
    expect(() =>
      (db as unknown as { db: { run: (s: string) => void } }).db.run(
        "UPDATE benchmark_items SET correct = 1",
      ),
    ).toThrow(/append-only/);
  });

  it("never prunes the ledger", () => {
    const kinds = Object.fromEntries(RETENTION_POLICIES.map((p) => [p.table, p.kind]));
    expect(kinds.benchmark_runs).toBe("append-only");
    expect(kinds.benchmark_items).toBe("append-only");
  });

  it("benchmark compare pairs two runs on shared items", () => {
    record("weak", [true, false, false, false], { cost: 0.04 });
    record("strong", [true, true, true, false], { cost: 0.4 });
    const text = run("benchmark compare weak strong");
    expect(text).toContain("shared 4");
    expect(text).toContain("A right / B wrong 0");
    expect(text).toContain("A wrong / B right 2");
    expect(text).toContain("exact McNemar p=0.500");
    expect(text).toContain("+$0.090");
  });

  it("benchmark compare warns when the judges differ", () => {
    record("j1", [true, false]);
    record("j2", [true, true], { judge: "another/judge" });
    expect(run("benchmark compare j1 j2")).toContain("different judges");
  });

  it("leaderboard shows the ledger columns and frontier lists the Pareto set", () => {
    record("cheap", [true, false, false, false], { cost: 0.04 });
    record("pricey-worse", [false, false, false, false], { cost: 4 });
    record("best", [true, true, true, true], { cost: 0.8 });
    const board = run("benchmark leaderboard synthetic-set");
    expect(board).toMatch(/n=4 CI \[/);
    expect(board).toContain("/item");
    const frontier = run("benchmark frontier synthetic-set");
    expect(frontier).toContain("2 of 3 priced runs");
    expect(frontier).toContain("cheap");
    expect(frontier).toContain("best");
    expect(frontier).not.toContain("pricey-worse");
  });

  it("benchmark participants credits agents and models, and says when none are recorded", () => {
    record("bare", [true, false]);
    expect(run("benchmark participants synthetic-set")).toContain("No participants recorded");
    record("attributed", [true, true, false, false], { participants: true });
    const text = run("benchmark participants synthetic-set");
    expect(text).toContain("4 of 6 items attributed");
    expect(text).toContain("Answerer");
    expect(text).toContain("m1");
  });
});
