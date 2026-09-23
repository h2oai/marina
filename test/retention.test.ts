// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  describeRetentionPolicies,
  effectivePolicies,
  formatKeepWindow,
  formatRetentionSummary,
  getLastRetentionReport,
  isRetentionTick,
  parseRetentionOverrides,
  parseRetentionValue,
  RETENTION_DEFAULTS,
  RETENTION_POLICIES,
  type RetentionPolicy,
  resetRetentionReportForTests,
  runRetentionPass,
} from "../src/engine/retention";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const DAY = 86_400_000;

describe("retention overrides", () => {
  it("parses durations, row counts and the disable sentinel", () => {
    expect(parseRetentionValue("30d")).toEqual({ keepMs: 30 * DAY });
    expect(parseRetentionValue("12h")).toEqual({ keepMs: 12 * 3_600_000 });
    expect(parseRetentionValue("2w")).toEqual({ keepMs: 14 * DAY });
    expect(parseRetentionValue("90m")).toEqual({ keepMs: 90 * 60_000 });
    expect(parseRetentionValue("45s")).toEqual({ keepMs: 45_000 });
    expect(parseRetentionValue("250000")).toEqual({ keepRows: 250_000 });
    expect(parseRetentionValue("0")).toEqual({ disabled: true });
    expect(parseRetentionValue("never")).toEqual({ disabled: true });
    expect(parseRetentionValue("soon")).toBeUndefined();
    expect(parseRetentionValue("-3d")).toBeUndefined();
  });

  it("keeps known entries and reports the rejected ones", () => {
    const { overrides, rejected } = parseRetentionOverrides(
      "primitive_usage=30d, feed_events=0,event_log=50000,nope=1d,witness_attestations=abc,junk",
    );
    expect(overrides.get("primitive_usage")).toEqual({ keepMs: 30 * DAY });
    expect(overrides.get("feed_events")).toEqual({ disabled: true });
    expect(overrides.get("event_log")).toEqual({ keepRows: 50_000 });
    expect(rejected).toEqual(["nope=1d", "witness_attestations=abc", "junk"]);
    expect(parseRetentionOverrides(undefined).overrides.size).toBe(0);
  });

  it("applies class defaults, per-policy windows and overrides; append-only is never enabled", () => {
    const { overrides } = parseRetentionOverrides("primitive_usage=3d,chronicle=1d,event_log=0");
    const byTable = new Map(effectivePolicies(overrides).map((p) => [p.table, p]));
    expect(byTable.get("primitive_usage")?.effectiveKeepMs).toBe(3 * DAY);
    expect(byTable.get("feed_events")?.effectiveKeepMs).toBe(7 * DAY);
    expect(byTable.get("witness_attestations")?.effectiveKeepMs).toBe(RETENTION_DEFAULTS.audit);
    expect(byTable.get("cognitive_events")?.effectiveKeepMs).toBe(RETENTION_DEFAULTS.ledger);
    expect(byTable.get("event_log")?.disabled).toBe(true);
    // An override cannot re-enable an append-only table.
    expect(byTable.get("chronicle")?.disabled).toBe(true);
    expect(byTable.get("entity_standing")?.disabled).toBe(true);
    expect(byTable.get("memory_resolutions")?.disabled).toBe(true);
    expect(byTable.get("economic_events")?.disabled).toBe(true);
  });

  it("describes the shipped policy table", () => {
    const rows = describeRetentionPolicies("feed_events=0,shell_log=12h");
    const by = (table: string) => rows.find((r) => r.table === table)!;
    expect(by("chronicle")).toMatchObject({
      kind: "append-only",
      keep: "never",
      overridden: false,
    });
    expect(by("feed_events")).toMatchObject({ keep: "never", overridden: true });
    expect(by("shell_log")).toMatchObject({ keep: "12h", overridden: true });
    expect(by("primitive_usage")).toMatchObject({ keep: "14d", overridden: false });
    expect(by("event_log").keep).toMatch(/^\d+ rows$/);
    expect(by("event_log").overridden).toBe(false);
    for (const row of rows) expect(typeof row.overridden).toBe("boolean");
    expect(formatKeepWindow(90 * 24 * 3_600_000)).toBe("90d");
    expect(formatKeepWindow(36 * 3_600_000)).toBe("36h");
    expect(formatKeepWindow(90_000)).toBe("90s");
  });

  it("runs on its own hourly phase", () => {
    expect(isRetentionTick(2100, 3600)).toBe(true);
    expect(isRetentionTick(5700, 3600)).toBe(true);
    expect(isRetentionTick(2700, 3600)).toBe(false);
    expect(isRetentionTick(3300, 3600)).toBe(false);
  });
});

describe("retention pass", () => {
  const path = `/tmp/marina-retention-${crypto.randomUUID()}.db`;
  let db: MarinaDB;
  let raw: Database;
  const now = 1_800_000_000_000;

  beforeEach(() => {
    db = new MarinaDB(path);
    raw = new Database(path);
  });

  afterEach(() => {
    raw.close();
    db.close();
    cleanupDb(path);
  });

  const count = (table: string) =>
    (raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("every shipped policy names a real table and time column", () => {
    for (const policy of RETENTION_POLICIES) {
      expect(db.tableExists(policy.table)).toBe(true);
      if (policy.kind === "append-only") {
        expect(policy.keepMs).toBeUndefined();
        expect(policy.keepRows).toBeUndefined();
        continue;
      }
      const columns = db.tableColumns(policy.table);
      if (policy.keepRows !== undefined) {
        expect(columns).toContain("id");
      } else {
        expect(policy.timeColumn).toBeDefined();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(policy.timeColumn as string)) {
          expect(columns).toContain(policy.timeColumn as string);
        }
      }
    }
    // Nothing is deleted from an empty database and no shipped table is skipped.
    const result = runRetentionPass(db, { now, overridesEnv: "" });
    expect(result.deleted).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  it("keeps the last pass as a report for the dashboard", () => {
    resetRetentionReportForTests();
    expect(getLastRetentionReport()).toBeNull();
    const result = runRetentionPass(db, {
      now,
      overridesEnv: "",
      policies: [
        { table: "does_not_exist", timeColumn: "created_at", kind: "telemetry" },
        ...RETENTION_POLICIES,
      ],
    });
    const report = getLastRetentionReport()!;
    expect(report).toEqual({
      at: now,
      deleted: result.deleted,
      skipped: ["does_not_exist"],
      durationMs: result.durationMs,
    });
    // A copy, not the live object.
    report.skipped.push("mutated");
    expect(getLastRetentionReport()?.skipped).toEqual(["does_not_exist"]);
  });

  it("migration 116 added the hot-path indexes", () => {
    const names = (
      raw.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("idx_direct_messages_delivered_deadline");
    expect(names).toContain("idx_notes_supersedes");
    expect(names).toContain("idx_note_sources_url");
  });

  it("prunes past-window rows per class and leaves append-only tables alone", () => {
    const old = now - 400 * DAY;
    const recent = now - DAY;
    const insertUsage = (at: number) =>
      raw.run(
        `INSERT INTO primitive_usage (actor_name, actor_kind, source, primitive, action, safe_label, created_at)
         VALUES ('a', 'agent', 'ws', 'note', 'create', 'note', ?)`,
        [at],
      );
    insertUsage(old);
    insertUsage(now - 20 * DAY);
    insertUsage(recent);
    raw.run("INSERT INTO feed_events (kind, summary, created_at) VALUES ('x', 's', ?)", [old]);
    raw.run("INSERT INTO feed_events (kind, summary, created_at) VALUES ('x', 's', ?)", [recent]);
    raw.run(
      "INSERT INTO witness_attestations (entity_id, gate, kind, created_at) VALUES ('u', 'shell.exec', 'request', ?)",
      [old],
    );
    raw.run(
      "INSERT INTO witness_attestations (entity_id, gate, kind, created_at) VALUES ('u', 'shell.exec', 'request', ?)",
      [now - 100 * DAY],
    );
    raw.run(
      "INSERT INTO chronicle (created_at, kind, source, title, body) VALUES (?, 'event', 'engine', 't', 'b')",
      [old],
    );
    raw.run(
      "INSERT INTO core_memory_history (entity_name, key, old_value, new_value, changed_at) VALUES ('a', 'k', 'o', 'n', ?)",
      [old],
    );

    const result = runRetentionPass(db, { now, overridesEnv: "" });

    expect(result.deleted).toEqual({
      primitive_usage: 2,
      feed_events: 1,
      witness_attestations: 1,
      core_memory_history: 1,
    });
    expect(count("primitive_usage")).toBe(1);
    expect(count("feed_events")).toBe(1);
    expect(count("witness_attestations")).toBe(1);
    expect(count("chronicle")).toBe(1);
    expect(result.truncated).toEqual([]);
    expect(formatRetentionSummary(result)).toContain("primitive_usage=2");
  });

  it("reconciles the direct-message lifecycle: settled rows age out, live deadlines stay", () => {
    const old = now - 100 * DAY;
    const insert = (status: string, deadline: number | null, at: number) =>
      raw.run(
        `INSERT INTO direct_messages
           (correlation_id, dedupe_key, sender_id, sender_name, target_id, target_name, content, status, created_at, deadline_at)
         VALUES (?, 'd', 'a', 'A', 'b', 'B', 'hi', ?, ?, ?)`,
        [crypto.randomUUID(), status, at, deadline],
      );
    insert("acknowledged", null, old);
    insert("expired", old + 1, old);
    insert("delivered", null, old); // deadline-less, never acknowledged: dead
    insert("delivered", now + DAY, old); // live deadline: expireDirectMessages owns it
    insert("acknowledged", null, now - DAY);

    const result = runRetentionPass(db, { now, overridesEnv: "" });
    expect(result.deleted.direct_messages).toBe(3);
    const remaining = raw
      .query("SELECT status, deadline_at FROM direct_messages ORDER BY id")
      .all() as { status: string; deadline_at: number | null }[];
    expect(remaining).toEqual([
      { status: "delivered", deadline_at: now + DAY },
      { status: "acknowledged", deadline_at: null },
    ]);
  });

  it("honours MARINA_RETENTION_OVERRIDES (0 disables, durations replace the window)", () => {
    const old = now - 400 * DAY;
    raw.run("INSERT INTO feed_events (kind, summary, created_at) VALUES ('x', 's', ?)", [old]);
    raw.run(
      "INSERT INTO witness_attestations (entity_id, gate, kind, created_at) VALUES ('u', 'g', 'request', ?)",
      [now - 40 * DAY],
    );
    const result = runRetentionPass(db, {
      now,
      overridesEnv: "feed_events=0,witness_attestations=30d,bogus=1d",
    });
    expect(result.deleted.feed_events).toBeUndefined();
    expect(result.deleted.witness_attestations).toBe(1);
    expect(result.rejectedOverrides).toEqual(["bogus=1d"]);
    expect(count("feed_events")).toBe(1);
  });

  it("deletes in bounded batches and reports a truncated backlog", () => {
    const old = now - 400 * DAY;
    for (let i = 0; i < 12; i++) {
      raw.run("INSERT INTO feed_events (kind, summary, created_at) VALUES ('x', 's', ?)", [old]);
    }
    const first = runRetentionPass(db, {
      now,
      overridesEnv: "",
      batchRows: 5,
      maxBatchesPerTable: 2,
    });
    expect(first.deleted.feed_events).toBe(10);
    expect(first.truncated).toEqual(["feed_events"]);
    const second = runRetentionPass(db, { now, overridesEnv: "", batchRows: 5 });
    expect(second.deleted.feed_events).toBe(2);
    expect(second.truncated).toEqual([]);
    expect(count("feed_events")).toBe(0);
  });

  it("keeps the newest N rows for row-bounded tables (event_log)", () => {
    for (let i = 0; i < 25; i++) {
      raw.run("INSERT INTO event_log (type, data, timestamp) VALUES ('t', '{}', ?)", [now + i]);
    }
    const result = runRetentionPass(db, { now, overridesEnv: "event_log=10" });
    expect(result.deleted.event_log).toBe(15);
    const ids = (raw.query("SELECT id FROM event_log ORDER BY id").all() as { id: number }[]).map(
      (r) => r.id,
    );
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe(16);
    // The delegate used by the old hourly call site has the same semantics.
    expect(db.pruneEvents(4)).toBe(6);
    expect(count("event_log")).toBe(4);
    expect(db.pruneEvents(0)).toBe(4);
  });

  it("skips tables and columns that do not exist instead of failing", () => {
    const policies: RetentionPolicy[] = [
      { table: "no_such_table", timeColumn: "created_at", kind: "telemetry" },
      { table: "feed_events", timeColumn: "no_such_column", kind: "telemetry" },
      { table: "feed_events", timeColumn: "created_at", kind: "telemetry" },
    ];
    raw.run("INSERT INTO feed_events (kind, summary, created_at) VALUES ('x', 's', ?)", [
      now - 400 * DAY,
    ]);
    const result = runRetentionPass(db, { now, overridesEnv: "", policies });
    expect(result.skipped).toEqual(["no_such_table", "feed_events"]);
    expect(result.deleted.feed_events).toBe(1);
  });

  it("dates memory_assistance_actions by their owning job", () => {
    const old = now - 400 * DAY;
    raw.run(
      "INSERT INTO principals (principal_id, principal_type, display_name, created_at) VALUES ('p', 'human', 'P', ?)",
      [old],
    );
    raw.run(
      "INSERT INTO memory_spaces (id, owner_id, name, created_at) VALUES ('s', 'p', 'S', ?)",
      [old],
    );
    const job = (id: string, at: number) => {
      raw.run(
        `INSERT INTO memory_sources (id, space_id, body, content_hash, created_at) VALUES (?, 's', '"b"', 'h', ?)`,
        [`src-${id}`, at],
      );
      raw.run(
        `INSERT INTO memory_assistance_jobs
           (id, space_id, requester_id, credential_id, worker_id, role, root_id, depth, deadline, remaining_operations, input_source_id, created_at)
         VALUES (?, 's', 'p', 'c', 'w', 'reflector', ?, 0, ?, 5, ?, ?)`,
        [id, id, at + DAY, `src-${id}`, at],
      );
    };
    job("j_old", old);
    job("j_new", now - DAY);
    raw.run(
      "INSERT INTO memory_assistance_actions (job_id, principal_id, request_key, fingerprint, response) VALUES ('j_old', 'p', 'r1', 'f', '{}')",
    );
    raw.run(
      "INSERT INTO memory_assistance_actions (job_id, principal_id, request_key, fingerprint, response) VALUES ('j_new', 'p', 'r2', 'f', '{}')",
    );
    const result = runRetentionPass(db, { now, overridesEnv: "" });
    expect(result.deleted.memory_assistance_actions).toBe(1);
    expect(
      (raw.query("SELECT job_id FROM memory_assistance_actions").all() as { job_id: string }[]).map(
        (r) => r.job_id,
      ),
    ).toEqual(["j_new"]);
  });
});
