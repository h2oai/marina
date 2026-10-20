// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cache-aware idle handling for the agent loop.
 *
 * A provider's prompt cache lives a few minutes (Anthropic: 5 min by default)
 * from the request that last used it. A resident's next prompt after a longer
 * gap is therefore COLD: the whole request — tools, system prompt and history
 * — is written to the cache again, at 1.25× the input price. This module holds
 * the pure policy (which providers cache, for how long, when a turn is cold,
 * when to compact before it, the optional keep-alive and 1 h static-prefix
 * TTL) and a small per-agent tracker for the metrics. The adapter supplies the
 * clock, the transcript and the model calls.
 */

import { parseDuration } from "../engine/commands/format-duration";
import type { ConversationTokenCap } from "./context-manager";

/** The minimal model shape the policy reads. */
export interface CacheModel {
  provider: string;
  api: string;
  id: string;
  /** True for the synthesized `marina/*` loopback model. */
  proxied?: boolean;
  /** True for a local inference server (no prompt cache to keep warm). */
  local?: boolean;
}

/** Built-in cache lifetimes per provider family (ms). Unlisted ⇒ no cache known. */
export const DEFAULT_PROMPT_CACHE_TTLS: Readonly<Record<string, number>> = {
  anthropic: 5 * 60_000,
  bedrock: 5 * 60_000,
  marina: 5 * 60_000,
  openrouter: 5 * 60_000,
  openai: 5 * 60_000,
};

/** The provider family whose prompt cache a request lands in; undefined = none known. */
export function promptCacheFamily(
  model: CacheModel,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (model.local) return undefined;
  if (model.proxied) {
    // `MARINA_AGENT_PROMPT_CACHE=off` strips the markers and the session id.
    if ((env.MARINA_AGENT_PROMPT_CACHE ?? "").trim().toLowerCase() === "off") return undefined;
    return "marina";
  }
  const provider = model.provider.toLowerCase();
  if (provider === "anthropic" || model.api === "anthropic-messages") return "anthropic";
  if (provider === "amazon-bedrock") return "bedrock";
  if (provider === "openrouter") return "openrouter";
  if (provider === "openai" || provider.startsWith("azure-openai")) return "openai";
  return provider || undefined;
}

/**
 * `MARINA_PROMPT_CACHE_TTL`: a default lifetime (`5m`), per-family lifetimes
 * (`anthropic=5m,openai=10m`), or both (`5m,deepseek=off`). `off`/`0` says the
 * family keeps no cache (no turn is ever cold). Junk entries are ignored.
 */
export function parsePromptCacheTtls(raw: string | undefined): {
  fallback?: number | null;
  families: Record<string, number | null>;
} {
  const families: Record<string, number | null> = {};
  let fallback: number | null | undefined;
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const value = eq === -1 ? entry : entry.slice(eq + 1).trim();
    const ms = value === "off" || value === "0" ? null : parseDuration(value);
    if (ms === undefined) continue;
    if (eq === -1) fallback = ms;
    else families[entry.slice(0, eq).trim()] = ms;
  }
  return { ...(fallback !== undefined ? { fallback } : {}), families };
}

/** How long `family`'s cache lives after a request (ms); undefined = no cache. */
export function promptCacheTtlMs(
  family: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!family) return undefined;
  const spec = parsePromptCacheTtls(env.MARINA_PROMPT_CACHE_TTL);
  if (Object.hasOwn(spec.families, family)) return spec.families[family] ?? undefined;
  const builtin = DEFAULT_PROMPT_CACHE_TTLS[family];
  if (builtin === undefined) return undefined;
  if (spec.fallback !== undefined) return spec.fallback ?? undefined;
  return builtin;
}

/** A turn is cold when its cache has expired since the last request. */
export function isColdTurn(lastRequestAt: number, now: number, ttlMs: number | undefined): boolean {
  return ttlMs !== undefined && lastRequestAt > 0 && now - lastRequestAt > ttlMs;
}

const off = (raw: string | undefined) => {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "false" || v === "0";
};
const on = (raw: string | undefined) => {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
};

/** Smallest cut a cold-turn compaction must make to be worth a summarizer call. */
export const COLD_COMPACT_MIN_SAVING_TOKENS = 8_000;

/**
 * The history size (estimated tokens) from which a cold turn compacts first
 * (`MARINA_AGENT_COLD_COMPACT`, default on; `MARINA_AGENT_COLD_COMPACT_MIN_TOKENS`,
 * default the cap's target + 8000 — 24000 under the built-in 48k/16k cap).
 * Undefined when off or when no conversation cap is in force (no target to
 * compact to). Never at or above the cap itself: the cap already compacts there.
 */
export function coldCompactionThreshold(
  cap: ConversationTokenCap | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!cap || off(env.MARINA_AGENT_COLD_COMPACT)) return undefined;
  const floor = cap.targetTokens + COLD_COMPACT_MIN_SAVING_TOKENS;
  const raw = Number(env.MARINA_AGENT_COLD_COMPACT_MIN_TOKENS);
  const chosen = Number.isFinite(raw) && raw > 0 ? Math.max(Math.floor(raw), floor) : floor;
  return chosen < cap.capTokens ? chosen : undefined;
}

/**
 * `MARINA_PROMPT_CACHE_STATIC_TTL` (default `1h`): mark the static prefix —
 * tool schemas and the system prompt — with a one-hour cache lifetime while
 * the conversation keeps the 5-minute one. Only where the request format
 * carries a per-breakpoint TTL: direct Anthropic Messages requests.
 */
export function staticPrefixTtl(
  model: Pick<CacheModel, "provider" | "api"> & {
    compat?: { supportsLongCacheRetention?: boolean } | unknown;
  },
  env: NodeJS.ProcessEnv = process.env,
): "1h" | undefined {
  const raw = (env.MARINA_PROMPT_CACHE_STATIC_TTL ?? "1h").trim().toLowerCase();
  if (raw !== "1h") return undefined;
  // pi-ai's own long-retention flag: a model that refuses `ttl` says so here.
  const compat = model.compat as { supportsLongCacheRetention?: boolean } | undefined;
  if (compat?.supportsLongCacheRetention === false) return undefined;
  return model.api === "anthropic-messages" && model.provider === "anthropic" ? "1h" : undefined;
}

/**
 * Rewrite an Anthropic Messages payload so the tool and system breakpoints
 * carry `ttl: "1h"`. Longer lifetimes must precede shorter ones; tools and
 * system come before the messages, so the conversation's 5-minute breakpoint
 * stays last. Returns undefined when nothing changes (no breakpoints there,
 * or already marked).
 */
export function withStaticPrefixTtl(
  payload: unknown,
  ttl: "1h" | undefined,
): Record<string, unknown> | undefined {
  if (!ttl || typeof payload !== "object" || payload === null || Array.isArray(payload))
    return undefined;
  const body = payload as Record<string, unknown>;
  let changed = false;
  const mark = <T>(block: T): T => {
    if (!block || typeof block !== "object") return block;
    const cc = (block as { cache_control?: Record<string, unknown> }).cache_control;
    if (!cc || typeof cc !== "object" || cc.ttl === ttl) return block;
    changed = true;
    return { ...block, cache_control: { ...cc, ttl } };
  };
  const system = Array.isArray(body.system) ? body.system.map(mark) : body.system;
  const tools = Array.isArray(body.tools) ? body.tools.map(mark) : body.tools;
  if (!changed) return undefined;
  return { ...body, system, tools };
}

/** Keep-alive settings (`MARINA_AGENT_CACHE_KEEPALIVE*`); undefined when off (the default). */
export interface KeepAlivePolicy {
  /** Ping this long after the last request (TTL minus a margin). */
  intervalMs: number;
  /** Ping only while the last real prompt is at most this old. */
  windowMs: number;
  /** Pings per idle gap. */
  maxPerGap: number;
  /** Spend bound per agent per UTC day. */
  dailyUsd: number;
}

export function keepAlivePolicy(
  ttlMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): KeepAlivePolicy | undefined {
  if (!on(env.MARINA_AGENT_CACHE_KEEPALIVE) || ttlMs === undefined || ttlMs < 60_000)
    return undefined;
  const windowMs = parseDuration(env.MARINA_AGENT_CACHE_KEEPALIVE_WINDOW?.trim()) ?? 30 * 60_000;
  const max = Number(env.MARINA_AGENT_CACHE_KEEPALIVE_MAX);
  const usd = Number(env.MARINA_AGENT_CACHE_KEEPALIVE_DAILY_USD);
  return {
    intervalMs: ttlMs - Math.min(30_000, Math.floor(ttlMs / 10)),
    windowMs,
    maxPerGap: Number.isFinite(max) && max >= 0 ? Math.floor(max) : 6,
    dailyUsd: Number.isFinite(usd) && usd >= 0 ? usd : 0.5,
  };
}

/** Lifetime prompt-cache counters an operator reads in `agent status`. */
export interface PromptCacheMetrics {
  /** Prompts sent after the cache had expired. */
  coldTurns: number;
  /** History compactions run because the next turn was cold. */
  coldCompactions: number;
  /** Estimated tokens / bytes not rewritten to the cache thanks to them. */
  coldWriteTokensAvoided: number;
  coldWriteBytesAvoided: number;
  keepAlives: number;
  keepAliveCostUsd: number;
}

/**
 * Per-agent state: when the cache was last touched, the keep-alive bounds for
 * the current gap and the day, and the counters.
 */
export class PromptCacheTracker {
  lastRequestAt = 0;
  lastPromptAt = 0;
  private gapPings = 0;
  private day = "";
  private dayUsd = 0;
  /** Set when a keep-alive did not read the cache: never ping again. */
  disabled = false;
  readonly metrics: PromptCacheMetrics = {
    coldTurns: 0,
    coldCompactions: 0,
    coldWriteTokensAvoided: 0,
    coldWriteBytesAvoided: 0,
    keepAlives: 0,
    keepAliveCostUsd: 0,
  };

  /** A real model request: the cache is fresh again. */
  noteRequest(at: number): void {
    this.lastRequestAt = at;
  }

  /** A real prompt: a new gap starts after it. */
  notePrompt(at: number): void {
    this.lastPromptAt = at;
    this.gapPings = 0;
  }

  /** Why no keep-alive is due now, or null when one is. */
  keepAliveRefusal(policy: KeepAlivePolicy | undefined, now: number): string | null {
    if (!policy) return "off";
    if (this.disabled) return "disabled";
    if (this.lastRequestAt === 0 || this.lastPromptAt === 0) return "no request yet";
    if (now - this.lastRequestAt < policy.intervalMs) return "not due";
    if (now - this.lastPromptAt > policy.windowMs) return "outside window";
    if (this.gapPings >= policy.maxPerGap) return "gap cap";
    if (this.spentToday(now) >= policy.dailyUsd) return "daily cap";
    return null;
  }

  noteKeepAlive(at: number, costUsd: number): void {
    this.gapPings++;
    this.spentToday(at);
    this.dayUsd += costUsd;
    this.lastRequestAt = at;
    this.metrics.keepAlives++;
    this.metrics.keepAliveCostUsd += costUsd;
  }

  private spentToday(now: number): number {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dayUsd = 0;
    }
    return this.dayUsd;
  }
}

/**
 * Whether a keep-alive reply actually kept the cache: it must have READ the
 * cached prefix and written almost nothing. A miss means the replayed request
 * no longer matches the cache — stop rather than pay for full rewrites.
 */
export function keepAliveHit(usage: {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): boolean {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  return read > 0 && write <= Math.max(1024, read * 0.05);
}
