#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Offline service qualification. Never dispatches a real provider or opens a world database.
 * Run: bun --no-env-file scripts/qualify-investigations.ts /tmp/investigation-qualification
 * Keep measured reports outside this repository; this file is the reproducible harness. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { InvestigationService } from "../src/investigations/service";
import {
  CONTENT_ATTEMPT_BYTES,
  CONTENT_OBJECT_BYTES,
  CONTENT_OWNER_BYTES,
  MAX_INVESTIGATION_EVENTS,
} from "../src/investigations/validation";
import { MarinaDB } from "../src/persistence/database";
import { investigationAttemptText } from "../src/sdk/investigation-text";
import { INVESTIGATION_SCHEMA, type InvestigationResult } from "../src/sdk/investigation-types";

const directory = resolve(process.argv[2] ?? "/tmp/marina-investigation-qualification");
mkdirSync(directory, { recursive: true });
const runDirectory = mkdtempSync(join(directory, "run-"));
// Set before measurement; generous release thresholds, not accuracy or live-provider promises.
const thresholds = {
  projectionP95Ms: 100,
  completeMs: 30_000,
  rssGrowthBytes: 256 * 1024 * 1024,
  databaseGrowthBytes: 32 * 1024 * 1024,
  captureWriteP95Ms: 200,
};
const report: Record<string, unknown> = {
  mode: "simulated; zero provider calls",
  at: new Date().toISOString(),
  hardware: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryBytes: totalmem(),
    platform: platform(),
    release: release(),
    bun: Bun.version,
  },
  thresholds,
  runDirectory,
};
const result = (): InvestigationResult => ({
  schema: INVESTIGATION_SCHEMA,
  kind: "prediction",
  availability: "final",
  summary: "Simulated qualification answer",
  estimate: { type: "binary", probability: 0.65 },
  reasons: [{ actor: "simulated-analyst", text: "Fixture evidence", sourceIds: ["fixture"] }],
  sources: [{ id: "fixture", url: "https://example.org/fixture" }],
  limitations: ["Simulated; no forecast accuracy claim"],
  capture: { status: "partial", gaps: ["Synthetic fixture"] },
  accounting: { knownUsd: 0, complete: false, outstanding: 0 },
});
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
const bytes = (path: string) =>
  [path, `${path}-wal`, `${path}-shm`].reduce((sum, p) => {
    try {
      return sum + statSync(p).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return sum;
    }
  }, 0);

async function scale(actors: number) {
  const path = join(runDirectory, `scale-${actors}.db`);
  const db = new MarinaDB(path);
  const baselineBytes = bytes(path);
  const rssBefore = process.memoryUsage().rss;
  let active = 0;
  let peak = 0;
  let calls = 0;
  let firstAnswerMs = 0;
  const started = performance.now();
  const service = new InvestigationService(db, async ({ observation }) => {
    await observation.stage("model", "simulated-analyst", { text: "x".repeat(1024) }, async () => {
      active++;
      calls++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((done) => setImmediate(done));
        return { text: "y".repeat(1024) };
      } finally {
        active--;
      }
    });
    firstAnswerMs ||= performance.now() - started;
    return { result: result() };
  });
  try {
    const attempts = Array.from({ length: actors }, (_, i) => {
      const actor = { key: `owner-${i}`, name: `Owner${i}` };
      db.createUser({ id: actor.key, name: actor.name });
      return service.start(
        actor,
        {
          kind: "prediction",
          question: "Simulated question",
          limits: { calls: 2, concurrency: 1 },
        },
        `scale-${i}`,
      ).attempt;
    });
    await Promise.all(attempts.map((attempt) => service.wait(attempt.id)));
    const completeMs = performance.now() - started;
    assert.equal(calls, actors);
    assert(peak <= 16, `provider capacity exceeded: ${peak}`);
    const times: number[] = [];
    for (let pass = 0; pass < 10; pass++)
      for (const attempt of attempts) {
        const start = performance.now();
        const snapshot = db.getInvestigation(attempt.actor.key, attempt.caseId);
        assert.equal(snapshot.attempt.state, "completed");
        assert(investigationAttemptText(snapshot.attempt).includes("65% chance"));
        db.readInvestigationEvents(attempt.actor.key, attempt.id);
        assert.throws(() => db.getInvestigation("unauthorized", attempt.caseId), /not found/);
        times.push(performance.now() - start);
      }
    assert.equal(calls, actors, "read paths dispatched work");
    const measured = {
      actors,
      calls,
      peak,
      firstAnswerMs,
      completeMs,
      projectionP95Ms: percentile(times, 0.95),
      projectionP99Ms: percentile(times, 0.99),
      rssGrowthBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
      databaseGrowthBytes: bytes(path) - baselineBytes,
    };
    for (const [name, value, limit] of [
      ["projection p95 ms", measured.projectionP95Ms, thresholds.projectionP95Ms],
      ["complete ms", completeMs, thresholds.completeMs],
      ["RSS growth bytes", measured.rssGrowthBytes, thresholds.rssGrowthBytes],
      ["database growth bytes", measured.databaseGrowthBytes, thresholds.databaseGrowthBytes],
    ] as const)
      assert(value < limit, `${actors} actors: ${name} ${Math.round(value)} ≥ ${limit}`);
    return measured;
  } finally {
    service.close();
    db.close();
  }
}

function bounds() {
  const db = new MarinaDB(join(runDirectory, "bounds.db"));
  const owner = { key: "bounded", name: "Bounded" };
  db.createUser({ id: owner.key, name: owner.name });
  const request = { kind: "prediction" as const, question: "Simulated bounded history" };
  try {
    const { attempt } = db.createInvestigation(owner, request, "history");
    const generation = db.claimInvestigation(attempt.id)!;
    const started = performance.now();
    const raw = db.memoryRepository().raw;
    raw.transaction(() => {
      for (let i = 2; i < MAX_INVESTIGATION_EVENTS; i++)
        db.appendInvestigationEvent(attempt.id, generation, {
          kind: "stage_completed",
          actor: "simulated",
          message: `event ${i}`,
        });
    })();
    assert.throws(
      () =>
        db.appendInvestigationEvent(attempt.id, generation, {
          kind: "stage_started",
          actor: "overflow",
        }),
      /event limit/,
    );
    assert(
      db.finishInvestigation(attempt.id, generation, { state: "completed", result: result() }),
    );
    let cursor = 0;
    let pages = 0;
    let events = 0;
    const times: number[] = [];
    for (;;) {
      const start = performance.now();
      const page = db.readInvestigationEvents(owner.key, attempt.id, cursor, 200);
      times.push(performance.now() - start);
      assert(!page.reset);
      for (const event of page.events) assert.equal(event.sequence, ++cursor);
      pages++;
      events += page.events.length;
      if (!page.more) break;
    }
    assert.equal(events, MAX_INVESTIGATION_EVENTS + 1);
    assert.equal(cursor, db.getInvestigation(owner.key, attempt.caseId).cursor);
    assert(db.readInvestigationEvents(owner.key, attempt.id, cursor + 1).reset);
    raw.run("DELETE FROM investigation_events WHERE attempt_id=? AND sequence<100", [attempt.id]);
    assert(db.readInvestigationEvents(owner.key, attempt.id, 1).reset);
    const pageP95 = percentile(times, 0.95);
    assert(
      pageP95 < thresholds.projectionP95Ms,
      `event page read p95 ${pageP95.toFixed(1)} ms ≥ ${thresholds.projectionP95Ms} ms over ${times.length} pages`,
    );
    const history = {
      events,
      pages,
      writeAndReadMs: performance.now() - started,
      pageP95Ms: pageP95,
    };

    // Exercise actual JSON byte lengths and physical writes, including UTF-8; no quota counters mocked.
    const payload = "x".repeat(CONTENT_OBJECT_BYTES - 2); // JSON quotes count too.
    let stored = 0;
    const writeTimes: number[] = [];
    const storageStarted = performance.now();
    for (let i = 0; stored < CONTENT_OWNER_BYTES; i++) {
      const next = db.createInvestigation(owner, request, `quota-${i}`).attempt;
      const gen = db.claimInvestigation(next.id)!;
      assert.throws(
        () => db.storeInvestigationContent(next.id, gen, "too-big", `${payload}é`),
        /2 MiB/,
      );
      let attemptBytes = 0;
      while (attemptBytes < CONTENT_ATTEMPT_BYTES && stored < CONTENT_OWNER_BYTES) {
        const writeStart = performance.now();
        db.storeInvestigationContent(next.id, gen, "quota", payload);
        writeTimes.push(performance.now() - writeStart);
        stored += CONTENT_OBJECT_BYTES;
        attemptBytes += CONTENT_OBJECT_BYTES;
      }
      assert.throws(
        () => db.storeInvestigationContent(next.id, gen, "overflow", "x"),
        /allowance exhausted/,
      );
      db.finishInvestigation(next.id, gen, { state: "completed", result: result() });
    }
    assert.equal(stored, CONTENT_OWNER_BYTES);
    const storedBytes = raw.query("SELECT sum(bytes) AS n FROM investigation_content").get() as {
      n: number;
    };
    assert.equal(storedBytes.n, stored);
    const writeP95 = percentile(writeTimes, 0.95);
    assert(
      writeP95 < thresholds.captureWriteP95Ms,
      `capture write p95 ${writeP95.toFixed(1)} ms ≥ ${thresholds.captureWriteP95Ms} ms over ${writeTimes.length} writes`,
    );
    for (const item of db.listInvestigations(owner.key)) db.eraseInvestigation(owner.key, item.id);
    assert.deepEqual(raw.query("SELECT count(*) AS n FROM investigation_content").get(), { n: 0 });
    assert.deepEqual(raw.query("SELECT count(*) AS n FROM investigation_events").get(), { n: 0 });

    // The global backlog and per-owner admission caps must refuse before dispatch, but allow retry.
    for (let i = 0; i < 128; i++) {
      const actor = {
        key: `capacity-${Math.floor(i / 32)}`,
        name: `Capacity${Math.floor(i / 32)}`,
      };
      db.createInvestigation(actor, request, `capacity-${i}`);
      if (i === 31)
        assert.throws(() => db.createInvestigation(actor, request, "owner-overflow"), /32 active/);
    }
    assert.throws(() => db.createInvestigation(owner, request, "global-overflow"), /at capacity/);
    assert.equal(
      db.createInvestigation({ key: "capacity-0", name: "Capacity0" }, request, "capacity-0")
        .created,
      false,
    );
    assert.equal(db.recoverInvestigations(), 128);
    assert.equal(db.recoverInvestigations(), 0);
    for (let i = 0; i < 1000; i++) {
      const retained = db.createInvestigation(owner, request, `retained-${i}`).attempt;
      const gen = db.claimInvestigation(retained.id)!;
      db.finishInvestigation(retained.id, gen, { state: "completed", result: result() });
    }
    assert.throws(
      () => db.createInvestigation(owner, request, "retained-overflow"),
      /1000 retained/,
    );
    assert.deepEqual(raw.query("PRAGMA foreign_key_check").all(), []);
    return {
      history,
      storage: {
        capturedBytes: stored,
        captureWriteP95Ms: percentile(writeTimes, 0.95),
        elapsedMs: performance.now() - storageStarted,
        erased: true,
      },
      globalBacklog: 128,
      perOwnerActive: 32,
      perOwnerRetained: 1000,
    };
  } finally {
    db.close();
  }
}

try {
  report.scale = [];
  for (const actors of [1, 10, 100]) (report.scale as unknown[]).push(await scale(actors));
  report.bounds = bounds();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const path = join(runDirectory, "report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, report: path, error: report.error }));
}
