// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional cross-encoder reranking: one call scores every (question,
 * document) pair, in place of a listwise LLM rerank. Off unless the operator
 * names an endpoint (`MARINA_RERANK_*`); Marina retrieves without one.
 *
 * Two request shapes cover the servers in use:
 * - `rerank` (default): `POST {url}` `{model, query, documents}` →
 *   `{results: [{index, relevance_score}]}` — Cohere, Jina, vLLM `/rerank`,
 *   TEI-compatible gateways, DeepInfra, OpenRouter.
 * - `nvidia`: `POST {url}` `{model, query: {text}, passages: [{text}]}` →
 *   `{rankings: [{index, logit}]}` — NVIDIA's hosted `/reranking` (Nemotron).
 *
 * The daily spend cap refuses a call before it is sent and a reported cost is
 * recorded as `search`, like a paid embedding.
 */

import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";

export interface CrossEncoder {
  /** Shown in traces and run labels (`rerank:<model>`). */
  name: string;
  /** One relevance score per document, in input order (higher is more relevant). */
  score(query: string, documents: readonly string[], signal?: AbortSignal): Promise<number[]>;
}

export type RerankFormat = "rerank" | "nvidia";

export interface RerankEndpointOptions {
  /** The full endpoint URL (e.g. https://api.example/v1/rerank). */
  url: string;
  model: string;
  apiKey?: string;
  format?: RerankFormat;
  timeoutMs?: number;
  /** Called before each request; a string refuses it (default: the daily spend cap). */
  refuse?: () => string | undefined;
  /** Called with a reported USD cost (default: recorded as `search`). */
  onCost?: (usd: number) => void;
  fetch?: typeof fetch;
}

/** A cross-encoder over an operator-configured HTTP endpoint. */
export function rerankEndpoint(opts: RerankEndpointOptions): CrossEncoder {
  const url = new URL(opts.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid rerank endpoint URL");
  if (!opts.model) throw new Error("A rerank model is required");
  const format = opts.format ?? "rerank";
  const doFetch = opts.fetch ?? fetch;
  const refuse = opts.refuse ?? (() => dailyCapRefusal());
  const onCost = opts.onCost ?? ((usd: number) => recordSpend("search", usd));
  return {
    name: `rerank:${opts.model}`,
    async score(query, documents, signal) {
      if (documents.length === 0) return [];
      const refused = refuse();
      if (refused) throw new Error(refused);
      const body =
        format === "nvidia"
          ? {
              model: opts.model,
              query: { text: query },
              passages: documents.map((text) => ({ text })),
            }
          : { model: opts.model, query, documents: [...documents] };
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          AbortSignal.timeout(opts.timeoutMs ?? 30_000),
          ...(signal ? [signal] : []),
        ]),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Rerank endpoint failed (${response.status})`);
      const data = (await response.json()) as Record<string, unknown>;
      const scores = parseScores(data, format, documents.length);
      const cost = Number((data.usage as { cost?: unknown } | undefined)?.cost);
      if (Number.isFinite(cost) && cost > 0) onCost(cost);
      return scores;
    },
  };
}

/** Scores by input index; every document must be scored exactly once. */
export function parseScores(
  data: Record<string, unknown>,
  format: RerankFormat,
  count: number,
): number[] {
  const rows = format === "nvidia" ? data.rankings : (data.results ?? data.data);
  if (!Array.isArray(rows)) throw new Error("Rerank reply has no results");
  const scores: (number | undefined)[] = new Array(count).fill(undefined);
  for (const row of rows as Record<string, unknown>[]) {
    const index = Number(row.index);
    const score = Number(format === "nvidia" ? row.logit : (row.relevance_score ?? row.score));
    if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isFinite(score))
      throw new Error("Rerank reply has an invalid row");
    scores[index] = score;
  }
  if (scores.some((s) => s === undefined)) throw new Error("Rerank reply left documents unscored");
  return scores as number[];
}

/** OpenRouter's rerank endpoint: one key reaches Cohere, Voyage, Qwen, Nemotron rerankers. */
export const OPENROUTER_RERANK_URL = "https://openrouter.ai/api/v1/rerank";

/** A vendor's own key, only ever sent to that vendor's host. */
function vendorRerankKey(url: string, env: NodeJS.ProcessEnv): string | undefined {
  const host = new URL(url).hostname;
  const byHost: Record<string, string> = {
    "openrouter.ai": "OPENROUTER_API_KEY",
    "api.cohere.com": "COHERE_API_KEY",
    "api.cohere.ai": "COHERE_API_KEY",
    "api.voyageai.com": "VOYAGE_API_KEY",
    "api.jina.ai": "JINA_API_KEY",
    "api.together.xyz": "TOGETHER_API_KEY",
    "api.deepinfra.com": "DEEPINFRA_API_KEY",
    "ai.api.nvidia.com": "NVIDIA_API_KEY",
  };
  const name = byHost[host];
  return name ? env[name]?.trim() || undefined : undefined;
}

/**
 * A cross-encoder for `model` on the operator's rerank endpoint — the way a
 * caller switches models per run (`web swarm rerank:<model>`) without a
 * restart. The endpoint and key are always operator configuration.
 */
export function crossEncoderFor(model: string, env: NodeJS.ProcessEnv = process.env): CrossEncoder {
  if (!model.trim()) throw new Error("A rerank model is required");
  const url = env.MARINA_RERANK_URL?.trim() || OPENROUTER_RERANK_URL;
  const format = (env.MARINA_RERANK_FORMAT?.trim().toLowerCase() || "rerank") as RerankFormat;
  if (format !== "rerank" && format !== "nvidia")
    throw new Error(`MARINA_RERANK_FORMAT must be rerank or nvidia (got "${format}")`);
  const apiKey = env.MARINA_RERANK_API_KEY?.trim() || vendorRerankKey(url, env);
  return rerankEndpoint({ url, model: model.trim(), format, ...(apiKey ? { apiKey } : {}) });
}

/**
 * The operator's default cross-encoder: `MARINA_RERANK_MODEL` (switching
 * models is changing this one variable), on `MARINA_RERANK_URL` — default
 * OpenRouter's rerank endpoint — or undefined when no model is set. The key is
 * `MARINA_RERANK_API_KEY`, else the endpoint vendor's own key (OpenRouter,
 * Cohere, Voyage, Jina, Together, DeepInfra, NVIDIA), never sent elsewhere.
 * A malformed configuration throws, so a typo is loud.
 */
export function crossEncoderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CrossEncoder | undefined {
  const model = env.MARINA_RERANK_MODEL?.trim();
  if (!model) {
    if (env.MARINA_RERANK_URL?.trim())
      throw new Error("MARINA_RERANK_URL is set but MARINA_RERANK_MODEL is not");
    return undefined;
  }
  return crossEncoderFor(model, env);
}
