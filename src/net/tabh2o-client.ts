// ─── TabH2O Tabular Foundation Model Client ─────────────────────────────────
//
// Minimal HTTP wrapper around H2O's hosted TabH2O endpoint. Used by the market
// forecast subcommand + the matching MCP tool to ground agent predictions in
// past resolved markets.
//
// Design notes:
// - SSRF-safe: every outbound call runs through validateFetchUrl(), though the
//   production endpoint is public so this is mostly defense-in-depth.
// - Timeout-safe: AbortController with the standard connector timeout.
// - Graceful degradation: returns a typed error instead of throwing so callers
//   can fall back to reasoning without the model.
// - No retries, no queueing — rate limiting is the caller's responsibility
//   (MCP tools use runCmd's per-entity limiter; commands use runCmd as well).

import { CONNECTOR_HTTP_TIMEOUT_MS } from "../engine/constants";
import { validateFetchUrl } from "./url-guard";

/** Override with env var for self-hosted deployments. */
const DEFAULT_ENDPOINT = "https://tabh2o.h2oai.com/api/v1/predict";

export type TabH2OTask = "classification" | "regression" | "forecast";

/** A single labeled row in the training set, or an unlabeled row to predict. */
export type TabH2ORow = Record<string, string | number | boolean | null>;

export interface TabH2OPredictRequest {
  task: TabH2OTask;
  /** Labeled training rows — the `target_column` value is what the model learns. */
  training: TabH2ORow[];
  /** Rows to predict on — should have the same features as training (minus target). */
  predict_on: TabH2ORow[];
  /** Which column in `training` holds the label. */
  target_column: string;
  /** Optional subset of features to use; defaults to all non-target columns. */
  feature_columns?: string[];
}

export interface TabH2OPrediction {
  /** Predicted label (class for classification, value for regression). */
  prediction: string | number;
  /** For classification: probabilities per class, keyed by class label. */
  probabilities?: Record<string, number>;
  /** For regression/forecast: [low, high] CI bounds. */
  confidence_interval?: [number, number];
}

export interface TabH2OPredictResponse {
  task: TabH2OTask;
  predictions: TabH2OPrediction[];
  model_version?: string;
  runtime_ms?: number;
  warnings?: string[];
}

export type TabH2OResult =
  | { ok: true; response: TabH2OPredictResponse }
  | { ok: false; error: string };

export interface TabH2OClientOpts {
  /** Bearer token — typically `process.env.TABH2O_API_KEY`. */
  apiKey?: string;
  /** Override endpoint for self-hosted / sandbox. */
  endpoint?: string;
  /** Override default request timeout. */
  timeoutMs?: number;
}

/**
 * Is the TabH2O client configured? The command/MCP tool should degrade
 * gracefully when this returns false, not crash.
 */
export function isTabH2OConfigured(apiKey = process.env.TABH2O_API_KEY): boolean {
  return typeof apiKey === "string" && apiKey.length > 0;
}

/**
 * POST a prediction request to TabH2O. Returns a typed result instead of
 * throwing so callers don't have to wrap every call in try/catch. Network
 * errors, non-200 responses, malformed JSON, and validation failures all
 * collapse to `{ ok: false, error }`.
 */
export async function tabh2oPredict(
  request: TabH2OPredictRequest,
  opts: TabH2OClientOpts = {},
): Promise<TabH2OResult> {
  const apiKey = opts.apiKey ?? process.env.TABH2O_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "TABH2O_API_KEY not set — ask an admin to configure the TabH2O integration.",
    };
  }

  if (request.training.length === 0) {
    return { ok: false, error: "No training rows provided — need at least one labeled row." };
  }
  if (request.predict_on.length === 0) {
    return { ok: false, error: "No rows to predict on." };
  }

  const endpoint = opts.endpoint ?? process.env.TABH2O_ENDPOINT ?? DEFAULT_ENDPOINT;
  const urlErr = validateFetchUrl(endpoint);
  if (urlErr) return { ok: false, error: `TabH2O endpoint rejected: ${urlErr}` };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `TabH2O returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }

    const json = (await res.json()) as TabH2OPredictResponse;
    if (!Array.isArray(json.predictions)) {
      return { ok: false, error: "TabH2O response missing predictions array." };
    }
    return { ok: true, response: json };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: `TabH2O request timed out after ${timeoutMs}ms.` };
    }
    return { ok: false, error: `TabH2O request failed: ${(err as Error).message}` };
  }
}
