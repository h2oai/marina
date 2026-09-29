// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── TabH2O Tabular Foundation Model Client ─────────────────────────────────
//
// Minimal HTTP wrapper around H2O's hosted TabH2O endpoint. Used by the market
// forecast subcommand + the matching MCP tool to ground agent predictions in
// past resolved markets, and by the experimental `tabh2o` arena forecaster.
//
// Design notes:
// - SSRF-safe: every outbound call runs through validateFetchUrl(), though the
//   production endpoint is public so this is mostly defense-in-depth.
// - Timeout-safe: AbortController with the standard connector timeout.
// - Graceful degradation: returns a typed error instead of throwing so callers
//   can fall back to reasoning without the model.
// - No retries, no queueing — rate limiting is the caller's responsibility
//   (MCP tools use runCmd's per-entity limiter; commands use runCmd as well).
// - Callers speak in row objects; the API's own wire format (column names plus
//   row arrays in, parallel result arrays out — tabh2o.h2oai.com/docs, checked
//   live 2026-09-29) is translated here by toWireRequest / fromWireResponse.

import { CONNECTOR_HTTP_TIMEOUT_MS } from "../engine/constants";
import { guardedFetch, validateFetchUrl } from "./url-guard";

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
  /**
   * Time/date column: a timeseries forecast, sent to the `/forecast` endpoint
   * (the API's `time_column`). `task: "forecast"` without one is a plain regression.
   */
  time_column?: string;
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
  /** What the call was billed: cells processed and the price in USD. */
  usage?: { cells: number; priceUsd: number };
}

export type TabH2OResult =
  | { ok: true; response: TabH2OPredictResponse }
  | { ok: false; error: string; status?: number; retryAfterSec?: number };

export interface TabH2OClientOpts {
  /** Bearer token — typically `process.env.TABH2O_API_KEY`. */
  apiKey?: string;
  /** Override endpoint for self-hosted / sandbox. */
  endpoint?: string;
  /** Override default request timeout. */
  timeoutMs?: number;
}

type Cell = string | number | boolean | null;

/** The API's request body: column names plus row arrays. */
export interface TabH2OWireRequest {
  task: "classification" | "regression";
  train: { columns: string[]; data: Cell[][] };
  test: { columns: string[]; data: Cell[][] };
  target_column: string;
  time_column?: string;
}

/** The API's response body: arrays parallel to the test rows. */
export interface TabH2OWireResponse {
  predictions: Array<string | number>;
  /** Classification: per-row class probabilities, classes in sorted label order. */
  probabilities?: number[][];
  /** Regression / forecast: per-row [lower, upper]. */
  confidence_intervals?: Array<[number, number]>;
  usage?: { cells?: number; multiplier?: number; price_usd?: string };
  metadata?: { task?: string; model?: string; time_ms?: number };
}

/** Row objects → the API's `{train, test}` column/row arrays. */
export function toWireRequest(request: TabH2OPredictRequest): TabH2OWireRequest {
  const seen = new Set<string>();
  for (const row of [...request.training, ...request.predict_on]) {
    for (const k of Object.keys(row)) seen.add(k);
  }
  const wanted = request.feature_columns;
  const features = [...seen].filter(
    (c) =>
      c !== request.target_column && (!wanted || wanted.includes(c) || c === request.time_column),
  );
  const cell = (row: TabH2ORow, c: string): Cell => row[c] ?? null;
  return {
    task: request.task === "classification" ? "classification" : "regression",
    train: {
      columns: [...features, request.target_column],
      data: request.training.map((r) => [
        ...features.map((c) => cell(r, c)),
        cell(r, request.target_column),
      ]),
    },
    test: {
      columns: features,
      data: request.predict_on.map((r) => features.map((c) => cell(r, c))),
    },
    target_column: request.target_column,
    ...(request.time_column ? { time_column: request.time_column } : {}),
  };
}

/** The API's parallel arrays → one {@link TabH2OPrediction} per test row. */
export function fromWireResponse(
  request: TabH2OPredictRequest,
  json: TabH2OWireResponse,
): TabH2OPredictResponse {
  // Class probabilities come in sorted label order (the documented example
  // predicts "Yes" with [0.05, 0.95] over the classes ["No", "Yes"]).
  const labels = [
    ...new Set(request.training.map((r) => String(r[request.target_column] ?? ""))),
  ].sort();
  const predictions = json.predictions.map((prediction, i): TabH2OPrediction => {
    const probs = json.probabilities?.[i];
    const ci = json.confidence_intervals?.[i];
    return {
      prediction,
      ...(Array.isArray(probs) && probs.length === labels.length
        ? { probabilities: Object.fromEntries(labels.map((l, j) => [l, probs[j]!])) }
        : {}),
      ...(Array.isArray(ci) && ci.length === 2 && ci.every((x) => Number.isFinite(x))
        ? { confidence_interval: [ci[0], ci[1]] as [number, number] }
        : {}),
    };
  });
  const price = Number(json.usage?.price_usd);
  return {
    task: request.task,
    predictions,
    ...(json.metadata?.model ? { model_version: json.metadata.model } : {}),
    ...(typeof json.metadata?.time_ms === "number" ? { runtime_ms: json.metadata.time_ms } : {}),
    ...(json.usage
      ? { usage: { cells: json.usage.cells ?? 0, priceUsd: Number.isFinite(price) ? price : 0 } }
      : {}),
  };
}

/** `/predict` serves classification and regression; a time column goes to `/forecast`. */
export function endpointFor(endpoint: string, request: TabH2OPredictRequest): string {
  return request.time_column ? endpoint.replace(/\/predict\/?$/, "/forecast") : endpoint;
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
 * collapse to `{ ok: false, error }` (with the HTTP status and any
 * `Retry-After` seconds, so a caller can honour a 429).
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

  const endpoint = endpointFor(
    opts.endpoint ?? process.env.TABH2O_ENDPOINT ?? DEFAULT_ENDPOINT,
    request,
  );
  const urlErr = await validateFetchUrl(endpoint);
  if (urlErr) return { ok: false, error: `TabH2O endpoint rejected: ${urlErr}` };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await guardedFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(toWireRequest(request)),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryAfter = Number(res.headers.get("retry-after"));
      return {
        ok: false,
        status: res.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSec: retryAfter } : {}),
        error: `TabH2O returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }

    const json = (await res.json()) as TabH2OWireResponse;
    if (!Array.isArray(json.predictions)) {
      return { ok: false, error: "TabH2O response missing predictions array." };
    }
    return { ok: true, response: fromWireResponse(request, json) };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: `TabH2O request timed out after ${timeoutMs}ms.` };
    }
    return { ok: false, error: `TabH2O request failed: ${(err as Error).message}` };
  }
}
