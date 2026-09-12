// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { canonicalPortableMemory, memoryPortableDigest } from "./memory-portable";
import type { MemoryClaim } from "./memory-types";

export type MemoryExportFormat = "mcp-knowledge-graph-v1" | "langgraph-items-v1";
interface Assertion {
  content: string;
  subject?: string;
  claim?: MemoryClaim;
  metadata: Record<string, unknown>;
}
/** Named import translations, not claims of full third-party API emulation.
 * Original exports remain verbatim sources. No automatic extraction or embedding. */
export async function translateMemoryExport(
  format: MemoryExportFormat,
  raw: unknown,
  options: { origin: string; imported_at: number },
) {
  if (!options.origin || !Number.isSafeInteger(options.imported_at) || options.imported_at < 0)
    throw new Error("Explicit origin and import timestamp are required");
  const assertions: Assertion[] = [],
    losses: string[] = [];
  const checkObject = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected an object");
    return value as Record<string, unknown>;
  };
  const text = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Expected a nonempty string");
    return value;
  };
  if (format === "mcp-knowledge-graph-v1") {
    const graph = checkObject(raw);
    if (!Array.isArray(graph.entities) || !Array.isArray(graph.relations))
      throw new Error("Expected entities and relations arrays");
    const names = new Set<string>();
    for (const value of graph.entities) {
      const entity = checkObject(value),
        name = text(entity.name),
        entityType = text(entity.entityType);
      if (names.has(name) || !Array.isArray(entity.observations))
        throw new Error("Duplicate entity or invalid observations");
      names.add(name);
      assertions.push({
        content: `${name}: ${entityType}`,
        subject: name,
        claim: {
          subject: name,
          predicate: "mcp:entity_type",
          object: { kind: "literal", value: entityType },
        },
        metadata: { adapter: format, entityType },
      });
      for (const observation of entity.observations)
        assertions.push({
          content: text(observation),
          subject: name,
          metadata: { adapter: format, kind: "observation" },
        });
      if (Object.keys(entity).some((key) => !["name", "entityType", "observations"].includes(key)))
        losses.push(
          `Additional fields on entity ${name} are preserved only in the original source`,
        );
    }
    for (const value of graph.relations) {
      const relation = checkObject(value),
        from = text(relation.from),
        to = text(relation.to),
        predicate = text(relation.relationType);
      if (!names.has(from) || !names.has(to))
        throw new Error("Relation endpoint is absent; refusing to invent an entity");
      assertions.push({
        content: `${from} ${predicate} ${to}`,
        subject: from,
        claim: { subject: from, predicate, object: { kind: "entity", id: to } },
        metadata: { adapter: format, kind: "relation" },
      });
    }
    losses.push(
      "The source format has no revision, temporal, authorization or dependency contract; none is inferred",
    );
  } else if (format === "langgraph-items-v1") {
    if (!Array.isArray(raw)) throw new Error("Expected an array of LangGraph store items");
    const keys = new Set<string>();
    for (const value of raw) {
      const item = checkObject(value);
      if (!Array.isArray(item.namespace) || item.namespace.some((part) => typeof part !== "string"))
        throw new Error("Invalid namespace");
      const key = text(item.key),
        subject = `langgraph:${JSON.stringify([...item.namespace, key])}`;
      if (keys.has(subject)) throw new Error("Duplicate namespace/key");
      keys.add(subject);
      const content = canonicalPortableMemory(checkObject(item.value));
      assertions.push({
        content,
        subject,
        metadata: { adapter: format, namespace: item.namespace, key, value: item.value },
      });
    }
    losses.push(
      "This is a store-item import, not a graph checkpointer or BaseStore batch implementation; TTL and semantic indexes are not inferred",
    );
  } else throw new Error("Unsupported memory export format");
  if (assertions.length > 2000)
    throw new Error("Translation exceeds the native bundle record limit");
  const sourceId = `source:${await memoryPortableDigest({ format, origin: options.origin, raw })}`;
  const bodyBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(raw)),
  );
  const bodyHash = Array.from(new Uint8Array(bodyBytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const records = await Promise.all(
    assertions.map(async (assertion, index) => {
      const id = `record:${await memoryPortableDigest({ sourceId, index })}`;
      const attributes = {
        subject: assertion.subject ?? null,
        metadata: {
          ...assertion.metadata,
          origin: options.origin,
          created_at_semantics: "import-time; source history unknown",
        },
        source_ids: [sourceId],
        depends_on: [],
        dependency_versions: {},
        claim: assertion.claim ?? null,
        valid_time: null,
        vocabulary_version: 0,
      };
      const record = {
        id,
        space_id: options.origin,
        version: 1,
        content: assertion.content,
        type: "fact",
        tier: "fact",
        importance: 5,
        created_at: options.imported_at,
        ...attributes,
      };
      return {
        id,
        version: 1,
        created_at: options.imported_at,
        stale: 0,
        stale_reason: null,
        versions: [{ record, attributes }],
      };
    }),
  );
  const payload = {
    origin_space: options.origin,
    sources: [
      {
        id: sourceId,
        space_id: options.origin,
        seq: 1,
        session_id: format,
        body: raw,
        content_hash: bodyHash,
        body_sha256: bodyHash,
        created_at: options.imported_at,
      },
    ],
    records,
    vocabularies: [],
    checkpoints: [],
  };
  const bundle = {
    schema: "marina.memory.bundle.v2",
    sha256: await memoryPortableDigest(payload),
    payload,
    excluded: ["credentials", "grants", "receipts", "indexes", "cached_results"],
  };
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > 1536 * 1024)
    throw new Error("Translation exceeds the native bundle byte limit");
  return { bundle, format, losses, original_source_id: sourceId };
}
