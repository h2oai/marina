// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../types";

// Env-overridable upper bound. Reasoning-heavy problems (competition math,
// multi-hop, debate-council orchestrations) can legitimately take minutes.
// Single passthrough substrates finish in seconds and aren't affected.
// Set to effectively off (10 min) so we don't bound correctness on wall time.
const DEFAULT_TIMEOUT_MS = Number.parseInt(
  process.env.HARNESS_TIMEOUT_MS ?? "600000",
  10,
);

export async function query(
  endpoint: string,
  model: string,
  messages: Message[],
  apiKey?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
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
      };
      const content = data.choices[0]?.message?.content;
      if (content === undefined) {
        throw new Error("API response missing choices[0].message.content");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
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
