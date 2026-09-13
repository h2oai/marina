// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Independent caller, fed a task on stdin. No fixture or database access. */
import { PlatformMemoryBackend } from "../../src/agent/memory-platform";
import { MarinaClient } from "../../src/sdk/client";
import type { MemoryAnswerContract } from "../../src/sdk/memory-answer";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import { expandMemoryQuery, type MemoryQueryVocabulary } from "../../src/sdk/memory-expansion";
import { type MemoryOperationRequest, runMemoryOperation } from "../../src/sdk/memory-operations";
import { retryMemoryOperation } from "../../src/sdk/memory-retry";
import { runMemoryTask } from "../../src/sdk/memory-task";

const input = JSON.parse(await Bun.stdin.text()) as {
  task: string;
  contract: MemoryAnswerContract;
  instructions?: string;
  operations: MemoryOperationRequest["operation"][];
  maxTurns?: number;
  expansionVocabulary?: MemoryQueryVocabulary;
};
const http = new MarinaMemoryClient(
  process.env.MARINA_MEMORY_URL!,
  process.env.MARINA_MEMORY_TOKEN!,
);
const resident = process.env.MARINA_RESIDENT_URL
  ? new MarinaClient(process.env.MARINA_RESIDENT_URL, {
      autoReconnect: false,
      pingInterval: 0,
      commandDrainTimeout: 1,
    })
  : undefined;
const platform = resident ? new PlatformMemoryBackend(resident) : undefined;
const started = performance.now();
const usage: unknown[] = [];
const journal: unknown[] = [{ role: "user", content: input.task }];
try {
  if (resident) await resident.connect(process.env.MARINA_RESIDENT_NAME!);
  if (platform) await platform.journalMessage(journal[0]);
  const outcome = await runMemoryTask({
    ...input,
    space: process.env.MARINA_MEMORY_SPACE!,
    maxTurns: input.maxTurns ?? 20,
    maxRepairs: 3,
    signal: AbortSignal.timeout(240000),
    next: async (messages, signal) => {
      // Native function calls expose real capabilities to existing models. The
      // portable loop remains model-neutral and validates the same envelopes.
      const wire: Record<string, unknown>[] = [];
      for (const [index, message] of messages.entries()) {
        if (message.role === "assistant") {
          let action: Record<string, unknown>;
          try {
            action = JSON.parse(message.content);
          } catch {
            wire.push({ ...message });
            continue;
          }
          wire.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `step_${index}`,
                type: "function",
                function: {
                  name: action.operation ? "memory_operation" : "submit_answer",
                  arguments: message.content,
                },
              },
            ],
          });
        } else if (
          message.role === "user" &&
          wire.at(-1)?.role === "assistant" &&
          wire.at(-1)?.tool_calls
        ) {
          wire.push({ role: "tool", tool_call_id: `step_${index - 1}`, content: message.content });
        } else wire.push({ ...message });
      }
      const response = await fetch(`${process.env.MARINA_EVAL_ROUTER_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MARINA_EVAL_ROUTER_TOKEN}`,
        },
        body: JSON.stringify({
          model: "marina/default",
          temperature: 0,
          reasoning_effort: "none",
          max_completion_tokens: 1500,
          messages: wire,
          parallel_tool_calls: false,
          tool_choice: "required",
          tools: [
            {
              type: "function",
              function: {
                name: "memory_operation",
                description:
                  "Execute an authenticated Marina memory operation. Operations are available now through this function; use the documented payloads.",
                parameters: {
                  type: "object",
                  properties: {
                    operation: { type: "string", enum: input.operations },
                    id: { type: "string" },
                    input: { type: "object", additionalProperties: true },
                  },
                  required: ["operation"],
                  additionalProperties: false,
                },
              },
            },
            {
              type: "function",
              function: {
                name: "submit_answer",
                description:
                  "Submit the final answer for contract/evidence validation, or explicitly abstain with a reason. A rejected answer can be repaired.",
                parameters: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["answered", "abstained"] },
                    answer: input.contract.schema,
                    citations: {
                      type: "array",
                      items: { type: "object", additionalProperties: true },
                    },
                    reason: { type: "string" },
                  },
                  required: ["status"],
                  additionalProperties: false,
                },
              },
            },
          ],
        }),
        signal,
      });
      if (!response.ok) throw new Error(`Router HTTP ${response.status}`);
      const result = (await response.json()) as {
        model: string;
        usage?: unknown;
        choices: {
          message: {
            content: string;
            tool_calls?: { function: { name: string; arguments: string } }[];
          };
        }[];
      };
      usage.push({ model: result.model, usage: result.usage });
      const reply = result.choices[0]?.message;
      const content =
        reply?.tool_calls?.length === 1
          ? reply.tool_calls[0]!.function.arguments
          : (reply?.content ?? "");
      const message = { role: "assistant", content };
      journal.push(message);
      if (platform) await platform.journalMessage(message, signal);
      return content;
    },
    dispatch: async (request, signal) => {
      if (
        process.env.MARINA_EVAL_CONDITION === "none" ||
        process.env.MARINA_EVAL_CONDITION === "direct"
      )
        return { results: [], error: "No persistent memory is available in this condition" };
      if (
        input.expansionVocabulary &&
        ["search", "source_search"].includes(request.operation) &&
        typeof request.input?.query === "string"
      ) {
        const expansion = expandMemoryQuery(request.input.query, input.expansionVocabulary);
        request = { ...request, input: { ...request.input, expansion: expansion.expansion } };
      }
      if (resident) {
        const reply = await resident.memoryService(request, undefined, signal);
        if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
        return reply.result;
      }
      return retryMemoryOperation(() => runMemoryOperation(http, request, undefined, signal), {
        signal,
      });
    },
  });
  if (platform) {
    await platform.archiveContext(
      journal,
      "Preserved live task conversation; consult original sources and named task checkpoint for resumption.",
    );
    await platform.saveCheckpoint({
      lastIntent: "Resume the named task checkpoint",
      qualification_status: outcome.status,
    });
  }
  console.log(
    JSON.stringify({
      ...outcome,
      usage,
      pid: process.pid,
      elapsed_ms: performance.now() - started,
      resident: Boolean(resident),
      resident_checkpoint: platform ? await platform.getCheckpoint() : null,
    }),
  );
} finally {
  resident?.disconnect();
}
