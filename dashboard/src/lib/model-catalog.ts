// Static fallback catalog. Only used when /api/models returns empty or fails —
// live discovery is the primary source. Kept intentionally small: enough to
// launch an agent without network access, not a reference list of "good" models.

import type { ModelEntry, ProviderGroup } from "./types";

export const FALLBACK_GROUPS: ProviderGroup[] = [
  {
    provider: "anthropic",
    error: null,
    keySource: null,
    models: [
      {
        value: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        capabilities: { text: true },
      },
      {
        value: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        capabilities: { text: true },
      },
      {
        value: "anthropic/claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        capabilities: { text: true },
      },
    ],
  },
  {
    provider: "openai",
    error: null,
    keySource: null,
    models: [
      {
        value: "openai/gpt-4o",
        label: "GPT-4o",
        capabilities: { text: true, image: true },
      },
    ],
  },
];

export const DEFAULT_FALLBACK_MODEL = FALLBACK_GROUPS[0]!.models[0]!.value;

/** Self-hosted, OpenAI-compatible local runtimes, surfaced first in pickers. */
const LOCAL_PROVIDERS = new Set(["llama", "ollama"]);

/**
 * Merge live discovery with fallback. If a provider returned models, use those;
 * otherwise fill in from the fallback so the picker is never empty. Providers
 * the API reports on but the fallback doesn't know about pass through verbatim.
 */
export function mergeGroups(liveGroups: ProviderGroup[] | undefined): ProviderGroup[] {
  if (!liveGroups || liveGroups.length === 0) return FALLBACK_GROUPS;

  const out: ProviderGroup[] = [];
  const seen = new Set<string>();

  for (const live of liveGroups) {
    seen.add(live.provider);
    if (live.models.length > 0) {
      out.push(live);
      continue;
    }
    // Live provider has no models (no key, fetch failed) — try fallback
    const fb = FALLBACK_GROUPS.find((g) => g.provider === live.provider);
    if (fb) {
      out.push({ ...live, models: fb.models });
    } else {
      out.push(live);
    }
  }

  // Fallback-only providers that the API didn't report (shouldn't normally happen)
  for (const fb of FALLBACK_GROUPS) {
    if (!seen.has(fb.provider)) out.push(fb);
  }

  // Hoist self-hosted local runtimes to the top — operators running local-first
  // shouldn't have to scroll past every cloud provider to pick their model.
  // Stable: preserves relative order within the local and non-local partitions.
  const local = out.filter((g) => LOCAL_PROVIDERS.has(g.provider));
  const rest = out.filter((g) => !LOCAL_PROVIDERS.has(g.provider));
  return [...local, ...rest];
}

/** Total model count across groups — for UI status text. */
export function totalModelCount(groups: ProviderGroup[]): number {
  return groups.reduce((n, g) => n + g.models.length, 0);
}

/**
 * Substrings of well-known, broadly-available models, best-first. Used to pick a
 * sane launch default instead of whatever sorts alphabetically first — which for
 * a large catalog like OpenRouter's (~340 models) is an obscure model (e.g.
 * `ai21/jamba-large`) most accounts can't serve, so the agent 404s on first call.
 */
const PREFERRED_MODEL_SUBSTRINGS = [
  "claude-sonnet",
  "claude-3-7-sonnet",
  "gpt-4o",
  "gpt-4.1",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "llama-3.3",
];

/**
 * Pick a sensible default model value from the keyed/live groups. Prefers a
 * recognizable mainstream model (see PREFERRED_MODEL_SUBSTRINGS); falls back to
 * the first model only when none match. Returns undefined if there are no models.
 */
export function pickDefaultModel(liveGroups: ProviderGroup[]): string | undefined {
  const all = liveGroups.flatMap((g) => g.models.map((m) => m.value));
  if (all.length === 0) return undefined;
  for (const want of PREFERRED_MODEL_SUBSTRINGS) {
    const hit = all.find((v) => v.toLowerCase().includes(want));
    if (hit) return hit;
  }
  return all[0];
}

/** Prettier provider names for the optgroup label. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export type { ModelEntry, ProviderGroup };
