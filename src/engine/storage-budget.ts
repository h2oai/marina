// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The storage budget: Marina never fills the disk it runs on.
 *
 * `MARINA_STORAGE_MAX_BYTES` (default 5 GiB, `off` = no cap) bounds what this
 * world keeps on disk: the database (with its WAL), uploaded and generated
 * files (`ASSETS_DIR`) and scratch files (`MARINA_SCRATCH_DIR`).
 * `MARINA_STORAGE_MIN_FREE_BYTES` (default 1 GiB, `off` = no floor) is the free
 * space Marina leaves on that disk whatever else uses it.
 *
 * A pass runs at startup and hourly. Under pressure (the footprint past 90 %
 * of the cap, or the disk below its floor) it frees space in order of what is
 * least worth keeping, re-measuring after each step and stopping at 75 %:
 *   1. the normal retention pass, caught up (staged request images first);
 *   2. the oldest resident continuity journal (agents' archived conversation
 *      transcripts), keeping the newest 30, then 14, 7, 3 and 1 days;
 *   3. every telemetry table cut to one day (`event_log` to 10 000 rows).
 * Facts, lessons, tasks, the chronicle, ledgers and people's files are never
 * removed here. Freed database pages go back to the disk with incremental
 * auto-vacuum; a database made before that setting is rewritten once at the
 * next startup (`VACUUM`), when the disk has room for the copy.
 *
 * Still over after all of that (the footprint is people's files or durable
 * records), the world raises one critical `storage:budget` alert and agents
 * pause (`storageRefusal`) until there is room again; people keep working so
 * they can delete files or raise the cap.
 */

import { lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scratchRoot } from "../config/data-dir";
import type { MarinaDB } from "../persistence/database";
import { getErrorMessage } from "./errors";
import { Logger } from "./logger";
import {
  pruneRequestImageBlobs,
  RETENTION_OVERRIDES_ENV,
  RETENTION_POLICIES,
  runRetentionPass,
} from "./retention";

const logger = new Logger();

export const STORAGE_MAX_ENV = "MARINA_STORAGE_MAX_BYTES";
export const STORAGE_MIN_FREE_ENV = "MARINA_STORAGE_MIN_FREE_BYTES";
const GIB = 1024 ** 3;
export const DEFAULT_STORAGE_MAX_BYTES = 5 * GIB;
export const DEFAULT_STORAGE_MIN_FREE_BYTES = 1 * GIB;
/** Cleanup starts past this share of the cap … */
export const STORAGE_HIGH_WATER = 0.9;
/** … and stops once the footprint is under this share. */
export const STORAGE_LOW_WATER = 0.75;
/** Journal keep windows tried in turn under pressure, in days. */
export const JOURNAL_KEEP_DAYS = [30, 14, 7, 3, 1] as const;
/** Hourly tick phase, distinct from the other hourly jobs. */
export const STORAGE_TICK_PHASE = 2250;
/** Wall-clock budget of one in-tick pass; what is left is done next hour. */
export const STORAGE_PASS_BUDGET_MS = 15_000;
const JOURNAL_BATCH = 5_000;
/** A directory walk stops counting here (it is an estimate past that). */
const MAX_WALK_ENTRIES = 250_000;
export const STORAGE_ALERT_KEY = "storage:budget";

const UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: GIB,
  gb: GIB,
  gib: GIB,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/**
 * A byte size: a plain integer, or a number with a unit (`5GB`, `500 MiB`,
 * `1.5g`; units are binary). `0` or `off` means no limit (returns 0).
 * Returns undefined for anything else.
 */
export function parseByteSize(raw: string): number | undefined {
  const text = raw.trim().toLowerCase();
  if (text === "off" || text === "none" || text === "0") return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(text);
  const unit = match ? UNITS[match[2]!] : undefined;
  if (!match || unit === undefined) return undefined;
  const bytes = Math.round(Number(match[1]) * unit);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export interface StorageLimits {
  /** 0 = no cap. */
  maxBytes: number;
  /** 0 = no floor. */
  minFreeBytes: number;
  /** Settings that did not parse (their defaults apply). */
  rejected: string[];
}

export function storageLimits(env: NodeJS.ProcessEnv = process.env): StorageLimits {
  const rejected: string[] = [];
  const read = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = parseByteSize(raw);
    if (value === undefined) {
      rejected.push(`${name}=${raw}`);
      return fallback;
    }
    return value;
  };
  return {
    maxBytes: read(STORAGE_MAX_ENV, DEFAULT_STORAGE_MAX_BYTES),
    minFreeBytes: read(STORAGE_MIN_FREE_ENV, DEFAULT_STORAGE_MIN_FREE_BYTES),
    rejected,
  };
}

/** The directories counted besides the database. */
export function storageDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.ASSETS_DIR?.trim() || "data/assets", scratchRoot(env)].map((d) => resolve(d));
}

/** Bytes under `dir`, not following links; 0 when it does not exist. */
export function directoryBytes(dir: string): number {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < MAX_WALK_ENTRIES) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      // allow-empty-catch: missing or unreadable directory counts as empty
      continue;
    }
    for (const name of names) {
      if (++seen > MAX_WALK_ENTRIES) break;
      const path = join(current, name);
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory()) stack.push(path);
        else if (stat.isFile()) total += stat.size;
      } catch {
        // allow-empty-catch: removed while walking
      }
    }
  }
  return total;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function freeDiskBytes(path: string): number | undefined {
  try {
    const stat = statfsSync(path);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return undefined;
  }
}

export interface StorageMeasure {
  /** Database, WAL and shared-memory files as they sit on disk. */
  databaseFile: number;
  /** Of that, pages free inside the file (reused before it grows again). */
  databaseFree: number;
  /** Assets and scratch directories. */
  files: number;
  /** What is on disk now: `databaseFile + files`. */
  onDisk: number;
  /** What is held: `onDisk` less the database's free pages. */
  held: number;
  /** Free space on the database's disk (undefined when it cannot be read). */
  freeDisk?: number;
}

export function measureStorage(db: MarinaDB, dirs: string[] = storageDirs()): StorageMeasure {
  const pages = db.databasePages();
  const databaseFile = pages.file
    ? fileBytes(pages.file) + fileBytes(`${pages.file}-wal`) + fileBytes(`${pages.file}-shm`)
    : pages.pageCount * pages.pageSize;
  const databaseFree = pages.freePages * pages.pageSize;
  const files = dirs.reduce((sum, d) => sum + directoryBytes(d), 0);
  return {
    databaseFile,
    databaseFree,
    files,
    onDisk: databaseFile + files,
    held: databaseFile - databaseFree + files,
    freeDisk: freeDiskBytes(pages.file ? dirname(pages.file) : process.cwd()),
  };
}

export interface StorageReport {
  at: number;
  limits: StorageLimits;
  before: StorageMeasure;
  after: StorageMeasure;
  /** Whether cleanup ran. */
  pressure: boolean;
  /** Rows / sources removed per step. */
  freed: Record<string, number>;
  reclaimed: number;
  vacuumed: boolean;
  /** Over the cap after cleanup (counting free database pages as free). */
  overCap: boolean;
  /** Below the free-space floor after cleanup. */
  diskLow: boolean;
  /** Stopped at the pass's time budget with work left. */
  partial: boolean;
}

let lastReport: StorageReport | null = null;
let refusal: string | null = null;

export function getLastStorageReport(): StorageReport | null {
  return lastReport;
}

/**
 * Why agents are paused for storage, or null. Set by the last pass; a person's
 * own commands are never refused by it.
 */
export function storageRefusal(): string | null {
  return refusal;
}

export function resetStorageBudgetForTests(): void {
  lastReport = null;
  refusal = null;
}

/** Telemetry windows cut to a day, for the last cleanup step. */
function tightTelemetryOverrides(): string {
  return RETENTION_POLICIES.filter((p) => p.kind === "telemetry")
    .map((p) =>
      p.keepRows !== undefined ? `${p.table}=10000` : p.timeColumn ? `${p.table}=1d` : "",
    )
    .filter(Boolean)
    .join(",");
}

export interface StoragePassOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Asset storage, so staged request images' bytes are removed with their rows. */
  storage?: { delete(key: string): Promise<boolean> };
  /** Allow a full `VACUUM` (startup only: it rewrites the file). */
  allowVacuum?: boolean;
  /** Stop starting new steps after this long (default: no limit). */
  budgetMs?: number;
  dirs?: string[];
}

/**
 * Measure, clean up under pressure, reclaim free pages, then set the agent
 * pause and the `storage:budget` alert from the result. Never throws for a
 * step that fails: it is logged and the next step runs.
 */
export async function runStoragePass(
  db: MarinaDB,
  opts: StoragePassOptions = {},
): Promise<StorageReport> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const started = Date.now();
  const limits = storageLimits(env);
  const dirs = opts.dirs ?? storageDirs(env);
  const before = measureStorage(db, dirs);
  const freed: Record<string, number> = {};
  const capPressure = (m: StorageMeasure, share: number, field: "onDisk" | "held") =>
    limits.maxBytes > 0 && m[field] > limits.maxBytes * share;
  const diskPressure = (m: StorageMeasure) =>
    limits.minFreeBytes > 0 && m.freeDisk !== undefined && m.freeDisk < limits.minFreeBytes;
  const pressure = capPressure(before, STORAGE_HIGH_WATER, "onDisk") || diskPressure(before);
  let current = before;
  let partial = false;
  // Free pages count as room: the file reuses them before it grows. Under a
  // disk floor every step runs until a quarter of what is held is freed.
  const enough = (held: number) =>
    !(limits.maxBytes > 0 && held > limits.maxBytes * STORAGE_LOW_WATER) &&
    !(diskPressure(before) && held >= before.held * STORAGE_LOW_WATER);
  // Deleted rows leave index pages part-full until a VACUUM, so the page
  // count lags what was freed: the journal step also counts the bytes it
  // removed (the body and its text copy, so twice the body; not the index).
  let journalBytes = 0;
  const satisfied = () => enough(Math.min(current.held, before.held - 2 * journalBytes));
  /** `held` from the page counts alone, cheap enough to check between batches. */
  const quickHeld = () => {
    const pages = db.databasePages();
    return (pages.pageCount - pages.freePages) * pages.pageSize + current.files;
  };
  const outOfTime = () => {
    if (opts.budgetMs === undefined || Date.now() - started <= opts.budgetMs) return false;
    partial = true;
    return true;
  };
  const step = async (name: string, run: () => number | Promise<number>) => {
    if (satisfied() || outOfTime()) return;
    try {
      const count = await run();
      if (count > 0) freed[name] = (freed[name] ?? 0) + count;
    } catch (error) {
      logger.warn("storage", `Storage cleanup step ${name} failed`, {
        error: getErrorMessage(error),
      });
    }
    current = measureStorage(db, dirs);
  };

  if (pressure) {
    await step("retention", async () => {
      let rows = opts.storage ? await pruneRequestImageBlobs(db, opts.storage, { now }) : 0;
      const result = runRetentionPass(db, { now, maxBatchesPerTable: 1_000 });
      for (const n of Object.values(result.deleted)) rows += n;
      return rows;
    });
    for (const days of JOURNAL_KEEP_DAYS)
      await step(`journal>${days}d`, () => {
        const result = db.pruneJournalSources(now - days * 86_400_000, {
          batch: JOURNAL_BATCH,
          stop: (sofar) =>
            outOfTime() ||
            enough(Math.min(quickHeld(), before.held - 2 * (journalBytes + sofar.bytes))),
        });
        journalBytes += result.bytes;
        return result.manifests + result.parts;
      });
    await step("telemetry>1d", () => {
      const own = env[RETENTION_OVERRIDES_ENV]?.trim();
      const result = runRetentionPass(db, {
        now,
        maxBatchesPerTable: 1_000,
        overridesEnv: [tightTelemetryOverrides(), own].filter(Boolean).join(","),
      });
      return Object.values(result.deleted).reduce((a, b) => a + b, 0);
    });
  }

  // Give free pages back: cheap with incremental auto-vacuum; a full VACUUM
  // only at startup, when the disk has room for the copy it writes.
  let reclaimed = 0;
  let vacuumed = false;
  // Under pressure every free page; otherwise only a sizeable share.
  const worthReclaiming = pressure
    ? current.databaseFree > 0
    : current.databaseFree > 64 * 1024 ** 2 && current.databaseFree > current.databaseFile * 0.25;
  if (worthReclaiming) {
    const roomForCopy =
      current.freeDisk === undefined || current.freeDisk > current.databaseFile * 1.1;
    try {
      const result = db.reclaimFreePages({ allowVacuum: !!opts.allowVacuum && roomForCopy });
      reclaimed = result.reclaimed;
      vacuumed = result.vacuumed;
      if (reclaimed > 0) current = measureStorage(db, dirs);
    } catch (error) {
      logger.warn("storage", "Returning free database pages to the disk failed", {
        error: getErrorMessage(error),
      });
    }
  }

  const overCap = limits.maxBytes > 0 && current.held > limits.maxBytes;
  const diskLow = diskPressure(current);
  const report: StorageReport = {
    at: now,
    limits,
    before,
    after: current,
    pressure,
    freed,
    reclaimed,
    vacuumed,
    overCap,
    diskLow,
    partial,
  };
  lastReport = report;
  refusal = overCap
    ? `storage cap reached (${formatBytes(current.held)} held ≥ ${formatBytes(limits.maxBytes)} ${STORAGE_MAX_ENV})`
    : diskLow
      ? `disk nearly full (${formatBytes(current.freeDisk ?? 0)} free < ${formatBytes(limits.minFreeBytes)} ${STORAGE_MIN_FREE_ENV})`
      : null;
  try {
    if (refusal) {
      db.upsertOperationalAlert({
        key: STORAGE_ALERT_KEY,
        severity: "critical",
        category: "storage",
        title: overCap ? "Storage cap reached" : "Disk nearly full",
        detail: `${refusal}. Database ${formatBytes(current.databaseFile)} (${formatBytes(current.databaseFree)} free inside), files ${formatBytes(current.files)}. Cleanup removed what it may; agents are paused until there is room.`,
        remedy: overCap
          ? `Delete files you no longer need, or raise ${STORAGE_MAX_ENV} (e.g. 10GB, or off).`
          : `Free space on this disk, or lower ${STORAGE_MIN_FREE_ENV}.`,
        metadata: { held: current.held, maxBytes: limits.maxBytes, freeDisk: current.freeDisk },
      });
    } else {
      db.resolveOperationalAlertsExcept("storage", []);
    }
  } catch (error) {
    logger.warn("storage", "Storage alert update failed", { error: getErrorMessage(error) });
  }
  if (pressure || reclaimed > 0)
    logger.info("storage", formatStorageReport(report), { freed, reclaimed, vacuumed });
  if (limits.rejected.length)
    logger.warn("storage", "Ignored storage settings that are not byte sizes", {
      entries: limits.rejected,
    });
  return report;
}

export function formatStorageReport(report: StorageReport): string {
  const { after, limits } = report;
  const cap = limits.maxBytes > 0 ? formatBytes(limits.maxBytes) : "no cap";
  const parts = [
    `${formatBytes(after.held)} held of ${cap} (database ${formatBytes(after.databaseFile)}, ${formatBytes(after.databaseFree)} of it free; files ${formatBytes(after.files)})`,
  ];
  if (after.freeDisk !== undefined) parts.push(`${formatBytes(after.freeDisk)} free on disk`);
  const freed = Object.entries(report.freed).map(([k, n]) => `${k} ${n}`);
  if (freed.length) parts.push(`removed ${freed.join(", ")}`);
  if (report.reclaimed > 0)
    parts.push(`returned ${formatBytes(report.reclaimed)}${report.vacuumed ? " (vacuum)" : ""}`);
  if (report.partial) parts.push("more next hour");
  return parts.join("; ");
}
