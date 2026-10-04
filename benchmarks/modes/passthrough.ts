// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CallUsage, Message } from "../types";

// Env-overridable upper bound. Reasoning-heavy problems (competition math,
// multi-hop, debate-council orchestrations) can legitimately take minutes.
// Single passthrough substrates finish in seconds and aren't affected.
// Set to effectively off (10 min) so we don't bound correctness on wall time.
// Read per call, so `harness.ts --timeout` (which sets HARNESS_TIMEOUT_MS)
// applies to every adapter without threading a parameter through each one.
export function defaultTimeoutMs(): number {
  const v = Number.parseInt(process.env.HARNESS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

/** Header a Marina `/v1` passthru sets with the upstream dollar cost of the call. */
const MARINA_COST_HEADER = "x-marina-cost-usd";

/**
 * Usage of one completion as the endpoint reported it. Nothing is estimated:
 * a field the endpoint did not report stays undefined. Cost comes from Marina's
 * `x-marina-cost-usd` header, else from `usage.cost` (OpenRouter's accounting).
 */
export function usageFromResponse(
  body: { usage?: Record<string, unknown> } | undefined,
  costHeader: string | null,
): CallUsage {
  const usage = body?.usage ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const headerCost = costHeader !== null ? Number.parseFloat(costHeader) : Number.NaN;
  const costUsd = Number.isFinite(headerCost) ? headerCost : num(usage.cost);
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    costUsd,
  };
}

export interface QueryResult {
  content: string;
  usage: CallUsage;
  /**
   * The endpoint's `x-request-id`. On a Marina it is the request's traceId, so
   * the ledger can resolve who worked on the item (`POST /v1/benchmarks/runs`).
   */
  requestId?: string;
  /** Marina's `x-marina-repair` label: the answer reached the endpoint through output repair. */
  repaired?: string;
  /**
   * From Marina's `x-marina-verify` label (the verification formation): the
   * checker approved (`passed`), found issues (`failed`), or never ran
   * (`not_run`: checker unavailable — the draft went out unchecked).
   */
  verification?: "passed" | "failed" | "not_run";
}

/** The ledger's verification state for a `x-marina-verify` label; undefined when absent. */
export function verificationFromLabel(
  label: string | null | undefined,
): QueryResult["verification"] {
  if (!label) return undefined;
  if (label === "approved") return "passed";
  if (label === "checker-unavailable") return "not_run";
  return "failed"; // revised, flagged, revision-failed, held-write: the check found a problem
}

/** The per-item labels a reply carries for the ledger (spread into a `ResultItem`). */
export function replyLabels(reply: QueryResult): { verification?: QueryResult["verification"] } {
  return reply.verification ? { verification: reply.verification } : {};
}

/**
 * Dead-target detection. A per-request timeout bounds one item, but a target
 * that stopped answering (a crashed or frozen server) would still cost the full
 * timeout per remaining item: hours for a long run. After
 * `DEAD_TARGET_AFTER_TIMEOUTS` consecutive timeouts on an endpoint, each new
 * request first probes `<endpoint>/health`. Any HTTP reply, even a 404, means
 * alive-but-slow and the request proceeds. No reply within the probe timeout
 * means the endpoint is dead: requests fail at once, and it is re-probed at
 * most once per `DEAD_TARGET_REPROBE_MS`. Any answered request clears the state.
 */
export const DEAD_TARGET_AFTER_TIMEOUTS = 2;
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const DEAD_TARGET_REPROBE_MS = 60_000;
const consecutiveTimeouts = new Map<string, number>();
const deadUntil = new Map<string, number>();

/** Forget every endpoint's timeout and dead state (tests). */
export function resetEndpointHealth(): void {
  consecutiveTimeouts.clear();
  deadUntil.clear();
}

async function endpointResponds(endpoint: string, probeTimeoutMs: number): Promise<boolean> {
  try {
    const resp = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    await resp.body?.cancel();
    return true;
  } catch {
    return false; // allow-empty-catch: no reply within the probe timeout is the answer
  }
}

/** Throws when the endpoint is known or found dead; returns when it may be called. */
async function assertEndpointAlive(endpoint: string, probeTimeoutMs: number): Promise<void> {
  const timeouts = consecutiveTimeouts.get(endpoint) ?? 0;
  if (timeouts < DEAD_TARGET_AFTER_TIMEOUTS) return;
  const dead = (deadUntil.get(endpoint) ?? 0) > Date.now();
  if (!dead && (await endpointResponds(endpoint, probeTimeoutMs))) return;
  if (!dead) deadUntil.set(endpoint, Date.now() + DEAD_TARGET_REPROBE_MS);
  throw new Error(
    `target unresponsive: ${timeouts} consecutive timeouts and ${endpoint}/health did not answer`,
  );
}

/** One chat completion, with the usage and cost the endpoint reported. */
export async function queryWithUsage(
  endpoint: string,
  model: string,
  messages: Message[],
  apiKey?: string,
  timeoutMs = defaultTimeoutMs(),
  probeTimeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<QueryResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  await assertEndpointAlive(endpoint, probeTimeoutMs);
  const maxAttempts = 6;
  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, temperature: 0 }),
        signal: controller.signal,
        // Bun's fetch fails a socket idle for 5 minutes on its own
        // (BUN_CONFIG_HTTP_IDLE_TIMEOUT), before `timeoutMs` ever fires; a
        // non-streaming answer from a deliberating crew is silent until it
        // lands. The idle deadline follows the harness bound instead.
        timeout: timeoutMs,
      });

      if (resp.status === 429 && attempt < maxAttempts) {
        await resp.text().catch(() => "");
        const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`API error ${resp.status}: ${text}`);
      }
      const data = (await resp.json()) as {
        choices: { message: { content: string | null }; finish_reason?: string }[];
        usage?: Record<string, unknown>;
      };
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (content === undefined) {
        throw new Error("API response missing choices[0].message.content");
      }
      // A reasoning model that spends its whole budget thinking returns
      // `content: null`: an empty answer (scored wrong), never a crash.
      const requestId = resp.headers.get("x-request-id") ?? undefined;
      const repaired = resp.headers.get("x-marina-repair") ?? undefined;
      const verification = verificationFromLabel(resp.headers.get("x-marina-verify"));
      consecutiveTimeouts.delete(endpoint);
      deadUntil.delete(endpoint);
      return {
        content: content ?? "",
        usage: usageFromResponse(data, resp.headers.get(MARINA_COST_HEADER)),
        ...(requestId ? { requestId } : {}),
        ...(repaired ? { repaired } : {}),
        ...(verification ? { verification } : {}),
      };
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "TimeoutError")) {
        consecutiveTimeouts.set(endpoint, (consecutiveTimeouts.get(endpoint) ?? 0) + 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function query(
  endpoint: string,
  model: string,
  messages: Message[],
  apiKey?: string,
  timeoutMs = defaultTimeoutMs(),
): Promise<string> {
  return (await queryWithUsage(endpoint, model, messages, apiKey, timeoutMs)).content;
}

export async function queryMultiTurn(
  endpoint: string,
  model: string,
  turns: string[],
  apiKey?: string,
  timeoutMs = defaultTimeoutMs(),
): Promise<string[]> {
  const messages: Message[] = [];
  const responses: string[] = [];

  for (const turn of turns) {
    messages.push({ role: "user", content: turn });
    const response = await query(endpoint, model, messages, apiKey, timeoutMs);
    messages.push({ role: "assistant", content: response });
    responses.push(response);
  }

  return responses;
}
