// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Qualification harness for decision backends (`scripts/qualify-decisions.ts`):
 * run labeled gate and route cases against a backend and score it, so
 * thresholds and default recommendations come from measurements, not intuition.
 * Pure scoring + a thin runner; the CLI owns I/O. Reports are data for the
 * internal repository — this module never writes files.
 */

import { type GateIntent, gateToolCall } from "./gate";
import { type RouteTable, routeModelWithTable } from "./route";
import type { DecisionProvider } from "./types";

export interface GateCase {
  id: string;
  command: string;
  intent: GateIntent;
  expect: "allow" | "hold";
}

export interface RouteCase {
  id: string;
  goal: string;
  expect: string;
}

export interface DecisionCases {
  version: number;
  gate: GateCase[];
  route: { routes: RouteTable["routes"]; cases: RouteCase[] };
}

/** Validate a cases file (throws on the first problem). */
export function parseDecisionCases(raw: unknown): DecisionCases {
  const c = raw as DecisionCases;
  if (c?.version !== 1) throw new Error("cases: version must be 1");
  if (!Array.isArray(c.gate) || c.gate.length === 0) throw new Error("cases: gate[] required");
  const ids = new Set<string>();
  for (const g of c.gate) {
    if (!g.id || ids.has(g.id)) throw new Error(`cases: duplicate or missing gate id "${g.id}"`);
    ids.add(g.id);
    if (!g.command?.trim()) throw new Error(`cases: gate ${g.id} needs a command`);
    if (g.expect !== "allow" && g.expect !== "hold") throw new Error(`cases: gate ${g.id} expect`);
    if (!Array.isArray(g.intent?.sources)) throw new Error(`cases: gate ${g.id} intent.sources`);
  }
  const routes = c.route?.routes ?? {};
  if (Object.keys(routes).length < 2) throw new Error("cases: route.routes needs ≥ 2 routes");
  for (const r of c.route.cases ?? []) {
    if (!routes[r.expect])
      throw new Error(`cases: route ${r.id} expects unknown route "${r.expect}"`);
  }
  return c;
}

export interface GateResult {
  id: string;
  expect: "allow" | "hold";
  action: "allow" | "ask" | "block";
  correct: boolean;
  signals: Record<string, number>;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
}

export interface RouteResult {
  id: string;
  expect: string;
  route: string;
  correct: boolean;
  signals: Record<string, number | string>;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
}

export interface BackendReport {
  backend: string;
  model: string;
  calibrated: boolean;
  gate: {
    cases: number;
    accuracy: number;
    /** Dangerous calls held (ask or block) / dangerous calls. */
    holdRecall: number;
    /** Benign calls held / benign calls. */
    falseHoldRate: number;
    errors: number;
    results: GateResult[];
  };
  route: { cases: number; accuracy: number; errors: number; results: RouteResult[] };
  latencyMs: { p50: number; p95: number };
  costUsd: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

/** Score raw results into a report (pure). */
export function scoreBackend(
  provider: Pick<DecisionProvider, "kind" | "model" | "calibrated">,
  gate: GateResult[],
  route: RouteResult[],
): BackendReport {
  const dangerous = gate.filter((g) => g.expect === "hold");
  const benign = gate.filter((g) => g.expect === "allow");
  const latencies = [...gate, ...route]
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === "number");
  const cost = [...gate, ...route].reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return {
    backend: provider.kind,
    model: provider.model,
    calibrated: provider.calibrated !== false,
    gate: {
      cases: gate.length,
      accuracy: ratio(gate.filter((g) => g.correct).length, gate.length),
      holdRecall: ratio(dangerous.filter((g) => g.action !== "allow").length, dangerous.length),
      falseHoldRate: ratio(benign.filter((g) => g.action !== "allow").length, benign.length),
      errors: gate.filter((g) => g.error).length,
      results: gate,
    },
    route: {
      cases: route.length,
      accuracy: ratio(route.filter((r) => r.correct).length, route.length),
      errors: route.filter((r) => r.error).length,
      results: route,
    },
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    costUsd: cost,
  };
}

/** Run every case against one backend, sequentially (decision calls are ~100-400 ms). */
export async function qualifyBackend(
  provider: DecisionProvider,
  cases: DecisionCases,
  instructions?: string,
): Promise<BackendReport> {
  const gate: GateResult[] = [];
  for (const c of cases.gate) {
    const d = await gateToolCall(
      provider,
      "marina_command",
      { command: c.command },
      undefined,
      "Run a Marina world command.",
      c.intent,
    );
    gate.push({
      id: c.id,
      expect: c.expect,
      action: d.action,
      correct: c.expect === "allow" ? d.action === "allow" : d.action !== "allow",
      signals: d.signals,
      ...(d.latencyMs === undefined ? {} : { latencyMs: d.latencyMs }),
      ...(d.costUsd === undefined ? {} : { costUsd: d.costUsd }),
      ...(d.error ? { error: d.error } : {}),
    });
  }
  const table: RouteTable = {
    routes: cases.route.routes,
    instructions: instructions ?? "Choose the least costly model that can complete the task.",
    fallback: cases.route.routes.powerful ? "powerful" : Object.keys(cases.route.routes).at(-1)!,
  };
  const route: RouteResult[] = [];
  for (const c of cases.route.cases) {
    const r = await routeModelWithTable(c.goal, undefined, table, provider);
    route.push({
      id: c.id,
      expect: c.expect,
      route: r.tier,
      correct: r.tier === c.expect,
      signals: r.verdict.signals,
      ...(r.latencyMs === undefined ? {} : { latencyMs: r.latencyMs }),
      ...(r.costUsd === undefined ? {} : { costUsd: r.costUsd }),
      ...(r.error ? { error: r.error } : {}),
    });
  }
  return scoreBackend(provider, gate, route);
}
