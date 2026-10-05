// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualifyAgentHandoff } from "../scripts/qualify-agent-handoff";
import { arenaExecutionSummary } from "../src/arena/execution-evidence";
import { benchmarkExecution } from "../src/engine/benchmark-execution";
import { ledgerFromHarnessResult } from "../src/engine/benchmark-ledger";
import { benchmarkRunOutcome } from "../src/learning/intake";
import {
  sourceEvidenceHash,
  sourceParticipants,
} from "../src/persistence/benchmark-source-evidence";
import { MarinaDB } from "../src/persistence/database";
import { readBenchmarkSourceEvidence } from "../src/persistence/db-benchmarks";
import { exportState, importState } from "../src/persistence/export-import";

const participant = {
  agent: "Answerer",
  model: "marina/default",
  via: "trace" as const,
  turns: 2,
  costUsd: 0.01,
};
function run(id: string, attributed: boolean) {
  return ledgerFromHarnessResult(
    {
      config: { name: "fixture", dataset: "fixture", model: "marina:answerer" },
      timestamp: 1000,
      duration_ms: 200,
      items: ["one", "two"].map((id, i) => ({
        id,
        correct: i === 0,
        score: i === 0 ? 1 : 0,
        traceId: `req-${id}`,
        ...(attributed ? { participants: [participant] } : {}),
        answerDigest: "a".repeat(64),
      })),
    },
    {
      id,
      now: 2000,
      targetKind: "crew",
      target: { crew: "answerer" },
      raw: attributed ? "source" : "target",
    },
  );
}

function raw(db: MarinaDB): Database {
  return (db as unknown as { db: Database }).db;
}
function fixture(conflict = false) {
  const source = new MarinaDB(":memory:");
  const target = new MarinaDB(":memory:");
  const a = run("source", true),
    b = run("target", false);
  if (conflict)
    b.items[1]!.participants_json = JSON.stringify([{ ...participant, agent: "Other" }]);
  source.recordBenchmarkLedgerRun(a.run, a.items);
  target.recordBenchmarkLedgerRun(b.run, b.items);
  const evidence = readBenchmarkSourceEvidence(raw(source), "source");
  return {
    source,
    target,
    evidence,
    [Symbol.dispose]() {
      source.close();
      target.close();
    },
  };
}

describe("source execution evidence", () => {
  test("restores attribution without changing scores, identities, keyed answers, or source", () => {
    using f = fixture();
    const sourceBefore = f.source.getBenchmarkItems("source");
    const before = f.target.getBenchmarkRun("target");
    const itemsBefore = f.target.getBenchmarkItems("target");
    expect(f.target.attachBenchmarkSourceEvidence("target", f.evidence).changed).toBe(2);
    expect(f.target.getBenchmarkRun("target")).toEqual(before);
    expect(
      f.target.getBenchmarkItems("target").map(({ participants_json: _, ...it }) => it),
    ).toEqual(itemsBefore.map(({ participants_json: _, ...it }) => it));
    expect(raw(f.target).query("SELECT * FROM benchmark_items ORDER BY id").all()).toEqual(
      itemsBefore,
    );
    expect(f.source.getBenchmarkItems("source")).toEqual(sourceBefore);
    expect(benchmarkExecution(f.target.getBenchmarkItems("target")).tracedItems).toBe(2);
    expect(f.target.listBenchmarkRunEvidence("target")[0]).toMatchObject({
      source_run_id: "source",
      changed_items: 2,
      actor: "operator",
      source_hash: sourceEvidenceHash(f.evidence),
    });
    expect(f.target.attachBenchmarkSourceEvidence("target", f.evidence).changed).toBe(0);
    expect(f.target.listBenchmarkRunEvidence("target")).toHaveLength(1);
    expect(() => raw(f.target).run("UPDATE benchmark_run_evidence SET actor = 'other'")).toThrow(
      "append-only",
    );
    expect(() =>
      raw(f.target).run("UPDATE benchmark_item_evidence SET participants_json = '[]'"),
    ).toThrow("append-only");
  });

  test.each(["trace_id", "score", "correct", "item_id"] as const)(
    "refuses any mismatched %s atomically",
    (field) => {
      using f = fixture();
      const bad = structuredClone(f.evidence);
      Object.assign(bad.items[1]!, {
        [field]: field === "score" || field === "correct" ? 1 : "unrelated",
      });
      expect(() => f.target.attachBenchmarkSourceEvidence("target", bad)).toThrow("mismatch");
      expect(
        f.target.getBenchmarkItems("target").every((it) => it.participants_json === null),
      ).toBe(true);
      expect(f.target.listBenchmarkRunEvidence("target")).toHaveLength(0);
    },
  );

  test("refuses a conflicting nonempty participant record", () => {
    using f = fixture(true);
    expect(() => f.target.attachBenchmarkSourceEvidence("target", f.evidence)).toThrow(
      "Conflicting",
    );
    expect(
      f.target.getBenchmarkItems("target").find((it) => it.item_id === "one")!.participants_json,
    ).toBeNull();
  });

  test("evidence on duplicate import repairs original without adding a replicate", () => {
    using f = fixture();
    const again = run("duplicate", false);
    expect(f.target.recordBenchmarkLedgerRun(again.run, again.items, f.evidence)).toEqual({
      id: "target",
      created: false,
    });
    expect(f.target.queryBenchmarkRuns({})).toHaveLength(1);
    expect(f.target.listBenchmarkRunEvidence("target")).toHaveLength(1);
  });

  test("fresh import with mismatched evidence rolls back the whole run", () => {
    using f = fixture();
    const fresh = run("new", false);
    fresh.run.content_hash = "different";
    const bad = structuredClone(f.evidence);
    bad.items[1]!.trace_id = "other";
    expect(() => f.target.recordBenchmarkLedgerRun(fresh.run, fresh.items, bad)).toThrow(
      "mismatch",
    );
    expect(f.target.getBenchmarkRun("new")).toBeNull();
    expect(f.target.getBenchmarkItems("new")).toHaveLength(0);
  });

  test("copies only attribution fields and rejects unverified roster entries", () => {
    expect(
      sourceParticipants([{ ...participant, prompt: "secret", credentials: "secret" }]),
    ).toEqual([participant]);
    expect(() => sourceParticipants([{ agent: "DeclaredOnly" }])).toThrow("evidence");
    using f = fixture();
    const reordered = structuredClone(f.evidence);
    reordered.items.reverse();
    expect(sourceEvidenceHash(reordered)).toBe(sourceEvidenceHash(f.evidence));
    const missingTrace = structuredClone(f.evidence);
    missingTrace.items[0]!.trace_id = null;
    expect(() => sourceEvidenceHash(missingTrace)).toThrow("trace ID");
  });

  test("execution summary deduplicates shared turns and distinguishes unknown from unverified/window", () => {
    const summary = benchmarkExecution([
      {
        participants_json: JSON.stringify([
          participant,
          { ...participant, tracedShared: true },
          { ...participant, agent: "Peer" },
        ]),
      },
      { participants_json: null },
      { participants_json: JSON.stringify([{ agent: "DeclaredOnly" }]) },
      { participants_json: JSON.stringify([{ ...participant, via: "window" }]) },
    ]);
    expect(summary).toMatchObject({
      items: 4,
      tracedItems: 1,
      unknownItems: 1,
      unverifiedItems: 1,
      windowOnlyItems: 1,
      multipleResidentItems: 1,
      sharedTraceItems: 1,
      models: [{ name: "marina/default", items: 1 }],
    });
    expect(summary.agents).toEqual([
      { name: "Answerer", items: 1 },
      { name: "Peer", items: 1 },
    ]);
  });

  test("malformed trace assertions are unverified, not measured execution", () => {
    const summary = benchmarkExecution([
      { participants_json: JSON.stringify([{ agent: "A", via: "trace", turns: "1" }]) },
    ]);
    expect(summary.tracedItems).toBe(0);
    expect(summary.unverifiedItems).toBe(1);
  });

  test("learning distinguishes declared target from observed execution and refuses incomparable baselines", () => {
    using f = fixture();
    const before = benchmarkRunOutcome(f.target, f.target.getBenchmarkRun("target")!);
    expect(before!.signals!.join(" ")).toContain("2 unknown");
    expect(before!.detail).toContain("superiority untested");
    f.target.attachBenchmarkSourceEvidence("target", f.evidence);
    const after = benchmarkRunOutcome(f.target, f.target.getBenchmarkRun("target")!);
    expect(after!.attempted).toContain("declared target");
    expect(after!.signals!.join(" ")).toContain("2/2 items trace-linked");
    expect(after!.signals!.join(" ")).toContain("not causal benefit");
    const other = run("other", false);
    other.run.content_hash = "other";
    other.run.score = 1;
    other.run.judge = "incomparable-judge";
    f.target.recordBenchmarkLedgerRun(other.run, other.items);
    expect(benchmarkRunOutcome(f.target, f.target.getBenchmarkRun("target")!)!.detail).toContain(
      "no comparable baseline",
    );
  });

  test("Arena evidence distinguishes completion protocols from autonomous residents", () => {
    expect(arenaExecutionSummary("{}")).toContain("unknown");
    expect(
      arenaExecutionSummary(
        JSON.stringify({ config: { spec: "formation:delphi:three-models" }, costUsd: 0 }),
      ),
    ).toContain("unknown");
    expect(
      arenaExecutionSummary(
        JSON.stringify({
          forecast: {
            rounds: [
              { member: "A", status: "ok" },
              { member: "B", status: "error" },
            ],
            fallback: "no usable proposal",
          },
        }),
      ),
    ).toBe(
      "Recorded formation steps: 1 succeeded, 1 failed; 2 members. Fallback: no usable proposal. Completion protocol evidence, not proof of autonomous world residents.",
    );
  });

  test("world snapshot restore preserves evidence and can replace a populated destination", () => {
    using f = fixture();
    const dir = mkdtempSync(join(tmpdir(), "marina-evidence-restore-"));
    const path = join(dir, "world.db");
    try {
      const db = new MarinaDB(path);
      const target = run("target", false);
      db.recordBenchmarkLedgerRun(target.run, target.items, f.evidence);
      db.close();
      const snapshot = exportState(path);
      expect(snapshot.tables.benchmark_item_evidence).toHaveLength(2);
      expect(snapshot.tables.benchmark_run_evidence).toHaveLength(1);
      expect(importState(path, snapshot).errors).toEqual([]);
      const restored = new MarinaDB(path);
      try {
        expect(benchmarkExecution(restored.getBenchmarkItems("target")).tracedItems).toBe(2);
        expect(restored.listBenchmarkRunEvidence("target")).toHaveLength(1);
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Importing this module must not launch a provider/server. Also includes the
  // reusable live harness in strict TypeScript checking without a paid CI job.
  test("live probe is opt-in", () => expect(typeof qualifyAgentHandoff).toBe("function"));
});
