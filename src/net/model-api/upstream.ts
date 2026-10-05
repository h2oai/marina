// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Direct upstream proxy: provider table + fallback order, default-model
// resolution, body preparation for OpenAI-compatible servers, textual tool-call
// normalization, lifecycle tracing + cost/cache metrics, and the provider
// conformance probe (`readiness providers`).

import { calculateCost, type Usage as PiUsage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { defaultModelPrice } from "../../agent/provider-cost";
import { localOutputBudget } from "../../engine/constants";
import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import { settleProxyCall } from "../../engine/proxy-settlement";
import { dailyCapRefusal, recordSpend } from "../../engine/spend-ledger";
import type { EngineEvent, EntityId } from "../../types";
import { estimatePrefixTokens, minCacheableTokens } from "../anthropic-tools";
import { getDefaultUpstreamModel } from "../default-models";
import {
  encodeMemoryReceiptAttribute,
  encodeMemoryReceiptHeader,
  MEMORY_RECEIPT_HEADER,
  type MemoryReceipt,
} from "../memory-receipt";
import {
  isLocalProvider,
  LOCAL_PROVIDERS,
  localProviderBaseUrl,
  localProviderContextWindow,
} from "../model-discovery";
import { openaiErrorBody, UnsupportedParameterError } from "../openai-errors";
import type { InjectionFormat } from "../passthru-context";
import {
  normalizeTextualToolCalls,
  type StreamEvent,
  ToolCallStreamParser,
} from "../tool-call-normalize";
import {
  anthropicAutoCacheEnabled,
  proxyToAnthropic,
  streamUsageSidecar,
} from "./anthropic-bridge";
import {
  CACHE_READ_TOKENS_HEADER,
  CACHE_WRITE_TOKENS_HEADER,
  COST_USD_HEADER,
  errorJson,
  isMarinaModel,
  json,
  MODEL_CORS,
  newRequestId,
  openaiStreamChunk,
  openaiStreamRoleChunk,
  requestTrace,
  SSE_HEADERS,
  UPSTREAM_MODEL_HEADER,
  upstreamAbort,
  upstreamTimeoutMs,
} from "./shared";

/** Module logger: upstream proxy — provider transport and HTTP-status failures. */
const logger = new Logger();

// --- Direct upstream proxy (fallback when no model agents are online) ---

// Built-in default model per provider key (direct-upstream proxy fallback, used
// when no model agent is online on the requested channel): `../default-models`.

/** OpenAI's Luna tier, current and previous generation (optionally `-pro`). */
const LUNA_MODEL = /^gpt-(?:5\.6|6)-luna(?:-pro)?$/;

/** provider → upstream endpoint. `anthropic` uses a non-OpenAI request format. */
const PROVIDER_UPSTREAM: Record<string, { url: string; envKeys: string[]; anthropic?: boolean }> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    envKeys: ["ANTHROPIC_API_KEY"],
    anthropic: true,
  },
  openai: { url: "https://api.openai.com/v1/chat/completions", envKeys: ["OPENAI_API_KEY"] },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", envKeys: ["GROQ_API_KEY"] },
  // OpenAI-compatible first-party APIs. Their keys used to count as "a
  // provider is configured" while marina/default had no route to them, so
  // every call 503'd; they are routable now.
  cerebras: { url: "https://api.cerebras.ai/v1/chat/completions", envKeys: ["CEREBRAS_API_KEY"] },
  deepseek: { url: "https://api.deepseek.com/chat/completions", envKeys: ["DEEPSEEK_API_KEY"] },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", envKeys: ["MISTRAL_API_KEY"] },
  xai: { url: "https://api.x.ai/v1/chat/completions", envKeys: ["XAI_API_KEY"] },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    envKeys: ["OPENROUTER_API_KEY"],
  },
  // Hugging Face Inference Providers router (OpenAI-compatible). Model ids are
  // Hub ids, optionally suffixed with a serving policy or provider
  // (`org/model:fastest`, `org/model:cheapest`, `org/model:<provider>`).
  huggingface: {
    url: "https://router.huggingface.co/v1/chat/completions",
    envKeys: ["HUGGINGFACE_API_KEY", "HF_TOKEN"],
  },
  // Self-hosted local runtimes, OpenAI-compatible (/chat/completions). Base URL
  // defaults to localhost (native install); override with LLAMA_BASE_URL /
  // OLLAMA_BASE_URL (docker-compose sets the in-cluster service name). Keys are
  // optional — see resolveProviderKey / the fallback loop's local handling.
  llama: {
    url: `${localProviderBaseUrl("llama")}/chat/completions`,
    envKeys: ["LLAMA_API_KEY"],
  },
  ollama: {
    url: `${localProviderBaseUrl("ollama")}/chat/completions`,
    envKeys: ["OLLAMA_API_KEY"],
  },
  // VibeThinker served via vLLM/SGLang (OpenAI-compatible). Override the base
  // URL with VIBETHINKER_BASE_URL (compose sets the in-cluster service name).
  vibethinker: {
    url: `${localProviderBaseUrl("vibethinker")}/chat/completions`,
    envKeys: ["VIBETHINKER_API_KEY"],
  },
};

/** Providers that serve other vendors' models under `<vendor>/<model>` ids. */
const AGGREGATORS = new Set(["openrouter", "huggingface"]);

// First-party providers preferred over OpenRouter on the fallback path, since
// OpenRouter is an aggregator that re-routes (and adds markup). An explicitly
// configured default model overrides this order entirely (see proxyToUpstream).
// `llama` is first: when a local model is configured (LLAMA_API_KEY set) it's the
// preferred default; deployments without that key skip it (resolveProviderKey → undefined).
const FALLBACK_PRIORITY = [
  "llama",
  "ollama",
  "anthropic",
  "openai",
  "google",
  "groq",
  "cerebras",
  "deepseek",
  "mistral",
  "xai",
  "huggingface",
  "openrouter",
];

/**
 * True if an operator has opted into a self-hosted local runtime by setting
 * either its key or its base URL. Gates the (keyless) fallback attempt so a
 * cloud-only deployment doesn't pay a failed localhost fetch on every request.
 */
function localProviderConfigured(provider: string): boolean {
  const spec = LOCAL_PROVIDERS[provider];
  return !!spec && (!!process.env[spec.keyEnv] || !!process.env[spec.baseUrlEnv]);
}

/** Resolve a provider's key from env first, then admin-panel/DB keys. */
function resolveProviderKey(engine: Engine, provider: string): string | undefined {
  const cfg = PROVIDER_UPSTREAM[provider];
  if (cfg) {
    for (const envKey of cfg.envKeys) {
      const v = process.env[envKey];
      if (v) return v;
    }
  }
  return engine.db?.getApiKeysByProvider(provider)[0]?.encrypted_value;
}

/**
 * True when `model` is `<provider>/<id>` naming an upstream this instance can
 * reach: a provider in `PROVIDER_UPSTREAM` with a key (env or admin panel), or
 * a local runtime the operator opted into. The endpoint modes that route to
 * agents (`agents` / `open` / `panel`) send such an id upstream instead of
 * looking for a `model-<id>` channel that cannot exist — the mirror of
 * `liveOrchestrationChannel`: an explicit id reaches what it names in every
 * mode. `marina` / `marina/default` ids and unprefixed ids keep their route.
 */
export function explicitUpstreamModel(engine: Engine, model: unknown): boolean {
  if (typeof model !== "string" || isMarinaModel(model)) return false;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return false;
  const provider = model.slice(0, slash);
  if (!PROVIDER_UPSTREAM[provider]) return false;
  if (isLocalProvider(provider) && localProviderConfigured(provider)) return true;
  return !!resolveProviderKey(engine, provider);
}

/**
 * The model the passthru branch pins (`forceModel`). In `passthru` endpoint
 * mode the operator's configured model wins, as always. In the agent-routing
 * modes the configured model is only the fallback for an id that names
 * nothing, so an explicit upstream id is served as named — never silently
 * answered by a different model.
 */
export function passthruForceModel(
  engine: Engine,
  ec: { mode: string; passthruModel: string },
  model: unknown,
): string {
  if (ec.mode !== "passthru" && explicitUpstreamModel(engine, model)) return "";
  return ec.passthruModel;
}

/**
 * Human-readable "what would the marina/default channel actually hit right now"
 * — mirrors proxyToUpstream's selection order without making a request. Used by
 * the boot wiring summary so it reports the concrete upstream (e.g.
 * "openai/gpt-4o") instead of the circular "marina/default". Returns undefined
 * when no upstream is configured at all.
 */
export function describeDefaultUpstream(engine: Engine): string | undefined {
  // 1) Operator-configured concrete default with a usable key wins.
  const dm = engine.db?.getDefaultModel();
  if (dm && !isMarinaModel(dm)) {
    const slash = dm.indexOf("/");
    const provider = slash >= 0 ? dm.slice(0, slash) : dm;
    const cfg = PROVIDER_UPSTREAM[provider];
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (cfg && (resolveProviderKey(engine, provider) || localReady)) return dm;
  }
  // 2) Otherwise the first-party-preferred fallback order over available keys.
  for (const provider of FALLBACK_PRIORITY) {
    const cfg = PROVIDER_UPSTREAM[provider]!;
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (!resolveProviderKey(engine, provider) && !localReady) continue;
    return `${provider}/${getDefaultUpstreamModel(cfg.envKeys[0]!)}`;
  }
  return undefined;
}

// ─── Provider conformance probe ─────────────────────────────────────────────

export interface ProviderProbeResult {
  provider: string;
  model: string;
  ok: boolean;
  /** HTTP status Marina's proxy produced (null on a transport failure/timeout). */
  status: number | null;
  latencyMs: number;
  /** Non-empty assistant text came back (catches dropped content blocks). */
  textOk: boolean;
  /** The SECOND system message was honored (catches dropped system messages). */
  systemHonored: boolean;
  text: string;
  /** `provider/model` that actually answered, from the routed lifecycle event. */
  servedBy?: string;
  /**
   * Tool-call probe (Anthropic / OpenAI providers): a one-tool request came
   * back as a structured `tool_calls` entry naming the tool with the nonce in
   * its arguments. `undefined` when the provider was not tool-probed. Catches
   * the silent-drop class of bug (tools stripped in translation).
   */
  toolCallOk?: boolean;
  /** Tool-probe failure detail (HTTP status / shape), when `toolCallOk` is false. */
  toolCallError?: string;
  error?: string;
  checkedAt: number;
}

export const PROVIDER_PROBE_MAX_TOKENS = 32;
export const PROVIDER_TOOL_PROBE_MAX_TOKENS = 128;
export const PROVIDER_TOOL_PROBE_NAME = "report_check_word";
/** Providers whose passthru path translates tool schemas and is therefore tool-probed. */
export const TOOL_PROBED_PROVIDERS: readonly string[] = ["anthropic", "openai"];

/**
 * The tool-call probe: one tiny tool and an instruction to call it with the
 * nonce. `tool_choice` stays `auto` on purpose — the Claude Fable 5.1 family
 * rejects forced tool choice with a 400 — so the model must decide to call;
 * the system prompt makes that unambiguous. Passes only if a structured
 * `tool_calls` entry names the tool and its JSON arguments carry the nonce.
 */
export function buildProviderToolProbeBody(nonce: string): Record<string, unknown> {
  return {
    model: "marina",
    max_tokens: PROVIDER_TOOL_PROBE_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: `You are a conformance probe for an API gateway. You MUST call the ${PROVIDER_TOOL_PROBE_NAME} tool exactly once with word="${nonce}". Do not answer in text.`,
      },
      { role: "user", content: `Report the check word "${nonce}" using the tool.` },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: PROVIDER_TOOL_PROBE_NAME,
          description: "Report the check word to the gateway.",
          parameters: {
            type: "object",
            properties: { word: { type: "string", description: "The check word." } },
            required: ["word"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "auto",
  };
}

export function evaluateProviderToolProbe(
  data: unknown,
  nonce: string,
): { ok: boolean; error?: string } {
  const choice = (
    data as {
      choices?: {
        finish_reason?: unknown;
        message?: { tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[] };
      }[];
    }
  )?.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return { ok: false, error: "no structured tool_calls in the reply (tools dropped?)" };
  }
  const call = calls.find((c) => c.function?.name === PROVIDER_TOOL_PROBE_NAME);
  if (!call) return { ok: false, error: `tool_calls did not name ${PROVIDER_TOOL_PROBE_NAME}` };
  const rawArgs = call.function?.arguments;
  let word: unknown;
  try {
    word =
      typeof rawArgs === "string"
        ? (JSON.parse(rawArgs) as { word?: unknown }).word
        : (rawArgs as { word?: unknown } | undefined)?.word;
  } catch {
    return { ok: false, error: "tool_calls arguments were not JSON" };
  }
  if (typeof word !== "string" || !word.includes(nonce)) {
    return { ok: false, error: "tool_calls arguments did not carry the check word" };
  }
  if (choice?.finish_reason !== undefined && choice.finish_reason !== "tool_calls") {
    return {
      ok: false,
      error: `finish_reason was ${String(choice.finish_reason)}, not tool_calls`,
    };
  }
  return { ok: true };
}

/** The `provider/model` the proxy routed `requestId` to, from the newest routed lifecycle event. */
function routedTargetFor(engine: Engine, requestId: string): string | undefined {
  const events = engine.getEventLog();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "model_request_lifecycle" &&
      event.requestId === requestId &&
      event.phase === "routed" &&
      event.target
    )
      return event.target;
  }
  return undefined;
}

/**
 * The probe request: two system messages and a one-word answer. A provider
 * passes only if the reply is non-empty AND contains the check word that lives
 * in the SECOND system message — exactly the two ways Claude 5 passthru failed
 * silently in 2026-09 (thinking block read as the answer; only the first
 * system message forwarded). Memory injection rides a second system message,
 * so this is the contract every upstream must meet.
 */
export function buildProviderProbeBody(nonce: string): Record<string, unknown> {
  return {
    model: "marina",
    max_tokens: PROVIDER_PROBE_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content:
          "You are a conformance probe for an API gateway. Follow the second system message exactly.",
      },
      { role: "system", content: `The check word is "${nonce}". Reply with the check word only.` },
      { role: "user", content: "What is the check word?" },
    ],
  };
}

export function evaluateProviderProbe(
  text: string,
  nonce: string,
): { textOk: boolean; systemHonored: boolean } {
  const trimmed = text.trim();
  return { textOk: trimmed.length > 0, systemHonored: trimmed.includes(nonce) };
}

/** Providers that would be used right now: a key (or a configured local runtime) is present. */
export function configuredUpstreamProviders(engine: Engine): { provider: string; model: string }[] {
  const out: { provider: string; model: string }[] = [];
  const dm = engine.db?.getDefaultModel();
  const dmSlash = dm ? dm.indexOf("/") : -1;
  const dmProvider = dm && !isMarinaModel(dm) && dmSlash >= 0 ? dm.slice(0, dmSlash) : undefined;
  for (const provider of FALLBACK_PRIORITY) {
    const cfg = PROVIDER_UPSTREAM[provider];
    if (!cfg) continue;
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (!resolveProviderKey(engine, provider) && !localReady) continue;
    // Probe the model marina/default would actually hit for this provider.
    const model =
      dmProvider === provider ? dm!.slice(dmSlash + 1) : getDefaultUpstreamModel(cfg.envKeys[0]!);
    out.push({ provider, model });
  }
  return out;
}

let lastProviderProbe: ProviderProbeResult[] | null = null;
export function getLastProviderProbe(): ProviderProbeResult[] | null {
  return lastProviderProbe;
}
/** Test seam: the last probe is module state and would otherwise leak between test files. */
export function resetLastProviderProbeForTests(): void {
  lastProviderProbe = null;
}

/**
 * Send one tiny request per configured provider through the SAME proxy path
 * passthru clients use and check the reply shape. Costs a few tokens per
 * provider; run it on demand (`readiness providers`), never on a hot path.
 */
export async function probeConfiguredProviders(
  engine: Engine,
  opts: { providers?: string[]; timeoutMs?: number } = {},
): Promise<ProviderProbeResult[]> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const targets = configuredUpstreamProviders(engine).filter(
    (t) => !opts.providers || opts.providers.includes(t.provider),
  );
  const results: ProviderProbeResult[] = [];
  for (const target of targets) {
    const nonce = `probe-${crypto.randomUUID().slice(0, 8)}`;
    const started = Date.now();
    let result: ProviderProbeResult = {
      ...target,
      ok: false,
      status: null,
      latencyMs: 0,
      textOk: false,
      systemHonored: false,
      text: "",
      checkedAt: started,
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Trace the request so the ROUTED target is observable: proxyToUpstream
      // falls back to the next configured provider when the forced one fails
      // (e.g. an expired key), and a fallback-served reply must not pass the
      // probe for the provider that actually failed.
      const requestId = `probe-${nonce}`;
      const response = await Promise.race([
        proxyToUpstream(
          engine,
          buildProviderProbeBody(nonce),
          `${target.provider}/${target.model}`,
          { routeKind: "passthru", requestId },
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      const servedBy = routedTargetFor(engine, requestId);
      const raw = await response.text();
      let text = "";
      let error: string | undefined;
      try {
        const data = JSON.parse(raw) as {
          choices?: { message?: { content?: unknown } }[];
          error?: { message?: string };
        };
        const content = data.choices?.[0]?.message?.content;
        text = typeof content === "string" ? content : "";
        if (!response.ok) error = data.error?.message ?? raw.slice(0, 200);
      } catch {
        error = raw.slice(0, 200);
      }
      const verdict = evaluateProviderProbe(text, nonce);
      const expected = `${target.provider}/${target.model}`;
      const misrouted = servedBy !== undefined && servedBy !== expected;
      if (misrouted && !error)
        error = `served by fallback ${servedBy} — ${target.provider} itself failed (see server log)`;
      result = {
        ...result,
        status: response.status,
        latencyMs: Date.now() - started,
        text: text.slice(0, 200),
        ...verdict,
        ...(servedBy ? { servedBy } : {}),
        ok: response.ok && verdict.textOk && verdict.systemHonored && !misrouted,
        ...(error ? { error } : {}),
      };
      // Tool-call probe — only where the proxy translates tool schemas, and
      // only once the text probe passed (a dead key would fail both for the
      // same reason and the first error is the useful one).
      if (result.ok && TOOL_PROBED_PROVIDERS.includes(target.provider)) {
        const toolNonce = `tool-${crypto.randomUUID().slice(0, 8)}`;
        const toolRequestId = `probe-${toolNonce}`;
        let toolTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const toolResponse = await Promise.race([
            proxyToUpstream(
              engine,
              buildProviderToolProbeBody(toolNonce),
              `${target.provider}/${target.model}`,
              { routeKind: "passthru", requestId: toolRequestId },
            ),
            new Promise<never>((_, reject) => {
              toolTimeout = setTimeout(
                () => reject(new Error(`timeout after ${timeoutMs} ms`)),
                timeoutMs,
              );
            }),
          ]);
          const toolRaw = await toolResponse.text();
          let toolVerdict: { ok: boolean; error?: string };
          if (!toolResponse.ok) {
            let reason = toolRaw.slice(0, 200);
            try {
              reason =
                (JSON.parse(toolRaw) as { error?: { message?: string } }).error?.message ?? reason;
            } catch {
              // keep the raw slice
            }
            toolVerdict = { ok: false, error: `HTTP ${toolResponse.status}: ${reason}` };
          } else {
            try {
              toolVerdict = evaluateProviderToolProbe(JSON.parse(toolRaw), toolNonce);
            } catch {
              toolVerdict = { ok: false, error: "tool probe reply was not JSON" };
            }
          }
          const toolServedBy = routedTargetFor(engine, toolRequestId);
          if (
            toolVerdict.ok &&
            toolServedBy &&
            toolServedBy !== `${target.provider}/${target.model}`
          )
            toolVerdict = { ok: false, error: `tool probe served by fallback ${toolServedBy}` };
          result = {
            ...result,
            latencyMs: Date.now() - started,
            toolCallOk: toolVerdict.ok,
            ...(toolVerdict.error ? { toolCallError: toolVerdict.error } : {}),
            ok: result.ok && toolVerdict.ok,
            ...(toolVerdict.ok ? {} : { error: `tool call dropped — ${toolVerdict.error}` }),
          };
        } catch (e) {
          result = {
            ...result,
            latencyMs: Date.now() - started,
            toolCallOk: false,
            toolCallError: getErrorMessage(e),
            ok: false,
            error: `tool probe failed — ${getErrorMessage(e)}`,
          };
        } finally {
          clearTimeout(toolTimeout);
        }
      }
    } catch (e) {
      result = { ...result, latencyMs: Date.now() - started, error: getErrorMessage(e) };
    } finally {
      clearTimeout(timeout);
    }
    results.push(result);
  }
  lastProviderProbe = results;
  return results;
}

/**
 * POST to an OpenAI-compatible upstream and normalize textual tool calls.
 *
 * Marina serves ANY model, so this runs on every openai-completions upstream
 * (cloud or self-hosted) and is passthrough-by-default: structured `tool_calls`
 * and ordinary content stream through verbatim; only literal `<tool_call>`
 * blocks in content are rewritten into structured calls, with a streaming parser
 * that holds back at most a tag's width so surrounding prose still streams
 * token-by-token. Returns null on network error / non-OK so the caller can try
 * the next provider.
 */
async function dispatchOpenAICompatible(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  wantStream: boolean,
  extraHeaders: Record<string, string> = {},
  clientSignal?: AbortSignal,
): Promise<{
  response: Response | null;
  errorStatus?: number;
  /** The upstream's own error reply (status and body), when it sent one. */
  errorResponse?: Response;
  networkError?: boolean;
  timedOut?: boolean;
}> {
  // Deadline for the call (headers for a stream, the whole reply otherwise);
  // a non-streaming caller that disconnects aborts it too.
  const abort = upstreamAbort(clientSignal);
  try {
    // Omit the Authorization header entirely when keyless (local servers) — an
    // empty `Bearer ` confuses some OpenAI-compatible implementations.
    const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    // A stream's lifetime belongs to its reader from here on (client cancel
    // propagates through the ReadableStream), so the deadline disarms.
    if (wantStream) abort.settle();
    if (!resp.ok) {
      let detail = "";
      try {
        const payload = (await resp.clone().json()) as {
          error?: { message?: string } | string;
          message?: string;
        };
        const message =
          typeof payload.error === "string"
            ? payload.error
            : (payload.error?.message ?? payload.message ?? "");
        detail = message ? `: ${message.slice(0, 300)}` : "";
      } catch {
        // Status and provider host are still enough to distinguish routing failures.
      }
      logger.warn(
        "model-api",
        `upstream ${new URL(url).host} returned HTTP ${resp.status}${detail}`,
        {
          host: new URL(url).host,
          status: resp.status,
        },
      );
      const text = await resp.text().catch(() => "");
      return {
        response: null,
        errorStatus: resp.status,
        errorResponse: new Response(text, {
          status: resp.status,
          headers: { ...MODEL_CORS, "Content-Type": "application/json" },
        }),
      };
    }
    const model = String((body.model as string) ?? "marina");
    if (wantStream) {
      if (!resp.body) return { response: null, networkError: true };
      return {
        response: new Response(normalizeToolCallSSE(resp.body, model), { headers: SSE_HEADERS }),
      };
    }
    const data = await resp.json();
    normalizeTextualToolCalls(data);
    return {
      response: new Response(JSON.stringify(data), {
        headers: { ...MODEL_CORS, "Content-Type": "application/json" },
      }),
    };
  } catch (error) {
    const timedOut = abort.timedOut();
    logger.warn(
      "model-api",
      timedOut
        ? `upstream ${new URL(url).host} timed out after ${upstreamTimeoutMs()} ms`
        : `upstream request failed: ${getErrorMessage(error)}`,
      { error: getErrorMessage(error), timedOut },
    );
    return { response: null, networkError: true, timedOut };
  } finally {
    abort.settle();
  }
}

/**
 * Stream-transform an upstream OpenAI SSE response, repairing textual tool calls
 * inline. Content streams through (≤ one tag's width of holdback); structured
 * `tool_calls` and other deltas pass through verbatim; a single authoritative
 * finish chunk is emitted at the end (`tool_calls` when any textual call was
 * converted). pi-ai's accumulator reads `delta.tool_calls` by index.
 */
export function normalizeToolCallSSE(
  upstream: ReadableStream<Uint8Array>,
  fallbackModel: string,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = new ToolCallStreamParser();
  const created = Math.floor(Date.now() / 1000);
  let sseBuf = "";
  let id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  let model = fallbackModel;
  let toolIndex = 0;
  let roleSent = false;
  let pendingFinish: string | null = null;
  let finishEmitted = false;
  let emittedFrames = 0;
  let cancelled = false;

  const send = (c: ReadableStreamDefaultController<Uint8Array>, frame: string) => {
    emittedFrames++;
    c.enqueue(encoder.encode(frame));
  };
  const chunk = (delta: unknown, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

  const flushEvents = (c: ReadableStreamDefaultController<Uint8Array>, events: StreamEvent[]) => {
    for (const ev of events) {
      if (!roleSent) {
        send(c, openaiStreamRoleChunk(id, model));
        roleSent = true;
      }
      if (ev.type === "content") {
        send(c, openaiStreamChunk(id, model, ev.text));
      } else {
        send(c, chunk({ tool_calls: [{ index: toolIndex++, ...ev.call }] }));
      }
    }
  };

  const emitFinish = (c: ReadableStreamDefaultController<Uint8Array>) => {
    if (finishEmitted) return;
    flushEvents(c, parser.finish());
    if (!roleSent) {
      send(c, openaiStreamRoleChunk(id, model));
      roleSent = true;
    }
    send(c, chunk({}, parser.sawToolCall ? "tool_calls" : (pendingFinish ?? "stop")));
    send(c, "data: [DONE]\n\n");
    finishEmitted = true;
  };

  const processLine = (line: string, c: ReadableStreamDefaultController<Uint8Array>) => {
    if (finishEmitted) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return emitFinish(c);
    let parsed: {
      id?: string;
      model?: string;
      usage?: unknown;
      choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.model === "string") model = parsed.model;
    // Providers may emit usage after the last choice's finish_reason. Preserve
    // it before the authoritative DONE frame so resident accounting sees it.
    if (parsed.usage !== undefined && parsed.usage !== null)
      send(c, `data: ${JSON.stringify({ ...parsed, choices: [] })}\n\n`);
    const choice = parsed.choices?.[0];
    const delta = choice?.delta ?? {};
    if (choice?.finish_reason) pendingFinish = choice.finish_reason;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      flushEvents(c, parser.push(delta.content));
    }
    const toolCalls = delta.tool_calls as unknown[] | undefined;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Structured tool calls — flush any held text, then forward verbatim
      // (preserving the upstream's index/id/argument fragments).
      flushEvents(c, parser.finish());
      const fwd: Record<string, unknown> = { tool_calls: toolCalls };
      if (delta.role) fwd.role = delta.role;
      send(c, chunk(fwd));
      roleSent = true;
    } else if (delta.role && delta.content === undefined) {
      send(c, openaiStreamRoleChunk(id, model));
      roleSent = true;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const before = emittedFrames;
        // A network fragment, heartbeat or held tool-call prefix may produce
        // no output. Keep reading until this pull satisfies downstream demand.
        while (!cancelled && emittedFrames === before) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            sseBuf += decoder.decode();
            if (sseBuf.trim()) processLine(sseBuf, controller);
            emitFinish(controller);
            controller.close();
            return;
          }
          sseBuf += decoder.decode(value, { stream: true });
          const parts = sseBuf.split("\n");
          sseBuf = parts.pop() ?? "";
          for (const part of parts) processLine(part, controller);
          if (finishEmitted) {
            controller.close();
            reader.cancel().catch(() => {});
            return;
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      cancelled = true;
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Resolve the completion-token budget for the local `llama` upstream: half the
 * server's context window by default (see localOutputBudget). Reads the window
 * from LLAMA_CONTEXT_WINDOW (16384 default), so set that to your server's real
 * size or the budget stays small.
 */
function llamaOutputBudget(): number {
  return localOutputBudget(localProviderContextWindow("llama") ?? 16384);
}

/**
 * Prepare a request body bound for the local `llama` upstream. Two concerns,
 * both aimed at the "agent connects but never acts" failure on reasoning
 * models (Qwen3):
 *   1. Suppress `<think>` blocks at the Jinja template level
 *      (`enable_thinking: false`). Only honored when llama.cpp runs with
 *      `--jinja`, so it's a best-effort hint, not the load-bearing fix.
 *   2. Guarantee a generous completion budget. `marina/default` agents send no
 *      `max_tokens` (the agent layer can't see which upstream the proxy will
 *      pick), so without this the reasoning model spends the server-default
 *      budget on `<think>` and returns no tool call. A larger caller-supplied
 *      value is always preserved.
 * Other providers pass through untouched.
 */
export function prepareLlamaBody(
  body: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  if (provider !== "llama") return body;
  const prepared: Record<string, unknown> = {
    ...body,
    chat_template_kwargs: { enable_thinking: false },
  };
  const budget = llamaOutputBudget();
  const current = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  if (current < budget) prepared.max_tokens = budget;
  return prepared;
}

/** Keep a caller's provider-specific completion budget from poisoning a
 * fallback request. For example, Gemini-oriented agents may request 32k output
 * while gpt-4o accepts at most 16,384 and otherwise rejects the whole turn; the
 * cap is per model (`openaiOutputCap`), so gpt-6-luna keeps its 128k. */
/**
 * Remove Anthropic-only `cache_control` markers before an OpenAI-compatible
 * upstream sees the body. Marina's own agents send them (pi-ai with
 * `cacheControlFormat: "anthropic"` puts one on the system text part, the last
 * tool and the last message part); the Anthropic path maps them onto blocks,
 * but strict OpenAI-style servers (OpenAI, llama.cpp, vLLM, Ollama) reject
 * unknown fields. A system `content` array that is pure text collapses back to
 * a string for the widest compatibility. Never mutates the caller's body.
 */
export function stripCacheControl(body: Record<string, unknown>): Record<string, unknown> {
  let touched = false;
  const stripPart = (part: unknown): unknown => {
    if (!part || typeof part !== "object" || !("cache_control" in (part as object))) return part;
    touched = true;
    const { cache_control: _cc, ...rest } = part as Record<string, unknown>;
    return rest;
  };
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => {
        if (!m || typeof m !== "object") return m;
        const msg = m as Record<string, unknown>;
        let next = msg;
        if ("cache_control" in msg) {
          touched = true;
          const { cache_control: _cc, ...rest } = msg;
          next = rest;
        }
        if (Array.isArray(next.content)) {
          const parts = next.content.map(stripPart);
          const allText = parts.every(
            (p) => p && typeof p === "object" && (p as { type?: unknown }).type === "text",
          );
          const collapsible =
            next.role === "system" && allText && parts.length > 0 && parts !== next.content;
          next = {
            ...next,
            content: collapsible
              ? parts.map((p) => String((p as { text?: unknown }).text ?? "")).join("\n")
              : parts,
          };
        }
        return next;
      })
    : body.messages;
  const tools = Array.isArray(body.tools) ? body.tools.map(stripPart) : body.tools;
  if (!touched) return body;
  return {
    ...body,
    ...(messages !== undefined ? { messages } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

/**
 * An OpenAI-compatible upstream that forwards `cache_control` on content parts
 * to Anthropic: OpenRouter serving an `anthropic/*` model. Everything else on
 * OpenRouter (OpenAI, Gemini, … — implicit/automatic caching) is stripped like
 * any other OpenAI-compatible provider.
 */
export function honorsCacheControl(provider: string, model: unknown): boolean {
  return provider === "openrouter" && typeof model === "string" && /^~?anthropic\//.test(model);
}

function hasCacheControl(value: unknown): boolean {
  return !!value && typeof value === "object" && "cache_control" in (value as object);
}

/** Any `cache_control` the client placed: message, content part or tool. */
function clientCacheMarked(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (hasCacheControl(m)) return true;
    const content = (m as { content?: unknown } | null)?.content;
    if (Array.isArray(content) && content.some(hasCacheControl)) return true;
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.some(
    (t) => hasCacheControl(t) || hasCacheControl((t as { function?: unknown } | null)?.function),
  );
}

const EPHEMERAL = { type: "ephemeral" } as const;

function markOpenAIMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") {
    if (!msg.content) return message;
    return { ...msg, content: [{ type: "text", text: msg.content, cache_control: EPHEMERAL }] };
  }
  if (!Array.isArray(msg.content)) return message;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const part = msg.content[i] as { type?: unknown; text?: unknown } | null;
    if (part?.type !== "text" || typeof part.text !== "string" || !part.text) continue;
    const content = [...msg.content];
    content[i] = { ...part, cache_control: EPHEMERAL };
    return { ...msg, content };
  }
  return message;
}

/**
 * Auto-cache breakpoints in the OpenAI chat shape, for an upstream that
 * forwards them to Anthropic (`honorsCacheControl`). Mirrors
 * `placeCacheBreakpoints`: the last STABLE leading system message (the one
 * before the proxy's memory addendum when `injectedSystemTail`), the memory
 * addendum itself, and a ROLLING breakpoint on the latest message's last text
 * part (a string content becomes one text part) once the request reaches the
 * model's minimum cacheable length — at most three markers, under Anthropic's
 * four. A body whose client already placed any marker is returned unchanged.
 */
export function placeOpenAICacheBreakpoints(
  body: Record<string, unknown>,
  opts: { injectedSystemTail?: boolean } = {},
): Record<string, unknown> {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body;
  if (clientCacheMarked(body)) return body;
  const messages = [...body.messages];
  const isSystem = (m: unknown) => {
    const role = (m as { role?: unknown } | null)?.role;
    return role === "system" || role === "developer";
  };
  let leading = 0;
  while (leading < messages.length && isSystem(messages[leading])) leading++;
  const last = leading - 1;
  const stable = opts.injectedSystemTail ? last - 1 : last;
  if (stable >= 0) messages[stable] = markOpenAIMessage(messages[stable]);
  if (stable !== last && last >= 0) messages[last] = markOpenAIMessage(messages[last]);
  if (
    messages.length > leading &&
    estimatePrefixTokens(body.tools, body.messages) >= minCacheableTokens(String(body.model))
  ) {
    for (let i = messages.length - 1; i >= leading; i--) {
      const marked = markOpenAIMessage(messages[i]);
      if (marked !== messages[i]) {
        messages[i] = marked;
        break;
      }
    }
  }
  return { ...body, messages };
}

export function prepareUpstreamBody(
  body: Record<string, unknown>,
  provider: string,
  defaultRoute = false,
  cache: { injectedSystemTail?: boolean } = {},
): Record<string, unknown> {
  // Anthropic upstreams take the markers through proxyToAnthropic; OpenRouter
  // serving `anthropic/*` forwards them on content parts (the client's own, or
  // auto-cache's); every other OpenAI-compatible provider must not see them.
  const cacheBody = honorsCacheControl(provider, body.model)
    ? anthropicAutoCacheEnabled()
      ? placeOpenAICacheBreakpoints(body, cache)
      : body
    : provider === "anthropic"
      ? body
      : stripCacheControl(body);
  let prepared = prepareLlamaBody(cacheBody, provider);
  // The Luna family (gpt-5.6-luna, gpt-6-luna, their -pro variants): accepts
  // reasoning_effort "none" and rejects legacy max_tokens (verified live
  // 2026-09-24 for gpt-6-luna on OpenAI and OpenRouter).
  const luna =
    (provider === "openai" && LUNA_MODEL.test(String(body.model))) ||
    (provider === "openrouter" && LUNA_MODEL.test(String(body.model).replace(/^openai\//, "")));
  // Preserve the former non-reasoning default's latency/cost role. Explicit
  // effort settings and direct model requests retain the caller's choices.
  if (luna && defaultRoute && body.reasoning_effort === undefined && body.reasoning === undefined)
    prepared = { ...prepared, reasoning_effort: "none" };
  if (provider !== "openai") return prepared;
  const bounded = { ...prepared };
  // Luna requires the modern token field. Preserve an explicitly supplied
  // max_completion_tokens and let the provider reject conflicting fields.
  if (luna && bounded.max_tokens !== undefined && bounded.max_completion_tokens === undefined) {
    bounded.max_completion_tokens = bounded.max_tokens;
    delete bounded.max_tokens;
  }
  const cap = openaiOutputCap(String(bounded.model ?? ""));
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const value = bounded[field];
    if (typeof value === "number" && value > cap) bounded[field] = cap;
  }
  return bounded;
}

/** Output cap for a model the catalog does not know (gpt-4o's, the smallest current limit). */
const UNKNOWN_OPENAI_OUTPUT_CAP = 16_384;

/**
 * The most output tokens an OpenAI model accepts, from pi-ai's catalog
 * (gpt-6-luna: 128,000; gpt-4o: 16,384), so a fallback request is clamped to
 * what THIS model allows rather than to gpt-4o's limit for every model.
 */
function openaiOutputCap(model: string): number {
  try {
    costCatalog ??= builtinModels();
    const max = costCatalog.getModel("openai", model)?.maxTokens;
    return typeof max === "number" && max > 0 ? max : UNKNOWN_OPENAI_OUTPUT_CAP;
  } catch {
    return UNKNOWN_OPENAI_OUTPUT_CAP;
  }
}

export async function proxyToUpstream(
  engine: Engine,
  body: Record<string, unknown>,
  forceModel?: string,
  traceOptions?: {
    routeKind: "passthru" | "fallback" | "synthesis";
    /** Why this route was taken when the mode alone does not say — `"internal"`
     *  for Marina's own agents proxied regardless of the endpoint mode. */
    routeReason?: string;
    /** Resolved passthru identity, tagged onto every lifecycle span. */
    entityId?: EntityId;
    /** Pre-minted request id (passthru surfaces mint it before injection so the
     *  receipt, header and trace agree). Minted here when absent. */
    requestId?: string;
    /** Memory receipt for the injected context — emitted on the received and
     *  terminal lifecycle events and returned as `x-marina-memory-receipt`. */
    memoryReceipt?: MemoryReceipt;
    /** Protocol surface (passthru only) — stamped on every lifecycle event. */
    surface?: InjectionFormat;
  },
  hints?: {
    /** The client request's signal: a NON-streaming upstream call is aborted
     *  when the client disconnects (streams keep their own cancel path). */
    clientSignal?: AbortSignal;
    /** Verification/evaluation names a provider, so another route cannot answer for it. */
    providerFallback?: boolean;
    /** Native Anthropic body to forward verbatim when the upstream is Anthropic. */
    anthropicNative?: Record<string, unknown>;
    /** The LAST system block is the proxy's injected memory addendum (see
     *  `placeCacheBreakpoints` — the stable-block breakpoint lands before it). */
    injectedSystemTail?: boolean;
  },
): Promise<Response> {
  // The world's daily budget is checked before any upstream call is made.
  const capped = dailyCapRefusal();
  if (capped) {
    return new Response(
      JSON.stringify(openaiErrorBody(429, capped, { code: "spend_cap_reached" })),
      {
        status: 429,
        headers: { "content-type": "application/json" },
      },
    );
  }
  const wantStream = body.stream === true;
  const clientSignal = wantStream ? undefined : hints?.clientSignal;
  let attemptedUpstream = false;
  let anyTimedOut = false;
  let lastTarget: string | undefined;
  let lastErrorKind: ProxyTraceMetrics["errorKind"];
  const requestedModel = typeof body.model === "string" ? body.model : "marina";
  const entityId = traceOptions?.entityId;
  const surface = traceOptions?.surface;
  const routeReason = traceOptions?.routeReason;
  const memoryReceipt = traceOptions?.memoryReceipt
    ? encodeMemoryReceiptAttribute(traceOptions.memoryReceipt)
    : undefined;
  const startedAt = Date.now();
  const requestId = traceOptions ? (traceOptions.requestId ?? newRequestId()) : undefined;
  // Correlate the upstream call with Marina's traced request id (OpenAI echoes
  // `x-request-id`; `prompt_cache_key` in the body passes through untouched).
  const upstreamHeaders: Record<string, string> = requestId ? { "x-request-id": requestId } : {};
  const cacheHints = { injectedSystemTail: hints?.injectedSystemTail };
  const anthropic = async (key: string, model: string): Promise<Response> => {
    try {
      // `model` is the resolved Anthropic id (`anthropic/claude-x` → `claude-x`);
      // the body's own id may still carry the provider prefix Anthropic 404s on.
      return await proxyToAnthropic(
        { ...body, model },
        key,
        model,
        wantStream,
        hints?.anthropicNative,
        {
          injectedSystemTail: hints?.injectedSystemTail,
          clientSignal,
        },
      );
    } catch (e) {
      // A parameter Anthropic cannot honor is a 400 the CLIENT must see, not
      // a reason to try the next provider (which would honor it differently).
      if (e instanceof UnsupportedParameterError) return json(e.toBody(), 400);
      throw e;
    }
  };
  if (requestId) {
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "received",
      requestId,
      ...requestTrace(requestId),
      model: requestedModel,
      routeKind: traceOptions!.routeKind,
      ...(routeReason ? { routeReason } : {}),
      ...(entityId ? { entityId } : {}),
      ...(memoryReceipt ? { memoryReceipt } : {}),
      ...(surface ? { surface } : {}),
      timestamp: startedAt,
    });
  }

  const finish = async (
    response: Response,
    target?: string,
    errorKind?: ProxyTraceMetrics["errorKind"],
  ): Promise<Response> => {
    if (!requestId) return response;
    if (target) {
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "routed",
        requestId,
        ...requestTrace(requestId),
        model: requestedModel,
        target,
        routeKind: traceOptions!.routeKind,
        ...(routeReason ? { routeReason } : {}),
        ...(entityId ? { entityId } : {}),
        ...(surface ? { surface } : {}),
        timestamp: Date.now(),
      });
    }
    return await traceProxyResponse(engine, response, {
      requestId,
      model: requestedModel,
      target,
      routeKind: traceOptions!.routeKind,
      routeReason,
      entityId,
      memoryReceipt: traceOptions!.memoryReceipt,
      surface,
      startedAt,
      errorKind,
    });
  };
  // `forceModel` (passthru endpoint mode) pins the upstream model regardless of
  // what the caller requested; otherwise only marina/default models resolve to
  // the configured default.
  const isDefault = !!forceModel || isMarinaModel(body.model as string);

  // 1) Explicit configured default: when marina/default is requested and an
  //    operator has set `default_model`, honor that exact provider — including
  //    OpenRouter — instead of the first-party priority. The key is resolved from
  //    env or the admin panel. Falls through to (2) only if its key is missing.
  if (isDefault && engine.db) {
    const dm = forceModel || engine.db.getDefaultModel();
    const slash = dm.indexOf("/");
    const provider = slash >= 0 ? dm.slice(0, slash) : dm;
    const upstreamModel = slash >= 0 ? dm.slice(slash + 1) : dm;
    const cfg = PROVIDER_UPSTREAM[provider];
    const key = cfg ? resolveProviderKey(engine, provider) : undefined;
    // Local runtimes route keyless when configured (base URL set); cloud
    // providers still require a key.
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (cfg && (key || localReady) && upstreamModel) {
      attemptedUpstream = true;
      lastTarget = `${provider}/${upstreamModel}`;
      if (cfg.anthropic) {
        return finish(await anthropic(key!, upstreamModel), lastTarget);
      }
      const r = await dispatchOpenAICompatible(
        cfg.url,
        key ?? "",
        prepareUpstreamBody({ ...body, model: upstreamModel }, provider, isDefault, cacheHints),
        wantStream,
        upstreamHeaders,
        clientSignal,
      );
      if (r.response) return finish(r.response, lastTarget);
      lastErrorKind = r.networkError ? "network" : classifyProxyError(r.errorStatus ?? 0);
      anyTimedOut ||= r.timedOut === true;
      // An explicitly configured default pins the model. A rejected or failed
      // request must not silently become a different provider's default model.
      return finish(
        r.errorResponse ??
          errorJson(
            r.timedOut ? 504 : 502,
            `Configured upstream ${lastTarget} could not complete the request. See server logs.`,
          ),
        lastTarget,
        lastErrorKind,
      );
    }
    if (forceModel) return finish(errorJson(503, `Pinned upstream ${dm} is not configured.`), dm);
  }

  // An Anthropic "model not found" for a non-default id is a routing miss, not
  // an answer: the next provider may serve that id. The 404 is returned only if
  // no provider does.
  let modelNotFound: { response: Response; target: string } | undefined;

  // 1b) Explicit provider prefix on a non-default id (`openrouter/z-ai/glm-…`,
  //     `openai/gpt-…`): that provider ONLY, prefix stripped. The prefix names
  //     the provider, so its answer — success, rejection, 404, 429, 5xx or a
  //     transport failure — is the answer. It never falls back to another
  //     provider: the full id is that provider's namespace (another provider
  //     would 400 on `openrouter/…`), and a silent reroute would credit the
  //     wrong provider and hide the named provider's error from the caller.
  if (!isDefault && typeof body.model === "string" && !clientSignal?.aborted) {
    const slash = body.model.indexOf("/");
    const provider = slash > 0 ? body.model.slice(0, slash) : "";
    const upstreamModel = slash > 0 ? body.model.slice(slash + 1) : "";
    const cfg = provider ? PROVIDER_UPSTREAM[provider] : undefined;
    const key = cfg ? resolveProviderKey(engine, provider) : undefined;
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (cfg && (key || localReady) && upstreamModel) {
      attemptedUpstream = true;
      lastTarget = `${provider}/${upstreamModel}`;
      if (cfg.anthropic) {
        return finish(await anthropic(key!, upstreamModel), lastTarget);
      }
      const r = await dispatchOpenAICompatible(
        cfg.url,
        key ?? "",
        prepareUpstreamBody({ ...body, model: upstreamModel }, provider, isDefault, cacheHints),
        wantStream,
        upstreamHeaders,
        clientSignal,
      );
      if (r.response) return finish(r.response, lastTarget);
      return finish(
        r.errorResponse ??
          errorJson(
            r.timedOut ? 504 : 502,
            r.timedOut
              ? `Named upstream ${lastTarget} did not answer within ${upstreamTimeoutMs()} ms (MARINA_UPSTREAM_TIMEOUT_MS).`
              : `Named upstream ${lastTarget} could not complete the request.`,
          ),
        lastTarget,
        r.networkError ? "network" : classifyProxyError(r.errorStatus ?? 0),
      );
    }
    // A prefix that can only mean a Marina provider — an aggregator
    // (`openrouter/…`, `huggingface/…`) or a local runtime — is never another
    // provider's model id, so with that provider unconfigured nothing can
    // serve it. (A first-party vendor prefix such as `openai/…` with no
    // OpenAI key is also an aggregator's vendor id and keeps the loop below.)
    if (
      cfg &&
      upstreamModel &&
      (hints?.providerFallback === false || AGGREGATORS.has(provider) || isLocalProvider(provider))
    ) {
      return finish(
        errorJson(503, `Named upstream ${provider}/${upstreamModel} is not configured.`),
        `${provider}/${upstreamModel}`,
      );
    }
  }

  // 2) Fallback: first-party-preferred over whatever keys exist (env or DB).
  //    A default request is mapped to EACH provider's own default model, so
  //    every attempt names a model that provider carries. A non-default id is
  //    sent as-is; one whose prefix names a first-party vendor this instance
  //    has no key for (`openai/gpt-…` with no OpenAI key) is that vendor's id
  //    in an aggregator's namespace, so only an aggregator is asked.
  const modelSlash = typeof body.model === "string" ? body.model.indexOf("/") : -1;
  const vendorPrefixed =
    !isDefault &&
    modelSlash > 0 &&
    PROVIDER_UPSTREAM[(body.model as string).slice(0, modelSlash)] !== undefined;
  for (const provider of FALLBACK_PRIORITY) {
    // A caller that disconnected gets no further provider attempts.
    if (clientSignal?.aborted) break;
    if (vendorPrefixed && !AGGREGATORS.has(provider)) continue;
    const cfg = PROVIDER_UPSTREAM[provider]!;
    const key = resolveProviderKey(engine, provider);
    // Skip cloud providers with no key, and local runtimes the operator hasn't
    // opted into — otherwise a keyless local server would be probed every call.
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (!key && !localReady) continue;
    attemptedUpstream = true;
    const envKey = cfg.envKeys[0]!;
    const requestModel = isDefault ? getDefaultUpstreamModel(envKey) : (body.model as string);
    lastTarget = `${provider}/${requestModel}`;
    if (cfg.anthropic) {
      const resp = await anthropic(key!, requestModel);
      if (hints?.providerFallback === false || isDefault || resp.status !== 404)
        return finish(resp, lastTarget);
      modelNotFound ??= { response: resp, target: lastTarget };
      lastErrorKind = classifyProxyError(404);
      continue;
    }
    const r = await dispatchOpenAICompatible(
      cfg.url,
      key ?? "",
      prepareUpstreamBody({ ...body, model: requestModel }, provider, isDefault, cacheHints),
      wantStream,
      upstreamHeaders,
      clientSignal,
    );
    if (r.response) return finish(r.response, lastTarget);
    if (hints?.providerFallback === false) {
      return finish(
        r.errorResponse ??
          errorJson(
            r.timedOut ? 504 : 502,
            `Selected upstream ${lastTarget} could not complete the request.`,
          ),
        lastTarget,
        r.networkError ? "network" : classifyProxyError(r.errorStatus ?? 0),
      );
    }
    lastErrorKind = r.networkError ? "network" : classifyProxyError(r.errorStatus ?? 0);
    anyTimedOut ||= r.timedOut === true;
  }

  if (modelNotFound && !anyTimedOut) {
    return finish(modelNotFound.response, modelNotFound.target, lastErrorKind);
  }

  if (attemptedUpstream && anyTimedOut) {
    return finish(
      errorJson(
        504,
        `Upstream LLM provider did not answer within ${upstreamTimeoutMs()} ms (MARINA_UPSTREAM_TIMEOUT_MS).`,
      ),
      lastTarget,
      lastErrorKind,
    );
  }

  if (attemptedUpstream) {
    return finish(
      errorJson(
        502,
        "Configured upstream LLM providers were reachable by configuration but rejected or could not complete the request. Check provider status, quota, model access, and server logs.",
      ),
      lastTarget,
      lastErrorKind,
    );
  }

  return finish(
    errorJson(
      503,
      "No upstream LLM providers configured. Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.) or add one in Admin → Keys.",
    ),
  );
}

interface ProxyTraceMetrics {
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  errorKind?: Extract<EngineEvent, { type: "model_request_lifecycle" }>["errorKind"];
}

/**
 * Cost of a proxied call from pi-ai's built-in model catalog when the upstream
 * did not price it itself (OpenRouter does, via `usage.cost`). `target` is the
 * served `provider/model`; Marina's provider ids (`anthropic`, `openai`,
 * `google`, `groq`, `openrouter`) are pi-ai's. OpenAI-shaped `prompt_tokens`
 * INCLUDES the cached share, pi-ai's `input` excludes it, so reads/writes are
 * subtracted before pricing. Undefined for unknown models (local runtimes,
 * unlisted ids) or when no token count is known — never a fabricated $0.
 */
let costCatalog: ReturnType<typeof builtinModels> | undefined;
export function upstreamCostUsd(
  target: string | undefined,
  metrics: Pick<
    ProxyTraceMetrics,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): number | undefined {
  if (!target) return undefined;
  const slash = target.indexOf("/");
  if (slash <= 0) return undefined;
  if (metrics.inputTokens === undefined && metrics.outputTokens === undefined) return undefined;
  try {
    costCatalog ??= builtinModels();
    const modelId = target.slice(slash + 1);
    const listed = costCatalog.getModel(target.slice(0, slash), modelId);
    // Marina's own default ids (e.g. gpt-6-luna) carry their list price even
    // before pi-ai's catalog lists them, so the daily cap sees their spend.
    const fallbackPrice = listed ? undefined : defaultModelPrice(modelId);
    const model =
      listed ??
      (fallbackPrice
        ? ({ cost: fallbackPrice } as unknown as NonNullable<typeof listed>)
        : undefined);
    if (!model) return undefined;
    const cacheRead = metrics.cacheReadTokens ?? 0;
    const cacheWrite = metrics.cacheWriteTokens ?? 0;
    const input = Math.max(0, (metrics.inputTokens ?? 0) - cacheRead - cacheWrite);
    const output = metrics.outputTokens ?? 0;
    const usage: PiUsage = {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const total = calculateCost(model, usage).total;
    return Number.isFinite(total) && total >= 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

/** Fill `costUsd` from the catalog when the upstream did not report a cost. */
function priceProxyMetrics(metrics: ProxyTraceMetrics, target?: string): ProxyTraceMetrics {
  if (metrics.costUsd !== undefined) return metrics;
  const costUsd = upstreamCostUsd(target, metrics);
  return costUsd === undefined ? metrics : { ...metrics, costUsd };
}

/** Cost / cache headers for a completed (non-streaming) proxied reply. */
function setProxyMetricHeaders(headers: Headers, metrics: ProxyTraceMetrics): void {
  if (metrics.cacheReadTokens !== undefined)
    headers.set(CACHE_READ_TOKENS_HEADER, String(metrics.cacheReadTokens));
  if (metrics.cacheWriteTokens !== undefined)
    headers.set(CACHE_WRITE_TOKENS_HEADER, String(metrics.cacheWriteTokens));
  if (metrics.costUsd !== undefined) headers.set(COST_USD_HEADER, metrics.costUsd.toFixed(8));
}

async function traceProxyResponse(
  engine: Engine,
  response: Response,
  trace: {
    requestId: string;
    model: string;
    target?: string;
    routeKind: "passthru" | "fallback" | "synthesis";
    routeReason?: string;
    entityId?: EntityId;
    memoryReceipt?: MemoryReceipt;
    surface?: InjectionFormat;
    startedAt: number;
    errorKind?: ProxyTraceMetrics["errorKind"];
  },
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", trace.requestId);
  // The served upstream `provider/model` — known before the body, so it rides
  // streamed replies too (a client prices its own stream from it).
  if (trace.target && response.ok) headers.set(UPSTREAM_MODEL_HEADER, trace.target);
  // The receipt rides every injected response — including failures, so a
  // client can see what was injected into a request that the upstream refused.
  if (trace.memoryReceipt) {
    headers.set(MEMORY_RECEIPT_HEADER, encodeMemoryReceiptHeader(trace.memoryReceipt));
  }
  const memoryReceipt = trace.memoryReceipt
    ? encodeMemoryReceiptAttribute(trace.memoryReceipt)
    : undefined;
  let terminal = false;
  const finish = (
    phase: "completed" | "failed",
    detail?: string,
    metrics: ProxyTraceMetrics = {},
  ) => {
    if (terminal) return;
    terminal = true;
    if (phase === "completed") {
      recordSpend("model_api", metrics.costUsd);
      // Streaming replies cannot carry the cost header; settle it for the
      // in-process agent that made the call (src/engine/proxy-settlement.ts).
      if (metrics.costUsd !== undefined) {
        settleProxyCall(trace.requestId, {
          costUsd: metrics.costUsd,
          ...(metrics.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: metrics.cacheReadTokens }),
          ...(metrics.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: metrics.cacheWriteTokens }),
        });
      }
    }
    engine.logEvent({
      type: "model_request_lifecycle",
      phase,
      requestId: trace.requestId,
      ...requestTrace(trace.requestId),
      model: trace.model,
      target: trace.target,
      routeKind: trace.routeKind,
      ...(trace.routeReason ? { routeReason: trace.routeReason } : {}),
      ...(trace.entityId ? { entityId: trace.entityId } : {}),
      ...(memoryReceipt ? { memoryReceipt } : {}),
      ...(trace.surface ? { surface: trace.surface } : {}),
      durationMs: Date.now() - trace.startedAt,
      ...metrics,
      ...(detail ? { detail } : {}),
      timestamp: Date.now(),
    });
  };

  if (!response.ok) {
    finish("failed", `upstream response HTTP ${response.status}`, {
      errorKind: trace.errorKind ?? classifyProxyError(response.status),
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    const metrics = priceProxyMetrics(await extractProxyUsage(response), trace.target);
    setProxyMetricHeaders(headers, metrics);
    finish("completed", undefined, metrics);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // Streamed reply: tap the OpenAI-shaped SSE frames for the trailing `usage`
  // chunk (OpenAI `stream_options.include_usage`; the Anthropic translator's
  // `message_delta.usage`) so the `completed` event carries tokens and cost —
  // Marina's own agents stream every turn, and without this their lifecycle
  // spans had no token fields at all.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseTail = "";
  let streamedUsage: Record<string, unknown> | undefined;
  const scanSse = (text: string): void => {
    sseTail += text;
    const lines = sseTail.split("\n");
    sseTail = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim()) as { usage?: unknown };
        if (
          parsed &&
          typeof parsed === "object" &&
          parsed.usage &&
          typeof parsed.usage === "object"
        )
          streamedUsage = parsed.usage as Record<string, unknown>;
      } catch {
        // Not a JSON frame (or split mid-line) — usage lands on a later frame if at all.
      }
    }
  };
  const streamMetrics = (): ProxyTraceMetrics => {
    const usage: Record<string, unknown> | undefined =
      streamedUsage ??
      (streamUsageSidecar.get(response)?.() as Record<string, unknown> | undefined);
    return priceProxyMetrics(usage ? metricsFromUsage(usage) : {}, trace.target);
  };
  let firstChunkAt = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          scanSse(decoder.decode());
          finish("completed", undefined, {
            ...(firstChunkAt > 0 ? { ttftMs: firstChunkAt - trace.startedAt } : {}),
            ...streamMetrics(),
          });
          controller.close();
        } else {
          if (firstChunkAt === 0) firstChunkAt = Date.now();
          scanSse(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        }
      } catch (cause) {
        finish("failed", cause instanceof Error ? cause.message : "upstream stream failed", {
          errorKind: "network",
          ...(firstChunkAt > 0 ? { ttftMs: firstChunkAt - trace.startedAt } : {}),
        });
        controller.error(cause);
      }
    },
    cancel(reason) {
      finish("failed", "response stream cancelled before completion", {
        errorKind: "cancelled",
        ...(firstChunkAt > 0 ? { ttftMs: firstChunkAt - trace.startedAt } : {}),
      });
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function extractProxyUsage(response: Response): Promise<ProxyTraceMetrics> {
  try {
    const data = (await response.clone().json()) as { usage?: Record<string, unknown> };
    const usage = data.usage;
    if (!usage || typeof usage !== "object") return {};
    return metricsFromUsage(usage);
  } catch {
    return {};
  }
}

/** Token / cost metrics from a usage block in any dialect the proxy sees. */
function metricsFromUsage(usage: Record<string, unknown>): ProxyTraceMetrics {
  {
    const finite = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const cost = usage.cost;
    const costUsd =
      typeof cost === "number"
        ? finite(cost)
        : cost && typeof cost === "object"
          ? finite((cost as Record<string, unknown>).total)
          : undefined;
    const inputTokens = finite(usage.prompt_tokens ?? usage.input_tokens ?? usage.input);
    const outputTokens = finite(usage.completion_tokens ?? usage.output_tokens ?? usage.output);
    // Cache counters in every dialect the proxy sees: Anthropic
    // (`cache_read_input_tokens` / `cache_creation_input_tokens`, also carried
    // on the translated OpenAI usage), OpenAI (`prompt_tokens_details.cached_tokens`),
    // and the OpenRouter-style `cache_read_tokens` / `cacheRead`.
    const promptDetails =
      usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    const cacheReadTokens = finite(
      usage.cache_read_input_tokens ??
        promptDetails?.cached_tokens ??
        usage.cache_read_tokens ??
        usage.cacheRead,
    );
    const cacheWriteTokens = finite(
      usage.cache_creation_input_tokens ??
        promptDetails?.cache_creation_tokens ??
        promptDetails?.cache_write_tokens ??
        usage.cache_write_tokens ??
        usage.cacheWrite,
    );
    return {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  }
}

function classifyProxyError(status: number): ProxyTraceMetrics["errorKind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 503) return "unavailable";
  if (status >= 500) return "provider";
  return "unknown";
}
