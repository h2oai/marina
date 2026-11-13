// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The storage budget (src/engine/storage-budget.ts): Marina never fills the
// disk. Pruning removes only proven journal captures, and a world still over
// its cap after cleanup pauses agents and raises one alert.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageCheck } from "../src/engine/readiness";
import {
  DEFAULT_STORAGE_MAX_BYTES,
  directoryBytes,
  parseByteSize,
  resetStorageBudgetForTests,
  runStoragePass,
  STORAGE_ALERT_KEY,
  storageLimits,
  storageRefusal,
} from "../src/engine/storage-budget";
import { MarinaDB } from "../src/persistence/database";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 12);

describe("byte sizes", () => {
  it("reads integers, binary units, and off", () => {
    expect(parseByteSize("1024")).toBe(1024);
    expect(parseByteSize("5GB")).toBe(5 * 1024 ** 3);
    expect(parseByteSize("5 GiB")).toBe(5 * 1024 ** 3);
    expect(parseByteSize("500mb")).toBe(500 * 1024 ** 2);
    expect(parseByteSize("1.5g")).toBe(1.5 * 1024 ** 3);
    expect(parseByteSize("off")).toBe(0);
    expect(parseByteSize("0")).toBe(0);
    expect(parseByteSize("five")).toBeUndefined();
    expect(parseByteSize("5 parsecs")).toBeUndefined();
    expect(parseByteSize("-1")).toBeUndefined();
  });

  it("defaults to a 5 GiB cap and keeps the default for junk", () => {
    expect(storageLimits({})).toMatchObject({
      maxBytes: DEFAULT_STORAGE_MAX_BYTES,
      minFreeBytes: 1024 ** 3,
      rejected: [],
    });
    expect(DEFAULT_STORAGE_MAX_BYTES).toBe(5 * 1024 ** 3);
    const junk = storageLimits({ MARINA_STORAGE_MAX_BYTES: "lots" });
    expect(junk.maxBytes).toBe(DEFAULT_STORAGE_MAX_BYTES);
    expect(junk.rejected).toEqual(["MARINA_STORAGE_MAX_BYTES=lots"]);
    expect(storageLimits({ MARINA_STORAGE_MAX_BYTES: "off" }).maxBytes).toBe(0);
  });
});

describe("storage budget", () => {
  let dir: string;
  let db: MarinaDB;
  let raw: Database;

  beforeEach(() => {
    resetStorageBudgetForTests();
    dir = mkdtempSync(join(tmpdir(), "marina-storage-"));
    db = new MarinaDB(join(dir, "world.db"));
    raw = new Database(join(dir, "world.db"));
    raw.run(
      "INSERT INTO memory_spaces (id, owner_id, name, created_at) VALUES ('s', 'p', 'resident', 0)",
    );
  });
  afterEach(() => {
    raw.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    resetStorageBudgetForTests();
  });

  const source = (id: string, at: number, body: unknown, size = 0) =>
    raw.run(
      "INSERT INTO memory_sources (id, space_id, body, content_hash, created_at) VALUES (?, 's', ?, 'h', ?)",
      [id, JSON.stringify(typeof body === "string" ? body + "x".repeat(size) : body), at],
    );
  const manifest = (id: string, at: number, kind: string, parts: string[], previous?: string) =>
    source(id, at, {
      format: "json-utf8-parts-v1",
      sha256: id,
      kind,
      source_ids: parts,
      previous_manifest_source_id: previous ?? null,
    });
  const ids = () =>
    (raw.query("SELECT id FROM memory_sources ORDER BY seq").all() as { id: string }[]).map(
      (r) => r.id,
    );

  it("makes new databases with incremental auto-vacuum", () => {
    expect(db.databasePages().autoVacuum).toBe(2);
  });

  it("prunes only old journal captures, keeping everything still referenced", () => {
    const old = now - 60 * DAY;
    for (const id of ["p1", "p2", "p3", "p4", "p6"]) source(id, old, `{"role":"user"}`);
    source("fact", old, "a fact someone captured");
    manifest("m1", old, "journal", ["p1", "p2", "p3", "p4"]);
    // The only archive is kept however old: the newest of its kind.
    manifest("a1", old, "archive", ["p6"]);
    source("p5", now - DAY, `{"role":"assistant"}`);
    // The current capture reuses p3.
    manifest("m2", now - DAY, "journal", ["p3", "p5"], "m1");
    // A record derived from p4 keeps it.
    raw.run(
      "INSERT INTO memory_records (id, space_id, version, created_at) VALUES ('r', 's', 1, 0)",
    );
    raw.run("INSERT INTO memory_derivations (record_id, source_id) VALUES ('r', 'p4')");
    const textRows = () =>
      (raw.query("SELECT count(*) AS n FROM memory_source_text").get() as { n: number }).n;
    const before = textRows();

    const result = db.pruneJournalSources(now - 30 * DAY);

    expect(result).toMatchObject({ manifests: 1, parts: 2 });
    expect(ids()).toEqual(["p3", "p4", "p6", "fact", "a1", "p5", "m2"]);
    // The text copy and the storage ledger follow.
    expect(textRows()).toBe(before - 3);
    expect(
      raw
        .query("SELECT count(*) AS n FROM memory_storage_items WHERE kind='source' AND ref='p1'")
        .get(),
    ).toEqual({ n: 0 });
    // Nothing left to prune at the same window.
    expect(db.pruneJournalSources(now - 30 * DAY)).toMatchObject({ manifests: 0, parts: 0 });
  });

  it("stopped between batches, no manifest is left pointing at a missing part", () => {
    const old = now - 60 * DAY;
    for (const id of ["a", "b", "c"]) source(id, old, `{"role":"user"}`);
    manifest("m1", old, "journal", ["a", "b"]);
    manifest("m2", old + 1, "journal", ["b", "c"], "m1");
    manifest("m3", now, "journal", [], "m2");
    const first = db.pruneJournalSources(now - 30 * DAY, { batch: 1, stop: () => true });
    expect(first).toMatchObject({ manifests: 1, parts: 1 });
    // b is still listed by m2, which this run did not reach.
    expect(ids()).toEqual(["b", "c", "m2", "m3"]);
    expect(db.pruneJournalSources(now - 30 * DAY)).toMatchObject({ manifests: 1, parts: 2 });
    expect(ids()).toEqual(["m3"]);
  });

  it("keeps a source a checkpoint names", () => {
    const old = now - 60 * DAY;
    source("p1", old, `{"role":"user"}`);
    manifest("m1", old, "journal", ["p1"]);
    manifest("m2", now, "journal", []);
    raw.run(
      `INSERT INTO memory_checkpoints (space_id, name, version, source_cursor, data, updated_at)
       VALUES ('s', 'resident', 1, 0, ?, 0)`,
      [JSON.stringify({ journal: { manifest_source_id: "m2" }, pinned: ["p1"] })],
    );
    expect(db.pruneJournalSources(now - 30 * DAY)).toMatchObject({ manifests: 1, parts: 0 });
    expect(ids()).toEqual(["p1", "m2"]);
  });

  it("under pressure frees the journal, returns pages, and stays quiet when there is room", async () => {
    const old = now - 60 * DAY;
    const parts = Array.from({ length: 40 }, (_, i) => `p${i}`);
    for (const id of parts) source(id, old, "part", 20_000);
    manifest("m1", old, "journal", parts);
    manifest("m2", now, "journal", []);
    const files = join(dir, "assets");
    const env = { MARINA_STORAGE_MAX_BYTES: "1GB", MARINA_STORAGE_MIN_FREE_BYTES: "off" };

    const roomy = await runStoragePass(db, { env, now, dirs: [files] });
    expect(roomy).toMatchObject({ pressure: false, overCap: false, freed: {} });
    expect(ids()).toContain("p0");

    // A cap just under what is held: the old journal goes and that is enough.
    const held = roomy.after.held;
    const tight = await runStoragePass(db, {
      env: { ...env, MARINA_STORAGE_MAX_BYTES: String(Math.ceil(held * 1.05)) },
      now,
      dirs: [files],
    });
    expect(tight.pressure).toBe(true);
    expect(Object.keys(tight.freed)).toContain("journal>30d");
    expect(ids()).toEqual(["m2"]);
    expect(tight.reclaimed).toBeGreaterThan(0);
    expect(tight.after.databaseFile).toBeLessThan(roomy.after.databaseFile);
    expect(tight.overCap).toBe(false);
    expect(storageRefusal()).toBeNull();
  });

  it("over the cap after cleanup: agents pause, one alert, both clear when there is room", async () => {
    const files = join(dir, "assets");
    mkdirSync(files);
    writeFileSync(join(files, "photo.png"), Buffer.alloc(200_000));
    expect(directoryBytes(files)).toBe(200_000);
    const env = { MARINA_STORAGE_MAX_BYTES: "100KB", MARINA_STORAGE_MIN_FREE_BYTES: "off" };

    const full = await runStoragePass(db, { env, now, dirs: [files] });
    expect(full).toMatchObject({ pressure: true, overCap: true });
    expect(storageRefusal()).toContain("storage cap reached");
    const alert = db.listOperationalAlerts("open").find((a) => a.alert_key === STORAGE_ALERT_KEY);
    expect(alert?.severity).toBe("critical");
    expect(storageCheck()).toMatchObject({ id: "storage", status: "degraded" });
    // People's files are never removed.
    expect(directoryBytes(files)).toBe(200_000);

    const roomy = await runStoragePass(db, {
      env: { ...env, MARINA_STORAGE_MAX_BYTES: "off" },
      now,
      dirs: [files],
    });
    expect(roomy.overCap).toBe(false);
    expect(storageRefusal()).toBeNull();
    expect(db.listOperationalAlerts("open").some((a) => a.alert_key === STORAGE_ALERT_KEY)).toBe(
      false,
    );
    expect(storageCheck().status).toBe("ok");
  });
});
