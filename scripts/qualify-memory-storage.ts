// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Actual ENOSPC and read-only filesystem faults in a private Linux mount namespace.
 * Never fills a host filesystem. Mount is capped to 32 MiB and verified before filling.
 */
import type { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { memoryStorageFailure } from "../src/persistence/db-memory-failures";
import { MarinaMemoryClient, MemoryClientError } from "../src/sdk/memory-client";

const worker = Bun.argv[2] === "--worker";
async function command(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LIBMOUNT_FORCE_MOUNT2: "always", ...env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(`${args.join(" ")} failed (${code}): ${err}`);
  return out;
}
if (!worker) {
  const output = Bun.argv[2];
  if (!output)
    throw new Error(
      "Usage: bun run scripts/qualify-memory-storage.ts OUTPUT_JSON (Linux user/mount namespaces required)",
    );
  const directory = mkdtempSync(join(tmpdir(), "marina-storage-drill-"));
  try {
    const library = join(directory, "fault.so");
    await command([
      "cc",
      "-shared",
      "-fPIC",
      "-O2",
      "-Wall",
      "-Wextra",
      resolve(import.meta.dir, "fixtures/memory-eio.c"),
      "-ldl",
      "-o",
      library,
    ]);
    const result = await command(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        process.execPath,
        resolve(import.meta.path),
        "--worker",
        directory,
      ],
      { LD_PRELOAD: library, MARINA_EIO_FIXTURE_DIR: directory },
    );
    const report = JSON.parse(result.trim().split("\n").at(-1)!);
    await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } finally {
    rmSync(directory, { recursive: true });
  }
} else {
  const directory = Bun.argv[3]!;
  if (!directory.startsWith(join(tmpdir(), "marina-storage-drill-")))
    throw new Error("Disposable directory required");
  await command([
    "mount",
    "-t",
    "tmpfs",
    "-o",
    "size=32m,nosuid,nodev,uid=0,gid=0",
    "tmpfs",
    directory,
  ]);
  const fs = statfsSync(directory);
  assert.equal(fs.type, 0x01021994);
  assert.ok(fs.blocks * fs.bsize <= 32 * 1024 ** 2);
  const path = join(directory, "memory.db");
  let db = new MarinaDB(path, { durability: "full" });
  const token = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "storage-drill" }).principal_id,
  ).token;
  let service = new MemoryService(db);
  const client = new MarinaMemoryClient("http://memory.test", token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  const space = (await client.createSpace("storage")).id;
  const before = await client.capture(
    space,
    "acknowledged before storage failure",
    undefined,
    "before",
  );
  (db as unknown as { db: Database }).db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const filler = join(directory, "filler"),
    fd = openSync(filler, "wx", 0o600);
  let full = false;
  try {
    for (let i = 0; i < 513; i++) writeSync(fd, Buffer.alloc(65536, 0x61));
  } catch (error) {
    assert.equal((error as { code?: string }).code, "ENOSPC");
    full = true;
  } finally {
    closeSync(fd);
  }
  assert.ok(full, "actual filesystem capacity must be exhausted");
  const faults: { fault: string; code: string; status: number }[] = [];
  const attempt = async (fault: string, key: string) => {
    try {
      await client.capture(space, `${fault} source`, undefined, key);
      assert.fail("Faulted write succeeded");
    } catch (error) {
      assert.ok(error instanceof MemoryClientError);
      assert.ok(["storage_full", "storage_read_only", "storage_io_error"].includes(error.code));
      faults.push({ fault, code: error.code, status: error.status });
    }
  };
  await attempt("ENOSPC", "full-write");
  unlinkSync(filler);
  await service.close();
  db.close();
  db = new MarinaDB(path, { durability: "full" });
  service = new MemoryService(db);
  assert.equal(
    (await client.sourceRange(space, before.id)).text,
    "acknowledged before storage failure",
  );
  const recovered = await client.capture(space, "ENOSPC source", undefined, "full-write");
  assert.deepEqual(
    await client.capture(space, "ENOSPC source", undefined, "full-write"),
    recovered,
  );
  writeFileSync(join(directory, "inject-eio"), "explicit disposable fault");
  await attempt("EIO: injected write/sync", "io-write");
  unlinkSync(join(directory, "inject-eio"));
  await service.close();
  db.close();
  db = new MarinaDB(path, { durability: "full" });
  service = new MemoryService(db);
  const ioRecovered = await client.capture(
    space,
    "EIO: injected write/sync source",
    undefined,
    "io-write",
  );
  assert.deepEqual(
    await client.capture(space, "EIO: injected write/sync source", undefined, "io-write"),
    ioRecovered,
  );

  (db as unknown as { db: Database }).db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await service.close();
  db.close();
  await command(["mount", "-t", "tmpfs", "-o", "remount,ro,uid=0,gid=0", "tmpfs", directory]);
  assert.throws(() => writeFileSync(join(directory, "readonly-probe"), "x"), { code: "EROFS" });
  try {
    new MarinaDB(path, { durability: "full" });
    assert.fail("Read-only WAL deployment unexpectedly started");
  } catch (error) {
    const failure = memoryStorageFailure(error);
    assert.ok(failure);
    faults.push({ fault: "EROFS: startup refused", code: failure.code, status: failure.status });
  }
  await command(["mount", "-t", "tmpfs", "-o", "remount,rw,uid=0,gid=0", "tmpfs", directory]);
  db = new MarinaDB(path, { durability: "full" });
  service = new MemoryService(db);
  await client.capture(space, "EROFS source", undefined, "readonly-write");
  assert.equal((await client.sources(space)).sources.length, 4);
  assert.deepEqual((db as unknown as { db: Database }).db.query("PRAGMA integrity_check").all(), [
    { integrity_check: "ok" },
  ]);
  await service.close();
  db.close();
  console.log(
    JSON.stringify({
      schema: "marina.memory.storage-drill.v1",
      observed_at: new Date().toISOString(),
      filesystem: "private tmpfs, 32 MiB",
      faults,
      recovered_sources: 4,
      same_key_recovery: true,
      integrity_check: "ok",
      host_filesystem_filled: false,
      limits:
        "Real Linux ENOSPC/EROFS errors on tmpfs; deterministic EIO injected at libc write/sync boundary. Does not simulate failing disk hardware, controller write-cache loss, or power failure.",
    }),
  );
}
