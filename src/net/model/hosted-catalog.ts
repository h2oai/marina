// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { TokenPrice } from "../../agent/provider-cost";
import { guardedFetch } from "../url-guard";
import { type HostedProvider, hostedModelsUrl } from "./hosted-providers";
import type { ModelEntry } from "./model-discovery";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Missing/invalid prices stay unknown; an explicit zero is a real free tier. */
function rate(value: unknown, multiplier: number): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return;
  const n = Number(value) * multiplier;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function hostedPrice(provider: HostedProvider, value: unknown): TokenPrice | undefined {
  const p = record(value);
  const together = provider === "together";
  const multiplier = together ? 1 : 1_000_000;
  const input = rate(p[together ? "input" : "prompt"], multiplier);
  const output = rate(p[together ? "output" : "completion"], multiplier);
  if (input === undefined || output === undefined) return;
  return {
    input,
    output,
    // No advertised discount means ordinary input pricing, never free reads.
    cacheRead: rate(p[together ? "cached_input" : "input_cache_read"], multiplier) ?? input,
    cacheWrite: rate(p.input_cache_write, multiplier) ?? input,
  };
}

/** Together /models is an array; Nebius /models?verbose=true is { data: [...] }. */
export function parseHostedModels(provider: HostedProvider, body: unknown): ModelEntry[] {
  const rows = Array.isArray(body) ? body : record(body).data;
  if (!Array.isArray(rows)) throw new Error("Invalid model catalog response");
  const entries = new Map<string, ModelEntry>();
  for (const row of rows) {
    const m = record(row);
    if (typeof m.id !== "string" || !m.id.trim()) continue;
    const architecture = record(m.architecture);
    const modality = typeof architecture.modality === "string" ? architecture.modality : "";
    // This is a chat picker, not an image/embedding/fine-tuning catalog.
    if (provider === "together" && m.type !== undefined && m.type !== "chat") continue;
    if (modality && !modality.endsWith("->text")) continue;
    const pricing = hostedPrice(provider, m.pricing);
    const context = rate(m.context_length, 1);
    const inputModes = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities
      : (modality.split("->")[0]?.split("+") ?? []);
    entries.set(m.id, {
      value: `${provider}/${m.id}`,
      label:
        typeof m.display_name === "string"
          ? m.display_name
          : typeof m.name === "string"
            ? m.name
            : m.id,
      ...(context && Number.isInteger(context) ? { contextLength: context } : {}),
      ...(typeof m.description === "string" ? { description: m.description } : {}),
      capabilities: { text: true, ...(inputModes.includes("image") ? { image: true } : {}) },
      ...(pricing ? { pricing } : {}),
    });
  }
  return [...entries.values()];
}

const TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 30_000;
const catalogs = new Map<string, { expires: number; models: Promise<ModelEntry[]> }>();
export type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Credential- and endpoint-scoped, bounded cache shared by discovery and accounting. */
export async function fetchHostedModels(
  provider: HostedProvider,
  apiKey: string,
  options: { refresh?: boolean; fetcher?: CatalogFetch; signal?: AbortSignal } = {},
): Promise<ModelEntry[]> {
  options.signal?.throwIfAborted();
  if (!apiKey.trim()) throw new Error("Provider key unavailable");
  const url = hostedModelsUrl(provider);
  const key = createHash("sha256").update(`${provider}\0${url}\0${apiKey}`).digest("hex");
  const cached = catalogs.get(key);
  if (!options.refresh && cached && cached.expires > Date.now()) return cached.models;
  if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value!);
  const entry = { expires: Date.now() + TTL_MS, models: Promise.resolve([] as ModelEntry[]) };
  entry.models = (async () => {
    try {
      const request =
        options.fetcher ??
        ((url: string, init: RequestInit) =>
          guardedFetch(url, init, {
            refuseHop: (next) =>
              new URL(next).origin === new URL(url).origin
                ? undefined
                : "Catalog redirect changed origin",
          }));
      const response = await request(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any([
          AbortSignal.timeout(8_000),
          ...(options.signal ? [options.signal] : []),
        ]),
        // Do not forward credentials to a redirected catalog origin.
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
      return parseHostedModels(provider, await response.json());
    } catch {
      entry.expires = Date.now() + FAILURE_TTL_MS;
      // Do not leak provider responses, URLs with secrets, or credentials.
      throw new Error("Model catalog unavailable");
    }
  })();
  catalogs.set(key, entry);
  return entry.models;
}

export async function hostedModelInfo(
  provider: HostedProvider,
  modelId: string,
  apiKey: string,
  fetcher?: CatalogFetch,
  signal?: AbortSignal,
): Promise<ModelEntry | undefined> {
  try {
    return (await fetchHostedModels(provider, apiKey, { fetcher, signal })).find(
      (m) => m.value === `${provider}/${modelId}`,
    );
  } catch {
    // A catalog outage does not change a selected model or stop inference.
    return undefined;
  }
}

export function resetHostedCatalogsForTests(): void {
  catalogs.clear();
}
