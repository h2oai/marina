// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest, MemoryOperationResult } from "../sdk/memory-operations";

export const MEMORY_SERVICE_HELP = `Portable memory service (private to your durable world account):
  memory service                         show service capabilities
  memory usage                           show your storage usage and limits
  memory transfers [JSON filters]         discover your staged imports
  memory transfer <ID>                    inspect an import
  memory transfer-abort <ID>              explicitly discard unpublished staging
  memory review [JSON filters]            review stale/competing assertions
  memory reaffirm <ID> <version> <JSON pins>
                                         reaffirm after explicitly reviewing premises
  memory remember <text>                 store a plain memory
  memory claim <subject> <predicate> <JSON scalar>
  memory relate <subject> <predicate> <entity ID>
  memory query <JSON filters>            exact symbolic query; {} lists records
  memory join <JSON patterns>            typed joins with supporting record versions
  memory rule-save <JSON request>        author or revise a bounded symbolic rule
  memory rule-run <JSON request>         inspect conclusions without saving them
  memory rule-materialize <JSON request> explicitly save dependency-pinned conclusions
  memory graph <subject>                 follow asserted relationships
  memory show <record ID>                inspect a full record and provenance
  memory sources <query>                 search original source text
  memory source <source ID> [start end]  read a stable UTF-8 byte range
  memory federation                     list explicitly mounted peers
  memory across <JSON query>            search explicitly selected peers
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
    case "transfers":
      return { operation: "transfers", input: json(rest || "{}") };
    case "transfer":
      return { operation: "transfer_status", id: rest };
    case "transfer-abort":
      return { operation: "transfer_abort", id: rest };
    case "federation":
      return { operation: "federation_mounts" };
    case "across":
      return { operation: "federated_search", input: json(rest) };
    case "review":
      return { operation: "review", input: json(rest || "{}") };
    case "reaffirm": {
      const fields = rest.match(/^(\S+)\s+(\d+)\s+([\s\S]+)$/);
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          "Use: memory reaffirm ID VERSION JSON_DEPENDENCY_VERSIONS",
        );
      return {
        operation: "reaffirm",
        id: fields[1],
        input: { expected_version: Number(fields[2]), dependency_versions: json(fields[3]!) },
      };
    }
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
    case "join":
      return { operation: "join", input: json(rest) };
    case "rule-save":
      return { operation: "save_rule", input: json(rest) };
    case "rule-run":
      return { operation: "run_rule", input: json(rest) };
    case "rule-materialize":
      return { operation: "materialize_rule", input: json(rest) };
    case "sources":
      return { operation: "source_search", input: { query: rest } };
    case "source": {
      const fields = rest.match(/^(\S+)(?:\s+(\d+)(?:\s+(\d+))?)?$/);
      if (!fields)
        throw new MemoryClientError(400, "invalid_input", "Use: memory source ID [START [END]]");
      return {
        operation: "source_range",
        id: fields[1],
        input: {
          ...(fields[2] ? { start: Number(fields[2]) } : {}),
          ...(fields[3] ? { end: Number(fields[3]) } : {}),
        },
      };
    }
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
