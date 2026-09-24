// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Trace and structured-log read surface behind `GET /api/traces` and
// `GET /api/logs` (both operator-read gated in the entry point): span-tree
// projection with its per-database cache, query/filter parsing, evaluation +
// routing advice, and the shared export response shape (native, `eval-json`,
// `otlp-json`). The route predicates themselves stay in `system.ts` so the
// dispatch order is unchanged.

import type { Engine } from "../../engine/engine";
import { tracesToOtlpJson } from "../../engine/otlp-trace-export";
import { analyzeTraces } from "../../engine/trace-analytics";
import { buildTraceDataset, compareTraceCohorts } from "../../engine/trace-dataset";
import { evaluateTrace } from "../../engine/trace-evaluation";
import { projectTraces } from "../../engine/trace-projection";
import { queryTraces, type TracePage, type TraceQuery } from "../../engine/trace-query";
import { adviseTraceAggregates, adviseTraceRouting } from "../../engine/trace-routing-advice";
import type { MarinaDB } from "../../persistence/database";
import { decodeLogCursor } from "../../persistence/db-logs";
import { logsToOtlpJson } from "../../telemetry/otlp-log-exporter";
import { corsHeaders } from "../cors";
import { json } from "./shared";

// The 5,000-row fetch + full projection is the expensive half of /api/traces,
// and every dashboard tab polls it every 5s. Cache validity keys on
// MAX(event_log.id) — an O(1) rowid-max lookup — so concurrent tabs share one
// projection while any new event invalidates immediately (never stale).
// Scoped per MarinaDB instance (WeakMap) so two engines in one process can
// never serve each other's projections on a coincidentally equal max id.
type TraceProjectionEntry = {
  maxEventId: number;
  projected: ReturnType<typeof projectTraces>;
  truncated: boolean;
};
const traceProjectionCaches = new WeakMap<MarinaDB, Map<string, TraceProjectionEntry>>();

function projectRecentTraces(
  engine: Engine,
  db: MarinaDB | undefined,
  traceId: string | undefined,
): { projected: ReturnType<typeof projectTraces>; truncated: boolean } {
  if (!db) return { projected: projectTraces(engine.getEventLog()), truncated: false };
  let traceProjectionCache = traceProjectionCaches.get(db);
  if (!traceProjectionCache) {
    traceProjectionCache = new Map();
    traceProjectionCaches.set(db, traceProjectionCache);
  }
  // Prefix the per-trace key so no user-supplied traceId (e.g. "*") can
  // collide with — and poison — the unfiltered-listing key.
  const key = traceId ? `t:${traceId}` : "*";
  const maxEventId = db.getMaxEventId();
  const cached = traceProjectionCache.get(key);
  if (cached && cached.maxEventId === maxEventId) return cached;
  const history = db.getRecentTraceEvents(5000, traceId);
  const entry = {
    maxEventId,
    projected: projectTraces(history.events),
    truncated: history.truncated,
  };
  traceProjectionCache.set(key, entry);
  if (traceProjectionCache.size > 200) {
    for (const [k, v] of traceProjectionCache) {
      if (v.maxEventId !== maxEventId) traceProjectionCache.delete(k);
    }
    // Hard cap regardless of staleness: a caller issuing many distinct
    // traceId queries between two event-log writes would otherwise grow the
    // map without bound (every entry shares the current maxEventId). Map
    // iteration order is insertion order, so this evicts oldest-first.
    while (traceProjectionCache.size > 200) {
      const oldest = traceProjectionCache.keys().next().value;
      if (oldest === undefined) break;
      traceProjectionCache.delete(oldest);
    }
  }
  return entry;
}

export function getTraces(engine: Engine, url: URL, db?: MarinaDB): Response {
  const format = url.searchParams.get("format");
  if (format && format !== "otlp-json" && format !== "eval-json") {
    return json({ error: "Unsupported trace format. Use 'otlp-json' or 'eval-json'." }, 400);
  }
  const rawLimit = url.searchParams.get("limit");
  const requestedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 100))
      : 25;
  const traceId = url.searchParams.get("traceId")?.trim();
  let query: TraceQuery;
  try {
    query = parseTraceQuery(url, limit);
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : "Invalid trace query." }, 400);
  }
  const history = projectRecentTraces(engine, db, traceId);
  const projected = history.projected;
  let page: TracePage;
  try {
    page = queryTraces(
      traceId ? projected.filter((trace) => trace.traceId === traceId) : projected,
      query,
    );
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : "Invalid trace cursor." }, 400);
  }
  // One batched judgments query for the page (previously one query per trace).
  const judgmentsByTrace = db
    ? db.getTraceJudgmentsByTraceIds(page.traces.map((trace) => trace.traceId))
    : new Map<string, never[]>();
  const evidence = page.traces.map((trace) => ({
    ...trace,
    judgments: judgmentsByTrace.get(trace.traceId) ?? [],
  }));
  const traces = evidence.map((trace) => ({ ...trace, evaluation: evaluateTrace(trace) }));
  if (format === "otlp-json") {
    return traceExportResponse(
      tracesToOtlpJson(traces, { truncated: history.truncated }),
      url,
      "marina-traces-otlp.json",
      page.nextCursor,
    );
  }
  if (format === "eval-json") {
    return traceExportResponse(
      buildTraceDataset(evidence),
      url,
      "marina-traces-eval.json",
      page.nextCursor,
    );
  }
  const modelComparisons = compareTraceCohorts(evidence, "model");
  const routeComparisons = compareTraceCohorts(evidence, "route");
  const analytics = analyzeTraces(traces);
  const native = {
    traces,
    page: {
      limit,
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
    analytics,
    comparisons: {
      models: modelComparisons,
      routes: routeComparisons,
    },
    shadowAdvice: {
      models: adviseTraceRouting(modelComparisons, "model"),
      routes: adviseTraceRouting(routeComparisons, "route"),
      autonomousModels: adviseTraceAggregates(analytics.agentModels, "autonomous_model"),
      tools: adviseTraceAggregates(analytics.tools, "tool"),
    },
    partial: history.truncated || traces.some((trace) => trace.partial),
    truncated: history.truncated,
    source: db ? "event-log" : "memory",
    retention: db ? "pruned-hourly (MARINA_EVENT_RETENTION rows)" : "bounded-memory",
    otlp: engine.getOtlpExporterStatus(),
  };
  return traceExportResponse(native, url, "marina-traces.json", page.nextCursor);
}

export function getLogs(engine: Engine, url: URL, db?: MarinaDB): Response {
  if (!db) return json({ error: "Durable structured logs are unavailable." }, 503);
  const format = url.searchParams.get("format");
  if (format && format !== "otlp-json") {
    return json({ error: "Unsupported log format. Use 'otlp-json'." }, 400);
  }
  const rawLevel = url.searchParams.get("level")?.trim();
  if (rawLevel && !["debug", "info", "warn", "error"].includes(rawLevel)) {
    return json({ error: "Invalid log level. Use debug, info, warn, or error." }, 400);
  }
  let beforeId: number | undefined;
  try {
    const cursor = url.searchParams.get("cursor")?.trim();
    beforeId = cursor ? decodeLogCursor(cursor) : undefined;
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : "Invalid log cursor." }, 400);
  }
  const filter = (name: string): string | undefined => {
    const value = url.searchParams.get(name)?.trim();
    if (!value) return undefined;
    if (value.length > 200) throw new Error(`Log '${name}' filter must be at most 200 characters.`);
    return value;
  };
  const parseTime = (name: "since" | "until"): number | undefined => {
    const raw = url.searchParams.get(name)?.trim();
    if (!raw) return undefined;
    const numeric = Number(raw);
    const value = Number.isFinite(numeric) ? numeric : Date.parse(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid log '${name}' time.`);
    return Math.trunc(value);
  };
  let since: number | undefined;
  let until: number | undefined;
  try {
    since = parseTime("since");
    until = parseTime("until");
    if (since !== undefined && until !== undefined && since > until) {
      throw new Error("Log 'since' must not be later than 'until'.");
    }
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : "Invalid log time." }, 400);
  }
  let page: ReturnType<MarinaDB["queryStructuredLogs"]>;
  try {
    page = db.queryStructuredLogs({
      limit: Number(url.searchParams.get("limit")) || 100,
      beforeId,
      level: rawLevel as "debug" | "info" | "warn" | "error" | undefined,
      category: filter("category"),
      traceId: filter("traceId"),
      spanId: filter("spanId"),
      requestId: filter("requestId"),
      entityId: filter("entityId"),
      q: filter("q"),
      since,
      until,
    });
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : "Invalid log query." }, 400);
  }
  if (format === "otlp-json") {
    return traceExportResponse(
      logsToOtlpJson(page.logs, { serviceName: "marina", resourceAttributes: {} }),
      url,
      "marina-logs-otlp.json",
      page.nextCursor,
    );
  }
  return json({
    logs: page.logs,
    page: {
      limit: Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 100, 500)),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
    source: "structured_logs",
    retention: Number(process.env.MARINA_LOG_RETENTION) || 10_000,
    otlp: engine.getOtlpLogExporterStatus(),
  });
}

function parseTraceQuery(url: URL, limit: number): TraceQuery {
  const rawStatus = url.searchParams.get("status")?.trim();
  if (rawStatus && rawStatus !== "running" && rawStatus !== "completed" && rawStatus !== "failed") {
    throw new Error("Invalid trace status. Use running, completed, or failed.");
  }
  const status = rawStatus as TraceQuery["status"];
  const since = parseTraceTime(url.searchParams.get("since"), "since");
  const until = parseTraceTime(url.searchParams.get("until"), "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("Trace 'since' must not be later than 'until'.");
  }
  return {
    limit,
    ...(url.searchParams.get("cursor")?.trim()
      ? { cursor: url.searchParams.get("cursor")!.trim() }
      : {}),
    ...(status ? { status } : {}),
    ...boundedTraceFilter(url, "model"),
    ...boundedTraceFilter(url, "agent"),
    ...boundedTraceFilter(url, "tool"),
    ...boundedTraceFilter(url, "q"),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

function boundedTraceFilter(url: URL, key: "model" | "agent" | "tool" | "q") {
  const value = url.searchParams.get(key)?.trim();
  if (!value) return {};
  if (value.length > 200) throw new Error(`Trace '${key}' filter must be at most 200 characters.`);
  return { [key]: value };
}

function parseTraceTime(raw: string | null, name: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const numeric = Number(raw);
  const value = Number.isFinite(numeric) ? numeric : Date.parse(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid trace '${name}' timestamp. Use Unix milliseconds or ISO 8601.`);
  }
  return Math.trunc(value);
}

function traceExportResponse(
  data: unknown,
  url: URL,
  filename: string,
  nextCursor?: string,
): Response {
  const cursorHeaders: Record<string, string> = nextCursor
    ? { "x-marina-next-cursor": nextCursor }
    : {};
  if (url.searchParams.get("download") !== "1") {
    return new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders(null),
        "content-type": "application/json; charset=utf-8",
        ...cursorHeaders,
      },
    });
  }
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders(null),
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "application/json; charset=utf-8",
      ...cursorHeaders,
    },
  });
}
