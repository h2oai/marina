// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Distill a world database into a `marina.learned.v1` bundle, and archive it.
 *
 * `distillDatabase` reads the source READ-ONLY: SQLite's `VACUUM INTO` takes a
 * consistent snapshot through a read-only connection (a running server may
 * hold the file), the snapshot is opened and exported through the ordinary
 * allow-list (`exportLearnedBundle`: trusted lessons, ratified conventions,
 * promoted defaults, k-anonymous ledger aggregates, adopted roles, every item
 * scanned), and the snapshot is removed. The source file is never opened for
 * writing, so no migration, checkpoint or row ever touches it. Everything
 * outside the allow-list is excluded by construction, and the manifest says
 * so (`excludes`). No model is involved.
 *
 * `archiveDatabase` moves a database (and its `-wal`/`-shm`/`-journal`) into a
 * cold archive directory next to it. It never deletes, and it refuses while a
 * server holds the database's lease (`acquireDatabaseLease`).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MarinaDB } from "../persistence/database";
import { acquireDatabaseLease } from "../persistence/database-lease";
import { MANIFEST_FILE } from "./bundle";
import { type ExportOptions, type ExportResult, exportLearnedBundle } from "./export";

export interface DistillOptions
  extends Omit<ExportOptions, "outDir" | "signingKey" | "unsignedIdentity" | "parentDir"> {
  /** The world database to distill (read-only). */
  sourcePath: string;
  /** Bundle directory to write (must not already hold a bundle). */
  outDir: string;
  /** The publisher key; `null` writes an UNSIGNED bundle, labelled as such. */
  signingKey: string | null;
}

export interface DistillResult extends ExportResult {
  outDir: string;
  sourcePath: string;
  unsigned: boolean;
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Distill `sourcePath` into a bundle at `outDir` without writing to the source. */
export function distillDatabase(opts: DistillOptions): DistillResult {
  const sourcePath = resolve(opts.sourcePath);
  if (opts.sourcePath === ":memory:" || !existsSync(sourcePath) || !statSync(sourcePath).isFile())
    throw new Error(`no database file at ${opts.sourcePath}`);
  const outDir = resolve(opts.outDir);
  if (existsSync(join(outDir, MANIFEST_FILE)))
    throw new Error(`${opts.outDir} already holds a bundle — distill to a new directory`);
  if (outDir === sourcePath || outDir.startsWith(`${sourcePath}/`))
    throw new Error("the bundle directory cannot be the database itself");
  // The snapshot lives beside the output (same filesystem as the bundle), never beside the source.
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, ".marina-distill-"));
  const snapshot = join(work, "snapshot.db");
  try {
    const source = new Database(sourcePath, { readonly: true });
    try {
      source.exec(`VACUUM INTO ${sqlString(snapshot)}`);
    } finally {
      source.close();
    }
    const db = new MarinaDB(snapshot);
    try {
      const { sourcePath: _s, outDir: _o, signingKey, ...rest } = opts;
      const result = exportLearnedBundle(db, {
        ...rest,
        outDir,
        signingKey,
        ...(signingKey === null ? { unsignedIdentity: `db:${sourcePath}` } : {}),
      });
      return { ...result, outDir, sourcePath, unsigned: signingKey === null };
    } finally {
      db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface ArchiveResult {
  archiveDir: string;
  moved: string[];
}

/** `20261024T120000Z` */
function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * Move `dbPath` and its SQLite side files into `<dbPath>.archive-<UTC stamp>/`.
 * Refuses while the database's lease is held (a running server); never deletes.
 */
export function archiveDatabase(dbPath: string, opts: { now?: number } = {}): ArchiveResult {
  const path = resolve(dbPath);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error(`no database file at ${dbPath}`);
  let release: () => void;
  try {
    release = acquireDatabaseLease(path);
  } catch (err) {
    throw new Error(
      `refusing to archive ${dbPath}: a running Marina holds it (stop that server first)`,
      { cause: err },
    );
  }
  try {
    const archiveDir = `${path}.archive-${stamp(opts.now ?? Date.now())}`;
    if (existsSync(archiveDir)) throw new Error(`${archiveDir} already exists`);
    mkdirSync(archiveDir, { mode: 0o700 });
    const moved: string[] = [];
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const from = `${path}${suffix}`;
      if (!existsSync(from)) continue;
      const to = join(archiveDir, `${basename(path)}${suffix}`);
      renameSync(from, to);
      moved.push(to);
    }
    return { archiveDir, moved };
  } finally {
    release();
  }
}

/** The one-paragraph bootstrap story printed after a distill or archive. */
export function bootstrapStory(bundleDir: string, unsigned: boolean, archived?: string): string {
  const flags = unsigned ? "--own --allow-unsigned" : "--own";
  return [
    "Start fresh: `marina start` builds a new world from the code seed.",
    `Then import what the old world learned: \`MARINA_UPSTREAM=on marina learned import ${bundleDir} ${flags}\``,
    `(or set MARINA_BOOTSTRAP_BUNDLES=${bundleDir} and MARINA_BOOTSTRAP_ACCEPT=${unsigned ? "own,unsigned" : "own"} so it lands before any agent wakes).`,
    "Imported lessons arrive with trust `imported` in upstream:* spaces; accounts, standing, grants, approvals, holds, secrets and journals never travel,",
    "so your new world earns trust again through its own verified work.",
    archived
      ? `The old database is archived at ${archived}; nothing was deleted.`
      : "The old database is unchanged.",
  ].join(" ");
}
