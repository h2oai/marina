// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Cooperative exclusion on a separate SQLite file. The kernel releases its
 * locks after SIGKILL, including across container PID namespaces. Never unlink
 * the lease file: competing processes must keep locking the same inode.
 */
export function acquireDatabaseLease(path: string): () => void {
  const file = `${resolve(path)}.instance-lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lease = new Database(file);
  try {
    lease.exec("PRAGMA busy_timeout=0");
    lease.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY)");
    lease.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lease.close();
    throw new Error(
      `Database is leased or its lease is unavailable: ${path}. Stop its server before offline maintenance.`,
      { cause: error },
    );
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.close();
    process.removeListener("exit", release);
  };
  process.on("exit", release);
  return release;
}

/** Verify that the kernel has released a stopped instance's lease; never break a live lock. */
export function unlockStoppedDatabase(path: string): void {
  acquireDatabaseLease(path)();
}
