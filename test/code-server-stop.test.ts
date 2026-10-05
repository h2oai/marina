// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// A folder-scoped `marina` launch must not exit before its server has released
// the project database, or the next launch on the same folder (an implementer
// followed by a reviewer) dies on the still-held lease.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopServerProcess } from "../scripts/code";
import { acquireDatabaseLease, waitForDatabaseLease } from "../src/persistence/database-lease";

const LEASE_MODULE = resolve(import.meta.dir, "../src/persistence/database-lease.ts");

/** A stand-in server: holds the lease, drains for `drainMs` after SIGTERM, then releases. */
function leaseHolder(dbPath: string, drainMs: number, ignoreTerm = false) {
  const script = `
    import { acquireDatabaseLease } from ${JSON.stringify(LEASE_MODULE)};
    const release = acquireDatabaseLease(${JSON.stringify(dbPath)});
    process.on("SIGTERM", () => {
      if (${ignoreTerm}) return;
      setTimeout(() => { release(); process.exit(0); }, ${drainMs});
    });
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  return Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit" });
}

async function untilReady(proc: ReturnType<typeof leaseHolder>): Promise<void> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("lease holder exited before it was ready");
    out += decoder.decode(value);
  }
  reader.releaseLock();
}

describe("folder-scoped server stop and database lease", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-code-stop-"));
    dbPath = join(dir, "marina.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reproduces the race: the lease is still held right after SIGTERM, and free once the stop is awaited", async () => {
    const server = leaseHolder(dbPath, 300);
    await untilReady(server);

    server.kill("SIGTERM");
    // What the launcher used to do: exit here, and the next launch boots into a held lease.
    expect(() => acquireDatabaseLease(dbPath)()).toThrow("leased");

    expect(await stopServerProcess(server, 10_000)).toBe("exited");
    expect(() => acquireDatabaseLease(dbPath)()).not.toThrow();
  });

  it("escalates to SIGKILL after the grace period, and the kernel drops the lease", async () => {
    const server = leaseHolder(dbPath, 0, true);
    await untilReady(server);

    expect(await stopServerProcess(server, 200)).toBe("killed");
    expect(() => acquireDatabaseLease(dbPath)()).not.toThrow();
  });

  it("waits, bounded, for a draining holder to release the lease", async () => {
    const release = acquireDatabaseLease(dbPath);
    setTimeout(release, 150);
    const waited = await waitForDatabaseLease(dbPath, { timeoutMs: 5_000, initialDelayMs: 20 });
    expect(waited.attempts).toBeGreaterThan(1);
    expect(() => acquireDatabaseLease(dbPath)()).not.toThrow();
  });

  it("refuses with the lease error when the holder never lets go", async () => {
    const release = acquireDatabaseLease(dbPath);
    try {
      await expect(
        waitForDatabaseLease(dbPath, { timeoutMs: 150, initialDelayMs: 20 }),
      ).rejects.toThrow("leased");
    } finally {
      release();
    }
  });
});
