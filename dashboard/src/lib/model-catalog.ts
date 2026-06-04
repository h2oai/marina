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
      { value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
      { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "anthropic/claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  {
    provider: "openai",
    error: null,
    keySource: null,
    models: [{ value: "openai/gpt-4o", label: "GPT-4o" }],
  },
];

export const DEFAULT_FALLBACK_MODEL = FALLBACK_GROUPS[0]!.models[0]!.value;

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

  return out;
}

/** Total model count across groups — for UI status text. */
export function totalModelCount(groups: ProviderGroup[]): number {
  return groups.reduce((n, g) => n + g.models.length, 0);
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
