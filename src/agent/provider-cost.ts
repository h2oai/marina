// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-reported cost for agent turns on models pi-ai cannot price.
 *
 * pi-ai prices a turn from its bundled catalog. A model it does not list (an
 * OpenRouter id newer than the catalog, e.g. `openrouter/openai/gpt-6-luna`)
 * is synthesized with a $0 price, so the turn's own `usage.cost.total` is 0
 * and the daily spend ledger never saw it. OpenRouter (and other
 * OpenAI-compatible aggregators) report the real charge as `usage.cost` on the
 * reply — the final SSE chunk of a stream, or the JSON body — which pi-ai's
 * usage parser drops. {@link sniffProviderCost} passes the body through
 * unchanged while reading that field, so the adapter can record what the
 * provider actually billed.
 */

/** USD per million tokens, the shape of pi-ai's `Model.cost`. */
export interface TokenPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * List prices for the models Marina itself defaults to when pi-ai's bundled
 * catalog does not list them yet (OpenRouter list price, checked 2026-09-28).
 * Keyed by the bare model id (the provider prefix is stripped, so
 * `openai/gpt-6-luna` and `openrouter/openai/gpt-6-luna` share a row). Only
 * ids Marina chooses by default belong here — anything else is priced by the
 * catalog or by the provider's reported `usage.cost`, never guessed.
 */
const DEFAULT_MODEL_PRICES: Record<string, TokenPrice> = {
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
};

/** A default model's list price, or undefined (never a fabricated $0). */
export function defaultModelPrice(modelId: string): TokenPrice | undefined {
  const bare = (modelId.split("/").pop() ?? modelId).toLowerCase();
  return DEFAULT_MODEL_PRICES[bare];
}

type PricedModel = { cost?: { input?: number; output?: number } };

/** True when the model's own catalog price is zero (synthesized or unlisted). */
export function isUnpricedModel(model: PricedModel | undefined): boolean {
  const cost = model?.cost;
  return !cost || (!cost.input && !cost.output);
}

/** `usage.cost` (number, or `{ total }`) from one parsed reply/chunk. */
export function usageCostOf(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const raw = (usage as { cost?: unknown }).cost;
  const value =
    typeof raw === "number"
      ? raw
      : raw && typeof raw === "object"
        ? (raw as { total?: unknown }).total
        : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Cap on a buffered non-streaming body; a larger one is passed through unread. */
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Return a response whose body is byte-identical to `response`'s, reporting
 * the provider's `usage.cost` through `onCost` as the body is read (before
 * the consumer sees the end of the stream, so the cost is known by the time
 * the turn ends). Errors, empty bodies and replies without a cost are passed
 * through untouched.
 */
export function sniffProviderCost(response: Response, onCost: (usd: number) => void): Response {
  if (!response.ok || !response.body) return response;
  const contentType = response.headers.get("content-type") ?? "";
  const isStream = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "";
  let size = 0;
  let overflow = false;
  const report = (text: string): void => {
    try {
      const cost = usageCostOf(JSON.parse(text));
      if (cost !== undefined) onCost(cost);
    } catch {
      // allow-empty-catch: not every SSE line is JSON (keep-alives, [DONE]).
    }
  };
  const scanLines = (flush: boolean): void => {
    const lines = pending.split("\n");
    pending = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data && data !== "[DONE]" && data.includes('"cost"')) report(data);
    }
  };
  const sniffer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (overflow) return;
      pending += decoder.decode(chunk, { stream: true });
      if (isStream) {
        scanLines(false);
      } else {
        size += chunk.byteLength;
        if (size > MAX_JSON_BODY_BYTES) {
          overflow = true;
          pending = "";
        }
      }
    },
    flush() {
      if (overflow) return;
      pending += decoder.decode();
      if (isStream) scanLines(true);
      else if (pending.includes('"cost"')) report(pending);
    },
  });
  return new Response(response.body.pipeThrough(sniffer), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
