// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { memoryQueryExpansion } from "../memory/query-expansion";
import { integer, MemoryError, textValue } from "../memory/service-types";
import type {
  MemorySourceRange,
  MemorySourceSearch,
  MemorySourceSearchResult,
} from "../sdk/memory-types";
import { authorizeMemorySpace } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";
import { buildFtsQuery } from "./fts";

export function searchMemorySources(
  db: Database,
  actor: MemoryActor,
  space: string,
  input: MemorySourceSearch,
): MemorySourceSearchResult {
  return db.transaction(() => {
    const current = authorizeMemorySpace(db, actor, space);
    textValue(input.query, "query", 8192);
    const limit = integer(input.limit ?? 10, "limit", 1, 100);
    const mode = input.match ?? "all";
    if (!["all", "any", "phrase"].includes(mode))
      throw new MemoryError(400, "invalid_input", "match must be all, any or phrase");
    if (input.session_id !== undefined) textValue(input.session_id, "session_id", 256);
    const expansion = memoryQueryExpansion(input.query, input.expansion);
    if (expansion) {
      const lists = [input.query, ...expansion.queries].map((query) =>
        searchMemorySources(db, actor, space, {
          ...input,
          query,
          expansion: undefined,
          limit: 100,
        }),
      );
      const ranked = new Map<string, MemorySourceSearchResult["results"][number]>();
      for (const [index, list] of lists.entries()) {
        for (const [i, row] of list.results.entries()) {
          const result = ranked.get(row.id) ?? { ...row, score: 0, ranks: {} };
          result.score! += 1 / ((index === 0 ? 1 : expansion.queries.length) * (60 + i + 1));
          if (index === 0) result.ranks!.lexical = i + 1;
          else {
            result.ranks!.expansion ??= Array(expansion.queries.length).fill(null);
            result.ranks!.expansion[index - 1] = i + 1;
          }
          ranked.set(row.id, result);
        }
      }
      return {
        space_id: space,
        generation: current.generation,
        results: [...ranked.values()]
          .sort((a, b) => b.score! - a.score! || a.seq - b.seq)
          .slice(0, limit),
        truncated: ranked.size > limit || lists.some((list) => list.truncated),
        expansion: {
          ...expansion,
          candidates: lists.slice(1).map((list) => list.results.length),
          candidate_limit: 100,
          fusion: "mean-alternatives-rrf:k=60" as const,
        },
      };
    }
    const fts =
      mode === "phrase"
        ? `"${input.query.replaceAll('"', '""')}"`
        : buildFtsQuery(input.query, mode === "all" ? "and" : "or");
    if (!fts)
      return { space_id: space, generation: current.generation, results: [], truncated: false };
    const rows = db
      .query(`SELECT s.id,s.seq,s.session_id,s.content_hash,
      snippet(memory_source_fts,0,'','',' … ',32) AS excerpt
      FROM memory_source_fts f CROSS JOIN memory_sources s ON s.seq=f.rowid
      WHERE memory_source_fts MATCH ? AND s.space_id=? AND (? IS NULL OR s.session_id=?)
      ORDER BY f.rank,s.seq LIMIT ?`)
      .all(
        fts,
        space,
        input.session_id ?? null,
        input.session_id ?? null,
        limit + 1,
      ) as MemorySourceSearchResult["results"];
    return {
      space_id: space,
      generation: current.generation,
      results: rows.slice(0, limit),
      truncated: rows.length > limit,
    };
  })();
}

/** Offsets refer to immutable UTF-8 text: string bodies decode directly; other
 * JSON bodies use the exact stored JSON. Explicit offsets must be codepoint boundaries. */
export function readMemorySourceRange(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  start = 0,
  end?: number,
  expectedHash?: string,
): MemorySourceRange {
  authorizeMemorySpace(db, actor, space);
  const source = db
    .query(`SELECT s.id,s.session_id,s.content_hash,t.text FROM memory_sources s
    JOIN memory_source_text t ON t.seq=s.seq WHERE s.space_id=? AND s.id=?`)
    .get(space, id) as {
    id: string;
    session_id: string | null;
    content_hash: string;
    text: string;
  } | null;
  if (!source) throw new MemoryError(404, "source_not_found", "Source not found");
  const bytes = Buffer.from(source.text);
  const textHash = createHash("sha256").update(bytes).digest("hex");
  if (expectedHash !== undefined && expectedHash !== textHash)
    throw new MemoryError(409, "source_changed", "Source text hash does not match");
  integer(start, "start", 0, bytes.length);
  let stop = end ?? Math.min(bytes.length, start + 16384);
  integer(stop, "end", start, Math.min(bytes.length, start + 65536));
  const boundary = (offset: number) => offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
  if (end === undefined) while (stop > start && !boundary(stop)) stop--;
  if (!boundary(start) || !boundary(stop))
    throw new MemoryError(416, "invalid_range", "Offsets must be UTF-8 codepoint boundaries");
  return {
    id: source.id,
    session_id: source.session_id,
    content_hash: source.content_hash,
    text_hash: textHash,
    representation: "utf8-source-text-v1",
    start,
    end: stop,
    total_bytes: bytes.length,
    next_start: stop < bytes.length ? stop : null,
    text: bytes.subarray(start, stop).toString("utf8"),
  };
}
