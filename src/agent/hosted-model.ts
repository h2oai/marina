// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Api, Model } from "@earendil-works/pi-ai";
import { type CatalogFetch, hostedModelInfo } from "../net/model/hosted-catalog";
import { hostedBaseUrl, isHostedProvider } from "../net/model/hosted-providers";
import { piModels } from "./pi-models";

/** Literal model IDs always stay with the selected service, even if unlisted. */
export function hostedModel(provider: string, id: string): Model<Api> | undefined {
  if (!isHostedProvider(provider)) return;
  // Keep capabilities of an exact bundled match (not a sibling or another
  // service). The live service catalog remains the authority on token prices.
  const known = piModels.getModels(provider).find((model) => model.id === id);
  return {
    ...known,
    id,
    name: `${provider}/${id}`,
    provider,
    api: "openai-completions",
    baseUrl: hostedBaseUrl(provider),
    reasoning: known?.reasoning ?? false,
    input: known?.input ?? ["text"],
    contextWindow: known?.contextWindow ?? 32_768,
    maxTokens: known?.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: known?.compat ?? {
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
    },
  };
}

/** Refresh the selected service's rates before pi computes turn usage. */
export async function prepareHostedModel(
  model: Model<Api>,
  apiKey?: string,
  fetcher?: CatalogFetch,
  signal?: AbortSignal,
  options: { updateContext?: boolean } = {},
): Promise<void> {
  if (!isHostedProvider(model.provider) || !apiKey) return;
  const info = await hostedModelInfo(model.provider, model.id, apiKey, fetcher, signal);
  // Do not reuse a different credential's rates after key rotation or outage.
  model.cost = info?.pricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Running agents own their operator/adaptive context limits after startup.
  if (options.updateContext !== false && info?.contextLength)
    model.contextWindow = info.contextLength;
  if (info?.capabilities?.imageInput) model.input = ["text", "image"];
}
