// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type MarinaMemoryClient, MemoryClientError } from "./memory-client";

export const MEMORY_OPERATIONS = [
  "assist_create",
  "assist_jobs",
  "assist_get",
  "assist_claim",
  "assist_heartbeat",
  "assist_read",
  "assist_finish",
  "assist_cancel",
  "assist_delegate",
  "adopt",
  "capabilities",
  "usage",
  "federation_mounts",
  "federated_search",
  "federated_read",
  "export_bundle",
  "import_bundle",
  "knowledge_graph",
  "export_page",
  "transfer_begin",
  "transfer_status",
  "transfers",
  "transfer_page",
  "transfer_commit",
  "transfer_abort",
  "acknowledge",
  "review",
  "reaffirm",
  "resolve",
  "cache_delete",
  "cache_get",
  "cache_put",
  "me",
  "spaces",
  "create_space",
  "space",
  "remember",
  "get",
  "revise",
  "query",
  "join",
  "json_store",
  "save_rule",
  "run_rule",
  "materialize_rule",
  "graph",
  "search",
  "context",
  "capture",
  "capture_batch",
  "sources",
  "source_headers",
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
  if (operation === "assist_jobs") {
    const params = new URLSearchParams();
    for (const key of ["open", "limit", "cursor"] as const)
      if (request.input?.[key] !== undefined) params.set(key, String(request.input[key]));
    return client.request(`/assistance?${params}`);
  }
  if (operation.startsWith("assist_") && operation !== "assist_create") {
    const base = `/assistance/${field(request.id, "id")}`;
    return operation === "assist_get"
      ? client.request(base)
      : client.request(`${base}/${operation.slice(7)}`, "POST", request.input ?? {}, request.key);
  }
  if (operation === "adopt") {
    // Explicit space ⇒ target route; otherwise the job's own space decides.
    const input: Record<string, unknown> = {
      ...(request.input ?? {}),
      ...(request.id ? { job_id: request.id } : {}),
    };
    const target = request.space_id ?? (input.target_space_id as string | undefined);
    return target
      ? client.request(`/spaces/${field(target, "space_id")}/adopt`, "POST", input, request.key)
      : client.request(
          `/assistance/${field(input.job_id, "job_id")}/adopt`,
          "POST",
          input,
          request.key,
        );
  }
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
    case "assist_create":
      return client.request(`${base}/assistance`, "POST", input, request.key);
    case "save_rule":
      return client.request(`${base}/rules`, "POST", input, request.key);
    case "run_rule":
      return client.request(`${base}/rules/run`, "POST", input);
    case "materialize_rule":
      return client.request(`${base}/rules/materialize`, "POST", input, request.key);
    case "federation_mounts":
      return client.request(`${base}/federation_mounts`);
    case "knowledge_graph":
      return client.request(`${base}/knowledge_graph`, "POST", input, request.key);
    case "federated_search":
      return client.request(`${base}/federated_search`, "POST", input);
    case "federated_read":
      return client.request(`${base}/federated_read`, "POST", input);
    case "export_bundle":
      return client.request(`${base}/bundle`);
    case "export_page":
      return client.request(
        `${base}/transfer${input?.cursor === undefined ? "" : `?cursor=${field(input.cursor, "cursor")}`}`,
      );
    case "transfer_begin":
      return client.request(`${base}/transfers`, "POST", input, request.key);
    case "transfer_status":
      return client.request(`${base}/transfers/${field(request.id, "id")}`);
    case "transfers": {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input ?? {}))
        if (value !== undefined) params.set(key, String(value));
      return client.request(`${base}/transfers?${params}`);
    }
    case "transfer_page":
      return client.request(
        `${base}/transfers/${field(request.id, "id")}/pages`,
        "POST",
        input,
        request.key,
      );
    case "transfer_commit":
      return client.request(
        `${base}/transfers/${field(request.id, "id")}/commit`,
        "POST",
        input,
        request.key,
      );
    case "transfer_abort":
      return client.request(
        `${base}/transfers/${field(request.id, "id")}/abort`,
        "POST",
        {},
        request.key,
      );
    case "import_bundle":
      return client.request(`${base}/bundle`, "POST", input, request.key);
    case "acknowledge":
      return client.request(`${base}/acknowledge`, "POST", input);
    case "review":
      return client.request(`${base}/review`, "POST", input ?? {});
    case "reaffirm":
      return client.request(`${base}/reaffirm`, "POST", { ...input, id: request.id }, request.key);
    case "resolve":
      return client.request(`${base}/resolve`, "POST", { ...input, id: request.id }, request.key);
    case "cache_delete":
      return client.request(`${base}/cache/delete`, "POST", input, request.key);
    case "cache_get":
      return client.request(`${base}/cache/get`, "POST", input);
    case "cache_put":
      return client.request(`${base}/cache/put`, "POST", input, request.key);
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
    case "source_headers":
    case "sources": {
      const params = new URLSearchParams();
      for (const name of ["after", "limit"])
        if (input?.[name] !== undefined) params.set(name, String(input[name]));
      return client.request(`${base}/${operation}?${params}`);
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
