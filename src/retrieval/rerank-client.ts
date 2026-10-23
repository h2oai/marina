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

/**
 * The operator's cross-encoder (`MARINA_RERANK_URL` + `MARINA_RERANK_MODEL`),
 * or undefined when unset. `MARINA_RERANK_FORMAT=rerank|nvidia`; the key is
 * `MARINA_RERANK_API_KEY`. A malformed configuration throws, so a typo is loud
 * rather than a silent fallback.
 */
export function crossEncoderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CrossEncoder | undefined {
  const url = env.MARINA_RERANK_URL?.trim();
  const model = env.MARINA_RERANK_MODEL?.trim();
  if (!url && !model) return undefined;
  if (!url || !model)
    throw new Error("MARINA_RERANK_URL and MARINA_RERANK_MODEL must be set together");
  const format = (env.MARINA_RERANK_FORMAT?.trim().toLowerCase() || "rerank") as RerankFormat;
  if (format !== "rerank" && format !== "nvidia")
    throw new Error(`MARINA_RERANK_FORMAT must be rerank or nvidia (got "${format}")`);
  const apiKey = env.MARINA_RERANK_API_KEY?.trim();
  return rerankEndpoint({ url, model, format, ...(apiKey ? { apiKey } : {}) });
}
