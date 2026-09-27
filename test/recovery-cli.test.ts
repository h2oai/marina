// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { exportState, importState } from "../src/persistence/export-import";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "marina-recovery-cli-"));
  directories.push(directory);
  return { directory, path: join(directory, "world.db") };
}
async function run(script: string, args: string[]) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../scripts", script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, S3_BUCKET: "" },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("empty exported tables clear target data while omitted tables preserve their scope", () => {
  const source = fixture(),
    target = fixture();
  const a = new MarinaDB(source.path),
    b = new MarinaDB(target.path);
  const note = b.createNote("Alice", "remove from replacement");
  b.setCoreMemory("Alice", "retain", "outside selected scope");
  a.close();
  b.close();
  const snapshot = exportState(source.path);
  expect(snapshot.tables.notes).toEqual([]);
  const selected = { ...snapshot, tables: { notes: snapshot.tables.notes! } };
  expect(importState(target.path, selected).errors).toEqual([]);
  const restored = new MarinaDB(target.path);
  try {
    expect(restored.getNote(note)).toBeUndefined();
    expect(restored.getCoreMemory("Alice", "retain")).toBeDefined();
  } finally {
    restored.close();
  }
});

test("failed CLI imports exit nonzero and roll back existing data", async () => {
  const { directory, path } = fixture();
  const db = new MarinaDB(path);
  const note = db.createNote("Alice", "preserved");
  const schema = exportState(path).schema_version;
  db.close();
  const input = join(directory, "invalid.json");
  writeFileSync(
    input,
    JSON.stringify({
      format: "marina-snapshot",
      version: 1,
      schema_version: schema,
      tables: { notes: [{ id: 999, entity_name: "Alice", content: null }] },
    }),
  );
  const result = await run("state-import.ts", [input, path]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("Transaction failed");
  expect(result.stdout).not.toContain("Restart the Marina server");
  const restored = new MarinaDB(path);
  try {
    expect(restored.getNote(note)?.content).toBe("preserved");
  } finally {
    restored.close();
  }
});

test("backup reads committed WAL data and restore refuses to replace an existing database", async () => {
  const { directory, path } = fixture();
  const db = new MarinaDB(path);
  const note = db.createNote("Alice", "committed before checkpoint");
  try {
    const backups = join(directory, "backups");
    const backup = await run("backup.ts", ["backup", path, backups]);
    expect(backup.code).toBe(0);
    const file = readdirSync(backups).find((name) => name.endsWith(".db"))!;
    const restoredPath = join(directory, "restored.db");
    expect((await run("backup.ts", ["restore", join(backups, file), restoredPath])).code).toBe(0);
    const restored = new MarinaDB(restoredPath);
    try {
      expect(restored.getNote(note)?.content).toBe("committed before checkpoint");
    } finally {
      restored.close();
    }
    expect((await run("backup.ts", ["restore", join(backups, file), path])).code).toBe(1);
    expect(db.getNote(note)?.content).toBe("committed before checkpoint");
  } finally {
    db.close();
  }
});

test("unknown or inconsistent imported columns roll back rather than silently discarding rows", () => {
  const { path } = fixture();
  const db = new MarinaDB(path);
  const id = db.createNote("Alice", "keep this note");
  try {
    const snapshot = exportState(path);
    const row = snapshot.tables.notes![0] as Record<string, unknown>;
    const invalid = [
      [{ unexpected_column: "wrong" }],
      [row, { ...row, id: id + 1, unexpected_column: "wrong" }],
    ];
    for (const notes of invalid) {
      const result = importState(path, { ...snapshot, tables: { notes } });
      expect(result.errors.length).toBe(1);
      expect(db.getNote(id)?.content).toBe("keep this note");
    }
  } finally {
    db.close();
  }
});
