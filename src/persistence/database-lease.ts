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

/**
 * Wait, bounded, until no live process holds the database's lease. A previous
 * server that is still draining (agent checkpoints, background jobs, WAL
 * close) releases the lease when it exits; a caller about to boot a new server
 * on the same file probes with exponential backoff instead of failing at once.
 * Probing never breaks a live lock: on timeout it throws the lease error, and
 * the caller must refuse to start rather than continue degraded.
 */
export async function waitForDatabaseLease(
  path: string,
  opts: { timeoutMs?: number; initialDelayMs?: number; maxDelayMs?: number } = {},
): Promise<{ waitedMs: number; attempts: number }> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const maxDelayMs = opts.maxDelayMs ?? 1_000;
  let delay = opts.initialDelayMs ?? 50;
  const started = Date.now();
  for (let attempts = 1; ; attempts++) {
    try {
      acquireDatabaseLease(path)();
      return { waitedMs: Date.now() - started, attempts };
    } catch (error) {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw error;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
