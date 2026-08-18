// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../types";
import { query } from "./passthrough";

interface MemoryModeOptions {
  wsUrl: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  agentName?: string;
}

let MarinaAgent: typeof import("../../src/sdk/client").MarinaAgent | null = null;

async function getAgentClass() {
  if (!MarinaAgent) {
    const sdk = await import("../../src/sdk/client");
    MarinaAgent = sdk.MarinaAgent;
  }
  return MarinaAgent;
}

function topicFrom(messages: Message[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return lastUser.slice(0, 200).replace(/\s+/g, " ").trim();
}

function perceptionsToText(perceptions: { data: Record<string, unknown> }[]): string {
  return perceptions
    .map((p) => (typeof p.data?.text === "string" ? (p.data.text as string) : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

function isEmptyRecall(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || /no matching memories found/i.test(t);
}

export async function queryWithMemory(
  opts: MemoryModeOptions,
  messages: Message[],
  preloadNotes?: string[],
): Promise<string> {
  const AgentClass = await getAgentClass();
  const agent = new AgentClass(opts.wsUrl);
  const agentName = opts.agentName ?? `BenchAgent-${Date.now()}`;

  try {
    await agent.connect(agentName);

    if (preloadNotes) {
      for (const noteText of preloadNotes) {
        await agent.note(noteText);
      }
    }

    // Ask the agent to recall relevant context, then inject into the LLM call.
    const topic = topicFrom(messages);
    let augmented = messages;
    if (topic.length > 0) {
      const recalled = perceptionsToText(await agent.recall(topic));
      if (!isEmptyRecall(recalled)) {
        augmented = [
          {
            role: "system",
            content: `Relevant prior knowledge from your memory:\n${recalled}`,
          },
          ...messages,
        ];
      }
    }

    return await query(opts.endpoint, opts.model, augmented, opts.apiKey);
  } finally {
    try {
      await agent.quit();
    } catch {
      // Agent may already be disconnected
    }
  }
}

export async function runRetentionTask(
  opts: MemoryModeOptions,
  teach: string,
  distractors: string[],
  recallQuestion: string,
): Promise<string> {
  const AgentClass = await getAgentClass();
  const agent = new AgentClass(opts.wsUrl);
  const agentName = `BenchRetention-${Date.now()}`;

  try {
    await agent.connect(agentName);

    // Phase 1: Teach — store as note
    await agent.note(`${teach} importance 8`);

    // Phase 2: Distract — send unrelated queries through model API
    for (const d of distractors) {
      await query(opts.endpoint, opts.model, [{ role: "user", content: d }], opts.apiKey);
    }

    // Phase 3: Recall — fetch relevant memory then inject into the LLM call
    const recalled = perceptionsToText(await agent.recall(recallQuestion));
    const messages: Message[] = [];
    if (!isEmptyRecall(recalled)) {
      messages.push({
        role: "system",
        content: `Relevant prior knowledge from your memory:\n${recalled}`,
      });
    }
    messages.push({ role: "user", content: recallQuestion });
    return await query(opts.endpoint, opts.model, messages, opts.apiKey);
  } finally {
    try {
      await agent.quit();
    } catch {
      // Agent may already be disconnected
    }
  }
}

export async function runRetentionTaskPassthrough(
  opts: MemoryModeOptions,
  teach: string,
  distractors: string[],
  recallQuestion: string,
): Promise<string> {
  const messages: Message[] = [];

  // Phase 1: Teach
  messages.push({ role: "user", content: `Remember this: ${teach}` });
  messages.push({
    role: "assistant",
    content: "I'll remember that.",
  });

  // Phase 2: Distract
  for (const d of distractors) {
    messages.push({ role: "user", content: d });
    messages.push({
      role: "assistant",
      content: "Noted.",
    });
  }

  // Phase 3: Recall
  messages.push({ role: "user", content: recallQuestion });
  return await query(opts.endpoint, opts.model, messages, opts.apiKey);
}

export function chunkText(text: string, maxChunkSize = 500): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${sentence} `;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}
