// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { freshDbFile } from "./fresh-db";
import { until } from "./helpers";

// Opening a world database while another process holds its lock waits for
// the lock (busy_timeout) instead of failing on the first statement. The
// busy timeout used to be set after `PRAGMA journal_mode=WAL`, so a second
// process opening the same database at that moment threw SQLITE_BUSY.
describe("opening a database another process has locked", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-open-busy-"));
    path = freshDbFile(join(dir, "world.db"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits for the lock instead of throwing", async () => {
    const ready = join(dir, "locked");
    // Exclusive locking mode keeps every other connection out until the holder closes.
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(path)});
         db.exec("PRAGMA locking_mode=EXCLUSIVE");
         db.exec("BEGIN EXCLUSIVE");
         db.exec("CREATE TABLE IF NOT EXISTS open_busy_probe (x)");
         require("node:fs").writeFileSync(${JSON.stringify(ready)}, "");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    await until(() => Bun.file(ready).exists(), { message: "the lock holder never started" });
    // Throws SQLITE_BUSY at once when the busy timeout is not yet in force.
    new MarinaDB(path).close();
    expect(await holder.exited).toBe(0);
    // The holder's write committed before the open went through.
    const check = new Database(path, { readonly: true });
    try {
      expect(check.query("SELECT count(*) AS n FROM open_busy_probe").get()).toEqual({ n: 0 });
    } finally {
      check.close();
    }
  });
});
