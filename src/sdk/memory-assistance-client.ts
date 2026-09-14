// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryAnswer } from "./memory-answer";
import {
  MEMORY_ASSISTANCE_CONTRACT,
  MEMORY_ASSISTANCE_READS,
  MEMORY_HELPER_INSTRUCTIONS,
  type MemoryAssistanceInput,
  type MemoryAssistanceJob,
  type MemoryAssistanceListInput,
  type MemoryAssistancePage,
} from "./memory-assistance";
import type { MarinaMemoryClient } from "./memory-client";
import { type MemoryOperationRequest, runMemoryOperation } from "./memory-operations";
import { type MemoryTaskOptions, runMemoryTask } from "./memory-task";

/** Same protocol over HTTP or a resident's correlated memoryService transport. */
export class MarinaMemoryAssistance {
  constructor(private dispatch: (request: MemoryOperationRequest) => Promise<unknown>) {}
  static http(client: MarinaMemoryClient) {
    return new MarinaMemoryAssistance((request) => runMemoryOperation(client, request));
  }
  create(space: string, input: MemoryAssistanceInput, key: string = crypto.randomUUID()) {
    return this.dispatch({
      operation: "assist_create",
      space_id: space,
      input: { ...input },
      key,
    }) as Promise<{ id: string }>;
  }
  jobs(input: MemoryAssistanceListInput = {}) {
    return this.dispatch({
      operation: "assist_jobs",
      input: { ...input },
    }) as Promise<MemoryAssistancePage>;
  }
  get(id: string) {
    return this.dispatch({ operation: "assist_get", id }) as Promise<MemoryAssistanceJob>;
  }
  cancel(id: string) {
    return this.dispatch({ operation: "assist_cancel", id });
  }
  claim(id: string, key: string = crypto.randomUUID()) {
    return this.dispatch({ operation: "assist_claim", id, key }) as Promise<{
      id: string;
      lease_token: string;
      lease_until: number;
    }>;
  }
  heartbeat(id: string, lease: string, key: string = crypto.randomUUID()) {
    return this.dispatch({
      operation: "assist_heartbeat",
      id,
      key,
      input: { lease_token: lease },
    }) as Promise<{ id: string; lease_until: number }>;
  }
  delegate(
    id: string,
    lease: string,
    input: Pick<MemoryAssistanceInput, "worker_id" | "role" | "task">,
    key: string = crypto.randomUUID(),
  ) {
    return this.dispatch({
      operation: "assist_delegate",
      id,
      key,
      input: { ...input, lease_token: lease },
    }) as Promise<{ id: string }>;
  }
  read(
    id: string,
    lease: string,
    request: MemoryOperationRequest,
    key: string = crypto.randomUUID(),
  ) {
    return this.dispatch({
      operation: "assist_read",
      id,
      key,
      input: { lease_token: lease, request },
    });
  }
  finish(id: string, lease: string, completion: MemoryAnswer, key: string = crypto.randomUUID()) {
    return this.dispatch({
      operation: "assist_finish",
      id,
      key,
      input: { lease_token: lease, completion },
    });
  }
  /** Optional bounded agent loop. `next` may call Marina's own model endpoint,
   * any other model, or a human. Storage never needs a particular model. */
  async work(id: string, options: Pick<MemoryTaskOptions, "next" | "signal" | "maxTurns">) {
    options.signal?.throwIfAborted();
    const job = await this.get(id);
    const claim = await this.claim(id);
    const result = await runMemoryTask({
      ...options,
      task: job.task!,
      space: job.space_id,
      contract: MEMORY_ASSISTANCE_CONTRACT,
      instructions: MEMORY_HELPER_INSTRUCTIONS[job.role],
      operations: [...MEMORY_ASSISTANCE_READS],
      next: async (messages, signal) => {
        await this.heartbeat(id, claim.lease_token);
        return options.next(messages, signal);
      },
      dispatch: (request) =>
        this.read(id, claim.lease_token, {
          operation: request.operation,
          ...(request.id ? { id: request.id } : {}),
          ...(request.input ? { input: request.input } : {}),
        }),
    });
    options.signal?.throwIfAborted();
    if (result.completion) await this.finish(id, claim.lease_token, result.completion);
    return result;
  }
}
