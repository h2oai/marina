// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import type { MemoryReviewResult } from "../sdk/memory-types";
import {
  authorizeMemorySpace,
  readCurrentMemoryRecords,
  readMemoryRecord,
  reviseRecord,
} from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

const competing = `SELECT c2.record_id FROM memory_claims c JOIN memory_claims c2
 ON c2.space_id=c.space_id AND c2.subject=c.subject AND c2.predicate=c.predicate
 JOIN memory_records other ON other.id=c2.record_id
 WHERE c.record_id=r.id AND c2.record_id!=r.id AND c2.object_json!=c.object_json
 AND other.status='active' AND (r.valid_until IS NULL OR other.valid_from IS NULL OR other.valid_from<r.valid_until)
 AND (other.valid_until IS NULL OR r.valid_from IS NULL OR r.valid_from<other.valid_until)`;

export function reviewMemory(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown = {},
): MemoryReviewResult {
  const input = object(raw),
    limit = integer(input.limit ?? 20, "limit", 1, 100);
  const kind = input.kind ?? "all";
  if (!["all", "stale", "competing"].includes(String(kind)))
    throw new MemoryError(400, "invalid_input", "Review kind must be all, stale or competing");
  return db.transaction(() => {
    const current = authorizeMemorySpace(db, actor, space);
    let after = "";
    if (input.cursor !== undefined) {
      let cursor: Record<string, unknown>;
      try {
        cursor = object(
          JSON.parse(Buffer.from(textValue(input.cursor, "cursor", 2048), "base64url").toString()),
        );
      } catch {
        throw new MemoryError(400, "invalid_cursor", "Malformed review cursor");
      }
      if (cursor.space !== space || cursor.kind !== kind || typeof cursor.after !== "string")
        throw new MemoryError(400, "invalid_cursor", "Cursor belongs to another review");
      if (cursor.generation !== current.retrieval_generation)
        throw new MemoryError(409, "query_changed", "Memory changed; restart review");
      after = cursor.after;
    }
    const condition =
      kind === "stale"
        ? "r.stale=1"
        : kind === "competing"
          ? `EXISTS(${competing})`
          : `(r.stale=1 OR EXISTS(${competing}))`;
    const rows = db
      .query(
        `SELECT r.id FROM memory_records r WHERE r.space_id=? AND r.status='active' AND r.id>? AND ${condition} ORDER BY r.id LIMIT ?`,
      )
      .all(space, after, limit + 1) as { id: string }[];
    const selected = rows.slice(0, limit);
    const records = new Map(
      readCurrentMemoryRecords(
        db,
        actor,
        space,
        selected.map((row) => row.id),
      ).map((r) => [r.id, r]),
    );
    const items = selected.map(({ id }) => {
      const record = records.get(id)!;
      const peers = db
        .query(
          `${competing.replace("FROM memory_claims c", "FROM memory_records r JOIN memory_claims c ON c.record_id=r.id")} AND r.id=? ORDER BY c2.record_id LIMIT 21`,
        )
        .all(id) as { record_id: string }[];
      const premises = record.depends_on.map((parent) => {
        const live = db
          .query("SELECT version,stale,status FROM memory_records WHERE id=? AND space_id=?")
          .get(parent, space) as { version: number; stale: number; status: string } | null;
        const pinned = record.dependency_versions?.[parent] ?? null;
        const state =
          live?.status !== "active"
            ? "missing"
            : live.stale
              ? "stale"
              : pinned === null
                ? "unbound"
                : pinned !== live.version
                  ? "changed"
                  : "current";
        return {
          id: parent,
          pinned_version: pinned,
          current_version: live?.status === "active" ? live.version : null,
          state,
        };
      });
      return {
        record,
        premises,
        competing_records: readCurrentMemoryRecords(
          db,
          actor,
          space,
          peers.slice(0, 20).map((peer) => peer.record_id),
        ),
        competing_truncated: peers.length > 20,
      };
    });
    return {
      space_id: space,
      retrieval_generation: current.retrieval_generation,
      items,
      next_cursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                space,
                kind,
                generation: current.retrieval_generation,
                after: selected.at(-1)!.id,
              }),
            ).toString("base64url")
          : null,
    };
  })();
}

export function reaffirmMemory(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  raw: unknown,
  key: string,
  model?: string,
) {
  const input = object(raw),
    expected = integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER);
  if (input.dependency_versions === undefined)
    throw new MemoryError(
      400,
      "dependency_review_required",
      "Explicit dependency_versions are required, including {} for independent assertions",
    );
  const record = readMemoryRecord(db, actor, space, id);
  return reviseRecord(
    db,
    actor,
    space,
    id,
    expected,
    {
      content: input.content === undefined ? record.content : textValue(input.content, "content"),
      dependency_versions: object(input.dependency_versions) as Record<string, number>,
    },
    key,
    model,
  );
}
