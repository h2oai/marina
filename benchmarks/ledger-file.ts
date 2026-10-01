// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * File a finished harness run into a Marina's benchmark ledger
 * (`POST /v1/benchmarks/runs`). The server resolves each item's participants
 * from its `traceId` (the target's `x-request-id`) against its own trace and
 * event log, so a run against a Marina crew lands ranked and attributed.
 *
 * What is sent: the credential-free config and per-item ids, outcomes, scores,
 * latency, cost, judge verdict and trace id — never the question, expected
 * answer or response text.
 */

import { resultForDisk } from "./result-file";
import type { BenchmarkResult } from "./types";

export type LedgerTargetKind = "model" | "crew" | "population";

export interface LedgerFileOptions {
  /** Base URL of the Marina whose ledger receives the run. */
  fileTo: string;
  apiKey?: string;
  targetKind: LedgerTargetKind;
  target: unknown;
  label?: string;
  judge?: string;
  costUsd?: number;
}

/** The request body: the result stripped to what the ledger stores. */
export function ledgerFileBody(result: BenchmarkResult, opts: LedgerFileOptions) {
  const safe = resultForDisk(result);
  return {
    targetKind: opts.targetKind,
    target: opts.target,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.judge ? { judge: opts.judge } : {}),
    ...(typeof opts.costUsd === "number" ? { costUsd: opts.costUsd } : {}),
    result: {
      config: safe.config,
      timestamp: safe.timestamp,
      duration_ms: safe.duration_ms,
      metadata: safe.metadata,
      items: safe.items.map((it) => ({
        id: it.id,
        correct: it.correct,
        ...(typeof it.score === "number" ? { score: it.score } : {}),
        latencyMs: it.latencyMs,
        ...(typeof it.usage?.costUsd === "number" ? { usage: { costUsd: it.usage.costUsd } } : {}),
        ...(it.judge ? { judge: it.judge } : {}),
        ...(it.traceId ? { traceId: it.traceId } : {}),
      })),
    },
  };
}

export interface LedgerFileOutcome {
  ok: boolean;
  status: number;
  runId?: string;
  created?: boolean;
  attribution?: Record<string, number>;
  error?: string;
}

/** POST the run; never throws — a filing failure must not fail the benchmark run. */
export async function fileToLedger(
  result: BenchmarkResult,
  opts: LedgerFileOptions,
): Promise<LedgerFileOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  try {
    const resp = await fetch(`${opts.fileTo.replace(/\/+$/, "")}/v1/benchmarks/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(ledgerFileBody(result, opts)),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await resp.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // allow-empty-catch: a non-JSON reply is reported by status and text below
    }
    if (!resp.ok) {
      const err = (body.error as { message?: string } | undefined)?.message ?? text.slice(0, 300);
      return { ok: false, status: resp.status, error: err };
    }
    return {
      ok: true,
      status: resp.status,
      ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
      ...(typeof body.created === "boolean" ? { created: body.created } : {}),
      ...(body.attribution && typeof body.attribution === "object"
        ? { attribution: body.attribution as Record<string, number> }
        : {}),
    };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse `--target`: JSON when it parses, else the raw string (a model id). */
export function parseTarget(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
