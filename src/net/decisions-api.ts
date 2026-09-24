// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/decisions` (alias `POST /v1/systemone`, TypeSafe's own path) — Marina as a decision endpoint for ANY harness, not only
 * the pi agents it runs: Claude Code hooks, Codex, LangChain middleware or a
 * custom loop send `{ state, questions }` in the Decisions API wire format
 * (noul / choice / score) and get typed answers back from whichever backend the
 * operator configured (a Jev-family / OpenJev decision model, or any chat model
 * used as a classifier). Auth and per-IP rate limiting are the model API's
 * (`handleModelApi`), which fails closed.
 *
 * Request:  { state: string | object | array, questions: { <id>: { type, instructions, criteria } } }
 * Response: { answers: { <id>: { type, ... } }, model, provider, latency_ms, usage?: { cost } }
 */

import { toWireAnswers } from "../decisions/answers";
import { getDecisionProvider } from "../decisions/config";
import { parseQuestions } from "../decisions/questions";
import { DecisionError } from "../decisions/types";
import { errorJson, json } from "./model-api/shared";

/**
 * A caller may name the configured model, or that model family's `-latest`
 * alias — what TypeSafe clients send by default (`jev-latest`,
 * `~typesafe/jev-latest`) — so `langchain-typesafe` works unchanged. Any other
 * model is refused rather than silently answered by a different one.
 */
export function acceptsRequestedModel(requested: unknown, configured: string): boolean {
  if (typeof requested !== "string") return false;
  if (requested === configured) return true;
  const bare = (id: string) => id.trim().replace(/^~/, "").split("/").pop() ?? "";
  const family = (id: string) => bare(id).replace(/-(latest|\d[\w.]*)$/, "");
  return bare(requested).endsWith("-latest") && family(requested) === family(configured);
}

/** Largest serialized `state` accepted (the Jev family's context is 32k tokens). */
const MAX_STATE_BYTES = 64 * 1024;

export async function handleDecisions(req: Request): Promise<Response> {
  const provider = getDecisionProvider();
  if (!provider) {
    return errorJson(
      404,
      "Decisions are disabled on this instance. Set MARINA_DECISIONS (see .env.example).",
      { code: "decisions_disabled" },
    );
  }
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    body = raw as Record<string, unknown>;
  } catch {
    return errorJson(400, "Request body must be a JSON object.", { code: "invalid_request_error" });
  }
  if (body.model !== undefined && !acceptsRequestedModel(body.model, provider.model)) {
    // The backend model is operator configuration; a caller cannot pick another.
    return errorJson(
      400,
      `This instance answers decisions with "${provider.model}"; omit model or pass that id.`,
      { code: "unsupported_parameter", param: "model" },
    );
  }
  const state = body.state;
  if (state === undefined || state === null || state === "") {
    return errorJson(400, "state is required.", { code: "invalid_request_error", param: "state" });
  }
  if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_STATE_BYTES) {
    return errorJson(400, `state exceeds ${MAX_STATE_BYTES} bytes.`, {
      code: "invalid_request_error",
      param: "state",
    });
  }
  try {
    const questions = parseQuestions(body.questions);
    const result = await provider.ask({ state, questions }, req.signal);
    const usage = {
      ...(result.usage?.inputTokens === undefined
        ? {}
        : { input_tokens: result.usage.inputTokens }),
      ...(result.usage?.outputTokens === undefined
        ? {}
        : { output_tokens: result.usage.outputTokens }),
      ...(result.costUsd === undefined ? {} : { cost: result.costUsd }),
    };
    return json({
      model: result.model,
      answers: toWireAnswers(questions, result.answers),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      provider: result.provider,
      latency_ms: result.latencyMs,
    });
  } catch (err) {
    if (err instanceof DecisionError) {
      if (err.code === "invalid_request") {
        return errorJson(400, err.message, { code: "invalid_request_error", param: "questions" });
      }
      return errorJson(err.status, err.message, { code: "upstream_error" });
    }
    throw err;
  }
}
