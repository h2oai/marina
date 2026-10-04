// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Spawn-time tool-calling probe. An agent acts only through tool calls, so a
 * model that answers in prose leaves it silent — and a model id the bundled
 * registry does not know (or any OpenRouter route, whose serving provider can
 * change) carries no evidence either way. The probe sends one tiny request
 * with one tool and records whether the model called it, once per model id per
 * process:
 *
 *  - `tools`        — the model called the tool.
 *  - `no-tool-call` — it answered without one (prose, or ran out of output).
 *  - `unknown`      — the probe could not tell (network, auth, timeout, 4xx).
 *
 * A second request with reasoning disabled tells `reasoning-control` whether
 * the explicit disable is safe for this model (it is only ever sent when this
 * succeeded with a tool call). Results surface in `agent status` and
 * `readiness`. `MARINA_TOOL_PROBE=off|warn|refuse` (default `warn`): `refuse`
 * stops a crew lead whose model made no tool call.
 */
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";
import { isLocalProvider } from "../net/model-discovery";
import { piModels } from "./pi-models";
import {
  isOpenRouterModel,
  markReasoningOffVerified,
  noteUpstreamRejection,
  shapeOpenRouterPayload,
} from "./reasoning-control";

export type ToolProbeOutcome = "tools" | "no-tool-call" | "unknown";

export interface ToolProbeResult {
  /** `provider/model` as spawned. */
  model: string;
  outcome: ToolProbeOutcome;
  /** The reasoning-disabled variant (OpenRouter only; absent when not tried). */
  reasoningOff?: ToolProbeOutcome | "rejected";
  /** One line for operators: stop reason, token use or the error. */
  detail: string;
  at: number;
}

export type ToolProbeMode = "off" | "warn" | "refuse";

export function toolProbeMode(env: NodeJS.ProcessEnv = process.env): ToolProbeMode {
  const raw = (env.MARINA_TOOL_PROBE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "refuse" || raw === "warn") return raw;
  // Unset under a test runner: no live probe requests from test spawns.
  return env.NODE_ENV === "test" ? "off" : "warn";
}

/**
 * Whether a spawn on `modelStr` should be probed: an id the registry does not
 * know, or any OpenRouter route. Never the Marina proxy (its upstream is probed
 * where it is configured) or a local runtime (no per-call spend, its own
 * operator).
 */
export function shouldProbeTools(
  modelStr: string,
  resolution: "exact" | "synthesized" | "fallback",
): boolean {
  const provider = (modelStr.split("@")[0] ?? modelStr).split("/")[0] ?? "";
  if (provider === "marina" || isLocalProvider(provider)) return false;
  return resolution === "synthesized" || provider === "openrouter";
}

const results = new Map<string, ToolProbeResult>();
/** Inconclusive probes, kept apart from `results` and retried only after a back-off. */
const inconclusive = new Map<string, ToolProbeResult>();
/** How long an inconclusive probe stands before a spawn on that model probes again. */
export const INCONCLUSIVE_PROBE_RETRY_MS = 10 * 60_000;
const inflight = new Map<string, Promise<ToolProbeResult>>();

/** The cached probe result for `modelStr`, if any. */
export function toolProbeResult(modelStr: string): ToolProbeResult | undefined {
  return results.get(modelStr);
}

/** Every cached probe result, newest first. */
export function listToolProbeResults(): ToolProbeResult[] {
  return [...results.values()].sort((a, b) => b.at - a.at);
}

/** Test hook. */
export function resetToolProbeForTests(): void {
  results.clear();
  inconclusive.clear();
  inflight.clear();
}

/** Test hook: seed a result without a request. */
export function recordToolProbeResultForTests(result: ToolProbeResult): void {
  results.set(result.model, result);
}

const PROBE_TOOL = {
  name: "send_message",
  description: "Send a message to a channel.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string" },
      text: { type: "string" },
    },
    required: ["channel", "text"],
  },
} as unknown as NonNullable<Context["tools"]>[number];

const PROBE_CONTEXT: Context = {
  systemPrompt: "You act only by calling tools. Prose is never delivered.",
  messages: [
    {
      role: "user",
      content: "Send the text 'ready' to the channel 'general'.",
      timestamp: 0,
    } as Message,
  ],
  tools: [PROBE_TOOL],
};

/** Output allowance for the probe: room for default reasoning before the call. */
const PROBE_MAX_TOKENS = 4096;
const PROBE_TIMEOUT_MS = 30_000;

export type ProbeComplete = (
  model: Model<Api>,
  context: Context,
  options: {
    apiKey?: string;
    maxTokens: number;
    signal: AbortSignal;
    onPayload: (payload: unknown) => unknown;
  },
) => Promise<AssistantMessage>;

const defaultComplete: ProbeComplete = (model, context, options) =>
  piModels.completeSimple(model, context, {
    apiKey: options.apiKey,
    maxTokens: options.maxTokens,
    signal: options.signal,
    onPayload: (payload) => options.onPayload(payload),
  });

function classify(message: AssistantMessage): { outcome: ToolProbeOutcome; detail: string } {
  const calls = (message.content ?? []).filter((block) => block.type === "toolCall").length;
  const out = message.usage?.output ?? 0;
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      outcome: "unknown",
      detail: `error: ${(message.errorMessage ?? "unknown").slice(0, 160)}`,
    };
  }
  if (calls > 0) return { outcome: "tools", detail: `tool call (${out} output tokens)` };
  return {
    outcome: "no-tool-call",
    detail: `no tool call (stop=${message.stopReason}, ${out} output tokens)`,
  };
}

async function attempt(
  model: Model<Api>,
  apiKey: string | undefined,
  complete: ProbeComplete,
  reasoningOff: boolean,
  timeoutMs: number,
): Promise<{ outcome: ToolProbeOutcome | "rejected"; detail: string }> {
  try {
    const message = await complete(model, PROBE_CONTEXT, {
      apiKey,
      maxTokens: PROBE_MAX_TOKENS,
      signal: AbortSignal.timeout(timeoutMs),
      onPayload: (payload) => {
        const shaped = shapeOpenRouterPayload(payload, model, "off") ?? payload;
        return reasoningOff && typeof shaped === "object" && shaped !== null
          ? { ...(shaped as Record<string, unknown>), reasoning: { enabled: false } }
          : shaped;
      },
    });
    recordSpend("agent", message.usage?.cost?.total);
    if (message.stopReason === "error") {
      const lesson = noteUpstreamRejection(model.id, message.errorMessage);
      if (reasoningOff && lesson === "reasoning-mandatory") {
        return { outcome: "rejected", detail: "reasoning cannot be disabled" };
      }
    }
    return classify(message);
  } catch (err) {
    return { outcome: "unknown", detail: `error: ${String(err).slice(0, 160)}` };
  }
}

/**
 * Probe `model` (spawned as `modelStr`) once per process; concurrent spawns on
 * the same model share one probe. Never throws.
 */
export function probeToolCalling(
  modelStr: string,
  model: Model<Api>,
  apiKey: string | undefined,
  opts: {
    complete?: ProbeComplete;
    timeoutMs?: number;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ToolProbeResult> {
  const cached = results.get(modelStr);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(modelStr);
  if (pending) return pending;
  const now = opts.now ?? Date.now;
  // An inconclusive probe (network, auth, timeout) is not re-sent on every
  // spawn: each probe costs money, so it waits out a back-off first.
  const recent = inconclusive.get(modelStr);
  if (recent && now() - recent.at < INCONCLUSIVE_PROBE_RETRY_MS) return Promise.resolve(recent);
  // The probe is a paid request like any other: none at the daily cap.
  const capped = dailyCapRefusal(opts.env);
  if (capped) {
    return Promise.resolve({
      model: modelStr,
      outcome: "unknown",
      detail: `not probed: ${capped.split(";")[0]}`,
      at: now(),
    });
  }
  const complete = opts.complete ?? defaultComplete;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const run = (async (): Promise<ToolProbeResult> => {
    const first = await attempt(model, apiKey, complete, false, timeoutMs);
    const outcome = first.outcome === "rejected" ? "unknown" : first.outcome;
    let reasoningOff: ToolProbeResult["reasoningOff"];
    if (isOpenRouterModel(model) && outcome !== "unknown") {
      const second = await attempt(model, apiKey, complete, true, timeoutMs);
      reasoningOff = second.outcome;
      if (second.outcome === "tools") markReasoningOffVerified(model.id);
    }
    const result: ToolProbeResult = {
      model: modelStr,
      outcome,
      ...(reasoningOff ? { reasoningOff } : {}),
      detail: first.detail,
      at: now(),
    };
    // An inconclusive probe is not a result; a spawn after the back-off tries again.
    if (outcome === "unknown") inconclusive.set(modelStr, result);
    else {
      results.set(modelStr, result);
      inconclusive.delete(modelStr);
    }
    return result;
  })().finally(() => inflight.delete(modelStr));
  inflight.set(modelStr, run);
  return run;
}

/** One status line for `agent status`, or undefined when never probed. */
export function describeToolProbe(modelStr: string): string | undefined {
  const r = results.get(modelStr);
  if (!r) return undefined;
  const label =
    r.outcome === "tools"
      ? "calls tools"
      : r.outcome === "no-tool-call"
        ? "NO tool call — agent may stay silent"
        : "inconclusive";
  const off =
    r.reasoningOff === undefined
      ? ""
      : r.reasoningOff === "tools"
        ? "; reasoning-off verified"
        : r.reasoningOff === "rejected"
          ? "; reasoning mandatory"
          : "; reasoning-off not used";
  return `${label} (${r.detail}${off})`;
}
