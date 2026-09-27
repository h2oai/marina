// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision backends.
 *
 * - `decisions-api`: a purpose-built decision model behind the Decisions API
 *   (`POST {baseUrl}/decisions`, body `{ model, state, questions }`). This is
 *   the Jev family on OpenRouter (`typesafe/jev-1.13`, `~typesafe/jev-latest`,
 *   and siblings such as nanojev / kev) and any self-hosted server that speaks
 *   the same wire format (OpenJev). The model id is configuration, never code.
 * - `chat-classifier`: ANY OpenAI-compatible chat model used as a classifier.
 *   Slower and less calibrated than a decision model, but it works with every
 *   model Marina can route to (including Marina's own `/v1` and local servers),
 *   so the harness patterns never depend on one vendor.
 *
 * Endpoints are operator configuration (env-only), so they are fetched
 * directly, like the provider upstreams in `net/model-api/upstream.ts` — a
 * local classifier on localhost is a legitimate target.
 */

import { normalizeAnswers } from "./answers";
import {
  answerFromDistribution,
  answerResponseFormat,
  type ClassifierMethod,
  distributionFromSamples,
  distributionsFromLogprobs,
  LABELED_SYSTEM,
  labeledPrompt,
  labelQuestions,
  type QuestionLabels,
  VERBALIZED_SYSTEM,
  verbalizedPrompt,
} from "./classifier-methods";
import {
  DecisionError,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
} from "./types";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  /** Decisions API path under `baseUrl`: `/decisions` (OpenRouter), `/v1/systemone` (TypeSafe). */
  path?: string;
  /**
   * USD per million input tokens, used when the backend reports tokens but no
   * `usage.cost` (TypeSafe's own API; OpenRouter reports cost itself). Output
   * tokens are free on the Decisions API.
   */
  inputUsdPerMTok?: number;
  /** chat-classifier: how probabilities are obtained (default `verbalized`). */
  method?: ClassifierMethod;
  /** chat-classifier: send a JSON-schema `response_format` (default off). */
  structured?: boolean;
  /** chat-classifier `sampled`: calls per decision (default 5, 2–15). */
  samples?: number;
  /** Test seam. */
  fetch?: FetchLike;
}

/** Upstream statuses worth one retry: rate limited, unavailable, TypeSafe's 529 overloaded. */
const RETRYABLE = new Set([429, 503, 529]);
/** Leave at least this much of the call's budget for the retried attempt itself. */
const RETRY_MIN_REMAINING_MS = 250;

function retryDelayMs(res: Response): number {
  const after = Number(res.headers.get("retry-after"));
  if (Number.isFinite(after) && after >= 0) return after * 1000;
  return 100 + Math.random() * 200;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function statusError(status: number, text: string): DecisionError {
  const message = `decision backend ${status}${text ? `: ${text.slice(0, 200)}` : ""}`;
  if (status === 429) return new DecisionError(message, "rate_limited", 429);
  if (status === 503 || status === 529) return new DecisionError(message, "overloaded", status);
  if (status === 400 || status === 422) return new DecisionError(message, "upstream_rejected", 422);
  return new DecisionError(message, "upstream_error");
}

/**
 * POST once, and retry ONCE on 429 / 503 / 529 when the call's own timeout
 * still has room (the Decisions API answers in ~150 ms, so a jittered retry
 * fits inside a 2 s budget). Never retries past the budget: a gate that fails
 * closed must not wait longer than its operator allowed.
 */
async function post(
  opts: ProviderOptions,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const deadline = performance.now() + opts.timeoutMs;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: combined,
  };
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await (opts.fetch ?? fetch)(url, init);
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new DecisionError(
          `decision call timed out after ${opts.timeoutMs}ms`,
          "timeout",
          504,
        );
      }
      throw new DecisionError(`decision call failed: ${(err as Error).message}`, "upstream_error");
    }
    if (res.ok || attempt > 1 || !RETRYABLE.has(res.status)) break;
    const delay = retryDelayMs(res);
    if (deadline - performance.now() - delay < RETRY_MIN_REMAINING_MS) break;
    await res.body?.cancel().catch(() => undefined);
    await waitFor(delay, combined);
    if (combined.aborted) {
      throw new DecisionError(`decision call timed out after ${opts.timeoutMs}ms`, "timeout", 504);
    }
  }
  if (!res.ok) throw statusError(res.status, await res.text().catch(() => ""));
  try {
    return await res.json();
  } catch {
    throw new DecisionError("decision backend returned non-JSON", "invalid_response");
  }
}

/** A purpose-built decision model (Jev family, OpenJev) behind the Decisions API. */
export function decisionsApiProvider(opts: ProviderOptions): DecisionProvider {
  return {
    kind: "decisions-api",
    model: opts.model,
    calibrated: true,
    async ask(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
      const started = performance.now();
      const body = (await post(
        opts,
        opts.path ?? "/decisions",
        { model: opts.model, state: request.state, questions: request.questions },
        signal,
      )) as {
        answers?: unknown;
        model?: unknown;
        usage?: { cost?: unknown; input_tokens?: unknown; output_tokens?: unknown };
      };
      const inputTokens =
        typeof body?.usage?.input_tokens === "number" ? body.usage.input_tokens : undefined;
      const cost =
        typeof body?.usage?.cost === "number"
          ? body.usage.cost
          : inputTokens !== undefined && opts.inputUsdPerMTok !== undefined
            ? (inputTokens * opts.inputUsdPerMTok) / 1_000_000
            : undefined;
      const outputTokens =
        typeof body?.usage?.output_tokens === "number" ? body.usage.output_tokens : undefined;
      return {
        answers: normalizeAnswers(request.questions, body?.answers),
        model: typeof body?.model === "string" ? body.model : opts.model,
        provider: "decisions-api",
        latencyMs: Math.round(performance.now() - started),
        ...(cost === undefined ? {} : { costUsd: cost }),
        ...(inputTokens === undefined && outputTokens === undefined
          ? {}
          : {
              usage: {
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
              },
            }),
      };
    },
  };
}

/** Pull the first balanced JSON object out of a chat reply (models wrap it in prose/fences). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new DecisionError("classifier reply has no JSON", "invalid_response");
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        break;
      }
    }
  }
  throw new DecisionError("classifier reply has malformed JSON", "invalid_response");
}

/** Output cap for a classifier reply (answers are ~100 tokens; the rest is thinking room). */
export const CLASSIFIER_MAX_TOKENS = 2_000;

const isOpenRouter = (baseUrl: string) => /^https:\/\/openrouter\.ai\//.test(baseUrl);

/** Per (server, model): what it turned out not to support, so it is not asked again. */
const unsupported = new Map<string, { logprobs?: boolean; schema?: boolean }>();

/** Test seam: forget learned server capabilities. */
export function resetClassifierCapabilitiesForTests(): void {
  unsupported.clear();
}

interface ChatReply {
  content: string;
  model?: string;
  logprobs?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Any OpenAI-compatible chat model as a decision classifier — a remote API, a
 * local server, or Marina's own `/v1` (which reaches every model Marina
 * routes). `method` picks how probabilities are obtained (see
 * `classifier-methods.ts`); the default, `verbalized` without a schema, is the
 * original behaviour.
 */
export function chatClassifierProvider(opts: ProviderOptions): DecisionProvider {
  const method = opts.method ?? "verbalized";
  const samples = Math.max(2, Math.min(15, Math.round(opts.samples ?? 5)));
  const capKey = `${opts.baseUrl}|${opts.model}`;
  const caps = () => unsupported.get(capKey) ?? {};
  const learn = (c: { logprobs?: boolean; schema?: boolean }) =>
    unsupported.set(capKey, { ...caps(), ...c });

  async function chat(
    system: string,
    user: string,
    extra: Record<string, unknown>,
    responseFormat: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<ChatReply> {
    const base = {
      model: opts.model,
      // Reasoning models spend output tokens thinking before they answer;
      // 400 left several (qwen3.7-flash, glm-5.3-flash, deepseek-v4-flash)
      // with an empty reply. OpenRouter also accepts a reasoning budget.
      max_tokens: CLASSIFIER_MAX_TOKENS,
      ...(isOpenRouter(opts.baseUrl) ? { reasoning: { effort: "low", exclude: true } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...extra,
    };
    const useSchema = !!responseFormat && opts.structured === true && !caps().schema;
    let body: unknown;
    try {
      body = await post(
        opts,
        "/chat/completions",
        useSchema ? { ...base, response_format: responseFormat } : base,
        signal,
      );
    } catch (err) {
      // A server that rejects structured output: remember, and ask plainly.
      if (!useSchema || !(err instanceof DecisionError) || err.code !== "upstream_rejected") {
        throw err;
      }
      body = await post(opts, "/chat/completions", base, signal);
      learn({ schema: true });
    }
    const b = body as {
      choices?: Array<{ message?: { content?: unknown }; logprobs?: { content?: unknown } }>;
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = b?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new DecisionError("classifier reply has no message content", "invalid_response");
    }
    const inputTokens =
      typeof b.usage?.prompt_tokens === "number" ? b.usage.prompt_tokens : undefined;
    const outputTokens =
      typeof b.usage?.completion_tokens === "number" ? b.usage.completion_tokens : undefined;
    return {
      content,
      ...(typeof b.model === "string" ? { model: b.model } : {}),
      ...(b.choices?.[0]?.logprobs?.content !== undefined
        ? { logprobs: b.choices[0].logprobs.content }
        : {}),
      ...(inputTokens === undefined && outputTokens === undefined
        ? {}
        : { usage: { inputTokens, outputTokens } }),
    };
  }

  const labeledPicks = (reply: ChatReply): Record<string, unknown> => {
    const parsed = extractJsonObject(reply.content) as { answers?: unknown };
    const answers = (parsed?.answers ?? parsed) as Record<string, unknown>;
    return answers && typeof answers === "object" ? answers : {};
  };
  const pickOf = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : undefined);

  async function verbalized(request: DecisionRequest, signal?: AbortSignal) {
    const reply = await chat(
      VERBALIZED_SYSTEM,
      verbalizedPrompt(request.state, request.questions),
      { temperature: 0 },
      answerResponseFormat(request.questions),
      signal,
    );
    const parsed = extractJsonObject(reply.content) as { answers?: unknown };
    return {
      reply,
      answers: normalizeAnswers(request.questions, parsed?.answers ?? parsed),
      used: "verbalized" as const,
    };
  }

  /** One labeled call with logprobs; undefined when the provider returned none. */
  async function withLogprobs(
    request: DecisionRequest,
    labels: Record<string, QuestionLabels>,
    signal?: AbortSignal,
  ) {
    const reply = await chat(
      LABELED_SYSTEM,
      labeledPrompt(request.state, request.questions, labels),
      { temperature: 0, logprobs: true, top_logprobs: 20 },
      answerResponseFormat(request.questions, labels),
      signal,
    );
    const dists = distributionsFromLogprobs(reply.logprobs, labels);
    if (Object.keys(dists).length === 0) {
      learn({ logprobs: true });
      return undefined;
    }
    // A question the logprobs did not cover keeps the stated label alone.
    const picks = labeledPicks(reply);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      const l = labels[id]!;
      const pick = pickOf(picks[id]);
      const dist =
        dists[id] ?? (pick && Object.hasOwn(l.byLabel, pick) ? { [pick]: 1 } : undefined);
      const answer = dist && answerFromDistribution(q, l, dist);
      if (!answer) throw new DecisionError(`answer ${id}: no label`, "invalid_response");
      answers[id] = answer;
    }
    return {
      reply,
      answers: normalizeAnswers(request.questions, answers),
      used: "logprobs" as const,
    };
  }

  async function sampled(
    request: DecisionRequest,
    labels: Record<string, QuestionLabels>,
    signal?: AbortSignal,
  ) {
    const settled = await Promise.allSettled(
      Array.from({ length: samples }, () =>
        chat(
          LABELED_SYSTEM,
          labeledPrompt(request.state, request.questions, labels),
          { temperature: 1 },
          answerResponseFormat(request.questions, labels),
          signal,
        ).then((reply) => ({ reply, picks: labeledPicks(reply) })),
      ),
    );
    const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    // Fewer than half the samples answered: the distribution would be noise.
    if (ok.length * 2 < samples) {
      const first = settled.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      throw first?.reason instanceof DecisionError
        ? first.reason
        : new DecisionError(`only ${ok.length}/${samples} samples answered`, "invalid_response");
    }
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      const l = labels[id]!;
      const dist = distributionFromSamples(
        l,
        ok.map((s) => pickOf(s.picks[id])),
      );
      const answer = dist && answerFromDistribution(q, l, dist);
      if (!answer) throw new DecisionError(`answer ${id}: no valid sample`, "invalid_response");
      answers[id] = answer;
    }
    const usage = ok.reduce(
      (u, s) => ({
        inputTokens: u.inputTokens + (s.reply.usage?.inputTokens ?? 0),
        outputTokens: u.outputTokens + (s.reply.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    return {
      reply: { ...ok[0]!.reply, usage },
      answers: normalizeAnswers(request.questions, answers),
      used: "sampled" as const,
    };
  }

  return {
    kind: "chat-classifier",
    model: opts.model,
    calibrated: false,
    async ask(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
      const started = performance.now();
      // A choice with more than 26 options cannot be labeled: verbalized only.
      const labels = method === "verbalized" ? undefined : labelQuestions(request.questions);
      let result:
        | Awaited<ReturnType<typeof verbalized>>
        | Awaited<ReturnType<typeof withLogprobs>>
        | Awaited<ReturnType<typeof sampled>>;
      if (!labels) result = await verbalized(request, signal);
      else if (method === "sampled") result = await sampled(request, labels, signal);
      else if (method === "logprobs" || (method === "auto" && !caps().logprobs)) {
        result =
          (await withLogprobs(request, labels, signal)) ?? (await verbalized(request, signal));
      } else result = await verbalized(request, signal);
      const { reply, answers, used } = result!;
      return {
        answers,
        model: reply.model ?? opts.model,
        provider: "chat-classifier",
        method: used,
        latencyMs: Math.round(performance.now() - started),
        ...(reply.usage ? { usage: reply.usage } : {}),
      };
    },
  };
}
