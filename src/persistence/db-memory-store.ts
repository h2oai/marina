// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import {
  authorizeMemorySpace,
  canonical,
  captureSource,
  forgetMemory,
  hash,
  mutation,
  readMemoryRecord,
  rememberRecord,
  reviseRecord,
} from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

const FORMAT = "marina.memory.json-store.v1";
const invalid = (message: string): never => {
  throw new MemoryError(400, "invalid_store", message);
};
const capacity = (): never => {
  throw new MemoryError(
    413,
    "store_capacity",
    "Store query exceeds 2,000 candidates or 4 MiB; narrow the namespace prefix",
  );
};
function namespace(raw: unknown, empty = false): string[] {
  if (!Array.isArray(raw) || raw.length > 32 || (!empty && !raw.length))
    invalid("Namespace must contain 1–32 labels (search prefixes may be empty)");
  const result = (raw as unknown[]).map((v) => textValue(v, "namespace label", 256));
  if (result.some((s) => s.includes(".")) || result[0] === "langgraph")
    invalid("Namespace labels cannot contain periods or use reserved root langgraph");
  return result;
}
export interface StoreItem {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
function item(db: Database, actor: MemoryActor, space: string, id: string): StoreItem {
  const record = readMemoryRecord(db, actor, space, id),
    meta = record.metadata;
  if (record.freshness === "stale" || meta.format !== FORMAT)
    throw new MemoryError(409, "store_requires_review", "Store item needs review");
  const ns = namespace(meta.namespace),
    key = textValue(meta.key, "key", 256);
  if (record.subject !== `store:${hash([ns, key])}`)
    throw new MemoryError(
      409,
      "store_requires_review",
      "Store namespace or key no longer agrees with its identity",
    );
  let value: unknown;
  try {
    value = JSON.parse(record.content);
  } catch {
    invalid("Stored item is not JSON");
  }
  return {
    namespace: ns,
    key,
    value: object(value),
    createdAt: new Date(record.created_at).toISOString(),
    updatedAt: new Date(
      (
        db
          .query(
            "SELECT n.created_at FROM memory_records r JOIN notes n ON n.id=r.current_note_id WHERE r.id=?",
          )
          .get(id) as { created_at: number }
      ).created_at,
    ).toISOString(),
  };
}
function filterValue(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const entries = Object.entries(expected);
    if (entries.some(([op]) => op.startsWith("$")))
      return entries.every(([op, want]) => {
        if (!["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"].includes(op))
          invalid("Unsupported store filter operator");
        if (op === "$eq") return canonical(actual) === canonical(want);
        if (op === "$ne") return canonical(actual) !== canonical(want);
        if (
          typeof actual !== typeof want ||
          (typeof actual !== "number" && typeof actual !== "string")
        )
          return false;
        const a = actual as number,
          b = want as number;
        return op === "$gt" ? a > b : op === "$gte" ? a >= b : op === "$lt" ? a < b : a <= b;
      });
  }
  return canonical(actual) === canonical(expected);
}
/** Named JSON store profile. Original JSON is captured, revisions are native,
 * and bounded batches publish atomically in caller order. No semantic query emulation. */
export function memoryJsonStore(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  const input = object(raw);
  if (Object.keys(input).some((k) => k !== "operations")) invalid("Unknown store batch field");
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 64)
    invalid("Use 1–64 store operations");
  const operations = (input.operations as unknown[]).map(object),
    writing = operations.some((op) => Object.hasOwn(op, "value"));
  authorizeMemorySpace(db, actor, space, writing ? "memory:write" : "memory:read");
  const execute = () => {
    let seq: number | undefined;
    const results = operations.map((op, index) => {
      const allowed = Object.hasOwn(op, "namespace")
        ? ["namespace", "key", ...(Object.hasOwn(op, "value") ? ["value", "index"] : [])]
        : Object.hasOwn(op, "namespacePrefix")
          ? ["namespacePrefix", "filter", "limit", "offset", "query"]
          : ["matchConditions", "maxDepth", "limit", "offset"];
      if (Object.keys(op).some((name) => !allowed.includes(name)))
        invalid("Unknown store operation field");
      const requestKey = `store:${hash([key, index])}`;
      if (Object.hasOwn(op, "namespace")) {
        const ns = namespace(op.namespace),
          itemKey = textValue(op.key, "key", 256),
          subject = `store:${hash([ns, itemKey])}`;
        const rows = db
          .query(
            "SELECT id FROM memory_records WHERE space_id=? AND subject=? AND status='active' ORDER BY id LIMIT 2",
          )
          .all(space, subject) as { id: string }[];
        if (rows.length > 1)
          throw new MemoryError(
            409,
            "store_requires_review",
            "Store identity has competing records",
          );
        const previous = rows[0] ? item(db, actor, space, rows[0].id) : null;
        if (!Object.hasOwn(op, "value")) return previous;
        if (op.index !== undefined && op.index !== false)
          invalid("This JSON store profile does not provide embedding indexes");
        if (op.value === null) {
          if (rows[0])
            seq = forgetMemory(
              db,
              actor,
              space,
              {
                record_ids: [rows[0].id],
                source_ids: (
                  db
                    .query("SELECT source_id FROM memory_derivations WHERE record_id=?")
                    .all(rows[0].id) as { source_id: string }[]
                ).map((s) => s.source_id),
              },
              requestKey,
            ).seq;
          return null;
        }
        const value = object(op.value),
          content = JSON.stringify(value);
        if (Buffer.byteLength(content) > 65536)
          invalid("Store values may use at most 64 KiB of JSON");
        const source = captureSource(db, actor, space, value, FORMAT, `${requestKey}:source`);
        const data = {
          content,
          subject,
          source_ids: [source.id],
          metadata: { format: FORMAT, namespace: ns, key: itemKey },
        };
        seq = rows[0]
          ? reviseRecord(
              db,
              actor,
              space,
              rows[0].id,
              readMemoryRecord(db, actor, space, rows[0].id).version,
              data,
              requestKey,
            ).seq
          : rememberRecord(db, actor, space, data, requestKey).seq;
        return null;
      }
      const searching = Object.hasOwn(op, "namespacePrefix"),
        prefix = searching ? namespace(op.namespacePrefix, true) : [];
      if (op.query !== undefined)
        invalid(
          "Semantic search is not supported by the langgraph-store-json-v1 profile; use Marina search explicitly",
        );
      const limit = integer(op.limit ?? (searching ? 10 : 100), "limit", 1, 100),
        offset = integer(op.offset ?? 0, "offset", 0, 2000);
      const clauses = [
          "r.space_id=?",
          "r.status='active'",
          "json_extract(r.metadata,'$.format')=?",
        ],
        args: (string | number)[] = [space, FORMAT];
      for (const [i, label] of prefix.entries()) {
        clauses.push(`json_extract(r.metadata,'$.namespace[${i}]')=?`);
        args.push(label);
      }
      const rows = db
        .query(
          `SELECT r.id,length(CAST(n.content AS BLOB)) bytes FROM memory_records r JOIN notes n ON n.id=r.current_note_id WHERE ${clauses.join(" AND ")} ORDER BY r.created_at,r.id LIMIT 2001`,
        )
        .all(...args) as { id: string; bytes: number }[];
      if (rows.length > 2000 || rows.reduce((sum, r) => sum + r.bytes, 0) > 4194304) capacity();
      const items = rows.map((r) => item(db, actor, space, r.id));
      if (searching) {
        const filter = op.filter === undefined ? {} : object(op.filter);
        for (const value of Object.values(filter))
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const keys = Object.keys(value);
            if (
              keys.some((k) => k.startsWith("$")) &&
              keys.some((k) => !["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"].includes(k))
            )
              invalid("Unsupported store filter operator");
          }
        return items
          .filter((i) =>
            Object.entries(filter).every(
              ([name, want]) => Object.hasOwn(i.value, name) && filterValue(i.value[name], want),
            ),
          )
          .slice(offset, offset + limit);
      }
      const conditions = op.matchConditions ?? [];
      if (!Array.isArray(conditions) || conditions.length > 16)
        invalid("Invalid namespace match conditions");
      const matches = (conditions as unknown[]).map((v) => {
        const c = object(v);
        if (Object.keys(c).some((k) => !["matchType", "path"].includes(k)))
          invalid("Unknown namespace match field");
        if (c.matchType !== "prefix" && c.matchType !== "suffix")
          invalid("Unknown namespace match type");
        return { kind: c.matchType, path: namespace(c.path, true) };
      });
      const depth = op.maxDepth === undefined ? 32 : integer(op.maxDepth, "maxDepth", 1, 32);
      const names = items
        .map((i) => i.namespace)
        .filter((ns) =>
          matches.every(
            (m) =>
              m.path.length <= ns.length &&
              m.path.every(
                (part, i) =>
                  part === "*" ||
                  part === ns[m.kind === "prefix" ? i : ns.length - m.path.length + i],
              ),
          ),
        )
        .map((ns) => ns.slice(0, depth));
      return [...new Map(names.map((ns) => [JSON.stringify(ns), ns])).values()]
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        .slice(offset, offset + limit);
    });
    return { id: space, seq, profile: "langgraph-store-json-v1", results };
  };
  return writing
    ? mutation(db, actor, space, key, "store.batch", input, execute)
    : db.transaction(execute)();
}
