// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { MemoryError } from "../memory/service-types";

/** Bind declared premises to exact revisions. Current means unchanged premises,
 * never verified truth. Call only inside the authorized mutation transaction. */
export function pinMemoryDependencies(
  db: Database,
  space: string,
  ids: string[],
  expected?: Record<string, number>,
) {
  const distinct = [...new Set(ids)];
  if (
    expected &&
    (Object.keys(expected).length !== distinct.length ||
      distinct.some((id) => !Object.hasOwn(expected, id)))
  )
    throw new MemoryError(
      400,
      "invalid_dependencies",
      "dependency_versions must name every current dependency exactly",
    );
  const versions: Record<string, number> = Object.create(null);
  for (const id of distinct) {
    const parent = db
      .query(
        "SELECT version,stale FROM memory_records WHERE id=? AND space_id=? AND status='active'",
      )
      .get(id, space) as { version: number; stale: number } | null;
    if (!parent)
      throw new MemoryError(404, "dependency_not_found", "Dependency must belong to this space");
    if (parent.stale)
      throw new MemoryError(
        409,
        "stale_dependency",
        "Review the premise before deriving another current conclusion",
      );
    if (expected && expected[id] !== parent.version)
      throw new MemoryError(
        409,
        "dependency_changed",
        "A premise changed; reread it before committing the conclusion",
      );
    versions[id] = parent.version;
  }
  return versions;
}

export function storeMemoryDependencyVersions(
  db: Database,
  id: string,
  version: number,
  ids: string[],
  pins: Record<string, number | null>,
) {
  for (const parent of new Set(ids))
    db.run("INSERT INTO memory_revision_dependencies VALUES (?,?,?,?)", [
      id,
      version,
      parent,
      pins[parent] ?? null,
    ]);
}

/** Derived metadata changes atomically with the correction; authored contents,
 * ownership and historical revisions remain intact. Only current edges propagate. */
export function staleMemoryDependents(db: Database, space: string, id: string, version: number) {
  return db.run(
    `WITH RECURSIVE affected(id) AS (
    SELECT d.record_id FROM memory_revision_dependencies d JOIN memory_records r ON r.id=d.record_id
    WHERE d.depends_on_id=? AND d.record_version=r.version AND r.space_id=? AND r.status='active'
    UNION
    SELECT d.record_id FROM memory_revision_dependencies d JOIN memory_records r ON r.id=d.record_id
    JOIN affected a ON d.depends_on_id=a.id WHERE d.record_version=r.version AND r.space_id=? AND r.status='active'
  ) UPDATE memory_records SET stale=1,stale_reason=? WHERE id IN (SELECT id FROM affected) AND stale=0`,
    [
      id,
      space,
      space,
      JSON.stringify({ kind: "premise_revised", record_id: id, observed_version: version }),
    ],
  ).changes;
}
