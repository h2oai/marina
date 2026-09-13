// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { BaseStore, type Operation, type OperationResults } from "@langchain/langgraph-checkpoint";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import { retryMemoryOperation } from "../../src/sdk/memory-retry";

/** LangGraph BaseStore using Marina's explicit langgraph-store-json-v1 profile.
 * Namespace CRUD/filtering only: semantic queries and embedding indexes are refused. */
export class MarinaStore extends BaseStore {
  constructor(
    readonly client: MarinaMemoryClient,
    readonly space: string,
  ) {
    super();
  }
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    if (!operations.length) return [] as unknown as OperationResults<Op>;
    const key = crypto.randomUUID();
    const response = await retryMemoryOperation(() =>
      this.client.request<{ results: unknown[] }>(
        `/spaces/${encodeURIComponent(this.space)}/json_store`,
        "POST",
        { operations },
        key,
      ),
    );
    const decode = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(decode);
      if (value && typeof value === "object" && "createdAt" in value && "updatedAt" in value) {
        const item = value as Record<string, unknown>;
        return {
          ...item,
          createdAt: new Date(item.createdAt as string),
          updatedAt: new Date(item.updatedAt as string),
        };
      }
      return value;
    };
    return response.results.map((value, i) =>
      Object.hasOwn(operations[i]!, "value") ? undefined : decode(value),
    ) as OperationResults<Op>;
  }
}
export { MarinaMemoryClient };
