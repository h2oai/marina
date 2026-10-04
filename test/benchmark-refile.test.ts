// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Re-filing a finished run is a no-op: the ledger's content hash covers only
// stable fields, the SWE-bench result is deterministic, and the SWE-bench
// subset → run → file path reads one subset and records its real seed.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ledgerResult } from "../benchmarks/swebench/adapter";
import {
  type HarnessResultFile,
  ledgerFromHarnessResult,
  stableResultHash,
} from "../src/engine/benchmark-ledger";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const REPO = resolve(import.meta.dir, "..");

function result(timestamp: number, duration: number, latency = true) {
  return {
    config: { dataset: "synthetic-set", seed: 1, model: "m" },
    timestamp,
    duration_ms: duration,
    metadata: { total: 2 },
    items: [
      { id: "a", correct: true, ...(latency ? { latencyMs: 812 } : {}) },
      { id: "b", correct: false, ...(latency ? { latencyMs: 1290 } : {}) },
    ],
  };
}

describe("stable content hash", () => {
  it("ignores when a run was filed, never what it measured", () => {
    const a = stableResultHash(JSON.stringify(result(1_000, 50)));
    expect(stableResultHash(JSON.stringify(result(9_999, 70)))).toBe(a);
    // Key order is irrelevant.
    const r = result(1_000, 50);
    const reordered = { items: r.items, metadata: r.metadata, config: r.config, timestamp: 5 };
    expect(stableResultHash(JSON.stringify(reordered))).toBe(a);
    // A different outcome is a different run.
    const changed = result(1_000, 50);
    changed.items[1]!.correct = true;
    expect(stableResultHash(JSON.stringify(changed))).not.toBe(a);
  });

  it("keeps the timestamp when no item carries a per-run measurement", () => {
    // Two genuine replicates with identical outcomes and no latency/trace are
    // told apart only by when they ran.
    expect(stableResultHash(JSON.stringify(result(1, 0, false)))).not.toBe(
      stableResultHash(JSON.stringify(result(2, 0, false))),
    );
  });

  it("hashes a non-JSON body as its bytes", () => {
    expect(stableResultHash("not json")).toBe(
      createHash("sha256").update("not json").digest("hex"),
    );
  });
});

describe("idempotent filing", () => {
  let dbPath: string;
  let db: MarinaDB;
  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `marina-refile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new MarinaDB(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function file(raw: string, id: string) {
    const { run, items } = ledgerFromHarnessResult(JSON.parse(raw) as HarnessResultFile, {
      targetKind: "model",
      target: "m",
      replicateGroup: "g",
      raw,
      id,
      now: 1,
    });
    return db.recordBenchmarkLedgerRun(run, items);
  }

  it("re-filing a resumed run with a new timestamp records nothing new", () => {
    expect(file(JSON.stringify(result(1_000, 50)), "r1")).toEqual({ id: "r1", created: true });
    expect(file(JSON.stringify(result(8_000, 90)), "r2")).toEqual({ id: "r1", created: false });
    expect(db.queryBenchmarkRuns({ benchmark: "synthetic-set" })).toHaveLength(1);
  });

  it("matches a run filed under the raw-bytes hash before the stable hash", () => {
    const raw = JSON.stringify(result(1_000, 50));
    const { run, items } = ledgerFromHarnessResult(JSON.parse(raw) as HarnessResultFile, {
      targetKind: "model",
      target: "m",
      raw,
      id: "old",
      now: 1,
    });
    db.recordBenchmarkLedgerRun(
      { ...run, content_hash: createHash("sha256").update(raw).digest("hex") },
      items,
    );
    expect(file(raw, "new")).toEqual({ id: "old", created: false });
  });
});

describe("SWE-bench filing", () => {
  const attempts = ["x__y-1", "x__y-2"].map((id, i) => ({
    instance_id: id,
    arm: "single",
    replicate: 1,
    exitCode: 0,
    patchBytes: 10,
    costUsd: 0.1,
    durationMs: 1000 + i,
    trajectory: `${id}.md`,
  }));

  it("ledgerResult is deterministic: a numeric finish time, never the filing time", () => {
    const meta = {
      arm: { name: "single", model: "m" },
      replicate: 1,
      subsetSeed: 42,
      completedAt: 1_700_000_000_123,
    };
    const a = ledgerResult({ resolved_ids: ["x__y-1"] }, attempts, meta);
    const b = ledgerResult({ resolved_ids: ["x__y-1"] }, attempts, meta);
    expect(a.timestamp).toBe(1_700_000_000_123);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.config.seed).toBe(42);
    expect(ledgerResult({}, attempts, { ...meta, subsetSeed: null }).config.seed).toBeNull();
  });

  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), "marina-swe-refile-"));
  });
  afterEach(() => {
    rmSync(data, { recursive: true, force: true });
  });

  function swe(...args: string[]) {
    const res = Bun.spawnSync(["bun", "scripts/swebench.ts", ...args, "--data", data], {
      cwd: REPO,
      env: { ...process.env, DB_PATH: join(data, "unused.db") },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: res.exitCode, out: `${res.stdout.toString()}${res.stderr.toString()}` };
  }

  it("subset → file reads one subset, records its seed, and re-filing is a no-op", () => {
    const rows = ["a/b", "c/d", "e/f"].flatMap((repo, r) =>
      [1, 2].map((k) => ({ instance_id: `${repo.replace("/", "__")}-${r}${k}`, repo })),
    );
    writeFileSync(join(data, "verified.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
    expect(swe("subset", "--n", "3", "--seed", "42").code).toBe(0);
    const idsPath = join(data, "subset-n3-s42.txt");
    const ledger = join(data, "ledger.db");
    for (const replicate of ["1", "2"]) {
      // What `run` leaves behind (the agent itself is not exercised here).
      const runDir = join(data, "runs", `single-r${replicate}`);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "arm.json"),
        JSON.stringify({
          name: "single",
          model: "m",
          replicate: Number(replicate),
          ids: idsPath,
          seed: 42,
          n: 3,
          mode: "agentless",
          benchmark: "verified",
        }),
      );
      const picked = readFileSync(idsPath, "utf8").split("\n").filter(Boolean);
      expect(picked).toHaveLength(3);
      writeFileSync(
        join(runDir, "attempts.jsonl"),
        picked
          .map((id: string) =>
            JSON.stringify({ ...attempts[0], instance_id: id, replicate: Number(replicate) }),
          )
          .join("\n"),
      );
      writeFileSync(
        join(runDir, `marina-single-r${replicate}.marina-single-r${replicate}.json`),
        JSON.stringify({ resolved_ids: picked.slice(0, 1), error_ids: [] }),
      );
      for (let i = 0; i < 2; i++) {
        // The seed flag is deliberately NOT the subset's: file reads it from arm.json.
        const filed = swe("file", "--arm", "single", "--replicate", replicate, "--db", ledger);
        expect(filed.code).toBe(0);
        if (i === 1) expect(filed.out).toContain("already recorded");
      }
    }
    const db = new MarinaDB(ledger);
    try {
      const runs = db.queryBenchmarkRuns({ benchmark: "swe-bench-verified" });
      // Two replicates, each filed twice: two runs, one group, one target.
      expect(runs).toHaveLength(2);
      expect(new Set(runs.map((r) => r.replicate_group))).toEqual(new Set(["swebench-single"]));
      expect(new Set(runs.map((r) => r.target_json)).size).toBe(1);
      expect(JSON.parse(runs[0]!.target_json!)).toEqual({
        harness: "marina -p",
        name: "single",
        model: "m",
      });
      expect(runs.every((r) => r.seed === 42)).toBe(true);
    } finally {
      db.close();
    }
  }, 180_000);

  it("run refuses a subset that was never drawn, naming --n/--seed", () => {
    writeFileSync(join(data, "verified.jsonl"), "");
    const res = swe("run", "--arm", "single", "--model", "m", "--n", "10", "--seed", "42");
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("subset-n10-s42.txt");
  }, 60_000);
});
