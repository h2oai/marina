// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { MemoryError, object, recordInput, textValue } from "../memory/service-types";
import {
  MEMORY_GRAPH_ACTIONS,
  type MemoryGraphAction,
  type MemoryGraphEntity,
  type MemoryGraphRelation,
  type MemoryKnowledgeGraph,
} from "../sdk/memory-knowledge-graph";
import type { MemoryRecord } from "../sdk/memory-types";
import {
  authorizeMemorySpace,
  captureSource,
  event,
  forgetMemory,
  hash,
  mutation,
  readMemoryRecord,
  rememberRecord,
} from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

const PROFILE = "mcp-memory-tools-v1",
  MAX_RECORDS = 2000,
  MAX_BYTES = 1024 * 1024;
type Entry = { record: MemoryRecord; kind: "entity" | "observation" | "relation"; order: number };
function capacity(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
    throw new MemoryError(
      413,
      "graph_capacity",
      "Compatibility graph exceeds 1 MiB; use native paginated memory interfaces",
    );
}
function entries(db: Database, actor: MemoryActor, space: string): Entry[] {
  const size = db
    .query(`SELECT count(*) n,coalesce(sum(length(CAST(n.content AS BLOB))),0) bytes
    FROM memory_records r JOIN notes n ON n.id=r.current_note_id WHERE r.space_id=? AND r.status='active' AND json_extract(r.metadata,'$.compat_profile')=?`)
    .get(space, PROFILE) as { n: number; bytes: number };
  if (size.n > MAX_RECORDS || size.bytes > MAX_BYTES)
    throw new MemoryError(
      413,
      "graph_capacity",
      "Compatibility profile is limited to 2,000 records and 1 MiB",
    );
  const ids = db
    .query(`SELECT id FROM memory_records WHERE space_id=? AND status='active' AND json_extract(metadata,'$.compat_profile')=?
    ORDER BY CAST(json_extract(metadata,'$.compat_order') AS INTEGER),id`)
    .all(space, PROFILE) as { id: string }[];
  return ids.map(({ id }) => {
    const record = readMemoryRecord(db, actor, space, id),
      kind = record.metadata.compat_kind,
      order = record.metadata.compat_order;
    if (record.freshness !== "current")
      throw new MemoryError(
        409,
        "compat_review_required",
        "Review and reaffirm stale records through the native memory service before using this profile",
      );
    if (
      !["entity", "observation", "relation"].includes(String(kind)) ||
      !Number.isSafeInteger(order)
    )
      throw new MemoryError(
        409,
        "invalid_compat_record",
        "A compatibility record needs explicit repair",
      );
    return { record, kind: kind as Entry["kind"], order: Number(order) };
  });
}
function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 2000)
    throw new MemoryError(
      400,
      "invalid_graph_input",
      `${name} must be an array with at most 2,000 entries`,
    );
  return value;
}
const strings = (value: unknown, name: string) =>
  list(value, name).map((v) => textValue(v, name, 8192));
function entity(raw: unknown): MemoryGraphEntity {
  const value = object(raw);
  return {
    name: textValue(value.name, "name", 256),
    entityType: textValue(value.entityType, "entityType", 256),
    observations: strings(value.observations, "observations"),
  };
}
function relation(raw: unknown): MemoryGraphRelation {
  const value = object(raw);
  return {
    from: textValue(value.from, "from", 256),
    to: textValue(value.to, "to", 256),
    relationType: textValue(value.relationType, "relationType", 256),
  };
}
function graph(items: Entry[]): MemoryKnowledgeGraph {
  try {
    return graphContents(items);
  } catch (error) {
    if (error instanceof MemoryError && error.status === 413) throw error;
    throw new MemoryError(
      409,
      "invalid_compat_record",
      "A compatibility record needs explicit repair through the native memory service",
    );
  }
}
function graphContents(items: Entry[]): MemoryKnowledgeGraph {
  const entities: MemoryGraphEntity[] = [],
    relations: MemoryGraphRelation[] = [];
  for (const item of items) {
    if (item.kind === "entity") {
      const value = object(JSON.parse(item.record.content));
      const name = textValue(value.name, "name", 256);
      if (entities.some((e) => e.name === name))
        throw new MemoryError(
          409,
          "invalid_compat_record",
          "Duplicate entity name requires explicit repair",
        );
      entities.push({
        name,
        entityType: textValue(value.entityType, "entityType", 256),
        observations: [],
      });
    } else if (item.kind === "relation") relations.push(relation(JSON.parse(item.record.content)));
  }
  for (const item of items)
    if (item.kind === "observation") {
      const parent = entities.find((e) => e.name === item.record.subject);
      if (!parent) throw new MemoryError(409, "invalid_compat_record", "Observation has no entity");
      parent.observations.push(item.record.content);
    }
  if (
    relations.some(
      (r) => !entities.some((e) => e.name === r.from) || !entities.some((e) => e.name === r.to),
    )
  )
    throw new MemoryError(409, "invalid_compat_record", "Relation has a missing endpoint");
  const result = { entities, relations };
  capacity(result);
  return result;
}
/** Atomic reference-tool semantics over native authored sources/records. Each
 * observation has separate lineage, so explicit deletion can actually forget it. */
export function memoryKnowledgeGraph(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  const input = object(raw),
    action = input.action as MemoryGraphAction;
  if (!MEMORY_GRAPH_ACTIONS.includes(action))
    throw new MemoryError(400, "invalid_graph_action", "Unsupported knowledge-graph action");
  capacity(input);
  const read = () => {
    authorizeMemorySpace(db, actor, space);
    const items = entries(db, actor, space),
      result = graph(items);
    if (action === "read_graph") return result;
    const selected = action === "open_nodes" ? strings(input.names, "names") : undefined;
    const query =
      action === "search_nodes"
        ? typeof input.query === "string" && input.query.length <= 8192
          ? input.query.toLowerCase()
          : textValue(input.query, "query", 8192)
        : undefined;
    const entities = result.entities.filter((e) =>
      selected
        ? selected.includes(e.name)
        : query !== undefined &&
          [e.name, e.entityType, ...e.observations].some((value) =>
            value.toLowerCase().includes(query),
          ),
    );
    const names = new Set(entities.map((e) => e.name));
    return {
      entities,
      relations: result.relations.filter((r) => names.has(r.from) || names.has(r.to)),
    };
  };
  if (["read_graph", "search_nodes", "open_nodes"].includes(action)) return db.transaction(read)();
  const receipt = mutation(db, actor, space, key, "compat.graph", input, () => {
    const items = entries(db, actor, space),
      current = graph(items);
    let order = Math.max(0, ...items.map((item) => item.order)),
      writeIndex = 0;
    const childKey = () => `compat:${hash({ key, index: writeIndex++ })}`;
    const add = (
      kind: Entry["kind"],
      subject: string,
      content: string,
      original: unknown,
      claim?: MemoryRecord["claim"],
    ) => {
      if (items.length >= MAX_RECORDS)
        throw new MemoryError(413, "graph_capacity", "Compatibility profile exceeds 2,000 records");
      const source = captureSource(db, actor, space, original, PROFILE, childKey());
      const result = rememberRecord(
        db,
        actor,
        space,
        recordInput({
          content,
          subject,
          claim,
          source_ids: [source.id],
          type: kind === "observation" ? "observation" : "fact",
          metadata: { compat_profile: PROFILE, compat_kind: kind, compat_order: ++order },
        }),
        childKey(),
      );
      const record = readMemoryRecord(db, actor, space, result.id);
      items.push({ kind, order, record });
    };
    const remove = (selected: Entry[]) => {
      if (!selected.length) return;
      const ids = new Set(selected.map((item) => item.record.id));
      const sources = [...new Set(selected.flatMap((item) => item.record.source_ids))];
      // Normal forget semantics also clear opaque checkpoints and reusable results.
      forgetMemory(db, actor, space, { record_ids: [...ids], source_ids: sources }, childKey());
      for (let i = items.length - 1; i >= 0; i--)
        if (ids.has(items[i]!.record.id)) items.splice(i, 1);
    };
    let result: unknown;
    if (action === "create_entities") {
      const proposed = list(input.entities, "entities").map(entity),
        created: MemoryGraphEntity[] = [];
      for (const value of proposed) {
        if (current.entities.some((e) => e.name === value.name)) continue;
        add(
          "entity",
          value.name,
          JSON.stringify({ name: value.name, entityType: value.entityType }),
          { name: value.name, entityType: value.entityType },
          {
            subject: value.name,
            predicate: "mcp:entity_type",
            object: { kind: "literal", value: value.entityType },
          },
        );
        for (const observation of value.observations)
          add("observation", value.name, observation, { entityName: value.name, observation });
        current.entities.push(value);
        created.push(value);
      }
      result = { entities: created };
    } else if (action === "create_relations") {
      const proposed = list(input.relations, "relations").map(relation),
        created: MemoryGraphRelation[] = [];
      for (const value of proposed) {
        if (
          !current.entities.some((e) => e.name === value.from) ||
          !current.entities.some((e) => e.name === value.to)
        )
          throw new MemoryError(404, "entity_not_found", "A relation endpoint is absent");
        if (current.relations.some((r) => hash(r) === hash(value))) continue;
        add("relation", value.from, JSON.stringify(value), value, {
          subject: value.from,
          predicate: value.relationType,
          object: { kind: "entity", id: value.to },
        });
        current.relations.push(value);
        created.push(value);
      }
      result = { relations: created };
    } else if (action === "add_observations") {
      const added = list(input.observations, "observations").map((raw) => {
        const value = object(raw),
          name = textValue(value.entityName, "entityName", 256),
          contents = strings(value.contents, "contents");
        const entity = current.entities.find((e) => e.name === name);
        if (!entity) throw new MemoryError(404, "entity_not_found", "Observation entity is absent");
        const observations = contents.filter((o) => !entity.observations.includes(o));
        for (const observation of observations)
          add("observation", name, observation, { entityName: name, observation });
        entity.observations.push(...observations);
        return { entityName: name, addedObservations: observations };
      });
      result = { results: added };
    } else if (action === "delete_entities") {
      const names = strings(input.entityNames, "entityNames"),
        present = new Set(current.entities.map((e) => e.name));
      remove(
        items.filter((item) =>
          item.kind === "relation"
            ? names.some((name) => {
                const r = relation(JSON.parse(item.record.content));
                return r.from === name || r.to === name;
              })
            : names.includes(item.record.subject ?? ""),
        ),
      );
      result = {
        deleted: names.map((_, i) => i).filter((i) => present.has(names[i]!)),
        notFound: names.map((_, i) => i).filter((i) => !present.has(names[i]!)),
      };
    } else if (action === "delete_observations") {
      let deletedCount = 0;
      const missingEntities: number[] = [];
      for (const [index, raw] of list(input.deletions, "deletions").entries()) {
        const value = object(raw),
          name = textValue(value.entityName, "entityName", 256),
          observations = strings(value.observations, "observations");
        if (!current.entities.some((e) => e.name === name)) {
          missingEntities.push(index);
          continue;
        }
        const selected = items.filter(
          (item) =>
            item.kind === "observation" &&
            item.record.subject === name &&
            observations.includes(item.record.content),
        );
        deletedCount += selected.length;
        remove(selected);
      }
      result = { deletedCount, missingEntities };
    } else {
      const selected = list(input.relations, "relations").map(relation);
      const removed = items.filter(
        (item) =>
          item.kind === "relation" &&
          selected.some((r) => hash(r) === hash(JSON.parse(item.record.content))),
      );
      remove(removed);
      result = { deletedCount: removed.length };
    }
    graph(entries(db, actor, space));
    capacity(result);
    return {
      id: space,
      seq: event(db, actor, space, "compat.graph", action),
      compat_graph: true,
      result,
    };
  });
  if (action === "delete_entities") {
    const names = strings(input.entityNames, "entityNames"),
      result = receipt.result as { deleted: number[]; notFound: number[] };
    return {
      deleted: result.deleted.map((i) => names[i]!),
      notFound: result.notFound.map((i) => names[i]!),
    };
  }
  if (action === "delete_observations") {
    const deletions = list(input.deletions, "deletions"),
      result = receipt.result as { deletedCount: number; missingEntities: number[] };
    return {
      deletedCount: result.deletedCount,
      missingEntities: result.missingEntities.map((i) => object(deletions[i]).entityName),
    };
  }
  return receipt.result;
}
