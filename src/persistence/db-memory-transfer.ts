// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import { canonicalPortableMemory } from "../sdk/memory-portable";
import {
  MEMORY_TRANSFER_KINDS,
  type MemoryTransferFilter,
  type MemoryTransferFragment,
  type MemoryTransferHeader,
  type MemoryTransferKind,
  type MemoryTransferList,
  type MemoryTransferPage,
  type MemoryTransferStatus,
} from "../sdk/memory-transfer";
import type { MemoryBundle } from "../sdk/memory-types";
import { applyMemoryImport, type MemoryImportRows } from "./db-memory-bundles";
import { authorizeMemorySpace, event, mutation, readMemoryRecord } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

const MAX_BYTES = 64 * 1024 * 1024,
  MAX_ROW = 4 * 1024 * 1024;
const PAGE_BYTES = 256 * 1024,
  PART_BYTES = 128 * 1024,
  MAX_ROWS = 300000;
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalPortableMemory(value)).digest("hex");
const byteHash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function invalid(message: string): never {
  throw new MemoryError(400, "invalid_transfer", message);
}
function headerInput(value: unknown): MemoryTransferHeader {
  const input = object(value),
    counts = object(input.counts);
  if (input.schema !== "marina.memory.transfer.v1") invalid("Unsupported transfer schema");
  const result = {
    schema: "marina.memory.transfer.v1" as const,
    origin_space: textValue(input.origin_space, "origin_space", 128),
    generation: integer(input.generation, "generation", 0, Number.MAX_SAFE_INTEGER),
    counts: Object.fromEntries(
      MEMORY_TRANSFER_KINDS.map((kind) => [kind, integer(counts[kind], kind, 0, MAX_ROWS)]),
    ) as MemoryTransferHeader["counts"],
  };
  if (Object.values(result.counts).reduce((sum, count) => sum + count, 0) > MAX_ROWS)
    invalid("Transfer exceeds 300,000 rows");
  return result;
}
interface Position {
  section: number;
  id: string;
  version: number;
  offset: number;
}
interface Cursor {
  header: MemoryTransferHeader;
  position: number;
  previous: string;
  row: Position;
}
function cursorInput(raw: string): Cursor {
  if (raw.length > 8192) invalid("Cursor is too large");
  try {
    const value = object(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))),
      row = object(value.row);
    const id = row.id;
    if (typeof id !== "string" || id.length > 256) invalid("Invalid row cursor");
    return {
      header: headerInput(value.header),
      position: integer(value.position, "position", 0, MAX_ROWS * 32),
      previous: textValue(value.previous, "previous", 64),
      row: {
        section: integer(row.section, "section", 0, 5),
        id,
        version: integer(row.version, "version", 0, Number.MAX_SAFE_INTEGER),
        offset: integer(row.offset, "offset", 0, MAX_ROW),
      },
    };
  } catch {
    return invalid("Invalid export cursor");
  }
}
function counts(db: Database, space: string): MemoryTransferHeader["counts"] {
  const count = (sql: string) => (db.query(sql).get(space) as { n: number }).n;
  return {
    source: count("SELECT count(*) n FROM memory_sources WHERE space_id=?"),
    record: count("SELECT count(*) n FROM memory_records WHERE space_id=? AND status='active'"),
    revision: count(
      "SELECT count(*) n FROM memory_record_versions v JOIN memory_records r ON r.id=v.record_id WHERE r.space_id=? AND r.status='active'",
    ),
    vocabulary: count("SELECT count(*) n FROM memory_vocabularies WHERE space_id=?"),
    checkpoint: count("SELECT count(*) n FROM memory_checkpoints WHERE space_id=?"),
  };
}
/** Read one row, using keyset cursors. Large histories are individual revisions. */
function nextRow(
  db: Database,
  actor: MemoryActor,
  space: string,
  pos: Position,
): { id: string; version: number; value: unknown } | null {
  const relation = pos.offset ? ">=" : ">";
  if (pos.section === 0) {
    const row = db
      .query(`SELECT * FROM memory_sources WHERE space_id=? AND id${relation}? ORDER BY id LIMIT 1`)
      .get(space, pos.id) as { id: string; body: string } | null;
    if (!row) return null;
    const body = JSON.parse(row.body);
    return {
      id: row.id,
      version: 0,
      value: { ...row, body, body_sha256: byteHash(JSON.stringify(body)) },
    };
  }
  if (pos.section === 1) {
    const row = db
      .query(
        `SELECT id,version,created_at,stale,stale_reason FROM memory_records WHERE space_id=? AND status='active' AND id${relation}? ORDER BY id LIMIT 1`,
      )
      .get(space, pos.id) as { id: string; version: number } | null;
    return row ? { id: row.id, version: 0, value: row } : null;
  }
  if (pos.section === 2) {
    const row = db
      .query(`SELECT v.record_id,v.version,v.attributes FROM memory_record_versions v JOIN memory_records r ON r.id=v.record_id
      WHERE r.space_id=? AND r.status='active' AND (v.record_id>? OR (v.record_id=? AND v.version${relation}?))
      ORDER BY v.record_id,v.version LIMIT 1`)
      .get(space, pos.id, pos.id, pos.version) as {
      record_id: string;
      version: number;
      attributes: string | null;
    } | null;
    if (!row) return null;
    return {
      id: row.record_id,
      version: row.version,
      value: {
        record: readMemoryRecord(db, actor, space, row.record_id, row.version),
        attributes: row.attributes === null ? null : JSON.parse(row.attributes),
      },
    };
  }
  if (pos.section === 3) {
    const row = db
      .query(
        `SELECT version,definition,created_at FROM memory_vocabularies WHERE space_id=? AND version${relation}? ORDER BY version LIMIT 1`,
      )
      .get(space, pos.version) as { version: number } | null;
    return row ? { id: String(row.version), version: row.version, value: row } : null;
  }
  const row = db
    .query(
      `SELECT name,version,source_cursor,data,updated_at FROM memory_checkpoints WHERE space_id=? AND name${relation}? ORDER BY name LIMIT 1`,
    )
    .get(space, pos.id) as { name: string } | null;
  return row ? { id: row.name, version: 0, value: row } : null;
}
export function exportMemoryTransferPage(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw?: string,
): MemoryTransferPage {
  return db.transaction(() => {
    const current = authorizeMemorySpace(db, actor, space, "memory:export");
    const header = raw
      ? undefined
      : headerInput({
          schema: "marina.memory.transfer.v1",
          origin_space: space,
          generation: current.generation,
          counts: counts(db, space),
        });
    const cursor: Cursor = raw
      ? cursorInput(raw)
      : {
          header: header!,
          position: 0,
          previous: digest(header),
          row: { section: 0, id: "", version: 0, offset: 0 },
        };
    if (cursor.header.origin_space !== space || cursor.header.generation !== current.generation)
      throw new MemoryError(409, "transfer_changed", "Source changed; start a new export");
    const fragments: MemoryTransferFragment[] = [];
    let bytes = 0;
    while (cursor.row.section < 5 && fragments.length < 128 && bytes < PAGE_BYTES) {
      const row = nextRow(db, actor, space, cursor.row);
      if (!row) {
        if (cursor.row.offset) invalid("Partial row is missing");
        cursor.row = { section: cursor.row.section + 1, id: "", version: 0, offset: 0 };
        continue;
      }
      const data = Buffer.from(JSON.stringify(row.value));
      if (data.byteLength > MAX_ROW)
        throw new MemoryError(413, "transfer_capacity", "One transfer row exceeds 4 MiB");
      const offset = cursor.row.offset;
      if (offset >= data.byteLength) invalid("Row offset is outside the row");
      const part = data.subarray(offset, offset + Math.min(PART_BYTES, PAGE_BYTES - bytes));
      fragments.push({
        kind: MEMORY_TRANSFER_KINDS[cursor.row.section]!,
        id: row.id,
        version: row.version,
        offset,
        size: data.byteLength,
        sha256: byteHash(data),
        base64: part.toString("base64"),
      });
      bytes += part.byteLength;
      cursor.row = {
        section: cursor.row.section,
        id: row.id,
        version: row.version,
        offset: offset + part.byteLength === data.byteLength ? 0 : offset + part.byteLength,
      };
    }
    const payload = {
      header: cursor.header,
      position: cursor.position,
      previous: cursor.previous,
      fragments,
      done: cursor.row.section === 5,
    };
    const sha256 = digest(payload);
    return {
      ...payload,
      sha256,
      next_cursor: payload.done
        ? null
        : Buffer.from(
            JSON.stringify({
              ...cursor,
              position: cursor.position + fragments.length,
              previous: sha256,
            }),
          ).toString("base64url"),
    };
  })();
}

interface TransferRow {
  id: string;
  space_id: string;
  principal_id: string;
  header: string;
  state: MemoryTransferStatus["state"];
  position: number;
  chain: string;
  bytes: number;
  cursor: string | null;
  expires_at: number;
}
function transfer(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  write = false,
): TransferRow {
  const owner = authorizeMemorySpace(db, actor, space, write ? "memory:write" : "memory:read");
  const row = db
    .query("SELECT * FROM memory_transfers WHERE id=? AND space_id=? AND principal_id=?")
    .get(id, space, actor.principalId) as TransferRow | null;
  if (!row || owner.owner_id !== actor.principalId)
    throw new MemoryError(404, "transfer_not_found", "Transfer not found");
  return row;
}
function status(row: TransferRow): MemoryTransferStatus {
  return {
    id: row.id,
    header: JSON.parse(row.header),
    state: row.state,
    position: row.position,
    sha256: row.chain,
    bytes: row.bytes,
    next_cursor: row.cursor,
    expires_at: row.expires_at,
  };
}
export function memoryTransferStatus(db: Database, actor: MemoryActor, space: string, id: string) {
  return status(transfer(db, actor, space, id));
}
export function listMemoryTransfers(
  db: Database,
  actor: MemoryActor,
  space: string,
  input: MemoryTransferFilter = {},
): MemoryTransferList {
  const owner = authorizeMemorySpace(db, actor, space);
  if (owner.owner_id !== actor.principalId)
    throw new MemoryError(403, "owner_required", "Transfer staging is visible only to its owner");
  const limit = integer(input.limit ?? 20, "limit", 1, 100);
  if (
    input.state !== undefined &&
    !["receiving", "ready", "committed", "aborted"].includes(input.state)
  )
    throw new MemoryError(400, "invalid_input", "Unknown transfer state");
  if (input.expired !== undefined && typeof input.expired !== "boolean")
    throw new MemoryError(400, "invalid_input", "expired must be boolean");
  const cursor = input.cursor === undefined ? "" : textValue(input.cursor, "cursor", 128);
  const now = Date.now();
  const rows = db
    .query(`SELECT * FROM memory_transfers WHERE space_id=? AND principal_id=? AND id>?
    AND (? IS NULL OR state=?) AND (? IS NULL OR (expires_at<=?)=?) ORDER BY id LIMIT ?`)
    .all(
      space,
      actor.principalId,
      cursor,
      input.state ?? null,
      input.state ?? null,
      input.expired === undefined ? null : Number(input.expired),
      now,
      input.expired === undefined ? null : Number(input.expired),
      limit + 1,
    ) as TransferRow[];
  const selected = rows.slice(0, limit);
  return {
    transfers: selected.map((row) => ({ ...status(row), expired: row.expires_at <= now })),
    next_cursor: rows.length > limit ? selected.at(-1)!.id : null,
  };
}
export function beginMemoryTransfer(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  const header = headerInput(raw);
  return mutation(db, actor, space, key, "transfer.begin", header, () => {
    const owner = authorizeMemorySpace(db, actor, space, "memory:write");
    if (owner.owner_id !== actor.principalId)
      throw new MemoryError(403, "owner_required", "Import requires the space owner");
    for (const table of [
      "memory_sources",
      "memory_records",
      "memory_vocabularies",
      "memory_checkpoints",
    ])
      if (db.query(`SELECT 1 FROM ${table} WHERE space_id=? LIMIT 1`).get(space))
        throw new MemoryError(409, "import_not_empty", "Import requires an empty destination");
    const active = (
      db
        .query(
          "SELECT count(*) n FROM memory_transfers WHERE principal_id=? AND state IN ('receiving','ready')",
        )
        .get(actor.principalId) as { n: number }
    ).n;
    if (active >= 2)
      throw new MemoryError(
        409,
        "transfer_capacity",
        "At most two active transfers per owner; explicitly abort unused transfers",
      );
    const id = randomUUID();
    db.run(
      "INSERT INTO memory_transfers(id,space_id,principal_id,header,state,position,chain,bytes,cursor,expires_at) VALUES (?,?,?,?,'receiving',0,?,0,NULL,?)",
      [id, space, actor.principalId, JSON.stringify(header), digest(header), Date.now() + 86400000],
    );
    return {
      ...status(transfer(db, actor, space, id)),
      seq: event(db, actor, space, "transfer.started", id),
    };
  });
}
type Part = MemoryTransferFragment & { position: number; data: string };
function validateFragment(raw: unknown): MemoryTransferFragment {
  const input = object(raw);
  if (!MEMORY_TRANSFER_KINDS.includes(input.kind as MemoryTransferKind))
    invalid("Invalid row kind");
  const base64 = textValue(input.base64, "base64", PART_BYTES * 2);
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.byteLength || bytes.byteLength > PART_BYTES || bytes.toString("base64") !== base64)
    invalid("Invalid base64 fragment");
  const result = {
    kind: input.kind as MemoryTransferKind,
    id: textValue(input.id, "id", 256),
    version: integer(input.version, "version", 0, Number.MAX_SAFE_INTEGER),
    offset: integer(input.offset, "offset", 0, MAX_ROW),
    size: integer(input.size, "size", 1, MAX_ROW),
    sha256: textValue(input.sha256, "sha256", 64),
    base64,
  };
  if (result.offset + bytes.byteLength > result.size) invalid("Fragment extends beyond its row");
  return result;
}
function rowBytes(
  db: Database,
  id: string,
  kind: string,
  item: string,
  version: number,
): Uint8Array {
  const rows = db
    .query(
      "SELECT data FROM memory_transfer_parts WHERE transfer_id=? AND kind=? AND item_id=? AND item_version=? ORDER BY byte_offset",
    )
    .all(id, kind, item, version) as { data: string }[];
  return Buffer.concat(rows.map((row) => Buffer.from(row.data, "base64")));
}
export function appendMemoryTransfer(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  raw: unknown,
  key: string,
) {
  const input = object(raw),
    header = headerInput(input.header);
  if (
    !Array.isArray(input.fragments) ||
    input.fragments.length > 128 ||
    typeof input.done !== "boolean"
  )
    invalid("Invalid transfer page");
  const payload = {
    header,
    position: integer(input.position, "position", 0, MAX_ROWS * 32),
    previous: textValue(input.previous, "previous", 64),
    fragments: input.fragments.map(validateFragment),
    done: input.done,
  };
  if (input.sha256 !== digest(payload)) invalid("Page SHA-256 mismatch");
  if (
    input.next_cursor !== null &&
    (typeof input.next_cursor !== "string" || input.next_cursor.length > 8192)
  )
    invalid("Invalid next cursor");
  if (payload.done !== (input.next_cursor === null)) invalid("End marker and cursor disagree");
  return mutation(db, actor, space, key, "transfer.append", { id, ...input }, () => {
    const row = transfer(db, actor, space, id, true);
    if (row.state !== "receiving" || row.expires_at <= Date.now())
      throw new MemoryError(
        409,
        "transfer_inactive",
        "Transfer is no longer receiving; inspect or abort it",
      );
    if (
      row.header !== JSON.stringify(header) ||
      row.position !== payload.position ||
      row.chain !== payload.previous
    )
      throw new MemoryError(409, "transfer_order", "Page does not continue the accepted transfer");
    let bytes = 0;
    let last = db
      .query(
        "SELECT kind,item_id AS id,item_version AS version,byte_offset AS offset,size,sha256,data,position FROM memory_transfer_parts WHERE transfer_id=? ORDER BY position DESC LIMIT 1",
      )
      .get(id) as Part | null;
    for (const [index, part] of payload.fragments.entries()) {
      const chunk = Buffer.from(part.base64, "base64");
      bytes += chunk.byteLength;
      if (last) {
        const end = last.offset + Buffer.from(last.data, "base64").byteLength;
        const same =
          last.kind === part.kind && last.id === part.id && last.version === part.version;
        if (
          same
            ? end !== part.offset || part.sha256 !== last.sha256 || part.size !== last.size
            : end !== last.size || part.offset !== 0
        )
          invalid("Fragments have a gap, duplicate, or conflicting row");
        if (
          !same &&
          MEMORY_TRANSFER_KINDS.indexOf(part.kind) < MEMORY_TRANSFER_KINDS.indexOf(last.kind)
        )
          invalid("Row sections are out of order");
      } else if (part.offset !== 0) invalid("First row must start at zero");
      if (bytes > PAGE_BYTES || row.bytes + bytes > MAX_BYTES)
        throw new MemoryError(
          413,
          "transfer_capacity",
          "Transfer exceeds its page or 64 MiB total byte limit",
        );
      db.run(
        "INSERT INTO memory_transfer_parts(transfer_id,space_id,position,kind,item_id,item_version,byte_offset,size,sha256,data) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          space,
          row.position + index,
          part.kind,
          part.id,
          part.version,
          part.offset,
          part.size,
          part.sha256,
          part.base64,
        ],
      );
      if (part.offset + chunk.byteLength === part.size) {
        const body = rowBytes(db, id, part.kind, part.id, part.version);
        if (body.byteLength !== part.size || byteHash(body) !== part.sha256)
          invalid("Completed row SHA-256 mismatch");
        try {
          const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
          if (part.kind === "revision") {
            const record = object(value.record);
            if (record.id !== part.id || record.version !== part.version)
              invalid("Revision identity differs from its row key");
          } else if (part.kind === "vocabulary") {
            if (value.version !== part.version || String(value.version) !== part.id)
              invalid("Vocabulary identity differs from its row key");
          } else if (
            (part.kind === "checkpoint" ? value.name : value.id) !== part.id ||
            part.version !== 0
          )
            invalid("Identity differs from its row key");
        } catch {
          invalid("Row is not a UTF-8 JSON object");
        }
      }
      last = { ...part, position: row.position + index, data: part.base64 };
    }
    if (payload.done) {
      if (last && last.offset + Buffer.from(last.data, "base64").byteLength !== last.size)
        invalid("Final row is incomplete");
      const actual = db
        .query(
          "SELECT kind,count(*) n FROM memory_transfer_parts WHERE transfer_id=? AND byte_offset=0 GROUP BY kind",
        )
        .all(id) as { kind: MemoryTransferKind; n: number }[];
      for (const kind of MEMORY_TRANSFER_KINDS)
        if ((actual.find((row) => row.kind === kind)?.n ?? 0) !== header.counts[kind])
          invalid("Transfer row count is incomplete");
    }
    db.run(
      "UPDATE memory_transfers SET position=?,chain=?,bytes=bytes+?,cursor=?,state=? WHERE id=?",
      [
        row.position + payload.fragments.length,
        input.sha256 as string,
        bytes,
        input.next_cursor as string | null,
        payload.done ? "ready" : "receiving",
        id,
      ],
    );
    return {
      ...status(transfer(db, actor, space, id)),
      seq: event(db, actor, space, "transfer.page", id),
    };
  });
}
function rows<T>(db: Database, id: string, kind: MemoryTransferKind, item?: string): Iterable<T> {
  return {
    *[Symbol.iterator]() {
      const sql = `SELECT item_id,item_version,sha256,size FROM memory_transfer_parts WHERE transfer_id=? AND kind=? AND byte_offset=0 ${item === undefined ? "" : "AND item_id=?"} ORDER BY position`;
      const args = item === undefined ? [id, kind] : [id, kind, item];
      for (const row of db.query(sql).iterate(...args) as Iterable<{
        item_id: string;
        item_version: number;
        sha256: string;
        size: number;
      }>) {
        const data = rowBytes(db, id, kind, row.item_id, row.item_version);
        if (data.byteLength !== row.size || byteHash(data) !== row.sha256)
          invalid("Staged row failed integrity verification");
        yield JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as T;
      }
    },
  };
}
export function commitMemoryTransfer(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  expected: string,
  key: string,
) {
  return mutation(db, actor, space, key, "transfer.commit", { id, expected }, () => {
    const row = transfer(db, actor, space, id, true),
      header = headerInput(JSON.parse(row.header));
    if (row.state !== "ready" || row.chain !== expected || row.expires_at <= Date.now())
      throw new MemoryError(409, "transfer_inactive", "Transfer is not ready with that digest");
    type BundleRecord = MemoryBundle["payload"]["records"][number];
    const data: MemoryImportRows = {
      origin_space: header.origin_space,
      sources: rows(db, id, "source"),
      vocabularies: rows(db, id, "vocabulary"),
      checkpoints: rows(db, id, "checkpoint"),
      records: {
        *[Symbol.iterator]() {
          for (const record of rows<Omit<BundleRecord, "versions">>(db, id, "record")) {
            yield {
              ...record,
              versions: rows<BundleRecord["versions"][number]>(db, id, "revision", record.id),
            };
          }
        },
      },
    };
    // Every revision must belong to a declared record; unknown rows cannot be silently dropped.
    const orphan = db
      .query(`SELECT 1 FROM memory_transfer_parts v WHERE v.transfer_id=? AND v.kind='revision' AND v.byte_offset=0 AND NOT EXISTS
      (SELECT 1 FROM memory_transfer_parts r WHERE r.transfer_id=v.transfer_id AND r.kind='record' AND r.item_id=v.item_id AND r.byte_offset=0) LIMIT 1`)
      .get(id);
    if (orphan) invalid("Revision has no declared record");
    const result = applyMemoryImport(db, actor, space, data);
    if (result.sources !== header.counts.source || result.records !== header.counts.record)
      invalid("Published counts differ from header");
    db.run("DELETE FROM memory_transfer_parts WHERE transfer_id=?", [id]);
    db.run("UPDATE memory_transfers SET state='committed',cursor=NULL WHERE id=?", [id]);
    return {
      id,
      ...result,
      sha256: expected,
      seq: event(db, actor, space, "transfer.committed", id),
    };
  });
}
export function abortMemoryTransfer(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  key: string,
) {
  return mutation(db, actor, space, key, "transfer.abort", { id }, () => {
    const row = transfer(db, actor, space, id, true);
    if (row.state === "committed")
      throw new MemoryError(
        409,
        "transfer_committed",
        "Committed memory must be removed through explicit forgetting",
      );
    db.run("DELETE FROM memory_transfer_parts WHERE transfer_id=?", [id]);
    db.run("UPDATE memory_transfers SET state='aborted',cursor=NULL WHERE id=?", [id]);
    return { id, state: "aborted", seq: event(db, actor, space, "transfer.aborted", id) };
  });
}
