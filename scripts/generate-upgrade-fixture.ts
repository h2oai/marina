#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds an upgrade fixture from a REAL release: the database that release's
 * own code creates, not today's migrations replayed to an old version.
 *
 *   bun scripts/generate-upgrade-fixture.ts v0.8.0
 *
 * Steps (see test/fixtures/upgrade/README.md):
 *   1. `git worktree add --detach <tmp> <tag>` and `bun install --frozen-lockfile`
 *      there (the release's own dependencies, from its own lockfile).
 *   2. Re-run this file in `--seed` mode with Bun inside that worktree: it imports
 *      the release's `MarinaDB`, opens a fresh database through the constructor
 *      (the release's own schema creation and migrations), runs the release's
 *      default world `seed(db)`, then writes a few representative rows through
 *      the release's own `MarinaDB` methods (user, entity, note, core memory,
 *      task, channel message, board post, canvas).
 *   3. Dumps that database to `test/fixtures/upgrade/<tag>.sql` (`dumpDatabase`
 *      below) and writes `<tag>.json` (tag, commit, schema version, seeded ids)
 *      beside it. The worktree is removed.
 *
 * The seed child gets a minimal environment (no `.env`, no `MARINA_*`), a
 * fixed `Date.now()` and a counting `crypto.randomUUID()`, so a regeneration
 * differs only where the release reads the clock in SQL (`strftime('now')`
 * defaults) or imports `randomUUID` from `node:crypto` directly. No network,
 * model call or server is involved.
 *
 * This file must not import today's `src/` — in `--seed` mode it runs against
 * the old release's code.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FIXTURE_DIR = join(REPO_ROOT, "test/fixtures/upgrade");
/** 2026-01-01T00:00:00Z — every fixture clock starts here and ticks 1 s per read. */
const FIXED_CLOCK_MS = 1_767_225_600_000;

/** The rows written through the release's own API; the upgrade test reads them back. */
export interface SeededRows {
  user: { id: string; name: string; rank: number };
  entity: { id: string; name: string };
  note: { id: number; entityName: string; content: string };
  coreMemory: { entityName: string; key: string; value: string };
  task: { id: number; title: string };
  channel: { id: string; messageId: number; content: string };
  boardPost: { boardId: string; id: number; body: string };
  canvas: { id: string; name: string };
  worldSeeded: boolean;
}

export interface UpgradeFixtureManifest {
  tag: string;
  commit: string;
  schemaVersion: number;
  bun: string;
  sqlite: string;
  world: string;
  generator: string;
  seeded: SeededRows;
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  return result.stdout;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite value ${value} in fixture`);
    return Number.isInteger(value) ? `${value}.0` : String(value);
  }
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  throw new Error(`unsupported value ${typeof value} in fixture`);
}

/**
 * A plain-SQL dump that loads under SQLite's defensive mode (Bun enables it,
 * so `sqlite3 .dump`'s `writable_schema` trick is refused): ordinary tables
 * and rows, then each FTS5 table is created and rebuilt from its external
 * content table (every Marina FTS table is external-content), then indexes,
 * views and triggers — triggers last so loading rows never fires them.
 * Rows are ordered by rowid (WITHOUT ROWID tables by their key).
 */
export function dumpDatabase(path: string): string {
  const db = new Database(path, { readonly: true, safeIntegers: true });
  try {
    const shadows = new Set(
      (db.query("PRAGMA table_list").all() as { name: string; type: string }[])
        .filter((table) => table.type === "shadow")
        .map((table) => table.name),
    );
    const objects = (
      db
        .query(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid",
        )
        .all() as { type: string; name: string; tbl_name: string; sql: string }[]
    ).filter((o) => !o.name.startsWith("sqlite_autoindex") && !shadows.has(o.name));
    const isVirtual = (sql: string) => /^CREATE VIRTUAL TABLE/i.test(sql);
    const out = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
    // AUTOINCREMENT counters last: loading rows rewrites them, so replace them after.
    const tables = objects
      .filter((o) => o.type === "table" && !isVirtual(o.sql) && !o.name.startsWith("sqlite_stat"))
      .sort((a, b) => Number(a.name === "sqlite_sequence") - Number(b.name === "sqlite_sequence"));
    for (const table of tables) {
      out.push(table.name === "sqlite_sequence" ? "DELETE FROM sqlite_sequence;" : `${table.sql};`);
      const withoutRowid = /WITHOUT\s+ROWID\s*$/i.test(table.sql);
      const query = db.query(
        `SELECT * FROM ${quote(table.name)}${withoutRowid ? "" : " ORDER BY rowid"}`,
      );
      const columns = query.columnNames.map(quote).join(",");
      for (const row of query.values() as unknown[][])
        out.push(
          `INSERT INTO ${quote(table.name)}(${columns}) VALUES(${row.map(literal).join(",")});`,
        );
    }
    for (const table of objects.filter((o) => o.type === "table" && isVirtual(o.sql))) {
      if (!/\bcontent\s*=\s*'?\w+/i.test(table.sql))
        throw new Error(`${table.name} is not an external-content FTS table; extend dumpDatabase`);
      out.push(`${table.sql};`);
      out.push(`INSERT INTO ${quote(table.name)}(${quote(table.name)}) VALUES('rebuild');`);
    }
    for (const type of ["index", "view", "trigger"])
      for (const object of objects.filter((o) => o.type === type)) out.push(`${object.sql};`);
    out.push("COMMIT;");
    return `${out.join("\n")}\n`;
  } finally {
    db.close();
  }
}

/** Seed mode: runs inside the release worktree against the release's own code. */
async function seed(worktree: string, dbPath: string): Promise<void> {
  let clock = FIXED_CLOCK_MS;
  Date.now = () => {
    clock += 1000;
    return clock;
  };
  let uuid = 0;
  const fixedUuid = () =>
    `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: fixedUuid, configurable: true });

  const { MarinaDB } = await import(join(worktree, "src/persistence/database.ts"));
  const db = new MarinaDB(dbPath);
  let worldSeeded = false;
  const world = (await import(join(worktree, "worlds/default.ts"))).default;
  if (typeof world?.seed === "function") {
    world.seed(db);
    worldSeeded = true;
  }

  const user = { id: "fixture-account-alice", name: "Alice", rank: 2 };
  db.createUser(user);
  const entity = { id: "e_fixture_alice", name: "Alice" };
  db.saveEntity({
    id: entity.id,
    kind: "agent",
    name: entity.name,
    short: "Alice is here.",
    long: "An upgrade-fixture resident.",
    room: "lobby",
    properties: { rank: 2 },
    inventory: [],
    createdAt: Date.now(),
  });
  const noteContent = "upgrade fixture: this note must survive every upgrade";
  const noteId = db.createNote("Alice", noteContent, undefined, { importance: 7 });
  const coreMemory = { entityName: "Alice", key: "fixture-belief", value: "upgrades keep data" };
  db.setCoreMemory(coreMemory.entityName, coreMemory.key, coreMemory.value);
  const taskTitle = "upgrade fixture task";
  const taskId = db.createTask({
    title: taskTitle,
    description: "created by the release under test",
    creatorId: entity.id,
    creatorName: "Alice",
  });
  const channelId = "fixture-channel";
  const messageContent = "upgrade fixture channel message";
  db.createChannel({ id: channelId, type: "custom", name: "fixture", ownerId: entity.id });
  const messageId = db.addChannelMessage(channelId, entity.id, "Alice", messageContent);
  const boardId = "fixture-board";
  const postBody = "upgrade fixture board post";
  db.createBoard({ id: boardId, name: "fixture-board" });
  const postId = db.createBoardPost({
    boardId,
    authorId: entity.id,
    authorName: "Alice",
    title: "fixture",
    body: postBody,
  });
  const canvas = { id: "fixture-canvas", name: "Fixture canvas" };
  db.createCanvas({ ...canvas, creatorName: "Alice" });
  db.close();

  const seeded: SeededRows = {
    user,
    entity,
    note: { id: noteId, entityName: "Alice", content: noteContent },
    coreMemory,
    task: { id: taskId, title: taskTitle },
    channel: { id: channelId, messageId, content: messageContent },
    boardPost: { boardId, id: postId, body: postBody },
    canvas,
    worldSeeded,
  };
  // The parent reads the last stdout line; world seeds may log above it.
  process.stdout.write(`\n${JSON.stringify(seeded)}\n`);
}

async function generate(tag: string): Promise<void> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag))
    throw new Error(`expected a release tag like v0.8.0, got ${tag}`);
  const commit = run("git", ["rev-list", "-n1", tag], REPO_ROOT).trim();
  const scratch = mkdtempSync(join(tmpdir(), `marina-fixture-${tag}-`));
  const worktree = join(scratch, "release");
  const dbPath = join(scratch, "world.db");
  try {
    run("git", ["worktree", "add", "--detach", worktree, tag], REPO_ROOT);
    run("bun", ["install", "--frozen-lockfile"], worktree);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: scratch,
      TMPDIR: scratch,
      NO_COLOR: "1",
    };
    const out = run(
      "bun",
      [
        "--no-env-file",
        join(import.meta.dir, "generate-upgrade-fixture.ts"),
        "--seed",
        worktree,
        dbPath,
      ],
      worktree,
      env,
    );
    const seeded = JSON.parse(out.trim().split("\n").at(-1) ?? "") as SeededRows;
    const check = new Database(dbPath, { readonly: true });
    const { version: schemaVersion, sqlite } = check
      .query("SELECT MAX(version) AS version, sqlite_version() AS sqlite FROM schema_version")
      .get() as { version: number; sqlite: string };
    check.close();
    const dump = dumpDatabase(dbPath);
    const sqlPath = join(FIXTURE_DIR, `${tag}.sql`);
    writeFileSync(sqlPath, dump);
    const manifest: UpgradeFixtureManifest = {
      tag,
      commit,
      schemaVersion,
      bun: run("bun", ["--version"], worktree).trim(),
      sqlite,
      world: "default",
      generator: "scripts/generate-upgrade-fixture.ts",
      seeded,
    };
    writeFileSync(join(FIXTURE_DIR, `${tag}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `${tag}: schema ${schemaVersion}, ${(statSync(sqlPath).size / 1024).toFixed(0)} KiB → ${sqlPath}\n`,
    );
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: REPO_ROOT });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--seed") {
    const [worktree, dbPath] = rest;
    if (!worktree || !dbPath) throw new Error("--seed <worktree> <db-path>");
    await seed(worktree, dbPath);
  } else if (first && first !== "--help") {
    await generate(first);
  } else {
    process.stdout.write("usage: bun scripts/generate-upgrade-fixture.ts <release-tag>\n");
  }
}
