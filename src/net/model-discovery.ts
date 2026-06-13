// ─── Provider Model Discovery ───────────────────────────────────────────────
//
// Fetches live model catalogs from each registered provider's `/v1/models`
// endpoint, normalizes the heterogeneous responses, and caches for 1 hour.
// Stored DB keys (api_keys) take precedence; env vars are a fallback.

import type { MarinaDB } from "../persistence/database";

export interface ModelCapabilities {
  text?: boolean;
  image?: boolean;
  video?: boolean;
  audio?: boolean;
}

export interface ModelEntry {
  /** Full routable id used by the model API: `<provider>/<model>` */
  value: string;
  /** Human label for the picker */
  label: string;
  /** Context window if the provider reports one */
  contextLength?: number;
  /** Short description if the provider reports one */
  description?: string;
  /** Modality support advertised by this model */
  capabilities?: ModelCapabilities;
}

export interface ProviderGroup {
  provider: string;
  /** Why this provider has no models: `no-key` | `fetch-failed` | null */
  error: string | null;
  /** Where the key came from: `db` | `env` | null */
  keySource: "db" | "env" | null;
  models: ModelEntry[];
}

export interface ModelDiscoveryResult {
  groups: ProviderGroup[];
  fetchedAt: number;
  /** True if served from in-memory cache. */
  cached: boolean;
}

interface ProviderSpec {
  provider: string;
  url: string;
  envKey: string;
  authStyle: "bearer" | "anthropic" | "query" | "none";
}

/**
 * Self-hosted, OpenAI-compatible local LLM runtimes — the keyless / bring-your-
 * own-server path for operators without cloud provider keys. Both are addressed
 * as `<provider>/<model-id>` and routed straight to the local server.
 *
 *  - `llama`  — a llama.cpp `--server` instance (default port 8080).
 *  - `ollama` — Ollama's OpenAI-compatible endpoint (default port 11434).
 *
 * Base URLs default to `localhost` (native / bare-metal install). In Docker
 * compose the service is reached by name, so set `LLAMA_BASE_URL` /
 * `OLLAMA_BASE_URL` in that deployment (docker-compose.yml does this). A key is
 * OPTIONAL: llama.cpp may run with `--api-key`, Ollama is typically keyless.
 */
export interface LocalProviderSpec {
  /** Env var that overrides the OpenAI-style base URL (must end with `/v1`). */
  baseUrlEnv: string;
  /** Default base URL for a native/localhost install. */
  defaultBaseUrl: string;
  /** Env var holding an optional bearer key (absent for keyless servers). */
  keyEnv: string;
  /** Built-in model id used when routing `marina/default` to this runtime. */
  defaultModel: string;
}

export const LOCAL_PROVIDERS: Record<string, LocalProviderSpec> = {
  llama: {
    baseUrlEnv: "LLAMA_BASE_URL",
    defaultBaseUrl: "http://localhost:8080/v1",
    keyEnv: "LLAMA_API_KEY",
    defaultModel: "local-model",
  },
  ollama: {
    baseUrlEnv: "OLLAMA_BASE_URL",
    defaultBaseUrl: "http://localhost:11434/v1",
    keyEnv: "OLLAMA_API_KEY",
    defaultModel: "llama3",
  },
};

/** True if `provider` is a self-hosted local runtime (llama.cpp / Ollama). */
export function isLocalProvider(provider: string): boolean {
  return provider in LOCAL_PROVIDERS;
}

/**
 * Resolve a local provider's OpenAI-style base URL (env override → localhost
 * default), trailing slashes stripped. Returns undefined for non-local providers.
 */
export function localProviderBaseUrl(provider: string): string | undefined {
  const spec = LOCAL_PROVIDERS[provider];
  if (!spec) return undefined;
  return (process.env[spec.baseUrlEnv] ?? spec.defaultBaseUrl).replace(/\/+$/, "");
}

const PROVIDERS: ProviderSpec[] = [
  {
    provider: "anthropic",
    url: "https://api.anthropic.com/v1/models",
    envKey: "ANTHROPIC_API_KEY",
    authStyle: "anthropic",
  },
  {
    provider: "openai",
    url: "https://api.openai.com/v1/models",
    envKey: "OPENAI_API_KEY",
    authStyle: "bearer",
  },
  {
    provider: "google",
    url: "https://generativelanguage.googleapis.com/v1/models",
    envKey: "GEMINI_API_KEY",
    authStyle: "query",
  },
  {
    provider: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    envKey: "OPENROUTER_API_KEY",
    // OpenRouter's /models endpoint is public; key is optional.
    authStyle: "none",
  },
  {
    provider: "groq",
    url: "https://api.groq.com/openai/v1/models",
    envKey: "GROQ_API_KEY",
    authStyle: "bearer",
  },
  {
    provider: "mistral",
    url: "https://api.mistral.ai/v1/models",
    envKey: "MISTRAL_API_KEY",
    authStyle: "bearer",
  },
  {
    provider: "xai",
    url: "https://api.x.ai/v1/models",
    envKey: "XAI_API_KEY",
    authStyle: "bearer",
  },
  {
    provider: "cerebras",
    url: "https://api.cerebras.ai/v1/models",
    envKey: "CEREBRAS_API_KEY",
    authStyle: "bearer",
  },
  {
    provider: "deepseek",
    url: "https://api.deepseek.com/v1/models",
    envKey: "DEEPSEEK_API_KEY",
    authStyle: "bearer",
  },
  {
    provider: "llama",
    url: `${localProviderBaseUrl("llama")}/models`,
    envKey: "LLAMA_API_KEY",
    // Keyless-friendly: a bare-metal llama.cpp may run without `--api-key`. We
    // still send LLAMA_API_KEY when set (the `none` branch forwards a present
    // key), so a hardened server with `--api-key` is discovered too.
    authStyle: "none",
  },
  {
    provider: "ollama",
    url: `${localProviderBaseUrl("ollama")}/models`,
    envKey: "OLLAMA_API_KEY",
    // Ollama's OpenAI-compatible endpoint is keyless; discovery still works
    // (the /v1/models list is public on a local server).
    authStyle: "none",
  },
];

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 8_000;

let cache: ModelDiscoveryResult | null = null;

interface CapabilityRule {
  test: (entry: ModelEntry) => boolean;
  capabilities: ModelEntry["capabilities"];
}

const CAPABILITY_RULES: CapabilityRule[] = [
  {
    test: (entry) =>
      /^openai\/gpt-image-/i.test(entry.value) || /^openai\/dall-e/i.test(entry.value),
    capabilities: { text: false, image: true },
  },
  {
    test: (entry) => /^openai\/gpt-4o(-mini)?-vision/i.test(entry.value),
    capabilities: { text: true, image: true },
  },
  {
    test: (entry) => /^openai\/gpt-4o-mini-audio/i.test(entry.value),
    capabilities: { text: true, audio: true },
  },
  {
    test: (entry) => /^runway\/gen2/i.test(entry.value),
    capabilities: { text: false, video: true },
  },
  {
    test: (entry) =>
      /^stability\/sdxl/i.test(entry.value) || /stability\/stable-diffusion/i.test(entry.value),
    capabilities: { text: false, image: true },
  },
];

function applyCapabilityHints(entry: ModelEntry): void {
  const base: NonNullable<ModelEntry["capabilities"]> = entry.capabilities
    ? { ...entry.capabilities }
    : {};
  // Default to text=true unless the rule explicitly disables it.
  if (base.text === undefined) base.text = true;
  for (const rule of CAPABILITY_RULES) {
    if (rule.test(entry)) {
      entry.capabilities = { ...base, ...rule.capabilities };
      return;
    }
  }
  entry.capabilities = base;
}

export interface CapabilitySnapshot {
  text: boolean;
  image?: boolean;
  video?: boolean;
  audio?: boolean;
}

/** Infer coarse modality support for a model identifier. */
export function inferModelCapabilities(modelId: string): CapabilitySnapshot {
  const value = modelId.includes("@") ? modelId.slice(0, modelId.indexOf("@")) : modelId;
  const entry: ModelEntry = { value, label: value };
  applyCapabilityHints(entry);
  const caps = entry.capabilities ?? {};
  return {
    text: caps.text !== false,
    image: caps.image ? true : undefined,
    video: caps.video ? true : undefined,
    audio: caps.audio ? true : undefined,
  };
}

function resolveKey(
  spec: ProviderSpec,
  db?: MarinaDB,
): { key: string | null; source: "db" | "env" | null } {
  if (db) {
    const rows = db.getApiKeysByProvider(spec.provider);
    if (rows.length > 0) return { key: rows[0]!.encrypted_value, source: "db" };
  }
  const envVal = process.env[spec.envKey];
  if (envVal) return { key: envVal, source: "env" };
  return { key: null, source: null };
}

async function fetchProvider(spec: ProviderSpec, key: string | null): Promise<ModelEntry[]> {
  let url = spec.url;
  const headers: Record<string, string> = {};

  if (spec.authStyle === "anthropic") {
    if (!key) return [];
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (spec.authStyle === "query") {
    if (!key) return [];
    url = `${url}?key=${encodeURIComponent(key)}`;
  } else if (spec.authStyle === "bearer") {
    if (!key) return [];
    headers.Authorization = `Bearer ${key}`;
  } else if (spec.authStyle === "none" && key) {
    // OpenRouter: optional bearer for user-specific filtering
    headers.Authorization = `Bearer ${key}`;
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = (await res.json()) as unknown;
  return parseProviderResponse(spec.provider, body);
}

export function parseProviderResponse(provider: string, body: unknown): ModelEntry[] {
  if (!body || typeof body !== "object") return [];

  // Google (Gemini): { models: [{ name, displayName, description }] }
  if (provider === "google") {
    const models = (body as { models?: unknown[] }).models;
    if (!Array.isArray(models)) return [];
    const out: ModelEntry[] = [];
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const rec = m as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : null;
      if (!name) continue;
      const methods = rec.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
      const id = name.replace(/^models\//, "");
      const label = typeof rec.displayName === "string" ? rec.displayName : id;
      const entry: ModelEntry = { value: `google/${id}`, label };
      if (typeof rec.description === "string") entry.description = rec.description;
      applyCapabilityHints(entry);
      out.push(entry);
    }
    return out;
  }

  // OpenRouter: { data: [{ id, name, context_length, description }] }
  if (provider === "openrouter") {
    const data = (body as { data?: unknown[] }).data;
    if (!Array.isArray(data)) return [];
    const out: ModelEntry[] = [];
    for (const m of data) {
      if (!m || typeof m !== "object") continue;
      const rec = m as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : null;
      if (!id) continue;
      const label = typeof rec.name === "string" ? rec.name : id;
      const entry: ModelEntry = { value: `openrouter/${id}`, label };
      if (typeof rec.context_length === "number") entry.contextLength = rec.context_length;
      if (typeof rec.description === "string") entry.description = rec.description;
      applyCapabilityHints(entry);
      out.push(entry);
    }
    return out;
  }

  // Anthropic: { data: [{ id, display_name }] }
  if (provider === "anthropic") {
    const data = (body as { data?: unknown[] }).data;
    if (!Array.isArray(data)) return [];
    const out: ModelEntry[] = [];
    for (const m of data) {
      if (!m || typeof m !== "object") continue;
      const rec = m as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : null;
      if (!id) continue;
      const label = typeof rec.display_name === "string" ? rec.display_name : id;
      const entry: ModelEntry = { value: `anthropic/${id}`, label };
      applyCapabilityHints(entry);
      out.push(entry);
    }
    return out;
  }

  // OpenAI-compatible: { data: [{ id }] } — openai, groq, mistral, xai, cerebras, deepseek
  const data = (body as { data?: unknown[] }).data;
  if (!Array.isArray(data)) return [];
  const out: ModelEntry[] = [];
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    if (!id) continue;
    const entry: ModelEntry = { value: `${provider}/${id}`, label: id };
    applyCapabilityHints(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Discover models across every provider that has a key (DB or env) plus any
 * public endpoints (currently only OpenRouter). Cached for 1 hour.
 * Pass `refresh: true` to bypass the cache.
 */
export async function discoverModels(
  db?: MarinaDB,
  opts?: { refresh?: boolean },
): Promise<ModelDiscoveryResult> {
  const now = Date.now();
  if (!opts?.refresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { ...cache, cached: true };
  }

  const groups = await Promise.all(
    PROVIDERS.map(async (spec): Promise<ProviderGroup> => {
      const { key, source } = resolveKey(spec, db);
      // No key AND not a public endpoint → skip silently
      if (!key && spec.authStyle !== "none") {
        return { provider: spec.provider, error: "no-key", keySource: null, models: [] };
      }
      try {
        const models = await fetchProvider(spec, key);
        // Sort alphabetically by label for stable UI
        models.sort((a, b) => a.label.localeCompare(b.label));
        return { provider: spec.provider, error: null, keySource: source, models };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          provider: spec.provider,
          error: `fetch-failed: ${msg}`,
          keySource: source,
          models: [],
        };
      }
    }),
  );

  cache = { groups, fetchedAt: now, cached: false };
  return cache;
}

/** Test hook: clear the in-process cache. */
export function clearModelDiscoveryCache(): void {
  cache = null;
}

export const MODEL_DISCOVERY_PROVIDERS = PROVIDERS.map((p) => p.provider);
