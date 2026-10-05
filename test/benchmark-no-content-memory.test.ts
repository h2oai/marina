// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * No benchmark path writes an item's question, expected answer or model answer
 * to memory: a memorised answer contaminates every later run of the same
 * benchmark and bypasses the judged lesson loop. Runs teach through ONE
 * outcome per run (ids, score, category accuracy) that the lesson loop turns
 * into a judged, general rule.
 *
 *   - dynamic: the runner, the import composition and POST /v1/benchmarks/runs
 *     are fed items whose text is a sentinel; afterwards no table in the
 *     database, no lesson and nothing the lesson writer saw contains it;
 *   - static: the files on those paths (and the harness) call no memory write;
 *   - legacy: `benchmark purge-content-notes` retires the per-item notes older
 *     runners left in `benchmark:<name>` pools, dry run first, audited.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider } from "../src/decisions/types";
import { ledgerFromHarnessResult } from "../src/engine/benchmark-ledger";
import {
  BenchmarkRunner,
  categoryAccuracy,
  purgeBenchmarkContentNotes,
} from "../src/engine/benchmark-runner";
import { Engine } from "../src/engine/engine";
import { grant } from "../src/engine/safety-gates";
import { benchmarkRunOutcome, noteBenchmarkRun } from "../src/learning/intake";
import { memoryLessonSink } from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  settleOutcomes,
} from "../src/learning/service";
import { handleBenchmarkFile } from "../src/net/benchmarks-api";
import type { PassthruAuthResult } from "../src/net/model-api/shared";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const Q = "SENTINELQUESTION";
const E = "SENTINELEXPECTED";
const A = "SENTINELACTUAL";
const SENTINELS = [Q, E, A];

/** The run's own lesson(s), without the cross-board `meta` mirror a transferable one gets. */
const producerLessons = (sink: ReturnType<typeof memoryLessonSink>) =>
  sink.all().filter((l) => l.domain !== "meta");

/** Harness items whose question/expected/actual text is a sentinel. */
function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    question: `${Q} ${i}: which option is right?`,
    expected: `${E}-${i}`,
    actual: `${A}-${i}`,
    correct: i % 3 === 0,
    category: i % 2 ? "algebra" : "geometry",
  }));
}

/** Every text value in every table, so a sentinel anywhere in the database is found. */
function databaseText(db: MarinaDB): string {
  const raw = (db as unknown as { db: Database }).db;
  const tables = raw
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const parts: string[] = [];
  for (const { name } of tables) {
    // FTS shadow tables hold the same text as their content table.
    if (/_(data|idx|docsize|config|content)$/.test(name)) continue;
    try {
      parts.push(JSON.stringify(raw.query(`SELECT * FROM "${name}"`).all()));
    } catch {
      // allow-empty-catch: a virtual table this build cannot read is not a write site
    }
  }
  return parts.join("\n");
}

function expectNoSentinel(text: string, where: string) {
  for (const s of SENTINELS) {
    if (text.includes(s)) throw new Error(`${where} contains ${s}`);
  }
}

/** A calibrated judge answering every lesson question with the given probabilities. */
function judge(answers: Record<string, number> = {}): DecisionProvider {
  return {
    kind: "test",
    model: "test/jev",
    calibrated: true,
    async ask(request) {
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: answers[k] ?? 0.9 }]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      } as never;
    },
  } as DecisionProvider;
}

/** A writer that records what it was shown and answers with a general rule. */
function recordingWriter() {
  const seen: string[] = [];
  return {
    seen,
    writer: {
      name: "test-writer",
      async complete(system: string, user: string) {
        seen.push(system, user);
        return '{"category": "math benchmark", "rule": "Verify each numeric step with a calculator before answering."}';
      },
    },
  };
}

let db: MarinaDB;
let dbPath: string;

beforeEach(() => {
  dbPath = `${tmpdir()}/marina-bench-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
  db = new MarinaDB(dbPath);
});

afterEach(() => {
  disableOutcomeLearning(db);
  db.close();
  cleanupDb(dbPath);
});

describe("the in-world runner", () => {
  function completeRun(runner: BenchmarkRunner, id: string, n = 12) {
    db.insertBenchmarkRun({
      id,
      benchmark: "gsm8k",
      config_hash: "cfg",
      config_json: "{}",
      status: "running",
      started_at: Date.now(),
    });
    const its = items(n);
    runner.recordHarnessResult(id, { benchmark: "gsm8k" }, Date.now(), {
      result: {
        scores: { overall: its.filter((i) => i.correct).length / n, breakdown: {} },
        metadata: { total: n, answered: n },
        items: its,
      },
    });
  }

  it("writes no item text to memory and still produces one judged, general lesson", async () => {
    const sink = memoryLessonSink();
    const w = recordingWriter();
    enableOutcomeLearning(db, { sink, writer: w.writer, judge: judge(), env: {} });
    const feed: string[] = [];
    const runner = new BenchmarkRunner(db, (e) => feed.push(JSON.stringify(e)));

    completeRun(runner, "br_test_1");
    await settleOutcomes(db);

    expect(db.getBenchmarkRun("br_test_1")?.status).toBe("completed");
    expect(db.getMemoryPool("benchmark:gsm8k")).toBeUndefined();
    expectNoSentinel(databaseText(db), "database");
    expectNoSentinel(feed.join("\n"), "feed");
    expectNoSentinel(w.seen.join("\n"), "lesson writer input");

    const lessons = producerLessons(sink);
    expect(lessons).toHaveLength(1);
    const [lesson] = lessons;
    expect(lesson?.domain).toBe("benchmark");
    expect(lesson?.trust).toBe("trusted");
    expect(lesson?.judge).toBe("test/jev");
    expect(lesson?.judgement?.leak_free).toBeGreaterThan(0.7);
    expect(lesson?.refs).toContain("bench:br_test_1");
    expect(lesson?.rule).toContain("calculator");
    expectNoSentinel(JSON.stringify(lessons), "lesson");
    // The writer saw the weakest categories (labels and counts), not items.
    expect(w.seen.join("\n")).toContain("weakest categories: ");
  });

  it("rejects a lesson the judge finds not leak-free", async () => {
    const sink = memoryLessonSink();
    enableOutcomeLearning(db, {
      sink,
      writer: recordingWriter().writer,
      judge: judge({ leak_free: 0.1 }),
      env: {},
    });
    completeRun(new BenchmarkRunner(db, () => {}), "br_test_2");
    await settleOutcomes(db);
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0]?.trust).toBe("rejected");
  });

  it("feeds nothing to the lesson loop for an invalid or failed run", async () => {
    const sink = memoryLessonSink();
    enableOutcomeLearning(db, { sink, writer: null, judge: null, env: {} });
    const runner = new BenchmarkRunner(db, () => {});
    db.insertBenchmarkRun({
      id: "br_fail",
      benchmark: "gsm8k",
      config_hash: "cfg",
      config_json: "{}",
      status: "running",
      started_at: Date.now(),
    });
    runner.recordHarnessResult("br_fail", { benchmark: "gsm8k" }, Date.now(), {
      error: "harness exited 1",
    });
    db.insertBenchmarkRun({
      id: "br_invalid",
      benchmark: "gsm8k",
      config_hash: "cfg",
      config_json: "{}",
      status: "running",
      started_at: Date.now(),
    });
    const fallback = items(10).map((it, i) => ({
      ...it,
      actual: i < 8 ? "ERROR: cap" : it.actual,
    }));
    runner.recordHarnessResult("br_invalid", { benchmark: "gsm8k" }, Date.now(), {
      result: { scores: { overall: 0.1 }, metadata: { total: 10, answered: 10 }, items: fallback },
    });
    await settleOutcomes(db);
    expect(db.getBenchmarkRun("br_fail")?.status).toBe("failed");
    expect(db.getBenchmarkRun("br_invalid")?.status).toBe("invalid");
    expect(sink.all()).toHaveLength(0);
    expectNoSentinel(databaseText(db), "database");
  });

  it("tallies categories from labels and verdicts only", () => {
    expect(
      categoryAccuracy([
        { category: "algebra", correct: true },
        { category: " algebra ", correct: false },
        { category: "x".repeat(60), correct: true },
        { correct: true },
      ]),
    ).toEqual([{ category: "algebra", n: 2, correct: 1 }]);
  });
});

describe("import and filing", () => {
  const file = () => ({
    config: { dataset: "gsm8k", model: "m" },
    items: items(9),
  });

  it("benchmark:import --learn's composition stores ids only and teaches one lesson", async () => {
    const sink = memoryLessonSink();
    const w = recordingWriter();
    enableOutcomeLearning(db, { sink, writer: w.writer, judge: judge(), env: {} });
    const f = file();
    const { run, items: ledgerItems } = ledgerFromHarnessResult(f as never, {
      targetKind: "model",
      target: "m",
      raw: JSON.stringify(f),
      id: "imp_1",
      now: Date.now(),
    });
    const res = db.recordBenchmarkLedgerRun(run, ledgerItems);
    noteBenchmarkRun(db, { ...run, id: res.id });
    await settleOutcomes(db);

    expectNoSentinel(databaseText(db), "database");
    expectNoSentinel(w.seen.join("\n"), "lesson writer input");
    expect(producerLessons(sink)).toHaveLength(1);
    expect(producerLessons(sink)[0]?.trust).toBe("trusted");
    expectNoSentinel(JSON.stringify(sink.all()), "lesson");
    const outcome = benchmarkRunOutcome(db, db.getBenchmarkRun(res.id)!);
    expectNoSentinel(JSON.stringify(outcome), "outcome");
  });

  it("POST /v1/benchmarks/runs stores ids only", async () => {
    const sink = memoryLessonSink();
    enableOutcomeLearning(db, { sink, writer: recordingWriter().writer, judge: judge(), env: {} });
    const engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    try {
      const res = await handleBenchmarkFile(
        new Request("http://local/v1/benchmarks/runs", {
          method: "POST",
          body: JSON.stringify({ targetKind: "model", target: "m", result: file() }),
        }),
        engine,
        { matchedKey: "k", internal: false, openMode: false } as PassthruAuthResult,
      );
      expect(res.status).toBe(201);
      await settleOutcomes(db);
      expectNoSentinel(databaseText(db), "database");
      expect(producerLessons(sink)).toHaveLength(1);
      expectNoSentinel(JSON.stringify(sink.all()), "lesson");
    } finally {
      engine.stop();
    }
  });
});

describe("static guard: benchmark code paths call no memory write", () => {
  /** Files on the runner, import, filing and harness paths. */
  function guardedFiles(): string[] {
    const files = [
      "src/engine/commands/benchmark.ts",
      "src/net/benchmarks-api.ts",
      "src/learning/intake.ts",
      "scripts/benchmark-import.ts",
      "benchmarks/harness.ts",
      "benchmarks/modes/passthrough.ts",
      "benchmarks/ledger-file.ts",
      "benchmarks/result-file.ts",
      "benchmarks/replicates.ts",
      "benchmarks/partition.ts",
      "benchmarks/journal.ts",
      "benchmarks/types.ts",
    ];
    for (const f of readdirSync(join(ROOT, "src/engine"))) {
      if (/^benchmark-.*\.ts$/.test(f)) files.push(`src/engine/${f}`);
    }
    const walk = (dir: string) => {
      for (const f of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${f}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (rel.endsWith(".ts")) files.push(rel);
      }
    };
    walk("benchmarks/adapters");
    walk("benchmarks/scoring");
    return files;
  }

  /**
   * Memory write sites: DB note/pool writes, the canonical memory service, the
   * `/mem` REST API, SDK note calls and in-world `pool … add` / `note` commands.
   * Deliberately broad; a benchmark path that needs to teach calls the lesson
   * loop (`noteBenchmarkRun` / `noteOutcome`), which stores judged rules only.
   * Not on these paths, by design: `benchmarks/memory/` and
   * `benchmarks/modes/memory.ts` measure memory itself with synthetic material,
   * and `benchmarks/native/` seeds each task's own inputs into per-instance pools.
   */
  const MEMORY_WRITE =
    /\b(addPoolNote|createNote|addNote|createMemoryPool|storeNote|upsertNote|residentMemoryOperation)\b|durableMemory\.run|notes\.add\(|\/mem\/|\.note\(|\.remember\(|`pool [^`]*\badd\b|["'`]note (add|create)\b/;

  it("matches the write sites it exists to forbid", () => {
    for (const line of [
      'this.db.addPoolNote(pool.id, "benchmark-runner", content, 7);',
      'this.db.createMemoryPool(newId, poolName, "benchmark-runner");',
      "await agent.note(item.question + item.expected);",
      "await session.cmd(`pool benchmark:x add QUESTION`);",
      'await fetch(base + "/mem/notes", { method: "POST" });',
      "await ctx.durableMemory.run(op);",
    ])
      expect(MEMORY_WRITE.test(line)).toBe(true);
    expect(MEMORY_WRITE.test("noteBenchmarkRun(this.db, run);")).toBe(false);
  });

  it("finds the guarded files", () => {
    const files = guardedFiles();
    expect(files).toContain("src/engine/benchmark-runner.ts");
    expect(files.some((f) => f.startsWith("benchmarks/adapters/"))).toBe(true);
  });

  it("no guarded file calls a memory write", () => {
    const hits: string[] = [];
    for (const rel of guardedFiles()) {
      const lines = readFileSync(join(ROOT, rel), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (MEMORY_WRITE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the learning feed never reads an item's question or expected answer", () => {
    for (const rel of ["src/engine/benchmark-runner.ts", "src/learning/intake.ts"]) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      expect(src.match(/\.(question|expected)\b/g) ?? []).toEqual([]);
    }
  });
});

describe("benchmark purge-content-notes", () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "Lobby", long: "Lobby." }));
  });

  afterEach(() => {
    engine.stop();
  });

  function login(name: string) {
    const conn = new MockConnection(`c-${name}`);
    engine.addConnection(conn);
    engine.login(conn.id, name);
    conn.clear();
    const send = async (cmd: string): Promise<string> => {
      conn.clear();
      await engine.processCommand(conn.entity!, cmd);
      return stripAnsi(conn.allTextJoined());
    };
    return { conn, send };
  }

  function seedLegacy() {
    db.createMemoryPool("pool-gsm", "benchmark:gsm8k", "benchmark-runner");
    db.createMemoryPool("pool-other", "facts:math", "someone");
    const runnerWrong = db.addPoolNote(
      "pool-gsm",
      "benchmark-runner",
      `WRONG [algebra] Q: ${Q} 1 | expected=${E} | we_answered=${A} | bench:br_x`,
      7,
    );
    const runnerOk = db.addPoolNote(
      "pool-gsm",
      "benchmark-runner",
      `OK Q: ${Q} 2 | answer=${E} | run=br_x`,
      4,
    );
    const copied = db.addPoolNote("pool-gsm", "Reflector", `OK Q: ${Q} 3 | answer=${E}`, 4);
    const general = db.addPoolNote(
      "pool-gsm",
      "Reflector",
      "Multi-step word problems: write each intermediate quantity before combining.",
      8,
    );
    const elsewhere = db.addPoolNote("pool-other", "someone", `OK Q: ${Q} | answer=${E}`, 4);
    return { runnerWrong, runnerOk, copied, general, elsewhere };
  }

  it("dry run counts per pool, shows no content and retires nothing", async () => {
    const ids = seedLegacy();
    // The whole-database scan the other tests rely on does see pool note text.
    expect(databaseText(db)).toContain(Q);
    const dry = purgeBenchmarkContentNotes(db);
    expect(dry).toMatchObject({ found: 3, retired: 0, applied: false });
    expect(dry.pools).toEqual([{ name: "benchmark:gsm8k", notes: 3 }]);
    const viewer = login("Viewer");
    const reply = await viewer.send("benchmark purge-content-notes");
    expect(reply).toContain("3 benchmark content note(s) would be retired");
    expect(reply).toContain("benchmark:gsm8k");
    expectNoSentinel(reply, "dry-run reply");
    for (const id of Object.values(ids)) expect(db.getNote(id)).toBeDefined();
  });

  it("needs role.edit to apply, then retires only the content notes in benchmark pools", async () => {
    const ids = seedLegacy();
    const viewer = login("Viewer");
    expect(await viewer.send("benchmark purge-content-notes confirm:yes")).toContain(
      "held: challenge",
    );
    expect(db.getNote(ids.runnerWrong)).toBeDefined();

    const op = login("Operator");
    grant(db, op.conn.entity!, "role.edit");
    const done = await op.send("benchmark purge-content-notes confirm:yes");
    expect(done).toContain("Retired 3 of 3 benchmark content note(s)");
    expectNoSentinel(done, "apply reply");
    expect(db.getNote(ids.runnerWrong)).toBeUndefined();
    expect(db.getNote(ids.runnerOk)).toBeUndefined();
    expect(db.getNote(ids.copied)).toBeUndefined();
    expect(db.getNote(ids.general)).toBeDefined();
    // Only benchmark:<name> pools are in scope.
    expect(db.getNote(ids.elsewhere)).toBeDefined();
    expect(purgeBenchmarkContentNotes(db).found).toBe(0);
    expect(await op.send("benchmark purge-content-notes")).toContain("No benchmark content notes");
    expect(await op.send("benchmark purge-content-notes now")).toContain("Usage:");
  });
});
