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
 * List prices for current models that pi-ai's bundled catalog does not list
 * yet (OpenRouter list prices, checked 2026-09-28) — Marina's own defaults
 * plus the current frontier and arena models, so the daily spend cap sees
 * them. Keyed by the bare model id (the provider prefix is stripped, so
 * `openai/gpt-6-luna` and `openrouter/openai/gpt-6-luna` share a row). Other
 * ids are priced by the catalog, by the provider's reported `usage.cost`, or
 * by {@link openRouterModelPrice} — never guessed.
 */
const DEFAULT_MODEL_PRICES: Record<string, TokenPrice> = {
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Official OpenAI model page, checked 2026-10-08 (cache writes are 1.25x input).
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  "claude-sonnet-5.5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-fable-5.1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "deepseek-v4-pro-0813": { input: 0.3942, output: 4.2, cacheRead: 0.3153, cacheWrite: 0 },
  "deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
};

/** A default model's list price, or undefined (never a fabricated $0). */
export function defaultModelPrice(modelId: string): TokenPrice | undefined {
  const bare = (modelId.split("/").pop() ?? modelId).toLowerCase();
  // Anthropic's own API spells versions with dashes (`claude-opus-5-5`) where
  // OpenRouter uses dots (`claude-opus-5.5`): both are the same model.
  return DEFAULT_MODEL_PRICES[bare] ?? DEFAULT_MODEL_PRICES[dottedVersion(bare)];
}

/** `claude-opus-5-5` → `claude-opus-5.5` (a trailing `<major>-<minor>` version only). */
function dottedVersion(id: string): string {
  return id.replace(/-(\d{1,2})-(\d{1,2})$/, "-$1.$2");
}

type PricedModel = { cost?: { input?: number; output?: number } };

/** Token counts as pi-ai reports them on a completion. */
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** USD for `usage` at `price` (per million tokens). */
export function costFromTokens(price: TokenPrice, usage: TokenUsage): number {
  return (
    ((usage.input ?? 0) * price.input +
      (usage.output ?? 0) * price.output +
      (usage.cacheRead ?? 0) * price.cacheRead +
      (usage.cacheWrite ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_PRICES_TTL_MS = 6 * 60 * 60_000;
let openRouterPrices: { at: number; prices: Promise<Map<string, TokenPrice>> } | undefined;

/**
 * OpenRouter's own list price for a model (`provider/model`, with or without
 * an `openrouter/` prefix), from its public catalog — fetched once and cached
 * for six hours through the SSRF guard. Undefined when the catalog cannot be
 * read or does not list the model; callers then keep whatever they had.
 */
export async function openRouterModelPrice(
  modelId: string,
  fetcher: (url: string) => Promise<Response> = async (url) => {
    const { guardedFetch } = await import("../net/url-guard");
    return guardedFetch(url, { signal: AbortSignal.timeout(20_000) });
  },
  now = Date.now(),
): Promise<TokenPrice | undefined> {
  if (!openRouterPrices || now - openRouterPrices.at > OPENROUTER_PRICES_TTL_MS) {
    const prices = (async () => {
      const map = new Map<string, TokenPrice>();
      try {
        const res = await fetcher(OPENROUTER_MODELS_URL);
        if (!res.ok) return map;
        const body = (await res.json()) as {
          data?: Array<{ id?: string; pricing?: Record<string, string | undefined> }>;
        };
        const perM = (v: string | undefined) => {
          const n = Number(v ?? 0);
          return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0;
        };
        for (const m of body.data ?? []) {
          if (!m.id || !m.pricing) continue;
          map.set(m.id.toLowerCase(), {
            input: perM(m.pricing.prompt),
            output: perM(m.pricing.completion),
            cacheRead: perM(m.pricing.input_cache_read),
            cacheWrite: perM(m.pricing.input_cache_write),
          });
        }
      } catch {
        // Pricing is best effort: an unreachable catalog leaves the map empty.
      }
      return map;
    })();
    openRouterPrices = { at: now, prices };
  }
  const id = modelId.toLowerCase().replace(/^openrouter\//, "");
  const price = (await openRouterPrices.prices).get(id);
  return price && (price.input > 0 || price.output > 0) ? price : undefined;
}

/** Test seam. */
export function resetOpenRouterPricesForTests(): void {
  openRouterPrices = undefined;
}

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
