// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LESSONS_ACCOUNT, lessonSinkFor } from "../src/learning/service";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { outcomeLearningJournal } from "../src/outcomes/journal";
import { MarinaDB } from "../src/persistence/database";

const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-crash-learning-"));
  dirs.push(dir);
  return join(dir, "world.db");
};
const raw = (db: MarinaDB) => (db as unknown as { db: Database }).db;
async function worker(path: string, fault = "", relation = "new", mode = "on", phase = "before") {
  const proc = Bun.spawn(
    [process.execPath, "test/fixtures/outcome-crash-worker.ts", path, fault, relation, mode, phase],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable lesson crash recovery", () => {
  for (const boundary of [
    "v1/sink/0:write/request:0/result", // primary mutation committed; response not checkpointed
    "v1/sink/0:write/complete",
    "v1/sink/1:write/request:0/result", // meta mutation committed
    "v1/complete", // both effects committed; delivery not settled
  ])
    it(`recovers after SIGKILL before ${boundary}`, async () => {
      const path = fresh();
      expect((await worker(path, boundary)).code).toBe(137);
      const resumed = await worker(path, "", "new", "no-judge");
      expect(resumed.err).toBe("");
      expect(resumed.code).toBe(0);
      const again = await worker(path, "", "new", "no-judge");
      expect(again.code).toBe(0);
      const db = new MarinaDB(path);
      try {
        const records = raw(db)
          .query(
            "SELECT s.name,r.version,json_extract(r.metadata,'$.trust') AS trust FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id WHERE r.subject='lesson' ORDER BY s.name",
          )
          .all();
        expect(records).toEqual([
          { name: "lessons:code", version: 1, trust: "trusted" },
          { name: "lessons:meta", version: 1, trust: "trusted" },
        ]);
        expect(db.outcomeDeliveries(1)).toMatchObject([{ state: "done", attempts: 1 }]);
      } finally {
        db.close();
      }
    }, 15000);

  it("merges once with saturated refs, including a restart into observe mode", async () => {
    const path = fresh();
    let db = new MarinaDB(path);
    const { id } = await lessonSinkFor(db).write({
      domain: "code",
      text: "[lesson:code] failure · pytest collection fails outside the repository root",
      kind: "failure",
      rule: "Run pytest from the repository root so test collection uses the project configuration.",
      trust: "trusted",
      scope: "method",
      resolvedAt: "2026-09-01T00:00:00.000Z",
      source: "code:verify",
      refs: Array.from({ length: 12 }, (_, i) => `trace:old-${i}`),
    });
    db.close();
    const killed = await worker(path, "v1/sink/0:update/request:1/result", "same_as_N1");
    expect(killed.code).toBe(137);
    const resumed = await worker(path, "", "new", "observe");
    expect(resumed.err).toBe("");
    expect(resumed.code).toBe(0);
    db = new MarinaDB(path);
    try {
      const record = raw(db)
        .query(
          "SELECT version,json_extract(metadata,'$.support') AS support FROM memory_records WHERE id=?",
        )
        .get(id!);
      expect(record).toEqual({ version: 2, support: 2 });
      expect(
        raw(db).query("SELECT count(*) AS n FROM memory_records WHERE subject='lesson'").get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 15000);

  it("forget purges journals and blocks a prepared mutation and later meta replay", async () => {
    const path = fresh();
    expect((await worker(path, "v1/sink/0:write/complete", "new", "on", "after")).code).toBe(137);
    const db = new MarinaDB(path);
    try {
      const primary = raw(db)
        .query("SELECT id,space_id FROM memory_records WHERE subject='lesson'")
        .get() as { id: string; space_id: string };
      const input = db.getOutcomeLearningStep(1, "v1/sink/0:write/request:0/input")!;
      const request = JSON.parse(input.value_json).value;
      await residentMemoryOperation(db, LESSONS_ACCOUNT, {
        operation: "forget",
        space_id: primary.space_id,
        key: "explicit-forget",
        input: { record_ids: [primary.id] },
      });
      expect(raw(db).query("SELECT count(*) AS n FROM outcome_learning_steps").get()).toEqual({
        n: 0,
      });
      expect(db.outcomeDeliveries(1)).toMatchObject([{ state: "skipped" }]);
      await expect(residentMemoryOperation(db, LESSONS_ACCOUNT, request)).rejects.toThrow(
        /erasure/,
      );
      expect(() => outcomeLearningJournal(db, 1).has("complete")).toThrow(/erasure/);
    } finally {
      db.close();
    }
    const replay = await worker(path);
    expect(replay.code).not.toBe(0);
    expect(replay.err).toContain("erasure");
    const reopened = new MarinaDB(path);
    try {
      expect(
        raw(reopened).query("SELECT count(*) AS n FROM memory_records WHERE status='active'").get(),
      ).toEqual({ n: 0 });
    } finally {
      reopened.close();
    }
  }, 15000);

  it("forgetting a completed primary also erases its existing meta mirror", async () => {
    const path = fresh();
    expect((await worker(path)).code).toBe(0);
    const db = new MarinaDB(path);
    try {
      const primary = raw(db)
        .query(
          "SELECT r.id,r.space_id FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id WHERE s.name='lessons:code'",
        )
        .get() as { id: string; space_id: string };
      await residentMemoryOperation(db, LESSONS_ACCOUNT, {
        operation: "forget",
        space_id: primary.space_id,
        key: "forget-complete",
        input: { record_ids: [primary.id] },
      });
      expect(
        raw(db).query("SELECT count(*) AS n FROM memory_records WHERE status='active'").get(),
      ).toEqual({ n: 0 });
      expect(raw(db).query("SELECT count(*) AS n FROM outcome_learning_steps").get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  }, 15000);
});
