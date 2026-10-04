// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/benchmarks/runs` — a benchmark harness files a finished run into
 * this Marina's ledger. Behind the model API's auth and per-IP limit like every
 * `/v1` route.
 *
 * Body: `{ result, targetKind, target, label?, judge?, costUsd?, replicateGroup? }`, where
 * `result` is a harness result document (`config`, `timestamp`, `duration_ms`,
 * `metadata`, `items[]`). For each item carrying a `traceId` (the target's
 * `x-request-id`), the server resolves who worked on it from its own trace and
 * event log (`src/engine/benchmark-participants.ts`) and records them on the
 * item; an unpriced item is charged the cost its exclusive participants
 * reported. Only item ids and outcomes are stored — no question, answer or
 * response text, whatever the body carries. Re-filing the same document is a
 * no-op (content hash). An item flagged `fallback: true` (or whose `actual`
 * carries the harness's `ERROR:` marker) is a fallback, not an answer; when
 * more than `MARINA_BENCHMARK_MAX_FALLBACK_RATE` of the items are, the run is
 * recorded `invalid` with the reason (status and reason in the reply).
 * `replicateGroup` puts the run into a named group of
 * replicates (`src/engine/benchmark-replicates.ts`); without it the run joins
 * the automatic group of its target, item slice and judge.
 *
 * The open-API dev sentinel may file only under the local, ungated trust
 * profile (`refuseOpenApiWrite` semantics); elsewhere a `MODEL_API_KEYS`
 * credential is required.
 */

import { randomUUID } from "node:crypto";
import {
  type HarnessResultFile,
  isFallbackItem,
  ledgerFromHarnessResult,
  TARGET_KINDS,
} from "../engine/benchmark-ledger";
import { type AttributionKind, resolveParticipants } from "../engine/benchmark-participants";
import { validReplicateGroup } from "../engine/benchmark-replicates";
import type { Engine } from "../engine/engine";
import { isLocalUngated } from "../engine/trust-profile";
import { noteBenchmarkRun } from "../learning/intake";
import type { BenchmarkTargetKind } from "../persistence/db-benchmarks";
import { errorJson, json, type PassthruAuthResult } from "./model-api/shared";

/** Largest result document accepted (bytes). */
export const MAX_BENCHMARK_FILE_BYTES = 8 * 1024 * 1024;
/** Most items one filed run may carry. */
export const MAX_BENCHMARK_FILE_ITEMS = 20_000;

/** Fields of a result item the ledger reads; everything else (text) is dropped before hashing. */
function slimItem(it: Record<string, unknown>): Record<string, unknown> {
  const usage = it.usage as { costUsd?: unknown } | undefined;
  return {
    id: it.id,
    correct: it.correct,
    ...(typeof it.score === "number" ? { score: it.score } : {}),
    ...(typeof it.latencyMs === "number" ? { latencyMs: it.latencyMs } : {}),
    ...(typeof usage?.costUsd === "number" ? { usage: { costUsd: usage.costUsd } } : {}),
    ...(typeof it.judge === "string" ? { judge: it.judge } : {}),
    ...(typeof it.traceId === "string" ? { traceId: it.traceId } : {}),
    // Only the flag survives — never the response text it may be derived from.
    ...(isFallbackItem(it) ? { fallback: true } : {}),
  };
}

export async function handleBenchmarkFile(
  req: Request,
  engine: Engine,
  auth: PassthruAuthResult | undefined,
): Promise<Response> {
  const sentinel = !auth || (auth.openMode && !auth.matchedKey && !auth.internal);
  if (sentinel && !isLocalUngated()) {
    return errorJson(
      403,
      "MARINA_OPEN_API grants read-only access; filing a benchmark run needs a MODEL_API_KEYS credential.",
      { code: "open_api_read_only" },
    );
  }
  const db = engine.db;
  if (!db) return errorJson(503, "no database", { code: "server_error" });

  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BENCHMARK_FILE_BYTES) {
    return errorJson(413, `result document exceeds ${MAX_BENCHMARK_FILE_BYTES} bytes`, {
      code: "invalid_request_error",
    });
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return errorJson(400, "unreadable body", { code: "invalid_request_error" });
  }
  if (text.length > MAX_BENCHMARK_FILE_BYTES) {
    return errorJson(413, `result document exceeds ${MAX_BENCHMARK_FILE_BYTES} bytes`, {
      code: "invalid_request_error",
    });
  }
  let body: {
    result?: unknown;
    targetKind?: unknown;
    target?: unknown;
    label?: unknown;
    judge?: unknown;
    costUsd?: unknown;
    replicateGroup?: unknown;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return errorJson(400, "body must be JSON", { code: "invalid_request_error" });
  }
  const kind = body.targetKind as BenchmarkTargetKind;
  if (!TARGET_KINDS.includes(kind)) {
    return errorJson(400, `targetKind must be one of ${TARGET_KINDS.join(", ")}`, {
      code: "invalid_request_error",
    });
  }
  const result = body.result as HarnessResultFile | undefined;
  if (!result || typeof result !== "object" || !Array.isArray(result.items)) {
    return errorJson(400, "result must be a harness result document with items[]", {
      code: "invalid_request_error",
    });
  }
  if (result.items.length > MAX_BENCHMARK_FILE_ITEMS) {
    return errorJson(413, `at most ${MAX_BENCHMARK_FILE_ITEMS} items per run`, {
      code: "invalid_request_error",
    });
  }
  const replicateGroup = body.replicateGroup;
  if (
    replicateGroup !== undefined &&
    (typeof replicateGroup !== "string" || !validReplicateGroup(replicateGroup))
  ) {
    return errorJson(
      400,
      "replicateGroup must be a short label (letters, digits, : . _ @ / -; never auto:…)",
      { code: "invalid_request_error" },
    );
  }
  const costUsd =
    typeof body.costUsd === "number" && Number.isFinite(body.costUsd) && body.costUsd >= 0
      ? body.costUsd
      : undefined;

  // Only ids and outcomes survive — the hash, and the ledger, never see text.
  const slim: HarnessResultFile = {
    ...(result.config ? { config: result.config } : {}),
    ...(typeof result.timestamp === "number" ? { timestamp: result.timestamp } : {}),
    ...(typeof result.duration_ms === "number" ? { duration_ms: result.duration_ms } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
    items: result.items.map((it) =>
      slimItem(it as Record<string, unknown>),
    ) as HarnessResultFile["items"],
  };
  const raw = JSON.stringify(slim);

  const traceIds = (slim.items ?? []).flatMap((it) =>
    typeof it.traceId === "string" ? [it.traceId] : [],
  );
  const resolved = resolveParticipants(db, traceIds);
  const counts: Record<AttributionKind, number> = {
    trace: 0,
    "trace+window": 0,
    window: 0,
    none: 0,
  };
  let overlappingItems = 0;
  // Items with at least one turn that served several requests (cost split).
  let tracedSharedItems = 0;
  for (const it of slim.items ?? []) {
    const a = typeof it.traceId === "string" ? resolved.get(it.traceId) : undefined;
    if (!a) {
      counts.none++;
      continue;
    }
    counts[a.attribution]++;
    if (a.overlapping > 0) overlappingItems++;
    if (a.participants.some((p) => p.tracedShared)) tracedSharedItems++;
    if (a.participants.length > 0) it.participants = a.participants;
    if (typeof it.usage?.costUsd !== "number" && a.costUsd !== null) {
      it.usage = { costUsd: a.costUsd };
    }
  }

  let ledger: ReturnType<typeof ledgerFromHarnessResult>;
  try {
    ledger = ledgerFromHarnessResult(slim, {
      targetKind: kind,
      target: body.target ?? null,
      ...(typeof body.label === "string" ? { label: body.label.slice(0, 200) } : {}),
      ...(typeof body.judge === "string" ? { judge: body.judge.slice(0, 300) } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(typeof replicateGroup === "string" ? { replicateGroup } : {}),
      raw,
      id: `bench_${randomUUID().slice(0, 12)}`,
      now: Date.now(),
    });
  } catch (e) {
    return errorJson(400, e instanceof Error ? e.message : String(e), {
      code: "invalid_request_error",
    });
  }
  // Record the attribution summary alongside the (credential-free) config.
  try {
    const config = JSON.parse(ledger.run.config_json) as Record<string, unknown>;
    config.attribution = { ...counts, overlappingItems, tracedSharedItems };
    ledger.run.config_json = JSON.stringify(config);
  } catch {
    // allow-empty-catch: config_json is always our own JSON; leave it as built
  }
  const saved = db.recordBenchmarkLedgerRun(ledger.run, ledger.items);
  if (saved.created) noteBenchmarkRun(db, { ...ledger.run, id: saved.id });
  // A re-file of content already recorded reports the STORED run (its group,
  // status and numbers), never the values this request would have written.
  const stored = saved.created ? undefined : db.getBenchmarkRun(saved.id);
  const status = stored?.status ?? (ledger.run.invalid_reason ? "invalid" : "completed");
  const invalidReason = stored
    ? stored.status === "invalid"
      ? db
          .listBenchmarkRunValidity(saved.id)
          .filter((r) => r.action === "invalidate")
          .at(-1)?.reason
      : undefined
    : (ledger.run.invalid_reason ?? undefined);
  return json(
    {
      runId: saved.id,
      created: saved.created,
      benchmark: stored?.benchmark ?? ledger.run.benchmark,
      n: stored ? (stored.n ?? null) : ledger.run.n,
      accuracy: stored ? stored.score : ledger.run.score,
      ciLow: stored ? (stored.ci_low ?? null) : ledger.run.ci_low,
      ciHigh: stored ? (stored.ci_high ?? null) : ledger.run.ci_high,
      costUsd: stored ? (stored.cost_usd ?? null) : ledger.run.cost_usd,
      replicateGroup: stored
        ? (stored.replicate_group ?? null)
        : (ledger.run.replicate_group ?? null),
      status,
      ...(invalidReason ? { invalidReason } : {}),
      attribution: counts,
      overlappingItems,
      tracedSharedItems,
    },
    saved.created ? 201 : 200,
  );
}
