// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MemoryOperationRequest, MemoryOperationResult } from "../sdk/memory-operations";
import type { MemorySpace } from "../sdk/memory-types";

type Run = (
  request: MemoryOperationRequest,
  extra: { signal?: AbortSignal },
) => Promise<{ structuredContent?: Record<string, unknown> }>;

/** One configured resource per connection. Polling observes HTTP/world writes too;
 * denied or failed reauthorization ends the subscription without disclosing data. */
export function registerMemoryResources(
  mcp: McpServer,
  profile: "native" | "knowledge-graph",
  runCmd: Run,
) {
  const uri = profile === "knowledge-graph" ? "memory://knowledge-graph" : "memory://space";
  let timer: ReturnType<typeof setInterval> | undefined,
    generation = -1,
    epoch = 0,
    polling = false;
  const cancel = new AbortController();
  const read = async (request: MemoryOperationRequest, signal?: AbortSignal) => {
    const response = await runCmd(request, {
      signal: AbortSignal.any([cancel.signal, ...(signal ? [signal] : [])]),
    });
    const result = response.structuredContent as MemoryOperationResult | undefined;
    if (!result?.ok)
      throw new McpError(
        -32002,
        "Memory resource unavailable",
        result && !result.ok ? { code: result.error.code } : undefined,
      );
    return result.result;
  };
  const stop = () => {
    epoch++;
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  mcp.registerResource(
    profile === "knowledge-graph" ? "knowledge-graph" : "memory-space",
    uri,
    {
      title: profile === "knowledge-graph" ? "Knowledge Graph" : "Memory Space",
      mimeType: "application/json",
      description:
        profile === "knowledge-graph"
          ? "Authored entities, observations and relationships in the configured space."
          : "Up to 20 current assertions. Use memory_query and source_range for further evidence.",
    },
    async (_url, extra) => {
      const result = await read(
        profile === "knowledge-graph"
          ? { operation: "knowledge_graph", input: { action: "read_graph" } }
          : { operation: "query", input: { limit: 20 } },
        extra.signal,
      );
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 1048576)
        throw new McpError(-32002, "Memory resource exceeds 1 MiB; use paged tools");
      return { contents: [{ uri, mimeType: "application/json", text }] };
    },
  );
  mcp.server.registerCapabilities({ resources: { subscribe: true } });
  mcp.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
    if (request.params.uri !== uri) throw new McpError(-32002, "Unknown memory resource");
    stop();
    const ticket = epoch;
    const current = (await read({ operation: "space" }, extra.signal)) as MemorySpace;
    if (ticket !== epoch || cancel.signal.aborted) return {};
    generation = current.generation;
    timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void (async () => {
        try {
          const current = (await read({ operation: "space" })) as MemorySpace;
          if (ticket !== epoch) return;
          if (current.generation !== generation) {
            generation = current.generation;
            await mcp.server.sendResourceUpdated({ uri });
          }
        } catch {
          if (ticket === epoch) stop();
        } finally {
          polling = false;
        }
      })();
    }, 1000);
    timer.unref();
    return {};
  });
  mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    if (request.params.uri !== uri) throw new McpError(-32002, "Unknown memory resource");
    stop();
    return {};
  });
  const close = mcp.server.onclose;
  mcp.server.onclose = () => {
    stop();
    cancel.abort();
    close?.();
  };
}
