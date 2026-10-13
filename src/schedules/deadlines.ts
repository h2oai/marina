// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deadline references for `before:<kind>:<id> lead:<dur>`. A source turns an id
 * into its deadline (epoch ms) — e.g. `arena:<round>` → the round's lock time.
 * A referenced schedule re-reads its deadline periodically, so a deadline that
 * moves moves the run. Sources are registered by the subsystem that owns the
 * records; the schedules module knows none of them.
 */

export type DeadlineSource = (id: string) => Promise<number | undefined>;

const sources = new Map<string, DeadlineSource>();

/** Register (or replace) the source for `<kind>:` references. */
export function registerDeadlineSource(kind: string, source: DeadlineSource): void {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error(`bad deadline kind ${kind}`);
  sources.set(kind, source);
}

/** Test seam. */
export function unregisterDeadlineSource(kind: string): void {
  sources.delete(kind);
}

export function deadlineKinds(): string[] {
  return [...sources.keys()].sort();
}

/**
 * A `<kind>:<id>` reference, or undefined. A reference starts with a letter,
 * so it never collides with an ISO time (which starts with a digit).
 */
export function parseDeadlineRef(raw: string): { kind: string; id: string } | undefined {
  const m = /^([a-z][a-z0-9-]*):(\S{1,200})$/i.exec(raw.trim());
  return m ? { kind: m[1]!.toLowerCase(), id: m[2]! } : undefined;
}

/** The deadline a reference names now; undefined when unknown or unreadable. */
export async function resolveDeadline(ref: string): Promise<number | undefined> {
  const parsed = parseDeadlineRef(ref);
  const source = parsed && sources.get(parsed.kind);
  if (!parsed || !source) return undefined;
  try {
    const at = await source(parsed.id);
    return at !== undefined && Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}
