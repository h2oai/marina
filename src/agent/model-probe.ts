/**
 * Model limit probing — autodetect a local model's real context window when an
 * agent is launched, so the compactor budgets against the truth instead of a
 * guess. Self-hosted runtimes expose their loaded window over their own admin
 * endpoints; cloud models carry correct limits in the bundled registry and need
 * no probe.
 *
 * The probe targets the operator-configured local base URL (env-supplied,
 * trusted — the same host the agent's LLM calls already hit), so it does NOT go
 * through the SSRF guard, which exists for user-supplied URLs and would block
 * localhost on purpose.
 */

import { isLocalProvider, LOCAL_PROVIDERS, localProviderBaseUrl } from "../net/model-discovery";

export interface ModelLimits {
  /** Real context window (prompt+output, tokens) reported by the server. */
  contextWindow?: number;
  /** Where the numbers came from, for logging. */
  source: string;
}

const PROBE_TIMEOUT_MS = 3000;

/** Strip a trailing `/v1` (or `/vN`) so we can reach the server's admin routes. */
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v\d+\/?$/i, "").replace(/\/+$/, "");
}

/** Provider prefix of a "provider/model" string (drops any `@host` suffix). */
function providerOf(modelStr: string): string {
  const head = modelStr.split("@")[0] ?? modelStr;
  const slash = head.indexOf("/");
  return slash >= 0 ? head.slice(0, slash) : head;
}

/** Model id after the provider prefix (drops any `@host` suffix). */
function modelIdOf(modelStr: string): string {
  const head = modelStr.split("@")[0] ?? modelStr;
  const slash = head.indexOf("/");
  return slash >= 0 ? head.slice(slash + 1) : head;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Best-effort detection of a local model's real context window. Returns null for
 * non-local providers, an unreachable server, or an unparseable response — every
 * caller falls back to the env override / conservative default in that case.
 */
export async function detectModelLimits(modelStr: string): Promise<ModelLimits | null> {
  const provider = providerOf(modelStr);
  if (!isLocalProvider(provider)) return null;
  const baseUrl = localProviderBaseUrl(provider);
  if (!baseUrl) return null;
  const root = serverRoot(baseUrl);

  const keyEnv = LOCAL_PROVIDERS[provider]?.keyEnv;
  const key = keyEnv ? process.env[keyEnv] : undefined;
  const authHeaders: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};

  if (provider === "llama") {
    // llama.cpp `--server` exposes /props with the loaded slot's n_ctx.
    const props = await fetchJson(`${root}/props`, { headers: authHeaders });
    if (!props) return null;
    const gen = props.default_generation_settings as Record<string, unknown> | undefined;
    const n = asPositiveInt(gen?.n_ctx) ?? asPositiveInt(props.n_ctx);
    return n ? { contextWindow: n, source: "llama.cpp /props" } : null;
  }

  if (provider === "ollama") {
    // Ollama's native /api/show returns model_info with `<arch>.context_length`.
    const show = await fetchJson(`${root}/api/show`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelIdOf(modelStr) }),
    });
    const info = show?.model_info as Record<string, unknown> | undefined;
    if (!info) return null;
    const arch = info["general.architecture"];
    const ctx =
      typeof arch === "string" ? asPositiveInt(info[`${arch}.context_length`]) : undefined;
    return ctx ? { contextWindow: ctx, source: "ollama /api/show" } : null;
  }

  return null;
}
