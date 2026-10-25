// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serving imported lessons. A learned bundle's lessons land in
 * `upstream:lessons:<domain>` spaces owned by `marina:upstream` with trust
 * `imported` (`import.ts`). This module reads them back for lesson recall
 * (`recallLessons` in `src/learning/service.ts`), so a world bootstrapped from
 * a bundle serves what the bundle carried.
 *
 *   MARINA_IMPORTED_LESSONS=off|observe|on
 *     unset    `on` when imported lessons exist (the upstream account does), else nothing
 *     on       imported lessons are recalled beside the world's own, labelled
 *              `imported` (`unsigned` too for an unsigned bundle), ranked
 *              below every local trusted lesson
 *     observe  what WOULD be served is recorded (`upstream_events` action
 *              `observed`, once per item per process); nothing is served
 *     off      never read; every surface is exactly as without imports
 *
 * Every local scope rule applies unchanged, because the same durable sink and
 * `selectServed` read them: family scoping (`scope_family` / `families`
 * travel in the bundle), leakage rule 2 (`eval:<board>` refs the importer
 * adds for the boards the lesson names), and the as-of fence (`visibleAt` on
 * the original `resolved_at`; an undated lesson is never visible). Imported
 * lessons are the shared pool's: a person's own lessons are never exported,
 * so the owner scope is untouched.
 *
 * Local evidence moves them (`importedLessonLink`, wired into the outcome
 * loop for shared-pool writes while serving is `on`): a local trusted lesson
 * whose rule matches an imported one cites it and confirms it
 * (`confirmImportedLesson`); the confirming lesson serves in its place. One
 * the lesson judge finds it contradicts is retired (status `retired`, an
 * `upstream_events` `contradicted` row) and stays retired on re-import of the
 * same version. Imported never becomes trusted without local evidence, and no
 * model is needed to serve.
 */

import type { ImportedLessonLink, Lesson, LessonSink, OutcomeDomain } from "../learning/outcomes";
import { durableLessonSink } from "../learning/store";
import { residentMemoryOperation } from "../memory/resident-service";
import type { MarinaDB } from "../persistence/database";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import { UPSTREAM_ACCOUNT, UPSTREAM_LESSONS_PREFIX } from "./upstream-account";

export type ImportedLessonsMode = "off" | "observe" | "on";

/** The explicit `MARINA_IMPORTED_LESSONS` value, or undefined when unset or unreadable. */
export function importedLessonsSetting(
  env: NodeJS.ProcessEnv = process.env,
): ImportedLessonsMode | undefined {
  const v = env.MARINA_IMPORTED_LESSONS?.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return "off";
  if (v === "observe") return "observe";
  if (v === "on" || v === "true" || v === "1") return "on";
  return undefined;
}

/** The effective mode for `db`: the setting, else `on` when anything was imported. */
export function importedLessonsMode(
  db: Pick<MarinaDB, "getUserByName"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ImportedLessonsMode {
  const set = importedLessonsSetting(env);
  if (set) return set;
  return db?.getUserByName(UPSTREAM_ACCOUNT) ? "on" : "off";
}

const sinks = new WeakMap<object, LessonSink>();

/**
 * A recall-only sink over the imported lesson spaces of `db`: never creates
 * the upstream account or a space (none ⇒ no lessons). Recall drops a lesson
 * a local one confirmed (the local lesson serves instead) and anything that
 * is not `imported`.
 */
export function importedRecallSink(db: MarinaDB): LessonSink {
  const cached = sinks.get(db);
  if (cached) return cached;
  const run = (request: MemoryOperationRequest) =>
    residentMemoryOperation(db, UPSTREAM_ACCOUNT, request) as Promise<{
      ok: true;
      result: unknown;
    }>;
  const found = new Map<OutcomeDomain, string>();
  const spaceFor = async (domain: OutcomeDomain) => {
    const known = found.get(domain);
    if (known) return known;
    if (!db.getUserByName(UPSTREAM_ACCOUNT)) return undefined;
    const listed = (await run({ operation: "spaces" })).result as {
      spaces?: Array<{ id: string; name: string }>;
    };
    const id = listed.spaces?.find((s) => s.name === `${UPSTREAM_LESSONS_PREFIX}${domain}`)?.id;
    if (id) found.set(domain, id);
    return id;
  };
  const inner = durableLessonSink(run, spaceFor);
  const sink: LessonSink = {
    write: () => Promise.reject(new Error("imported lessons are written only by an import")),
    recall: (domain, query, asOf, opts = {}) => {
      const exclude = opts.exclude;
      return inner.recall(domain, query, asOf, {
        ...opts,
        exclude: (l) => l.trust !== "imported" || !!l.imported?.confirmedBy || !!exclude?.(l),
      });
    },
  };
  sinks.set(db, sink);
  return sink;
}

const noted = new WeakMap<object, Set<string>>();

/**
 * Record imported lessons a recall served (`served`) or would have served
 * (`observed`): one `upstream_events` row per item and action per process, so
 * readiness can count them without a row per recall. Never throws.
 */
export function noteImportedRecall(
  db: MarinaDB,
  lessons: readonly Lesson[],
  action: "served" | "observed",
): void {
  let seen = noted.get(db);
  if (!seen) {
    seen = new Set();
    noted.set(db, seen);
  }
  for (const l of lessons) {
    const o = l.trust === "imported" ? l.imported : undefined;
    if (!o) continue;
    const key = `${action}\u0000${o.artifactId}\u0000${o.itemKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      db.recordUpstreamEvent({
        action,
        outcome: "ok",
        artifactId: o.artifactId,
        itemKey: o.itemKey,
        actor: "recall",
        detail: { domain: l.domain },
      });
    } catch {
      // allow-empty-catch: a read-only or closing database only loses the count
    }
  }
}

/**
 * The outcome loop's link to imported lessons over `db` (undefined unless
 * imported lessons are served `on`): neighbours for the judge, confirmation
 * by a local trusted lesson, and retirement when one contradicts them.
 */
export function importedLessonLink(
  db: MarinaDB,
  env: NodeJS.ProcessEnv = process.env,
): ImportedLessonLink | undefined {
  if (importedLessonsMode(db, env) !== "on") return undefined;
  return {
    neighbours: (domain, text, asOf) =>
      importedRecallSink(db).recall(domain, text, asOf, { limit: 3 }),
    async confirm(imported, localId) {
      const o = imported.imported;
      if (!o) return;
      const { confirmImportedLesson } = await import("./import");
      await confirmImportedLesson(db, {
        artifactId: o.artifactId,
        itemKey: o.itemKey,
        localLessonId: localId,
        actor: "outcome-loop",
      });
    },
    async contradict(imported, localId, reason) {
      const o = imported.imported;
      if (!o) return;
      const row = db.getLearnedItem(o.artifactId, o.itemKey);
      if (row?.kind !== "lesson" || row.status !== "active") return;
      const { retireImportedRecord } = await import("./import");
      if (row.local_ref)
        await retireImportedRecord(db, row.local_ref, `contradicted by local lesson ${localId}`);
      db.setLearnedItemStatus(o.artifactId, o.itemKey, "retired");
      db.recordUpstreamEvent({
        action: "contradicted",
        outcome: "ok",
        artifactId: o.artifactId,
        itemKey: o.itemKey,
        actor: "outcome-loop",
        detail: { local_lesson: localId, reason: reason.slice(0, 200) },
      });
    },
  };
}

export interface ImportedBundleSummary {
  artifactId: string;
  name: string;
  version: string;
  generation: number;
  signed: boolean;
  importedAt: number;
}

export interface ImportedLessonStats {
  bundles: ImportedBundleSummary[];
  /** Imported lesson items by status. */
  lessons: { active: number; retired: number; revoked: number };
  /** Distinct imported lessons a recall served / would have served / a local lesson confirmed / contradicted. */
  served: number;
  observed: number;
  confirmed: number;
  contradicted: number;
  lastImportAt?: number;
}

/** What readiness reports about imported bundles and their lessons (no model, no writes). */
export function importedLessonStats(db: MarinaDB): ImportedLessonStats {
  const latest = new Map<string, ImportedBundleSummary>();
  let lastImportAt: number | undefined;
  for (const a of db.listLearnedArtifacts()) {
    lastImportAt = Math.max(lastImportAt ?? 0, a.imported_at);
    const prior = latest.get(a.artifact_id);
    if (prior && prior.generation >= a.generation) continue;
    let name = a.artifact_id.split("/").pop() ?? a.artifact_id;
    let signed = !a.publisher_key_id.startsWith("unsigned");
    try {
      const m = JSON.parse(a.manifest_json) as { name?: unknown; unsigned?: unknown };
      if (typeof m.name === "string" && m.name) name = m.name;
      if (m.unsigned === true) signed = false;
    } catch {
      // allow-empty-catch: an unreadable stored manifest keeps the id-derived name
    }
    latest.set(a.artifact_id, {
      artifactId: a.artifact_id,
      name,
      version: a.version,
      generation: a.generation,
      signed,
      importedAt: a.imported_at,
    });
  }
  const lessons = { active: 0, retired: 0, revoked: 0 };
  let confirmed = 0;
  for (const item of db.listLearnedItems()) {
    if (item.kind !== "lesson") continue;
    lessons[item.status]++;
    if (item.confirmed_by) confirmed++;
  }
  return {
    bundles: [...latest.values()].sort((x, y) => y.importedAt - x.importedAt),
    lessons,
    served: db.countUpstreamEventItems("served"),
    observed: db.countUpstreamEventItems("observed"),
    confirmed,
    contradicted: db.countUpstreamEventItems("contradicted"),
    ...(lastImportAt !== undefined ? { lastImportAt } : {}),
  };
}
