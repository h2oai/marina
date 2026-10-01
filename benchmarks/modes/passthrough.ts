// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CallUsage, Message } from "../types";

// Env-overridable upper bound. Reasoning-heavy problems (competition math,
// multi-hop, debate-council orchestrations) can legitimately take minutes.
// Single passthrough substrates finish in seconds and aren't affected.
// Set to effectively off (10 min) so we don't bound correctness on wall time.
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.HARNESS_TIMEOUT_MS ?? "600000", 10);

/** Header a Marina `/v1` passthru sets with the upstream dollar cost of the call. */
const MARINA_COST_HEADER = "x-marina-cost-usd";

/**
 * Usage of one completion as the endpoint reported it. Nothing is estimated:
 * a field the endpoint did not report stays undefined. Cost comes from Marina's
 * `x-marina-cost-usd` header, else from `usage.cost` (OpenRouter's accounting).
 */
export function usageFromResponse(
  body: { usage?: Record<string, unknown> } | undefined,
  costHeader: string | null,
): CallUsage {
  const usage = body?.usage ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const headerCost = costHeader !== null ? Number.parseFloat(costHeader) : Number.NaN;
  const costUsd = Number.isFinite(headerCost) ? headerCost : num(usage.cost);
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    costUsd,
  };
}

export interface QueryResult {
  content: string;
  usage: CallUsage;
}

/** One chat completion, with the usage and cost the endpoint reported. */
export async function queryWithUsage(
  endpoint: string,
  model: string,
  messages: Message[],
  apiKey?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<QueryResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const maxAttempts = 6;
  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, temperature: 0 }),
        signal: controller.signal,
      });

      if (resp.status === 429 && attempt < maxAttempts) {
        await resp.text().catch(() => "");
        const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`API error ${resp.status}: ${text}`);
      }
      const data = (await resp.json()) as {
        choices: { message: { content: string } }[];
        usage?: Record<string, unknown>;
      };
      const content = data.choices[0]?.message?.content;
      if (content === undefined) {
        throw new Error("API response missing choices[0].message.content");
      }
      return { content, usage: usageFromResponse(data, resp.headers.get(MARINA_COST_HEADER)) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function query(
  endpoint: string,
  model: string,
  messages: Message[],
  apiKey?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return (await queryWithUsage(endpoint, model, messages, apiKey, timeoutMs)).content;
}

export async function queryMultiTurn(
  endpoint: string,
  model: string,
  turns: string[],
  apiKey?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  const messages: Message[] = [];
  const responses: string[] = [];

  for (const turn of turns) {
    messages.push({ role: "user", content: turn });
    const response = await query(endpoint, model, messages, apiKey, timeoutMs);
    messages.push({ role: "assistant", content: response });
    responses.push(response);
  }

  return responses;
}
