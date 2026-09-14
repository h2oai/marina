// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryActor } from "../persistence/db-principals";
import { MEMORY_ASSISTANCE_READS } from "../sdk/memory-assistance";
import type { MemoryGraphQuery, MemoryQuery, MemorySourceSearch } from "../sdk/memory-types";
import type { MemoryService } from "./service";
import { integer, MemoryError, object, textValue } from "./service-types";

/** A helper's authority is one live request, not a reusable owner credential.
 * Both sides of an asynchronous read recheck the lease and delegation. */
export async function readAssistance(
  service: MemoryService,
  actor: MemoryActor,
  id: string,
  raw: unknown,
  key: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const body = object(raw);
  const request = object(body.request);
  if (
    !MEMORY_ASSISTANCE_READS.includes(request.operation as never) ||
    Object.keys(request).some((name) => !["operation", "id", "input"].includes(name))
  )
    throw new MemoryError(
      400,
      "assistance_read_only",
      "Use an allowed read operation; identity and space are bound by the request",
    );
  const input = request.input === undefined ? {} : object(request.input);
  if (request.operation === "query" && input.query !== undefined)
    throw new MemoryError(
      400,
      "assistance_symbolic_query",
      "query uses exact subject/predicate/object filters, not text. For text use search or source_search with input.query",
    );
  if (["get", "source_range"].includes(String(request.operation)) && !request.id)
    throw new MemoryError(
      400,
      "assistance_read_id_required",
      `For ${request.operation}, put the record/source ID in request.id alongside request.operation, not inside request.input`,
    );
  const repo = service.repository;
  const binding = repo.assistance.beginRead(actor, id, body, key);
  const principal = binding.actor,
    space = binding.space;
  const limit = integer(input.limit ?? 10, "limit", 1, 20);
  let result: unknown;
  switch (request.operation) {
    case "search":
      result = await service.search(
        principal,
        space,
        {
          query: textValue(input.query, "query", 8192),
          limit,
          mode: "lexical",
          ...(input.subject === undefined
            ? {}
            : { subject: textValue(input.subject, "subject", 256) }),
        },
        signal,
      );
      break;
    case "query":
      result = repo.query(principal, space, { ...input, limit } as MemoryQuery);
      break;
    case "graph":
      result = repo.graph(principal, space, {
        ...input,
        subject: textValue(input.subject, "subject", 256),
        limit,
        max_depth: integer(input.max_depth ?? 2, "max_depth", 1, 3),
      } as MemoryGraphQuery);
      break;
    case "get":
      result = repo.read(principal, space, textValue(request.id, "id", 128));
      break;
    case "source_search": {
      result = repo.sourceSearch(
        principal,
        space,
        {
          query: textValue(input.query, "query", 8192),
          match: input.match as MemorySourceSearch["match"],
          limit,
        },
        true,
      );
      break;
    }
    case "source_range": {
      const source = textValue(request.id, "id", 128);
      if (repo.assistance.isInputSource(space, source))
        throw new MemoryError(
          400,
          "request_is_not_evidence",
          "Assistance instructions are not evidence for their own answer",
        );
      const start = integer(input.start ?? 0, "start", 0, Number.MAX_SAFE_INTEGER);
      const end =
        input.end === undefined ? undefined : integer(input.end, "end", start, start + 16384);
      result = repo.sourceRange(
        principal,
        space,
        source,
        start,
        end,
        input.text_hash as string | undefined,
      );
      break;
    }
    case "vocabulary":
      result = repo.vocabulary(principal, space);
      break;
    case "review":
      result = repo.review(principal, space, { ...input, limit });
      break;
  }
  signal?.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(result)) > 131072)
    throw new MemoryError(
      413,
      "assistance_read_too_large",
      "Narrow the query or source range; response exceeds 128 KiB",
    );
  repo.assistance.witness(actor, id, body.lease_token, result);
  return result;
}
