// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

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

import { isLocalProfile } from "../engine/trust-profile";
import { isLocalProvider, LOCAL_PROVIDERS, localProviderBaseUrl } from "../net/model-discovery";
import { validateFetchUrl, validateOperatorLanUrl } from "../net/url-guard";

export interface ModelLimits {
  /** Real context window (prompt+output, tokens) reported by the server. */
  contextWindow?: number;
  /** Where the numbers came from, for logging. */
  source: string;
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * Normalize a user-supplied remote-Marina target into an OpenAI-style base URL.
 * Accepts "host:port", "http(s)://host", or a full ".../v1" URL and always
 * returns "<scheme>://<host>[:port]/v1". Defaults to http:// when no scheme is
 * given (operators terminate TLS at a proxy or run on a trusted network).
 */
export function normalizeMarinaBaseUrl(raw: string): string {
  let u = raw.trim();
  // Only bare hosts get an implicit http:// — a foreign scheme (ftp://, file://)
  // is left intact so the URL validators can refuse it instead of it being
  // silently re-read as an http host named "ftp".
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u);
  if (!hasScheme) u = `http://${u}`;
  u = u.replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(u)) u = `${u}/v1`;
  return u;
}

/**
 * The remote base URL a `marina@<host-or-url>` model string points at, or
 * undefined for every other model string (including a plain `marina/default`,
 * which routes to this instance's own port).
 */
export function marinaRemoteTarget(modelStr: string): string | undefined {
  const at = modelStr.indexOf("@");
  if (at < 0) return undefined;
  const head = modelStr.slice(0, at);
  const provider = head.includes("/") ? head.slice(0, head.indexOf("/")) : head;
  if (provider !== "marina") return undefined;
  const remote = modelStr.slice(at + 1).trim();
  return remote ? normalizeMarinaBaseUrl(remote) : undefined;
}

/** True for the loopback hostnames the local operator may legitimately target. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * SSRF check for a `marina@<host>` model target. The host is agent/operator
 * supplied (an `agent spawn ... model marina@...` argument), so it goes through
 * the same guard as every other user-supplied URL: private ranges, link-local,
 * cloud metadata and DNS-rebinding hosts are refused. Loopback is allowed only
 * under the `local` trust profile (one operator on their own machine — the
 * documented way to chain two local instances). Returns an error string when
 * the target must not be used, `null` when it is safe; non-remote model strings
 * are always `null`.
 */
export async function validateMarinaRemoteTarget(modelStr: string): Promise<string | null> {
  const baseUrl = marinaRemoteTarget(modelStr);
  if (!baseUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `Remote Marina target "${baseUrl}" is not a valid URL`;
  }
  // Under the `local` profile the single operator is trusted with their own
  // machine and LAN (a second Marina on a LAN GPU box is a normal dev setup), so
  // only the URL shape is checked. Shared/public instances refuse loopback and
  // every private/link-local/metadata range through the SSRF guard.
  if (isLocalProfile()) {
    const shape = validateOperatorLanUrl(baseUrl);
    return shape ? `Remote Marina target "${baseUrl}" is blocked: ${shape}` : null;
  }
  if (isLoopbackHost(parsed.hostname)) {
    return `Remote Marina target "${baseUrl}" points at loopback — only allowed under the local trust profile (MARINA_PROFILE=local)`;
  }
  const blocked = await validateFetchUrl(baseUrl);
  return blocked ? `Remote Marina target "${baseUrl}" is blocked: ${blocked}` : null;
}

/** Throwing form of {@link validateMarinaRemoteTarget} for spawn/start/reconfigure paths. */
export async function assertMarinaRemoteTargetAllowed(modelStr: string): Promise<void> {
  const error = await validateMarinaRemoteTarget(modelStr);
  if (error) throw new Error(`${error}. The agent was not connected.`);
}

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
