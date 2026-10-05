// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A loopback proxy that lets an outside evaluator (a benchmark's official
 * Python judge) call OpenRouter on our key under a hard dollar cap:
 *
 *   - binds 127.0.0.1 on an ephemeral port; the evaluator gets a dummy key and
 *     this base URL, so the real key never enters its environment;
 *   - forwards `POST …/chat/completions` bodies unchanged except that it asks
 *     OpenRouter to report the call's cost (`usage.include`);
 *   - meters every reply's `usage.cost` (else tokens × the live list price),
 *     records it in the daily spend ledger, and refuses further calls with 429
 *     once the cap is reached or the world's daily cap refuses;
 *   - only the models in `allowModels` pass (the official judges), so the key
 *     cannot be used for anything else through it.
 *
 * Spend overshoot is bounded by the calls in flight when the cap is reached.
 */

import { openRouterModelPrice } from "../src/agent/provider-cost";
import { dailyCapRefusal, recordSpend } from "../src/engine/spend-ledger";

export interface JudgeProxyOptions {
  apiKey: string;
  /** Hard cap for this proxy's life, USD. */
  maxUsd: number;
  /** OpenRouter model ids the evaluator may call (e.g. `openai/gpt-5.5`). */
  allowModels: readonly string[];
  upstream?: string;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}

export interface JudgeProxy {
  /** Base URL ending in `/api/v1` (OpenRouter's shape). */
  baseUrl: string;
  spentUsd(): number;
  calls(): { ok: number; refused: number; failed: number };
  /** Cost per model, for the audit trail. */
  byModel(): Record<
    string,
    { calls: number; usd: number; promptTokens: number; completionTokens: number }
  >;
  stop(): void;
}

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

function refusal(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startJudgeProxy(opts: JudgeProxyOptions): JudgeProxy {
  const fetcher = opts.fetcher ?? fetch;
  let spent = 0;
  const counts = { ok: 0, refused: 0, failed: 0 };
  const models: ReturnType<JudgeProxy["byModel"]> = {};
  const allowed = new Set(opts.allowModels);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST" || !path.endsWith("/chat/completions"))
        return refusal(404, "not_found", "only POST …/chat/completions is proxied");
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return refusal(400, "bad_json", "body is not JSON");
      }
      const model = String(body.model ?? "");
      if (!allowed.has(model)) {
        counts.refused++;
        return refusal(403, "model_not_allowed", `model ${model} is not an allowed judge`);
      }
      const capped = dailyCapRefusal();
      if (spent >= opts.maxUsd || capped) {
        counts.refused++;
        return refusal(429, "spend_cap_reached", capped ?? `judge cap $${opts.maxUsd} reached`);
      }
      const res = await fetcher(opts.upstream ?? OPENROUTER, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
          "x-title": "Marina benchmark judge",
        },
        body: JSON.stringify({ ...body, usage: { include: true } }),
        signal: AbortSignal.timeout(900_000),
      }).catch((err: unknown) => err as Error);
      if (res instanceof Error) {
        counts.failed++;
        return refusal(502, "upstream_unreachable", res.message);
      }
      const text = await res.text();
      if (!res.ok) {
        counts.failed++;
        return new Response(text, {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      }
      let usd = 0;
      let usage: { cost?: number; prompt_tokens?: number; completion_tokens?: number } = {};
      try {
        usage = ((JSON.parse(text) as { usage?: typeof usage }).usage ?? {}) as typeof usage;
        usd = typeof usage.cost === "number" ? usage.cost : 0;
        if (!(usd > 0)) {
          const price = await openRouterModelPrice(model);
          if (price)
            usd =
              ((usage.prompt_tokens ?? 0) * price.input +
                (usage.completion_tokens ?? 0) * price.output) /
              1e6;
        }
      } catch {
        // allow-empty-catch: an unparseable body is passed through; its cost stays unknown (0)
      }
      spent += usd;
      recordSpend("model_api", usd);
      const m = (models[model] ??= { calls: 0, usd: 0, promptTokens: 0, completionTokens: 0 });
      m.calls++;
      m.usd += usd;
      m.promptTokens += usage.prompt_tokens ?? 0;
      m.completionTokens += usage.completion_tokens ?? 0;
      counts.ok++;
      opts.log?.(
        `judge ${model}: $${usd.toFixed(4)} (total $${spent.toFixed(2)} of $${opts.maxUsd})`,
      );
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/api/v1`,
    spentUsd: () => spent,
    calls: () => ({ ...counts }),
    byModel: () => structuredClone(models),
    stop: () => server.stop(true),
  };
}
