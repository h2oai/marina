// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bridge from the retired forecast-lesson store into the one lesson pool.
 *
 * Before the pool was unified, FutureX kept unjudged lessons (subject
 * `forecast-lesson`) in a `forecast-lessons` space owned by a world account
 * named `Forecaster` — an ordinary, loginable name. Nothing reads that space
 * for a forecast any more. `migrateLegacyForecastLessons` copies each current
 * record into `lessons:forecast`:
 *
 *   - as an `unverified` lesson (it was never judged; recall labels it so),
 *     with the record's own `resolved_at`, so the leakage rule is unchanged;
 *   - `source` = `legacy:forecast-lesson`, `refs` = `legacy-lesson:<id>`, and
 *     `provenance` = { store, account, space, id, version } in metadata;
 *   - idempotently: each write carries the key `legacy-forecast-lesson:<id>:<version>`,
 *     a durable memory-service receipt, so a re-run — or a curator's later
 *     retirement of the copy — never writes it twice.
 *
 * The originals are never changed or erased: they stay readable under their
 * owner. When every record copied and the account was created by the script
 * (it never logged in and has no bound identity), it is renamed to
 * `marina:legacy-forecast-lessons` — a server-owned name login cannot produce
 * — so no participant can claim the name and its space. An account someone
 * has logged into is left as it is (its lessons are still copied).
 */

import { getErrorMessage } from "../engine/errors";
import { LEGACY_LESSON_SUBJECT } from "../forecast/lessons";
import { residentMemoryOperation } from "../memory/resident-service";
import type { MarinaDB } from "../persistence/database";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import type { Lesson, LessonSink } from "./outcomes";
import { lessonSinkFor } from "./service";
import { retryingMemoryRun } from "./store";

export const LEGACY_FORECAST_ACCOUNT = "Forecaster";
export const LEGACY_FORECAST_SPACE = "forecast-lessons";
/** The server-owned name the script account is renamed to (no login can produce a colon). */
export const LEGACY_FORECAST_OWNER = "marina:legacy-forecast-lessons";
export const LEGACY_LESSON_SOURCE = "legacy:forecast-lesson";

interface LegacyRecord {
  id?: string;
  version?: number;
  content?: string;
  metadata?: Record<string, unknown>;
  valid_time?: { from: number | null; until: number | null } | null;
}

export interface LegacyMigration {
  /** The account the legacy records were read from, when one exists. */
  account?: string;
  found: number;
  /** Copied now, or already copied by an earlier run (the receipt answered). */
  copied: number;
  failed: number;
  /** The script account was renamed to `LEGACY_FORECAST_OWNER`. */
  renamed: boolean;
  errors: string[];
}

/** One legacy record as a pool lesson, or undefined when it is not a lesson. */
export function lessonFromLegacy(
  r: LegacyRecord,
  where: { account: string; space: string },
): Lesson | undefined {
  const m = r.metadata ?? {};
  if (m.kind !== LEGACY_LESSON_SUBJECT || typeof r.content !== "string" || !r.id) return undefined;
  const resolvedAt =
    typeof m.resolved_at === "string"
      ? m.resolved_at
      : typeof r.valid_time?.from === "number"
        ? new Date(r.valid_time.from).toISOString()
        : undefined;
  if (!resolvedAt || !Number.isFinite(Date.parse(resolvedAt))) return undefined;
  const score = typeof m.score === "number" ? m.score : undefined;
  const hit = m.failure === "hit" || (score !== undefined && score >= 0.99);
  return {
    domain: "forecast",
    text: r.content,
    kind: hit ? "success" : "failure",
    ...(typeof m.category === "string" ? { category: m.category } : {}),
    ...(typeof m.rule === "string" ? { rule: m.rule } : {}),
    ...(score !== undefined ? { score } : {}),
    trust: "unverified",
    resolvedAt,
    source: LEGACY_LESSON_SOURCE,
    refs: [`legacy-lesson:${r.id}`],
    provenance: {
      store: LEGACY_LESSON_SUBJECT,
      account: where.account,
      space: where.space,
      id: r.id,
      version: String(r.version ?? 1),
      ...(typeof m.origin === "string" ? { origin: m.origin } : {}),
    },
  };
}

/** Copy the legacy store's current lessons into the pool (see the file header). Never throws. */
export async function migrateLegacyForecastLessons(
  db: MarinaDB,
  opts: { account?: string; sink?: LessonSink } = {},
): Promise<LegacyMigration> {
  const out: LegacyMigration = { found: 0, copied: 0, failed: 0, renamed: false, errors: [] };
  // Once renamed (every record copied), the legacy name no longer resolves: nothing to do.
  const user = db.getUserByName(opts.account ?? LEGACY_FORECAST_ACCOUNT);
  if (!user) return out;
  out.account = user.name;
  try {
    const run = retryingMemoryRun(
      // By id, not the name read above: a concurrent run may rename the account
      // mid-way, and a stale name would resolve to a fresh system namespace.
      (request: MemoryOperationRequest) =>
        residentMemoryOperation(db, db.getUser(user.id)?.name ?? user.name, request) as Promise<{
          ok: true;
          result: unknown;
        }>,
    );
    const listed = (await run({ operation: "spaces" })).result as {
      spaces?: Array<{ id: string; name: string }>;
    };
    const space = listed.spaces?.find((s) => s.name === LEGACY_FORECAST_SPACE)?.id;
    if (!space) return out;
    const records: LegacyRecord[] = [];
    let cursor: string | undefined;
    const now = Date.now();
    for (let page = 0; page < 1_000; page++) {
      const reply = await run({
        operation: "query",
        space_id: space,
        input: {
          subject: LEGACY_LESSON_SUBJECT,
          valid_at: now,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      });
      const r = (reply.result ?? {}) as { results?: LegacyRecord[]; next_cursor?: string | null };
      records.push(...(r.results ?? []));
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
    const sink = opts.sink ?? lessonSinkFor(db);
    for (const record of records) {
      const lesson = lessonFromLegacy(record, { account: user.id, space });
      if (!lesson) continue;
      out.found++;
      try {
        await sink.write(lesson, {
          key: `legacy-forecast-lesson:${record.id}:${record.version ?? 1}`,
        });
        out.copied++;
      } catch (err) {
        // A retired receipt means the copy was written once already.
        if ((err as { status?: number }).status === 410) {
          out.copied++;
          continue;
        }
        out.failed++;
        if (out.errors.length < 5) out.errors.push(getErrorMessage(err).slice(0, 160));
      }
    }
  } catch (err) {
    out.failed++;
    out.errors.push(getErrorMessage(err).slice(0, 160));
    return out;
  }
  const scriptMade = user.last_login === user.created_at && !user.auth_subject;
  if (
    out.failed === 0 &&
    user.name !== LEGACY_FORECAST_OWNER &&
    scriptMade &&
    !db.getUserByName(LEGACY_FORECAST_OWNER)
  ) {
    out.renamed = db.renameUser(user.id, LEGACY_FORECAST_OWNER);
    if (out.renamed) out.account = LEGACY_FORECAST_OWNER;
  }
  return out;
}
