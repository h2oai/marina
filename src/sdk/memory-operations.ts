// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type MarinaMemoryClient, MemoryClientError } from "./memory-client";

export const MEMORY_OPERATIONS = [
  "capabilities",
  "usage",
  "me",
  "spaces",
  "create_space",
  "space",
  "remember",
  "get",
  "revise",
  "query",
  "graph",
  "search",
  "context",
  "capture",
  "capture_batch",
  "sources",
  "source_search",
  "source_range",
  "vocabulary",
  "save_vocabulary",
  "plan",
  "execute_plan",
  "checkpoint",
  "save_checkpoint",
  "grant",
  "forget",
  "export",
  "job",
  "reindex",
] as const;
export interface MemoryOperationRequest {
  operation: (typeof MEMORY_OPERATIONS)[number];
  request_id?: string;
  space_id?: string;
  id?: string;
  input?: Record<string, unknown>;
  key?: string;
}
export type MemoryOperationResult =
  | { ok: true; result: unknown; space_id?: string }
  | {
      ok: false;
      error: { code: string; message: string; status: number; retry_after_ms?: number };
    };

/** Shared transport vocabulary. The service validates all operation payloads. */
export async function runMemoryOperation(
  client: MarinaMemoryClient,
  request: MemoryOperationRequest,
  defaultSpace?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal) client = client.withSignal(signal);
  signal?.throwIfAborted();
  if (!request || !MEMORY_OPERATIONS.includes(request.operation))
    throw new MemoryClientError(400, "invalid_operation", "Unknown memory operation");
  const field = (value: unknown, name: string) => {
    if (typeof value !== "string" || !value.length)
      throw new MemoryClientError(400, "invalid_input", `${name} must be a nonempty string`);
    return encodeURIComponent(value);
  };
  const operation = request.operation;
  if (operation === "usage") return client.usage();
  if (operation === "capabilities") return client.capabilities();
  if (operation === "me") return client.me();
  if (operation === "spaces") return client.spaces();
  if (operation === "create_space")
    return client.request("/spaces", "POST", request.input, request.key);
  const space = field(request.space_id ?? defaultSpace, "space_id");
  const base = `/spaces/${space}`;
  const input = request.input;
  switch (operation) {
    case "vocabulary":
      return client.request(
        `${base}/vocabulary${input?.version === undefined ? "" : `?version=${field(String(input.version), "version")}`}`,
      );
    case "save_vocabulary":
      return client.request(`${base}/vocabulary`, "POST", input, request.key);
    case "space":
      return client.request(base);
    case "remember":
      return client.request(`${base}/records`, "POST", input, request.key);
    case "revise":
      return client.request(
        `${base}/records/${field(request.id, "id")}`,
        "PATCH",
        input,
        request.key,
      );
    case "get":
      return client.request(
        `${base}/records/${field(request.id, "id")}${input?.version === undefined ? "" : `?version=${field(String(input.version), "version")}`}`,
      );
    case "capture":
      return client.request(`${base}/sources`, "POST", input, request.key);
    case "capture_batch":
      return client.request(`${base}/sources/batch`, "POST", input, request.key);
    case "sources": {
      const params = new URLSearchParams();
      for (const name of ["after", "limit"])
        if (input?.[name] !== undefined) params.set(name, String(input[name]));
      return client.request(`${base}/sources?${params}`);
    }
    case "source_range": {
      const params = new URLSearchParams();
      for (const name of ["start", "end", "text_hash"])
        if (input?.[name] !== undefined) params.set(name, String(input[name]));
      return client.request(`${base}/sources/${field(request.id, "id")}?${params}`);
    }
    case "checkpoint":
      return client.request(`${base}/checkpoints/${field(request.id, "id")}`);
    case "save_checkpoint":
      return client.request(
        `${base}/checkpoints/${field(request.id, "id")}`,
        "POST",
        input,
        request.key,
      );
    case "job":
      return client.request(`${base}/jobs/${field(request.id, "id")}`);
    case "export":
      return client.request(`${base}/export`);
    case "grant":
      return client.request(`${base}/grants`, "POST", input, request.key);
    default:
      return client.request(`${base}/${operation}`, "POST", input ?? {}, request.key);
  }
}

export function memoryOperationError(error: unknown): MemoryOperationResult {
  return {
    ok: false,
    error:
      error instanceof MemoryClientError
        ? {
            code: error.code,
            message: error.message,
            status: error.status,
            retry_after_ms: error.retryAfterMs,
          }
        : { code: "memory_failed", message: "Memory operation failed", status: 500 },
  };
}
