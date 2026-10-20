// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  absentWorkers,
  formatAssistanceExpiry,
  runAssistanceExpiry,
} from "../src/engine/assistance-expiry";
import { opsCommand } from "../src/engine/commands/ops";
import { MarinaDB } from "../src/persistence/database";
import {
  ASSISTANCE_ABSENT_GRACE_MS,
  ASSISTANCE_EXPIRY_ACTOR,
} from "../src/persistence/db-memory-assistance";
import type { MemoryActor } from "../src/persistence/db-principals";

let directory: string;
let db: MarinaDB;
let requester: MemoryActor;
let workerId: string;
let space: string;

/** A world account principal for the helper, so presence can be judged by name. */
function worldWorker(name: string): string {
  const id = `user_${name}`;
  db.createUser({ id, name, rank: 0 });
  db.memoryRepository().raw.run(
    "INSERT OR IGNORE INTO principals(principal_id,principal_type,display_name,status,created_at) VALUES (?,?,?,?,?)",
    [id, "agent", name, "active", Date.now()],
  );
  return id;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-assist-expiry-"));
  db = new MarinaDB(join(directory, "world.db"));
  const owner = db.ensurePrincipal({ type: "service", displayName: "owner" });
  const credential = db.issueMemoryCredential(owner.principal_id);
  requester = db.verifyMemoryCredential(credential.token)!;
  workerId = worldWorker("Evaluator");
  space = db.memoryRepository().createSpace(requester, "private", "space-key").id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

function file(timeoutMs = 600_000): string {
  return db
    .memoryRepository()
    .assistance.create(
      requester,
      space,
      { worker_id: workerId, role: "evaluator", task: "Review", timeout_ms: timeoutMs },
      crypto.randomUUID(),
    ).id;
}
const stateOf = (id: string) =>
  (
    db
      .memoryRepository()
      .raw.query("SELECT state FROM memory_assistance_jobs WHERE id=?")
      .get(id) as {
      state: string;
    }
  ).state;
const events = (operation: string) =>
  db
    .memoryRepository()
    .raw.query(
      "SELECT reference_id,actor_id FROM memory_service_events WHERE operation=? ORDER BY seq",
    )
    .all(operation) as { reference_id: string; actor_id: string }[];

describe("assistance-job expiry", () => {
  it("expires jobs past their deadline with a clear status and one event each; dry run changes nothing", () => {
    const a = file(1_000);
    const b = file(1_000);
    const live = file(600_000);
    const later = Date.now() + 5_000;
    const repo = db.memoryRepository().assistance;

    const dry = repo.expireStale({ now: later });
    expect(dry.map((j) => j.id).sort()).toEqual([a, b].sort());
    expect(dry.every((j) => j.reason === "deadline" && j.prior === "pending")).toBe(true);
    expect(stateOf(a)).toBe("pending");

    repo.expireStale({ now: later, apply: true });
    expect(stateOf(a)).toBe("expired");
    expect(stateOf(b)).toBe("expired");
    expect(stateOf(live)).toBe("pending");
    const logged = events("assistance.expired.deadline");
    expect(logged.map((e) => e.reference_id).sort()).toEqual([a, b].sort());
    expect(logged.every((e) => e.actor_id === ASSISTANCE_EXPIRY_ACTOR)).toBe(true);
    // Idempotent: a second pass finds nothing.
    expect(repo.expireStale({ now: later, apply: true })).toEqual([]);
    // The job is history now, not open work.
    expect(repo.summary(requester, a).work_open).toBe(false);
  });

  it("expires an absent worker's job only after the grace, never one with a live lease", () => {
    const repo = db.memoryRepository().assistance;
    const job = file(3_600_000);
    const absent = new Set([workerId]);
    expect(repo.expireStale({ absentWorkers: absent })).toEqual([]);
    const afterGrace = Date.now() + ASSISTANCE_ABSENT_GRACE_MS + 1;
    // A live lease keeps it (the worker is mid-claim).
    db.memoryRepository().raw.run(
      "UPDATE memory_assistance_jobs SET state='running',lease_until=? WHERE id=?",
      [afterGrace + 60_000, job],
    );
    expect(repo.expireStale({ now: afterGrace, absentWorkers: absent })).toEqual([]);
    db.memoryRepository().raw.run("UPDATE memory_assistance_jobs SET lease_until=? WHERE id=?", [
      afterGrace - 1,
      job,
    ]);
    const expired = repo.expireStale({ now: afterGrace, absentWorkers: absent, apply: true });
    expect(expired).toEqual([
      expect.objectContaining({ id: job, reason: "worker_absent", prior: "running" }),
    ]);
    expect(events("assistance.expired.worker_absent").map((e) => e.reference_id)).toEqual([job]);

    // Reversible while the deadline is ahead.
    expect(repo.restoreExpired(job)).toEqual({ id: job, state: "pending" });
    expect(stateOf(job)).toBe("pending");
    expect(events("assistance.restored").map((e) => e.reference_id)).toEqual([job]);
  });

  it("refuses to reopen a job whose deadline passed", () => {
    const repo = db.memoryRepository().assistance;
    const job = file(1_000);
    repo.expireStale({ now: Date.now() + 5_000, apply: true });
    expect(() => repo.restoreExpired(job, Date.now() + 5_000)).toThrow(/deadline has passed/);
    expect(stateOf(job)).toBe("expired");
  });

  it("judges presence by world account name and leaves non-account workers alone", () => {
    file(3_600_000);
    const present = { db, isPresent: (name: string) => name === "Evaluator" };
    const gone = { db, isPresent: () => false };
    expect([...absentWorkers(present)]).toEqual([]);
    expect([...absentWorkers(gone)]).toEqual([workerId]);

    // A service principal with no world account is never judged absent.
    const external = db.ensurePrincipal({ type: "service", displayName: "external-helper" });
    db.memoryRepository().assistance.create(
      requester,
      space,
      { worker_id: external.principal_id, role: "librarian", task: "Find" },
      crypto.randomUUID(),
    );
    expect([...absentWorkers(gone)]).toEqual([workerId]);
  });

  it("the engine pass reports by reason and role and is a no-op on a clean ledger", () => {
    const job = file(1_000);
    const deps = { db, isPresent: () => true };
    const report = runAssistanceExpiry(deps, { now: Date.now() + 5_000 });
    expect(report.applied).toBe(true);
    expect(report.byReason).toEqual({ deadline: 1, worker_absent: 0 });
    expect(report.byRole).toEqual({ evaluator: 1 });
    expect(formatAssistanceExpiry(report)).toBe(
      "expired 1 (deadline 1, worker absent 0; evaluator 1)",
    );
    expect(stateOf(job)).toBe("expired");
    expect(runAssistanceExpiry(deps).expired).toEqual([]);
  });

  it("ops assistance reports, expires only for an operator, and restores", async () => {
    const job = file(3_600_000);
    const gone = { db, isPresent: () => false };
    const cmd = opsCommand({
      db,
      tasks: {} as never,
      runtime: {} as never,
      readiness: () => ({}) as never,
      assistance: () => gone,
      isOperator: (id) => id === "op",
    });
    const run = async (entity: string, raw: string) => {
      const out: string[] = [];
      await cmd.handler(
        { send: (_e: string, text: string) => out.push(text) } as never,
        { entity, tokens: raw.split(" ").filter(Boolean) } as never,
      );
      return out.join("\n");
    };
    // Inside the grace: nothing is dead yet.
    expect(await run("anyone", "assistance")).toContain("would expire 0");
    db.memoryRepository().raw.run("UPDATE memory_assistance_jobs SET created_at=? WHERE id=?", [
      Date.now() - ASSISTANCE_ABSENT_GRACE_MS - 1,
      job,
    ]);
    const report = await run("anyone", "assistance");
    expect(report).toContain("pending 1");
    expect(report).toContain("would expire 1 (deadline 0, worker absent 1; evaluator 1)");
    expect(stateOf(job)).toBe("pending");
    expect(await run("anyone", "assistance expire")).toContain("takes an operator");
    expect(stateOf(job)).toBe("pending");
    expect(await run("op", "assistance expire")).toContain("expired 1");
    expect(stateOf(job)).toBe("expired");
    expect(await run("op", `assistance restore ${job}`)).toContain("reopened as pending");
    expect(stateOf(job)).toBe("pending");
  });
});
