// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Candidate models, read from OpenRouter's public catalogue
 * (`/api/v1/models`) at selection time rather than hard-coded: the newest
 * models per major vendor, plus any the operator names. Each carries its
 * release date (`created`, an upper bound on its knowledge cutoff — what a
 * clean backtest needs) and its price (what a budget needs).
 */

export const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";

export interface CatalogueModel {
  /** The id after `openrouter/` (e.g. `anthropic/claude-fable-5.1`). */
  id: string;
  /** Release date, YYYY-MM-DD (UTC). */
  released: string;
  /** USD per million input / output tokens. */
  inPerM: number;
  outPerM: number;
}

/** Vendors whose newest general models are candidates by default. */
export const DEFAULT_VENDORS = ["anthropic", "openai", "google", "deepseek", "moonshotai", "x-ai"];

/** Variants that are the same weights (batch, free tiers), other modalities, or floating aliases. */
const SKIP =
  /(:batch|:free|^~|-image|image-|-audio|-tts|-vl\b|-omni|-embed|-preview|customtools|-mini-|router)/i;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchCatalogue(fetcher: Fetcher = fetch): Promise<CatalogueModel[]> {
  const res = await fetcher(CATALOGUE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`model catalogue → ${res.status}`);
  const data = (await res.json()) as {
    data?: Array<{
      id: string;
      created?: number;
      pricing?: { prompt?: string; completion?: string };
    }>;
  };
  return (data.data ?? [])
    .filter((m) => typeof m.id === "string" && typeof m.created === "number")
    .map((m) => ({
      id: m.id,
      released: new Date(m.created! * 1000).toISOString().slice(0, 10),
      inPerM: Number(m.pricing?.prompt ?? Number.NaN) * 1e6,
      outPerM: Number(m.pricing?.completion ?? Number.NaN) * 1e6,
    }))
    .sort((a, b) => b.released.localeCompare(a.released) || a.id.localeCompare(b.id));
}

/**
 * The candidate models: the newest `perVendor` usable models of each vendor
 * (priced, not over `maxOutPerM`), plus every id in `include` (always kept,
 * whatever its price — the budget decides later whether it can run).
 */
export function candidateModels(
  catalogue: CatalogueModel[],
  opts: { vendors?: string[]; perVendor?: number; maxOutPerM?: number; include?: string[] } = {},
): CatalogueModel[] {
  const vendors = opts.vendors ?? DEFAULT_VENDORS;
  const per = opts.perVendor ?? 2;
  const maxOut = opts.maxOutPerM ?? 60;
  const out: CatalogueModel[] = [];
  for (const v of vendors) {
    out.push(
      ...catalogue
        .filter(
          (m) =>
            m.id.startsWith(`${v}/`) &&
            !SKIP.test(m.id) &&
            Number.isFinite(m.outPerM) &&
            m.outPerM > 0 &&
            m.outPerM <= maxOut,
        )
        .slice(0, per),
    );
  }
  for (const id of opts.include ?? []) {
    const bare = id.replace(/^openrouter\//, "");
    if (out.some((m) => m.id === bare)) continue;
    const m = catalogue.find((x) => x.id === bare);
    if (!m) throw new Error(`${bare} is not in the model catalogue`);
    out.push(m);
  }
  return out;
}

/** Release dates by bare id, for knowledge bounds. */
export function releases(catalogue: CatalogueModel[]): Record<string, string> {
  return Object.fromEntries(catalogue.map((m) => [m.id, m.released]));
}

/**
 * A rough USD estimate of one forecast call by a model: `inTok` prompt and
 * `outTok` completion tokens at catalogue prices.
 */
export function callCost(
  m: Pick<CatalogueModel, "inPerM" | "outPerM">,
  inTok = 14_000,
  outTok = 1_200,
) {
  return (m.inPerM * inTok + m.outPerM * outTok) / 1e6;
}
