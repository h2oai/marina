// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An append-only run journal: one header line with the run's configuration,
 * then one line per finished item, written as each item lands. A run stopped
 * by a spend cap (or killed) keeps every item it paid for, and a resumed run
 * continues from them — under the same configuration only: a journal written
 * under another configuration is refused, never half one and half the other.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RunJournal<T> {
  path: string;
  /** Entries a stopped earlier run wrote (empty for a fresh journal). */
  entries: T[];
  /** When the journalled run first started (kept across resumes). */
  startedAt: string;
  /** Append one entry, on disk before the call returns. */
  append(entry: T): void;
}

/** The fields where a journal's recorded configuration differs from this one. */
export function configDifferences(
  recorded: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(next)]);
  return [...keys]
    .filter((k) => JSON.stringify(recorded[k] ?? null) !== JSON.stringify(next[k] ?? null))
    .sort();
}

/**
 * Open a journal: fresh (header written, earlier entries dropped) without
 * `resume` or when none exists; with `resume`, the entries already in it —
 * refused when it was written under a different configuration. A torn last
 * line (an interrupted write) is skipped, and later lines start on their own.
 */
export function openJournal<T>(
  path: string,
  config: Record<string, unknown>,
  opts: { resume?: boolean; startedAt?: string } = {},
): RunJournal<T> {
  mkdirSync(dirname(path), { recursive: true });
  const now = opts.startedAt ?? new Date().toISOString();
  const append = (entry: T) => appendFileSync(path, `${JSON.stringify({ entry })}\n`);
  if (!opts.resume || !existsSync(path)) {
    writeFileSync(path, `${JSON.stringify({ config, startedAt: now })}\n`);
    return { path, entries: [], startedAt: now, append };
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  let header: { config?: Record<string, unknown>; startedAt?: string } = {};
  try {
    header = JSON.parse(lines[0] ?? "{}");
  } catch {
    // allow-empty-catch: an unreadable header is refused below as a configuration mismatch
  }
  const differs = configDifferences(header.config ?? {}, config);
  if (differs.length > 0) {
    throw new Error(
      `refusing --resume: ${path} was run with a different configuration (${differs.join(", ")}); ` +
        "use another output directory, or run without --resume to start it over",
    );
  }
  const entries: T[] = [];
  for (const line of lines.slice(1)) {
    try {
      const parsed = JSON.parse(line) as { entry?: T };
      if (parsed.entry !== undefined) entries.push(parsed.entry);
    } catch {
      // allow-empty-catch: a torn last line (an interrupted write) is redone
    }
  }
  if (!text.endsWith("\n")) appendFileSync(path, "\n");
  return { path, entries, startedAt: header.startedAt ?? now, append };
}

/** A short stable digest of item ids (the slice a run covers), for a journal's configuration. */
export function idsDigest(ids: string[]): string {
  return createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
}
