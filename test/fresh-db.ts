// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";

let template: string | undefined;

/**
 * Write a new, empty, fully migrated world database at `path` and return it.
 *
 * A fresh install replays the schema baseline and then every later migration,
 * each ALTER re-parsing the whole schema: ~0.15 s idle and ~0.7–1 s on a
 * loaded machine, paid by every test that opens a new database file. This
 * copies one per-process template instead (closed, so checkpointed and
 * WAL-free) — the same schema at the same version, in a fraction of the time.
 * Use it where the test is about what happens AFTER the database exists; tests
 * of installation or migration itself must keep calling `new MarinaDB(path)`.
 */
export function freshDbFile(path: string): string {
  if (!template || !existsSync(template)) {
    const dir = mkdtempSync(join(tmpdir(), "marina-db-template-"));
    template = join(dir, "template.db");
    new MarinaDB(template).close();
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  copyFileSync(template, path);
  return path;
}
