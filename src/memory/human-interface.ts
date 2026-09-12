// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest, MemoryOperationResult } from "../sdk/memory-operations";

export const MEMORY_SERVICE_HELP = `Portable memory service (private to your durable world account):
  memory service                         show service capabilities
  memory usage                           show your storage usage and limits
  memory remember <text>                 store a plain memory
  memory claim <subject> <predicate> <JSON scalar>
  memory relate <subject> <predicate> <entity ID>
  memory query <JSON filters>            exact symbolic query; {} lists records
  memory graph <subject>                 follow asserted relationships
  memory show <record ID>                inspect a full record and provenance
  memory sources <query>                 search original source text
  memory source <source ID>              read the first stable source range
  memory plan <task>                     inspect a bounded retrieval plan
  memory vocabulary                      inspect the current vocabulary
  memory api <JSON request>              full service operations
Symbols are exact and case-sensitive. Claims are assertions, not verified truth.
Example: memory claim project:marina status "active"
Example: memory query {"subject":"project:marina","predicate":"status"}`;

export function parseMemoryServiceCommand(args: string): MemoryOperationRequest | undefined {
  const match = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const sub = match?.[1]?.toLowerCase(),
    rest = match?.[2] ?? "";
  const json = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      throw new MemoryClientError(
        400,
        "invalid_json",
        "Expected valid JSON; quote string literals with double quotes",
      );
    }
  };
  switch (sub) {
    case "usage":
      return { operation: "usage" };
    case "service":
      return { operation: "capabilities" };
    case "api":
      return json(rest);
    case "remember":
      return { operation: "remember", input: { content: rest } };
    case "query":
      return { operation: "query", input: json(rest || "{}") };
    case "sources":
      return { operation: "source_search", input: { query: rest } };
    case "source":
      return { operation: "source_range", id: rest };
    case "plan":
      return { operation: "plan", input: { task: rest } };
    case "vocabulary":
      return { operation: "vocabulary" };
    case "graph":
      return { operation: "graph", input: { subject: rest } };
    case "show":
      return { operation: "get", id: rest };
    case "claim":
    case "relate": {
      const claim = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (!claim)
        throw new MemoryClientError(
          400,
          "invalid_input",
          `Usage: memory ${sub} <subject> <predicate> <object>`,
        );
      return {
        operation: "remember",
        input: {
          content: rest,
          claim: {
            subject: claim[1],
            predicate: claim[2],
            object:
              sub === "relate"
                ? { kind: "entity", id: claim[3] }
                : { kind: "literal", value: json(claim[3]!) },
          },
        },
      };
    }
    default:
      return undefined;
  }
}

export function formatMemoryOperation(result: MemoryOperationResult): string {
  if (!result.ok) return `Memory error (${result.error.code}): ${result.error.message}`;
  // Lossless JSON is readable by humans and safely consumable by tool callers.
  return `Memory service${result.space_id ? ` — space ${result.space_id}` : ""}\n${JSON.stringify(result.result, null, 2)}`;
}
