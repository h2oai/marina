// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { snapshotMemoryDatabase } from "./db-memory-maintenance";

/** Only this source's verified, manifest-backed snapshots are eligible. No glob
 * cleanup of user files. Create and verify the replacement before pruning. */
export async function rotateMemoryBackups(sourcePath: string, directoryPath: string, keep: number) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 1000)
    throw new Error("keep must be 1–1000");
  const source = realpathSync(sourcePath),
    directory = resolve(directoryPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = createHash("sha256").update(source).digest("hex").slice(0, 24);
  const prefix = `marina-memory-${identity}-`,
    lock = join(directory, `${prefix}rotation.lock`);
  const fd = openSync(lock, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, source, started_at: Date.now() }));
    fsyncSync(fd);
    const name = `${prefix}${Date.now()}-${randomUUID()}.db`,
      destination = join(directory, name);
    const snapshot = await snapshotMemoryDatabase(source, destination);
    const manifest = { ...snapshot, source_identity: identity, file: name, created_at: Date.now() };
    const manifestPath = `${destination}.json`;
    writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    const manifestFd = openSync(manifestPath, "r");
    try {
      fsyncSync(manifestFd);
    } finally {
      closeSync(manifestFd);
    }
    syncDirectory(directory); // Publish the replacement manifest durably before pruning.
    const eligible: { name: string; created_at: number }[] = [],
      skipped: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".db.json")) continue;
      try {
        const file = join(directory, entry);
        if (!lstatSync(file).isFile()) {
          skipped.push(entry);
          continue;
        }
        const item = JSON.parse(readFileSync(file, "utf8"));
        if (
          item.schema !== "marina.memory.snapshot.v1" ||
          item.verified !== true ||
          item.source_identity !== identity ||
          item.file !== basename(item.file) ||
          `${item.file}.json` !== entry ||
          !Number.isSafeInteger(item.created_at)
        ) {
          skipped.push(entry);
          continue;
        }
        const backup = join(directory, item.file);
        if (
          !existsSync(backup) ||
          !lstatSync(backup).isFile() ||
          lstatSync(backup).size !== item.bytes ||
          (await digestFile(backup)) !== item.sha256
        ) {
          skipped.push(entry);
          continue;
        }
        eligible.push({ name: item.file, created_at: item.created_at });
      } catch {
        skipped.push(entry);
      }
    }
    if (!eligible.some((item) => item.name === name))
      throw new Error(
        "Replacement snapshot failed publication verification; retained backups were not pruned",
      );
    eligible.sort((a, b) => b.created_at - a.created_at || b.name.localeCompare(a.name));
    // Always retain the replacement, even with equal timestamps or clock rollback.
    const retained = new Set([
      name,
      ...eligible
        .filter((item) => item.name !== name)
        .slice(0, keep - 1)
        .map((item) => item.name),
    ]);
    const removed: string[] = [];
    for (const item of eligible)
      if (!retained.has(item.name)) {
        unlinkSync(join(directory, item.name));
        unlinkSync(join(directory, `${item.name}.json`));
        removed.push(item.name);
      }
    syncDirectory(directory);
    return {
      schema: "marina.memory.backup-rotation.v1",
      snapshot,
      retained: [...retained],
      removed,
      skipped,
    };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

async function digestFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
