// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CallUsage, Message } from "../types";

// Env-overridable upper bound. Reasoning-heavy problems (competition math,
// multi-hop, debate-council orchestrations) can legitimately take minutes.
// Single passthrough substrates finish in seconds and aren't affected.
// Set to effectively off (10 min) so we don't bound correctness on wall time.
// Read per call, so `harness.ts --timeout` (which sets HARNESS_TIMEOUT_MS)
// applies to every adapter without threading a parameter through each one.
export function defaultTimeoutMs(): number {
  const v = Number.parseInt(process.env.HARNESS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

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
  timeoutMs = defaultTimeoutMs(),
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
        // Bun's fetch fails a socket idle for 5 minutes on its own
        // (BUN_CONFIG_HTTP_IDLE_TIMEOUT), before `timeoutMs` ever fires; a
        // non-streaming answer from a deliberating crew is silent until it
        // lands. The idle deadline follows the harness bound instead.
        timeout: timeoutMs,
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
        choices: { message: { content: string | null }; finish_reason?: string }[];
        usage?: Record<string, unknown>;
      };
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (content === undefined) {
        throw new Error("API response missing choices[0].message.content");
      }
      // A reasoning model that spends its whole budget thinking returns
      // `content: null`: an empty answer (scored wrong), never a crash.
      return {
        content: content ?? "",
        usage: usageFromResponse(data, resp.headers.get(MARINA_COST_HEADER)),
      };
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
  timeoutMs = defaultTimeoutMs(),
): Promise<string> {
  return (await queryWithUsage(endpoint, model, messages, apiKey, timeoutMs)).content;
}

export async function queryMultiTurn(
  endpoint: string,
  model: string,
  turns: string[],
  apiKey?: string,
  timeoutMs = defaultTimeoutMs(),
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
