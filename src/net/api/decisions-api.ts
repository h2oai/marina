// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/decisions` (alias `POST /v1/systemone`, TypeSafe's own path) — Marina as a decision endpoint for ANY harness, not only
 * the pi agents it runs: Claude Code hooks, Codex, LangChain middleware or a
 * custom loop send `{ state, questions }` in the Decisions API wire format
 * (noul / choice / score) and get typed answers back from whichever backend the
 * operator configured (a Jev-family / OpenJev decision model, or any chat model
 * used as a classifier), or — chosen by `model` — a `marina/classifier:<m>`
 * engine answering through Marina's own passthru (`src/decisions/engines.ts`).
 * Auth and per-IP rate limiting are the model API's
 * (`handleModelApi`), which fails closed.
 *
 * Request:  { state: string | object | array, questions: { <id>: { type, instructions, criteria } } }
 *           `state` may carry image parts — { type: "image_url", image_url: { url: "data:image/png;base64,…" } } —
 *           as array elements beside text (box questions locate something in them).
 * Response: { answers: { <id>: { type, ... } }, model, provider, latency_ms, usage?: { cost } }
 *
 * Sizing: the text of `state` (each image counted as an `[image N]` marker) is
 * capped at 64 KB; images are counted separately — at most
 * `MARINA_DECISION_MAX_IMAGES` (default 8), each ≤ 16 MiB decoded, together
 * ≤ 30 MiB — and every image is prepared to the backend's limits before it
 * leaves Marina (src/decisions/images.ts).
 */

import { toWireAnswers } from "../../decisions/answers";
import { type EngineDeps, listEngines, resolveEngine } from "../../decisions/engines";
import {
  DECISION_IMAGE_LIMITS,
  DECISION_MAX_REQUEST_IMAGE_BYTES,
  dataUrlDecodedBytes,
  decisionMaxImages,
  stateImages,
  stateTextBytes,
} from "../../decisions/images";
import { parseQuestions } from "../../decisions/questions";
import { DecisionError } from "../../decisions/types";
import { errorJson, json } from "../model-api/shared";

export { acceptsRequestedModel } from "../../decisions/model-ids";

/** Largest serialized `state` text accepted (images excluded; see the module comment). */
const MAX_STATE_BYTES = 64 * 1024;
/** Largest request body: Jev's 32 MiB request cap, images included. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Why a request's images are refused before any backend is asked; undefined ⇒ acceptable. */
function imageSizingError(state: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const images = stateImages(state);
  if (images.length === 0) return undefined;
  const max = decisionMaxImages(env);
  if (images.length > max) return `state carries ${images.length} images; the limit is ${max}.`;
  const perImage = DECISION_IMAGE_LIMITS.maxBytes ?? 16 * 1024 * 1024;
  let total = 0;
  for (const [i, part] of images.entries()) {
    const url = part.image_url.url;
    const size = dataUrlDecodedBytes(url);
    if (size === undefined) {
      return /^https?:\/\//i.test(url)
        ? `image ${i + 1}: remote URLs are not fetched; send a base64 data URL.`
        : `image ${i + 1}: not a base64 data URL (data:image/png;base64,…).`;
    }
    if (size > perImage) return `image ${i + 1}: ${size} bytes decoded exceeds ${perImage}.`;
    total += size;
  }
  if (total > DECISION_MAX_REQUEST_IMAGE_BYTES) {
    return `images total ${total} bytes decoded; the limit is ${DECISION_MAX_REQUEST_IMAGE_BYTES}.`;
  }
  return undefined;
}

/** `GET /v1/decisions/models` (alias `/v1/systemone/models`): the engines served here. */
export function handleDecisionModels(): Response {
  return json({
    object: "list",
    data: listEngines().map((e) => ({ object: "decision_engine", ...e })),
  });
}

export async function handleDecisions(req: Request, deps: EngineDeps = {}): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return errorJson(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`, {
      code: "payload_too_large",
    });
  }
  let body: Record<string, unknown> | undefined;
  try {
    const raw: unknown = await req.json();
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      body = raw as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  // The engine is chosen by `model`; operator configuration decides what exists
  // (a disabled instance says so before judging the body).
  const resolved = resolveEngine(body?.model, process.env, deps);
  if ("error" in resolved && resolved.error.code === "decisions_disabled") {
    return errorJson(404, resolved.error.message, { code: "decisions_disabled" });
  }
  if (!body) {
    return errorJson(400, "Request body must be a JSON object.", { code: "invalid_request_error" });
  }
  if ("error" in resolved) {
    const { status, message, code } = resolved.error;
    return errorJson(status, message, { code, param: "model" });
  }
  const provider = resolved.provider;
  const state = body.state;
  if (state === undefined || state === null || state === "") {
    return errorJson(400, "state is required.", { code: "invalid_request_error", param: "state" });
  }
  if (stateTextBytes(state) > MAX_STATE_BYTES) {
    return errorJson(400, `state exceeds ${MAX_STATE_BYTES} bytes.`, {
      code: "invalid_request_error",
      param: "state",
    });
  }
  const imageError = imageSizingError(state, process.env);
  if (imageError) {
    return errorJson(400, imageError, { code: "unsupported_parameter", param: "state" });
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
      ...(result.method ? { method: result.method } : {}),
      ...(result.members ? { members: result.members } : {}),
      // False for a chat model used as a classifier: read its numbers as
      // rankings, not probabilities (no fine thresholds).
      calibrated: (result.calibrated ?? provider.calibrated) !== false,
      latency_ms: result.latencyMs,
    });
  } catch (err) {
    if (err instanceof DecisionError) return decisionErrorResponse(err);
    throw err;
  }
}

/**
 * Map a backend failure onto the status a Decisions API client expects, so
 * TypeSafe clients' own handling works through Marina: 422 for a request the
 * backend refused, 429 / 529 (and 503) for the ones they back off and retry.
 */
function decisionErrorResponse(err: DecisionError): Response {
  switch (err.code) {
    case "invalid_request":
      return errorJson(400, err.message, { code: "invalid_request_error", param: "questions" });
    case "unsupported_input":
      // An image the backend cannot take, or a box for a Jev older than 1.14.
      return errorJson(400, err.message, { code: "unsupported_parameter", param: "state" });
    case "upstream_rejected":
      return errorJson(422, err.message, { code: "invalid_request_error" });
    case "rate_limited":
      return errorJson(429, err.message, { code: "rate_limit_exceeded" });
    case "spend_cap":
      return errorJson(429, err.message, { code: "spend_cap_reached" });
    default:
      // overloaded keeps its 503 / 529 so clients back off; the rest are 502 / 504.
      return errorJson(err.status, err.message, { code: "upstream_error" });
  }
}
