// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Request shaping for the compaction summary call: one tool-free completion
 * whose whole value is its text. Measured 2026-10-20 (40 public-benchmark
 * trajectories, the real compaction path through OpenRouter): with no reasoning
 * directive, models that reason by default spent the output cap thinking —
 * Claude Haiku 5.5 fell back to the rule-based summary on 95 % of compactions,
 * DeepSeek v4.1 Flash on 82 %, and Qwen 3.5 Flash wrote its "Thinking
 * Process:" as the summary. With each provider's own reasoning switch off,
 * fact retention rose by 0.27–0.42 for those models.
 *
 *  - {@link summaryCallModel}: the model with its registry reasoning flag
 *    restored, so pi-ai sends the provider's NATIVE disable when no effort is
 *    asked (OpenAI `reasoning_effort`/`reasoning.effort: "none"`, DeepSeek
 *    `thinking: {type:"disabled"}`, Qwen `enable_thinking: false`, …).
 *  - {@link disableReasoningPayload}: the explicit switch where pi-ai sends
 *    none: OpenRouter `reasoning: {enabled: false}` (a low, excluded effort for
 *    a model whose reasoning is mandatory) and Anthropic `thinking: {type:
 *    "disabled"}` (except the Claude 5 models whose reasoning is mandatory).
 *  - {@link stripLeakedReasoning}: a reply that still carries its reasoning
 *    as text loses it; a reply that is ONLY reasoning becomes empty (the caller
 *    then falls back).
 *  - {@link compactionMaxTokens}: the output cap (`MARINA_AGENT_COMPACTION_MAX_TOKENS`,
 *    default 800 — at 500 the best summariser was cut off on 93 % of
 *    compactions; at 800 on 10 %, with no loss of fidelity).
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { catalogModel } from "../net/model/catalog-snapshots";
import { lowestReasoningEffort } from "../net/model/reasoning-effort";
import { piModels } from "./pi-models";
import {
  isOpenRouterModel,
  isReasoningMandatory,
  REASONING_HEADROOM_TOKENS,
} from "./reasoning-control";

/** Default output cap of a compaction summary, in tokens. */
export const DEFAULT_COMPACTION_MAX_TOKENS = 800;
const MIN_COMPACTION_MAX_TOKENS = 200;
const MAX_COMPACTION_MAX_TOKENS = 8_000;

/** `MARINA_AGENT_COMPACTION_MAX_TOKENS`: junk or unset ⇒ the default; clamped to 200–8000. */
export function compactionMaxTokens(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.MARINA_AGENT_COMPACTION_MAX_TOKENS?.trim() || Number.NaN);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COMPACTION_MAX_TOKENS;
  return Math.min(MAX_COMPACTION_MAX_TOKENS, Math.max(MIN_COMPACTION_MAX_TOKENS, Math.floor(raw)));
}

/** Upstream model id as OpenRouter's catalog and the learned facts key it. */
function upstreamId(model: Pick<Model<Api>, "id">): string {
  return model.id.replace(/^openrouter\//, "").replace(/^~/, "");
}

/** True when the model cannot stop reasoning (learned, or OpenRouter's catalog). */
export function reasoningMandatory(
  model: Pick<Model<Api>, "id" | "provider" | "baseUrl">,
): boolean {
  const id = upstreamId(model);
  if (isReasoningMandatory(id)) return true;
  return isOpenRouterModel(model) && lowestReasoningEffort("openrouter", id) === "low";
}

/**
 * The summary call's model. The agent's model is usually neutralized
 * (`reasoning: false`, so a TOOL-CALLING turn sends no directive a mandatory
 * model would refuse); for the tool-free summary call the registry's reasoning
 * flag is restored so pi-ai emits the provider's own disable.
 */
export function summaryCallModel(model: Model<Api>): Model<Api> {
  if (model.reasoning || reasoningMandatory(model)) return model;
  let listed: Model<Api> | undefined;
  try {
    listed = catalogModel(
      (id) =>
        piModels.getModel(String(model.provider) as never, id as never) as Model<Api> | undefined,
      model.id,
    );
  } catch {
    listed = undefined;
  }
  return listed?.reasoning ? { ...model, reasoning: true } : model;
}

/** Output cap for the call: the summary cap, plus room for reasoning a model cannot turn off. */
export function summaryCallMaxTokens(model: Model<Api>, cap: number): number {
  return reasoningMandatory(model) ? cap + REASONING_HEADROOM_TOKENS : cap;
}

/**
 * Patch the outgoing body of a summary call with the reasoning switch pi-ai
 * does not send itself. Returns the new body, or `undefined` to keep it.
 * `MARINA_OPENROUTER_REASONING_OFF=off` leaves OpenRouter bodies alone.
 */
export function disableReasoningPayload(
  payload: unknown,
  model: Pick<Model<Api>, "id" | "api" | "provider" | "baseUrl">,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  const mandatory = reasoningMandatory(model);
  if (model.api === "anthropic-messages") {
    // Anthropic's own switch (OpenRouter's Messages endpoint takes it too).
    // Thinking that cannot be disabled is asked for at its lowest effort.
    if (mandatory)
      return body.thinking === undefined
        ? undefined
        : { ...body, output_config: { ...asRecord(body.output_config), effort: "low" } };
    const thinking = body.thinking as { type?: unknown } | undefined;
    if (thinking?.type === "disabled") return undefined;
    const { output_config: _effort, ...rest } = body;
    return { ...rest, thinking: { type: "disabled" } };
  }
  if (!isOpenRouterModel(model)) return undefined;
  if ((env.MARINA_OPENROUTER_REASONING_OFF ?? "").trim().toLowerCase() === "off") return undefined;
  const { reasoning_effort: _effort, ...rest } = body;
  return {
    ...rest,
    reasoning: mandatory ? { effort: "low", exclude: true } : { enabled: false },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// A reply that opens with its reasoning. Deliberately narrow: a real summary
// never starts with these.
const REASONING_LEAD =
  /^\s*(?:\*\*|#+\s*)?(?:thinking process|thought process|reasoning process|internal reasoning)\b|^\s*(?:okay|ok|alright|so)?[,.]?\s*(?:the user (?:wants|is asking|has asked|asked) me\b|let me (?:analy[sz]e|think)\b)/i;
// Where a leaked preamble hands over to the answer.
const ANSWER_MARKER =
  /^\s*(?:#+\s*|\*\*)?(?:final (?:answer|output|checkpoint|summary)|checkpoint|summary|output)\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/gim;

/**
 * The reply without leaked reasoning: `<think>`/`<thinking>` blocks removed
 * (an unclosed one drops the rest); a reply that opens with a reasoning
 * preamble keeps only what follows its last answer marker, or nothing.
 */
export function stripLeakedReasoning(text: string): string {
  let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  const open = /<(?:think|thinking|reasoning)>/i.exec(out);
  if (open) out = out.slice(0, open.index);
  // A stray closing tag: everything before it was reasoning.
  const close = /<\/(?:think|thinking|reasoning)>/gi;
  let lastClose: RegExpExecArray | null = null;
  for (let m = close.exec(out); m; m = close.exec(out)) lastClose = m;
  if (lastClose) out = out.slice(lastClose.index + lastClose[0].length);
  out = out.trim();
  if (!REASONING_LEAD.test(out)) return out;
  let marker: RegExpExecArray | null = null;
  ANSWER_MARKER.lastIndex = 0;
  for (let m = ANSWER_MARKER.exec(out); m; m = ANSWER_MARKER.exec(out)) marker = m;
  return marker ? out.slice(marker.index + marker[0].length).trim() : "";
}
