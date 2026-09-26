// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI-compatible error envelopes for the model API.
 *
 * OpenAI SDKs branch on `error.code` (a string) far more than on the HTTP
 * status: `invalid_api_key` triggers a credential prompt, `model_not_found`
 * a model-picker fallback, `context_length_exceeded` an automatic history
 * trim, `rate_limit_exceeded` a backoff, `unsupported_parameter` a feature
 * downgrade. Emitting `code: null` everywhere (the previous behavior) made
 * every failure look the same to those clients. This module owns the code
 * vocabulary and the status → type mapping so every error site in
 * `model-api.ts` produces the same shape.
 */

export type OpenAIErrorCode =
  | "invalid_api_key"
  | "model_not_found"
  | "not_found"
  | "context_length_exceeded"
  | "rate_limit_exceeded"
  | "unsupported_parameter"
  | "invalid_request_error"
  | "upstream_error"
  | "server_error"
  // POST /v1/decisions while MARINA_DECISIONS is off (src/net/decisions-api.ts).
  | "decisions_disabled"
  // POST /v1/forecast without the keys forecasting needs (src/net/forecast-api.ts).
  | "forecast_unavailable"
  // The world's MARINA_DAILY_SPEND_CAP_USD is spent (src/engine/spend-ledger.ts).
  | "spend_cap_reached";

export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "server_error";

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: OpenAIErrorCode;
  };
}

export interface OpenAIErrorOptions {
  /** Explicit code; inferred from status + message when omitted. */
  code?: OpenAIErrorCode;
  /** The offending request parameter (OpenAI dot path, e.g. `response_format`). */
  param?: string;
}

/** HTTP status → OpenAI `error.type`. */
export function openaiErrorType(status: number): OpenAIErrorType {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  return "server_error";
}

const CONTEXT_LENGTH_RE =
  /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|input is too long|exceeds the (?:model'?s )?(?:maximum|context)/i;

/**
 * Infer the closest known code from the status and the human message. Used
 * when an error site has no more specific knowledge (e.g. an upstream 4xx
 * whose body we only have as text). Never returns `unsupported_parameter` —
 * that one is always explicit because it needs a `param`.
 */
export function inferOpenAIErrorCode(status: number, message: string): OpenAIErrorCode {
  if (status === 401 || status === 403) return "invalid_api_key";
  if (status === 404) return /model/i.test(message) ? "model_not_found" : "not_found";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 400) {
    return CONTEXT_LENGTH_RE.test(message) ? "context_length_exceeded" : "invalid_request_error";
  }
  if (status === 502 || status === 503 || status === 504) return "upstream_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

export function openaiErrorBody(
  status: number,
  message: string,
  opts: OpenAIErrorOptions = {},
): OpenAIErrorBody {
  return {
    error: {
      message,
      type: openaiErrorType(status),
      param: opts.param ?? null,
      code: opts.code ?? inferOpenAIErrorCode(status, message),
    },
  };
}

/**
 * A request parameter the current route cannot honor. Callers return this
 * instead of silently dropping the field: a client that asked for
 * `response_format` or `n: 3` and got a plain answer has no way to notice.
 */
export function unsupportedParameterBody(param: string, detail?: string): OpenAIErrorBody {
  const message = detail
    ? `Unsupported parameter: '${param}'. ${detail}`
    : `Unsupported parameter: '${param}' is not supported on this route.`;
  return openaiErrorBody(400, message, { code: "unsupported_parameter", param });
}

/** Error thrown by translation code to signal an unsupported parameter. */
export class UnsupportedParameterError extends Error {
  readonly status = 400;
  constructor(
    readonly param: string,
    readonly detail?: string,
  ) {
    super(unsupportedParameterBody(param, detail).error.message);
    this.name = "UnsupportedParameterError";
  }
  toBody(): OpenAIErrorBody {
    return unsupportedParameterBody(this.param, this.detail);
  }
}
