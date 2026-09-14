// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Passthru response cache — exact-match reuse of proxied completions, stored
 * on the durable memory service's pinned result cache (`cache_put/cache_get`,
 * see docs/guides/memory-service.md "Review and reusable results").
 *
 * Scope and rules:
 *  - Opt-in per bound identity (`passthruResponseCache` entity property) or,
 *    under the LOCAL trust profile only, `MARINA_PASSTHRU_RESPONSE_CACHE=on`.
 *  - The key is the SHA-256 of the canonicalized EFFECTIVE request — model id,
 *    messages/instructions AFTER memory injection, tools and sampling params —
 *    so a different memory context is a different key. The service adds the
 *    resident space's evidence generation and the declared pins on every read,
 *    so a revised or forgotten premise invalidates reuse conservatively.
 *  - Pins come from the memory receipt: durable [evidence] records by version
 *    and captured sources by content hash. The service refuses an empty pin
 *    set, so a response is cached ONLY when at least one pinned record or
 *    source shaped the prompt — legacy notes / proposals alone never cache.
 *  - Never cached: streaming responses, tool-call responses, non-2xx, and any
 *    request from the shared/anonymous passthru identity (it has no space).
 *  - Semantic (similarity-based) caching is explicitly OUT of scope: the key
 *    is byte-exact by design so a cache hit can never change an answer.
 */

import { createHash } from "node:crypto";
import { isLocalProfile } from "../engine/trust-profile";
import { residentMemoryOperation } from "../memory/resident-service";
import type { MarinaDB } from "../persistence/database";
import type { MemoryCacheResult } from "../sdk/memory-types";
import type { Entity } from "../types";
import { type MemoryReceipt, memoryReceiptPins, parseMemoryReceipt } from "./memory-receipt";

export const RESPONSE_CACHE_POLICY = "marina.passthru.response-cache.v1";
export const RESPONSE_CACHE_HEADER = "x-marina-cache";
export const CACHED_RESPONSE_SCHEMA = "marina.passthru.cached-response.v1" as const;
export const DEFAULT_RESPONSE_CACHE_TTL_MS = 60 * 60 * 1000;
const RESPONSE_CACHE_PROP = "passthruResponseCache";
/** Service-side entry cap (64 KiB); keep headroom for the envelope. */
const MAX_ENTRY_BYTES = 65_536;

/** Request fields that define the effective completion. Anything else (stream
 *  flag, user tag, client metadata) is deliberately excluded from the key. */
const CACHE_KEY_FIELDS = [
  "model",
  "messages",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "stop",
  "seed",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "reasoning_effort",
  "reasoning",
] as const;

export interface CachedPassthruResponse {
  schema: typeof CACHED_RESPONSE_SCHEMA;
  status: number;
  contentType: string;
  /** Parsed upstream JSON (OpenAI chat-completion shape — every surface translates from it). */
  body: unknown;
  /** The receipt of the request that produced the cached completion. */
  receipt: MemoryReceipt;
  storedAt: number;
}

export type ResponseCacheLookup =
  | { hit: true; key: string; value: CachedPassthruResponse }
  | { hit: false; key: string; reason: string };

/**
 * In-memory process counters read by the memory observability overview
 * (`/api/memory/overview` → `receipts.cache`). Observability only — they
 * never influence caching decisions and reset with the process.
 */
export const responseCacheCounters = { hits: 0, misses: 0, stores: 0 };

export function resetResponseCacheCounters(): void {
  responseCacheCounters.hits = 0;
  responseCacheCounters.misses = 0;
  responseCacheCounters.stores = 0;
}

export function responseCacheEnabled(
  entity: Entity,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = entity.properties[RESPONSE_CACHE_PROP];
  if (configured === true || configured === "on" || configured === "true") return true;
  if (configured === false || configured === "off" || configured === "false") return false;
  return isLocalProfile(env) && env.MARINA_PASSTHRU_RESPONSE_CACHE?.trim().toLowerCase() === "on";
}

export function responseCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.MARINA_PASSTHRU_RESPONSE_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESPONSE_CACHE_TTL_MS;
}

/** Deterministic JSON: object keys sorted recursively, array order preserved. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** SHA-256 over the canonicalized effective request (post-injection body). */
export function responseCacheKey(body: Record<string, unknown>, modelIdentity: string): string {
  const picked: Record<string, unknown> = { __model: modelIdentity };
  for (const field of CACHE_KEY_FIELDS) {
    if (body[field] !== undefined) picked[field] = body[field];
  }
  return createHash("sha256").update(canonicalJson(picked)).digest("hex");
}

function cacheIdentity(key: string, modelIdentity: string) {
  return {
    inputs: { request_sha256: key, surface: "passthru" },
    model: modelIdentity.slice(0, 256),
    policy: RESPONSE_CACHE_POLICY,
  };
}

/** True when the upstream completion carries no tool calls (text-only answers reuse safely). */
export function cacheableCompletion(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const choice of choices) {
    const c = choice as {
      message?: { tool_calls?: unknown; function_call?: unknown; content?: unknown };
      finish_reason?: unknown;
    };
    if (c.finish_reason === "tool_calls" || c.finish_reason === "function_call") return false;
    const calls = c.message?.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) return false;
    if (c.message?.function_call) return false;
  }
  return true;
}

function isCachedResponse(value: unknown): value is CachedPassthruResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CachedPassthruResponse>;
  return (
    v.schema === CACHED_RESPONSE_SCHEMA &&
    typeof v.status === "number" &&
    typeof v.contentType === "string" &&
    v.body !== undefined &&
    parseMemoryReceipt(v.receipt) !== undefined
  );
}

/**
 * Look up a cached completion for `entityName`'s resident space. Every failure
 * (no world account, service error, malformed value) is a miss — the cache is
 * an optimization and must never block inference.
 */
export async function lookupResponseCache(
  db: MarinaDB,
  entityName: string,
  body: Record<string, unknown>,
  modelIdentity: string,
): Promise<ResponseCacheLookup> {
  const key = responseCacheKey(body, modelIdentity);
  try {
    const result = await residentMemoryOperation(db, entityName, {
      operation: "cache_get",
      input: cacheIdentity(key, modelIdentity),
    });
    const outcome = result.result as MemoryCacheResult;
    if (!outcome.hit) {
      responseCacheCounters.misses++;
      return { hit: false, key, reason: outcome.reason };
    }
    if (!isCachedResponse(outcome.value)) {
      responseCacheCounters.misses++;
      return { hit: false, key, reason: "invalid" };
    }
    responseCacheCounters.hits++;
    return { hit: true, key, value: outcome.value };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "error";
    responseCacheCounters.misses++;
    return { hit: false, key, reason: code };
  }
}

export type ResponseCacheStore = { stored: true; key: string } | { stored: false; reason: string };

/**
 * Store a completed upstream response. `response` must be an unconsumed clone;
 * the caller decides eligibility of the REQUEST (non-stream, identified,
 * opted-in) while this function checks the RESPONSE (2xx JSON, no tool calls,
 * size, at least one pin).
 */
export async function storeResponseCache(
  db: MarinaDB,
  entityName: string,
  body: Record<string, unknown>,
  modelIdentity: string,
  response: Response,
  receipt: MemoryReceipt,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<ResponseCacheStore> {
  if (!response.ok) return { stored: false, reason: "not_ok" };
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) return { stored: false, reason: "streaming" };
  const pins = memoryReceiptPins(receipt);
  if (pins.records.length + pins.sources.length === 0) return { stored: false, reason: "no_pins" };
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { stored: false, reason: "not_json" };
  }
  if (!cacheableCompletion(data)) return { stored: false, reason: "tool_calls" };

  const key = responseCacheKey(body, modelIdentity);
  const now = opts.now ?? Date.now();
  const value: CachedPassthruResponse = {
    schema: CACHED_RESPONSE_SCHEMA,
    status: response.status,
    contentType: contentType || "application/json",
    body: data,
    receipt,
    storedAt: now,
  };
  const input = {
    ...cacheIdentity(key, modelIdentity),
    value,
    records: pins.records.slice(0, 32),
    sources: pins.sources.slice(0, Math.max(0, 32 - Math.min(32, pins.records.length))),
    expires_at: now + (opts.ttlMs ?? responseCacheTtlMs()),
  };
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_ENTRY_BYTES) {
    return { stored: false, reason: "too_large" };
  }
  try {
    await residentMemoryOperation(db, entityName, {
      operation: "cache_put",
      input,
      // Idempotency key: unique per put so a refreshed answer after expiry is
      // never mistaken for a replay of the earlier one.
      key: `passthru-cache:${key.slice(0, 40)}:${now.toString(36)}`,
    });
    responseCacheCounters.stores++;
    return { stored: true, key };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "error";
    return { stored: false, reason: code };
  }
}
