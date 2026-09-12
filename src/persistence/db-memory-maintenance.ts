// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MIGRATIONS } from "./schema";

export function memoryDatabaseHealth(db: Database): boolean {
  try {
    return Boolean(
      db.query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get(),
    );
  } catch {
    return false;
  }
}

/** Operator-only SQLite snapshot/restore. Publish only a verified complete file;
 * never replace a live database. Staging stays on the destination filesystem. */
export async function snapshotMemoryDatabase(sourcePath: string, destinationPath: string) {
  const source = resolve(sourcePath),
    destination = resolve(destinationPath);
  if (source === destination || existsSync(destination))
    throw new Error("Destination must be a new database path");
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(parent, ".marina-snapshot-"));
  const temporary = join(stage, "snapshot.db");
  try {
    const input = new Database(source, { readonly: true });
    try {
      input.exec("PRAGMA synchronous=FULL");
      input.exec("PRAGMA busy_timeout=5000");
      input.run("VACUUM INTO ?", [temporary]);
    } finally {
      input.close();
    }
    chmodSync(temporary, 0o600);
    const check = new Database(temporary, { readonly: true });
    let schema: number;
    try {
      const integrity = check.query("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[];
      if (
        integrity.length !== 1 ||
        integrity[0]?.integrity_check !== "ok" ||
        check.query("PRAGMA foreign_key_check").all().length
      )
        throw new Error("Snapshot failed database integrity validation");
      schema = (
        check.query("SELECT max(version) AS version FROM schema_version").get() as {
          version: number;
        }
      ).version;
      if (!Number.isSafeInteger(schema) || schema < 1 || schema > MIGRATIONS.at(-1)!.version)
        throw new Error("Snapshot uses an unsupported Marina schema");
    } finally {
      check.close();
    }
    const hasher = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(temporary)) {
      hasher.update(chunk);
      bytes += chunk.length;
    }
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    // Atomic no-replace publication; a racing destination creator wins safely.
    linkSync(temporary, destination);
    const directory = openSync(parent, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return {
      schema: "marina.memory.snapshot.v1",
      destination,
      schema_version: schema,
      bytes,
      sha256: hasher.digest("hex"),
      verified: true,
    };
  } finally {
    rmSync(stage, { recursive: true });
  }
}
