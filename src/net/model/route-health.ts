// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Route health: which ROUTE to a model (provider + key) can serve right now.
 *
 * A first-party key (Anthropic, OpenAI, …) can hit its account's usage limit —
 * Anthropic's "You have reached your specified workspace API usage limits. You
 * will regain access on 2026-11-01 at 00:00 UTC.", OpenAI's `insufficient_quota`,
 * OpenRouter's 402. That is a limit of the ROUTE, not of the model and not of
 * Marina's own daily spend cap: the same model is often still served through
 * OpenRouter. One classifier ({@link classifyUpstreamRefusal}) is shared by the
 * agent loop and the `/v1` passthru; one process-wide registry remembers a
 * limited route until its reset (read from the error when it says, else a
 * bounded backoff) so callers stop hammering it; and {@link sameModelFallback}
 * finds the SAME model on OpenRouter — never a different one. Nothing here
 * calls a provider; the next real call after the limit lapses is the re-probe
 * (one caller at a time), and a refused call is not billed.
 */

import { isProviderAuthError, providerErrorStatus } from "../../agent/provider-auth";
import { openRouterSameModel } from "../../agent/provider-cost";
import { Logger } from "../../engine/logger";

const logger = new Logger();

/** What an upstream refusal means for the caller. */
export type RefusalKind =
  /** The route's account (key) hit a usage/quota/credit limit — retrying the same route cannot succeed until it lifts. */
  | "usage-limit"
  /** The provider refused the credentials (401/403) — handled by the provider-auth park. */
  | "auth"
  /** Transient throttling — the ordinary backoff. */
  | "rate-limit"
  | "other";

export interface UpstreamRefusal {
  kind: RefusalKind;
  status?: number;
  /** When the provider said access returns (ms epoch), if it said. */
  resetAt?: number;
  /** The upstream's own words, trimmed (never a key). */
  detail: string;
}

/** Marina's OWN budgets — never a provider route's limit. */
const MARINA_BUDGET =
  /spend_cap_reached|spend cap reached|spend refused|run_budget_exhausted|reservation (?:refused|exceeds)/i;

const USAGE_LIMIT =
  /route_usage_limit|usage limit until|reached your (?:specified )?(?:\w+ )*usage limits?|usage limits? (?:reached|exceeded)|credit balance is too low|insufficient[_ ](?:credits|quota|funds|balance)|exceeded your current quota|requires more credits|payment required|quota exceeded|billing (?:hard )?limit/i;

const RATE_LIMIT = /rate[_ ]limit|too many requests|requests per (?:minute|second)|overloaded/i;

/**
 * The reset time a provider names in its refusal, if any: "regain access on
 * 2026-11-01 at 00:00 UTC", an ISO timestamp, or "2026-11-01 00:00 UTC".
 * Times without a zone are read as UTC. Undefined when none is given or the
 * date is not after `now`.
 */
export function parseLimitReset(message: string, now = Date.now()): number | undefined {
  const m =
    /(\d{4}-\d{2}-\d{2})(?:T|\s+at\s+|\s+)(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?/i.exec(
      message,
    ) ?? /(\d{4}-\d{2}-\d{2})()()()/.exec(message);
  if (!m) return undefined;
  const [, day, hm, sec, zone] = m;
  const z = !zone || /^(?:Z|UTC|GMT)$/i.test(zone) ? "Z" : zone;
  const at = Date.parse(`${day}T${hm || "00:00"}:${sec || "00"}${z}`);
  return Number.isFinite(at) && at > now ? at : undefined;
}

/**
 * Classify an upstream refusal. `status` is the HTTP status when the caller
 * has it; otherwise a leading status in the message (`400 {…}`) is used.
 * Marina's own spend cap is never a route limit (`other` — the spend-cap
 * paths own it).
 */
export function classifyUpstreamRefusal(
  message: string,
  status?: number,
  now = Date.now(),
): UpstreamRefusal {
  const code = status ?? providerErrorStatus(message);
  const detail = message.replace(/\s+/g, " ").trim().slice(0, 300);
  const base = { ...(code === undefined ? {} : { status: code }), detail };
  if (MARINA_BUDGET.test(message)) return { kind: "other", ...base };
  if (code === 402 || USAGE_LIMIT.test(message)) {
    const resetAt = parseLimitReset(message, now);
    return { kind: "usage-limit", ...base, ...(resetAt ? { resetAt } : {}) };
  }
  if (isProviderAuthError(message) || code === 401 || code === 403)
    return { kind: "auth", ...base };
  if (code === 429 || RATE_LIMIT.test(message)) return { kind: "rate-limit", ...base };
  return { kind: "other", ...base };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Providers that serve other vendors' models (their own route, never "direct"). */
const AGGREGATOR_ROUTES = new Set(["openrouter", "huggingface", "together", "nebius"]);

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  google: "Google Gemini API",
  xai: "xAI API",
  mistral: "Mistral API",
  deepseek: "DeepSeek API",
  groq: "Groq API",
  cerebras: "Cerebras API",
  openrouter: "OpenRouter",
  huggingface: "Hugging Face router",
  together: "Together AI",
  nebius: "Nebius Token Factory",
};

/** The first-party API host of each provider whose models OpenRouter also serves. */
const DIRECT_HOSTS: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  google: "generativelanguage.googleapis.com",
  xai: "api.x.ai",
  mistral: "api.mistral.ai",
  deepseek: "api.deepseek.com",
};

/**
 * True when a model call goes to `provider`'s own first-party API (by base
 * URL) — not a local runtime or proxy that borrows the `openai` transport.
 */
export function isDirectRoute(provider: string, baseUrl: string | undefined): boolean {
  const host = DIRECT_HOSTS[provider];
  if (!host || !baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === host;
  } catch {
    return false;
  }
}

/** Route id: `anthropic:direct` for a first-party key, the provider for an aggregator. */
export function routeIdFor(provider: string): string {
  return AGGREGATOR_ROUTES.has(provider) ? provider : `${provider}:direct`;
}

/** "Anthropic API (direct key)" / "OpenRouter" — what messages and readiness call a route. */
export function routeLabel(provider: string): string {
  const name = PROVIDER_NAMES[provider] ?? provider;
  return AGGREGATOR_ROUTES.has(provider) ? name : `${name} (direct key)`;
}

/** `2026-11-01 00:00 UTC` */
export function formatResetUtc(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface RouteLimit {
  provider: string;
  /** No call on this route before this time (the reset, or the next re-probe). */
  until: number;
  /** The reset the provider named, when it named one. */
  resetAt?: number;
  /** The provider's own words. */
  detail: string;
  /** When the limit was first seen. */
  since: number;
  /** Re-probes refused so far (drives the backoff when no reset is known). */
  probes: number;
  /** A re-probe in flight since this time (one caller at a time). */
  probingSince?: number;
}

/** Re-probe backoff when the provider named no reset: 15 min, doubling, at most 2 h. */
export const ROUTE_PROBE_BASE_MS = 15 * 60_000;
export const ROUTE_PROBE_CAP_MS = 2 * 60 * 60_000;
/** A re-probe that never reported back frees the slot after this long. */
export const ROUTE_PROBE_LEASE_MS = 3 * 60_000;

export function routeProbeDelayMs(probes: number): number {
  return Math.min(ROUTE_PROBE_CAP_MS, ROUTE_PROBE_BASE_MS * 2 ** Math.max(0, probes));
}

/** Where limits survive a restart (the world DB's core memory, attached at boot). */
export interface RouteHealthStore {
  load(): RouteLimit[];
  save(provider: string, limit: RouteLimit | undefined): void;
}

const limits = new Map<string, RouteLimit>();
let store: RouteHealthStore | undefined;

function persist(provider: string): void {
  if (!store) return;
  try {
    store.save(provider, limits.get(provider));
  } catch (error) {
    logger.warn("model-api", "route health not persisted", {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Attach the persistent store (loads its limits); returns the detach. */
export function attachRouteHealthStore(next: RouteHealthStore, now = Date.now()): () => void {
  store = next;
  try {
    for (const limit of next.load()) {
      if (!limit?.provider || !Number.isFinite(limit.until)) continue;
      // A limit whose reset passed long ago is stale; the next call re-probes anyway.
      if (limit.resetAt !== undefined && limit.resetAt < now - ROUTE_PROBE_CAP_MS) continue;
      const { probingSince: _, ...kept } = limit;
      limits.set(limit.provider, kept);
    }
  } catch (error) {
    logger.warn("model-api", "route health not loaded", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return () => {
    if (store === next) store = undefined;
  };
}

/** Core-memory owner the world DB keeps route limits under (one row per provider). */
export const ROUTE_HEALTH_OWNER = "route:health";

/** A {@link RouteHealthStore} over core memory (`owner route:health`, key = provider). */
export function coreMemoryRouteStore(db: {
  setCoreMemory(entityName: string, key: string, value: string): void;
  listCoreMemory(entityName: string): { key: string; value: string }[];
  deleteCoreMemory(entityName: string, key: string): boolean;
}): RouteHealthStore {
  return {
    load: () =>
      db.listCoreMemory(ROUTE_HEALTH_OWNER).flatMap((row) => {
        try {
          return [JSON.parse(row.value) as RouteLimit];
        } catch {
          return [];
        }
      }),
    save: (provider, limit) => {
      if (limit) db.setCoreMemory(ROUTE_HEALTH_OWNER, provider, JSON.stringify(limit));
      else db.deleteCoreMemory(ROUTE_HEALTH_OWNER, provider);
    },
  };
}

/**
 * Record a refusal on `provider`'s route. Only a usage limit marks the route;
 * returns the limit then, else undefined. A refused re-probe lengthens the
 * backoff; a named reset in the future always wins.
 */
export function noteRouteRefusal(
  provider: string,
  refusal: UpstreamRefusal,
  now = Date.now(),
): RouteLimit | undefined {
  if (refusal.kind !== "usage-limit" || !provider) return undefined;
  const prior = limits.get(provider);
  const probes = prior
    ? prior.probes + (prior.probingSince !== undefined || now >= prior.until ? 1 : 0)
    : 0;
  const resetAt =
    refusal.resetAt ?? (prior?.resetAt && prior.resetAt > now ? prior.resetAt : undefined);
  const until = resetAt && resetAt > now ? resetAt : now + routeProbeDelayMs(probes);
  const limit: RouteLimit = {
    provider,
    until,
    ...(resetAt ? { resetAt } : {}),
    detail: refusal.detail,
    since: prior?.since ?? now,
    probes,
  };
  limits.set(provider, limit);
  persist(provider);
  if (!prior) {
    logger.warn(
      "model-api",
      `${routeLabel(provider)}: usage limit${resetAt ? ` until ${formatResetUtc(resetAt)}` : ""} — route avoided until ${formatResetUtc(until)}`,
      { provider, route: routeIdFor(provider) },
    );
  }
  return limit;
}

/** A call on `provider`'s route succeeded: the limit (if any) is over. */
export function noteRouteOk(provider: string): void {
  const prior = limits.get(provider);
  if (!prior) return;
  limits.delete(provider);
  persist(provider);
  logger.info("model-api", `${routeLabel(provider)}: serving again — usage limit lifted`, {
    provider,
    route: routeIdFor(provider),
  });
}

/** The recorded limit on `provider`'s route (active or awaiting its re-probe). */
export function routeLimitOf(provider: string): RouteLimit | undefined {
  return limits.get(provider);
}

/** Every recorded route limit. */
export function routeLimits(): RouteLimit[] {
  return [...limits.values()];
}

/**
 * How to use `provider`'s route now: `direct` (healthy), `avoid` (limited, or
 * another caller is re-probing), or `probe` — the limit's time is up and THIS
 * caller makes the one re-probe call (report back with {@link noteRouteOk} /
 * {@link noteRouteRefusal}; an unreported probe frees the slot after
 * {@link ROUTE_PROBE_LEASE_MS}).
 */
export function routeChoice(provider: string, now = Date.now()): "direct" | "probe" | "avoid" {
  const limit = limits.get(provider);
  if (!limit) return "direct";
  if (now < limit.until) return "avoid";
  if (limit.probingSince !== undefined && now - limit.probingSince < ROUTE_PROBE_LEASE_MS)
    return "avoid";
  limit.probingSince = now;
  return "probe";
}

/** True while `provider`'s route should not be called (no probe slot taken). */
export function routeLimited(provider: string, now = Date.now()): boolean {
  const limit = limits.get(provider);
  return !!limit && now < limit.until;
}

/** `usage limit until 2026-11-01 00:00 UTC` / `usage limit, re-probe 14:20 UTC`. */
export function describeLimit(limit: RouteLimit): string {
  return limit.resetAt
    ? `usage limit until ${formatResetUtc(limit.resetAt)}`
    : `usage limit (reset not stated), re-probe ${formatResetUtc(limit.until)}`;
}

// ─── Same-model fallback ─────────────────────────────────────────────────────

/** `MARINA_PROVIDER_FALLBACK=off` keeps a usage-limited route's callers paused instead. */
export function routeFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARINA_PROVIDER_FALLBACK ?? "").trim().toLowerCase() !== "off";
}

export interface SameModelRoute {
  provider: "openrouter";
  /** OpenRouter's id for the same model (`anthropic/claude-opus-5.5`). */
  model: string;
}

/**
 * The same model on OpenRouter for a first-party `provider/modelId`, when:
 * fallback is on, an OpenRouter key exists, OpenRouter's own route is not
 * limited, and OpenRouter's live catalog lists the mapped id
 * (`openRouterSameModel`). Undefined otherwise — the caller keeps its own
 * behaviour; a different model is never substituted.
 */
export async function sameModelFallback(
  provider: string,
  modelId: string,
  opts: {
    hasOpenRouterKey: boolean;
    env?: NodeJS.ProcessEnv;
    fetcher?: (url: string) => Promise<Response>;
    now?: number;
  },
): Promise<SameModelRoute | undefined> {
  if (!routeFallbackEnabled(opts.env) || !opts.hasOpenRouterKey) return undefined;
  if (AGGREGATOR_ROUTES.has(provider)) return undefined;
  if (routeLimited("openrouter", opts.now)) return undefined;
  const model = await openRouterSameModel(provider, modelId, opts.fetcher, opts.now);
  return model ? { provider: "openrouter", model } : undefined;
}

/**
 * One line naming the served route:
 * `model:anthropic/claude-opus-5-5 via:openrouter (Anthropic API (direct key): usage limit until 2026-11-01 00:00 UTC)`.
 */
export function routeNote(provider: string, modelId: string, via: string): string {
  const limit = limits.get(provider);
  const why = limit ? ` (${routeLabel(provider)}: ${describeLimit(limit)})` : "";
  return `model:${provider}/${modelId} via:${via}${why}`;
}

/** The `x-marina-route` header value for a fallback-served reply. */
export function routeHeaderValue(provider: string, via: string): string {
  const limit = limits.get(provider);
  const parts = [`via=${via}`, `${routeIdFor(provider)}=usage-limit`];
  if (limit?.resetAt) parts.push(`until=${new Date(limit.resetAt).toISOString()}`);
  return parts.join("; ");
}

/**
 * Route status lines for readiness — distinct from Marina's own daily spend
 * cap: `anthropic (direct key): usage limit until 2026-11-01 00:00 UTC;
 * anthropic models served via openrouter`.
 */
export function describeRouteHealth(opts: {
  hasOpenRouterKey: boolean;
  env?: NodeJS.ProcessEnv;
}): string[] {
  return routeLimits().map((limit) => {
    const head = `${limit.provider}${AGGREGATOR_ROUTES.has(limit.provider) ? "" : " (direct key)"}: ${describeLimit(limit)}`;
    if (AGGREGATOR_ROUTES.has(limit.provider)) return head;
    const served =
      routeFallbackEnabled(opts.env) && opts.hasOpenRouterKey && !routeLimited("openrouter")
        ? `${limit.provider} models served via openrouter (same model, when OpenRouter lists it)`
        : `no other route configured — ${limit.provider} models wait for the reset${routeFallbackEnabled(opts.env) ? " (set OPENROUTER_API_KEY to serve them via OpenRouter)" : " (MARINA_PROVIDER_FALLBACK=off)"}`;
    return `${head}; ${served}`;
  });
}

/** Test seam. */
export function resetRouteHealthForTests(): void {
  limits.clear();
  store = undefined;
}
