// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Benchmark evidence for routing: what Marina has MEASURED about each
 * participant (an agent identity) and each model, per task family (a
 * benchmark name), from the benchmark ledger (`benchmark_items`).
 *
 * Evidence sources, per item:
 * - `trace`  — a participant whose turns carried the item's request trace
 *              (exact attribution, `src/engine/benchmark-participants.ts`);
 * - `target` — the target model of a `target_kind: "model"` run with no
 *              participants recorded (one model answered every item alone);
 * - `window` — crew-mates seen only in the request window; counted ONLY when
 *              `MARINA_ROUTE_EVIDENCE_WINDOW=true`;
 * - `shared` window evidence (another request overlapped) is NEVER counted.
 *
 * Agents and models are keyed separately: an external participant's backing
 * model may be invisible, so its record is its own name.
 *
 * Spawn-time `model:route` may consult this evidence (`MARINA_ROUTE_EVIDENCE`):
 * among the route's candidate models that have at least `minN` items in the
 * configured families — at least two of them, within the optional per-item cost
 * budget — the one with the best Wilson lower bound wins. `observe` records the
 * pick without acting; anything short of the rules leaves the router's choice.
 * The route resolves once at spawn and is persisted (never mid-history).
 */

import { wilsonInterval } from "../../benchmarks/stats";
import type { BenchmarkItemRow, BenchmarkRunRow } from "../persistence/db-benchmarks";

export type RouteEvidenceMode = "off" | "observe" | "on";

export interface RouteEvidenceSettings {
  mode: RouteEvidenceMode;
  /** Minimum items per candidate before its evidence counts. */
  minN: number;
  /** Count crew-mates seen only in the request window (exclusive windows only). */
  includeWindow: boolean;
  /** Per-item cost budget in USD; candidates above it (or unpriced) are not eligible. */
  maxCostPerItemUsd?: number;
  /** Task families for a role: a role-specific list, else the `*` list, else none. */
  families: Record<string, string[]>;
}

export const DEFAULT_ROUTE_EVIDENCE_MIN_N = 30;

/** Parse the evidence settings. Invalid values fall back to the safe default (off / unset). */
export function routeEvidenceSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RouteEvidenceSettings {
  const raw = env.MARINA_ROUTE_EVIDENCE?.trim().toLowerCase();
  const mode: RouteEvidenceMode = raw === "observe" || raw === "on" ? raw : "off";
  const n = Number.parseInt(env.MARINA_ROUTE_EVIDENCE_MIN_N ?? "", 10);
  const budget = Number.parseFloat(env.MARINA_ROUTE_EVIDENCE_MAX_COST_USD ?? "");
  return {
    mode,
    minN: Number.isFinite(n) && n >= 1 ? n : DEFAULT_ROUTE_EVIDENCE_MIN_N,
    includeWindow: env.MARINA_ROUTE_EVIDENCE_WINDOW?.trim().toLowerCase() === "true",
    ...(Number.isFinite(budget) && budget > 0 ? { maxCostPerItemUsd: budget } : {}),
    families: parseFamilies(env.MARINA_ROUTE_EVIDENCE_FAMILIES),
  };
}

/**
 * `hle-verified-gold,frames` (every role) or JSON `{"*": [...], "<role>": [...]}`.
 * Malformed JSON yields no families (evidence then never applies).
 */
export function parseFamilies(raw: string | undefined): Record<string, string[]> {
  const text = raw?.trim();
  if (!text) return {};
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(obj)
          .map(([k, v]) => [k.trim(), list(v)] as const)
          .filter(([k, v]) => k && v.length > 0),
      );
    } catch {
      return {};
    }
  }
  const all = list(text);
  return all.length > 0 ? { "*": all } : {};
}

export function familiesForRole(settings: RouteEvidenceSettings, role?: string): string[] {
  return (role ? settings.families[role] : undefined) ?? settings.families["*"] ?? [];
}

/**
 * A model id's comparison key: its last path segment, lower-cased, `.` → `-`.
 * `openrouter/anthropic/claude-opus-5.5`, `anthropic/claude-opus-5.5` and the
 * provider-native `claude-opus-5-5` are the same model.
 */
export function modelKey(id: string): string {
  return (id.split("/").at(-1) ?? id).trim().toLowerCase().replace(/\./g, "-");
}

export interface EvidenceItem {
  family: string;
  correct: boolean;
  costUsd: number | null;
  participantsJson: string | null;
  /** The target model when the run's target_kind is `model`. */
  targetModel?: string;
}

export interface EvidenceEntry {
  kind: "agent" | "model";
  /** Display name (first seen). */
  name: string;
  /** Comparison key (agent name, or `modelKey` for models). */
  key: string;
  family: string;
  n: number;
  correct: number;
  accuracy: number;
  ciLow: number;
  ciHigh: number;
  /** Mean cost of the priced items it touched; null when none were priced. */
  costPerItemUsd: number | null;
  sources: { trace: number; target: number; window: number };
}

interface RawParticipant {
  agent?: unknown;
  model?: unknown;
  via?: unknown;
  shared?: unknown;
}

/** Aggregate evidence per (kind, key, family). Pure. */
export function collectEvidence(
  items: readonly EvidenceItem[],
  opts: { includeWindow?: boolean } = {},
): EvidenceEntry[] {
  type Acc = {
    kind: "agent" | "model";
    name: string;
    key: string;
    family: string;
    n: number;
    correct: number;
    cost: number;
    priced: number;
    sources: EvidenceEntry["sources"];
  };
  const acc = new Map<string, Acc>();
  for (const item of items) {
    const touched = new Map<
      string,
      { kind: "agent" | "model"; name: string; key: string; via: keyof Acc["sources"] }
    >();
    const add = (kind: "agent" | "model", name: string, via: keyof Acc["sources"]) => {
      const key = kind === "model" ? modelKey(name) : name;
      if (!key) return;
      const id = `${kind}\u0000${key}`;
      // An item counts once per participant; the strongest source wins the label.
      if (!touched.has(id) || via === "trace") touched.set(id, { kind, name, key, via });
    };
    for (const p of parseRaw(item.participantsJson)) {
      if (p.shared === true) continue;
      const via = p.via === "trace" ? "trace" : p.via === "window" ? "window" : undefined;
      if (!via || (via === "window" && !opts.includeWindow)) continue;
      if (typeof p.agent === "string" && p.agent) add("agent", p.agent, via);
      if (typeof p.model === "string" && p.model) add("model", p.model, via);
    }
    if (touched.size === 0 && item.targetModel && parseRaw(item.participantsJson).length === 0) {
      add("model", item.targetModel, "target");
    }
    for (const [id, t] of touched) {
      const k = `${id}\u0000${item.family}`;
      const e =
        acc.get(k) ??
        ({
          kind: t.kind,
          name: t.name,
          key: t.key,
          family: item.family,
          n: 0,
          correct: 0,
          cost: 0,
          priced: 0,
          sources: { trace: 0, target: 0, window: 0 },
        } satisfies Acc);
      e.n++;
      if (item.correct) e.correct++;
      if (typeof item.costUsd === "number") {
        e.cost += item.costUsd;
        e.priced++;
      }
      e.sources[t.via]++;
      acc.set(k, e);
    }
  }
  return [...acc.values()]
    .map((e) =>
      toEntry(e.kind, e.name, e.key, e.family, e.n, e.correct, e.cost, e.priced, e.sources),
    )
    .sort((a, b) => b.ciLow - a.ciLow || b.n - a.n);
}

/** Pool entries of the same (kind, key) across families. */
export function poolFamilies(entries: readonly EvidenceEntry[]): EvidenceEntry[] {
  const acc = new Map<
    string,
    { e: EvidenceEntry; cost: number; priced: number; families: Set<string> }
  >();
  for (const e of entries) {
    const id = `${e.kind}\u0000${e.key}`;
    const priced = e.costPerItemUsd === null ? 0 : e.n;
    const cur = acc.get(id);
    if (!cur) {
      acc.set(id, {
        e: { ...e, sources: { ...e.sources } },
        cost: (e.costPerItemUsd ?? 0) * priced,
        priced,
        families: new Set([e.family]),
      });
      continue;
    }
    cur.e.n += e.n;
    cur.e.correct += e.correct;
    cur.cost += (e.costPerItemUsd ?? 0) * priced;
    cur.priced += priced;
    cur.families.add(e.family);
    for (const s of ["trace", "target", "window"] as const) cur.e.sources[s] += e.sources[s];
  }
  return [...acc.values()]
    .map(({ e, cost, priced, families }) =>
      toEntry(
        e.kind,
        e.name,
        e.key,
        [...families].sort().join("+"),
        e.n,
        e.correct,
        cost,
        priced,
        e.sources,
      ),
    )
    .sort((a, b) => b.ciLow - a.ciLow || b.n - a.n);
}

function toEntry(
  kind: "agent" | "model",
  name: string,
  key: string,
  family: string,
  n: number,
  correct: number,
  cost: number,
  priced: number,
  sources: EvidenceEntry["sources"],
): EvidenceEntry {
  const ci = wilsonInterval(correct, n);
  return {
    kind,
    name,
    key,
    family,
    n,
    correct,
    accuracy: n > 0 ? correct / n : 0,
    ciLow: ci.low,
    ciHigh: ci.high,
    costPerItemUsd: priced > 0 ? cost / priced : null,
    sources,
  };
}

function parseRaw(json: string | null): RawParticipant[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? (v.filter((p) => p && typeof p === "object") as RawParticipant[])
      : [];
  } catch {
    return [];
  }
}

// ─── Loading from the ledger ────────────────────────────────────────────────

/** The store slice evidence reads. */
export interface EvidenceSource {
  getBenchmarkItemsForBenchmark(benchmark: string, limit?: number): BenchmarkItemRow[];
  queryBenchmarkRuns(q: { benchmark?: string; status?: string; limit?: number }): BenchmarkRunRow[];
}

/** The ledger's items for the given families, with each run's target model attached. */
export function loadEvidenceItems(db: EvidenceSource, families: readonly string[]): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const family of new Set(families)) {
    const targets = new Map<string, string>();
    for (const run of db.queryBenchmarkRuns({
      benchmark: family,
      status: "completed",
      limit: 500,
    })) {
      const model = run.target_kind === "model" ? targetModel(run.target_json) : undefined;
      if (model) targets.set(run.id, model);
    }
    for (const item of db.getBenchmarkItemsForBenchmark(family)) {
      const tm = targets.get(item.run_id);
      out.push({
        family,
        correct: item.correct === 1,
        costUsd: item.cost_usd,
        participantsJson: item.participants_json,
        ...(tm ? { targetModel: tm } : {}),
      });
    }
  }
  return out;
}

function targetModel(json: string | null | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as unknown;
    if (typeof v === "string") return v;
    const m = (v as { model?: unknown } | null)?.model;
    return typeof m === "string" && m ? m : undefined;
  } catch {
    return undefined;
  }
}

// ─── Picking a route ────────────────────────────────────────────────────────

export interface EvidenceCandidate {
  /** Route name (table) or tier (`fast` / `powerful`). */
  route: string;
  model: string;
}

export interface EvidenceConsidered {
  route: string;
  model: string;
  n: number;
  accuracy?: number;
  ciLow?: number;
  costPerItemUsd?: number | null;
  eligible: boolean;
  why: string;
}

export interface EvidencePick {
  /** The route evidence prefers, when it can choose at all. */
  pick?: { route: string; model: string; ciLow: number; n: number; costPerItemUsd: number | null };
  considered: EvidenceConsidered[];
  reason: string;
}

/**
 * Choose among the router's eligible candidates by measured evidence. Needs at
 * least two candidates with `minN` items (and within budget, when one is set);
 * otherwise returns no pick and the router's choice stands. Ties on the lower
 * bound go to the cheaper candidate, then to candidate order. Pure.
 */
export function pickByEvidence(
  candidates: readonly EvidenceCandidate[],
  entries: readonly EvidenceEntry[],
  settings: Pick<RouteEvidenceSettings, "minN" | "maxCostPerItemUsd">,
): EvidencePick {
  const models = new Map(
    poolFamilies(entries.filter((e) => e.kind === "model")).map((e) => [e.key, e] as const),
  );
  const considered: EvidenceConsidered[] = candidates.map((c) => {
    const e = models.get(modelKey(c.model));
    if (!e) return { route: c.route, model: c.model, n: 0, eligible: false, why: "no evidence" };
    const base = {
      route: c.route,
      model: c.model,
      n: e.n,
      accuracy: e.accuracy,
      ciLow: e.ciLow,
      costPerItemUsd: e.costPerItemUsd,
    };
    if (e.n < settings.minN)
      return { ...base, eligible: false, why: `n ${e.n} < ${settings.minN}` };
    if (settings.maxCostPerItemUsd !== undefined) {
      if (e.costPerItemUsd === null) return { ...base, eligible: false, why: "unpriced" };
      if (e.costPerItemUsd > settings.maxCostPerItemUsd)
        return { ...base, eligible: false, why: "over budget" };
    }
    return { ...base, eligible: true, why: "eligible" };
  });
  const eligible = considered.filter((c) => c.eligible);
  if (eligible.length < 2) {
    return {
      considered,
      reason: `insufficient evidence: ${eligible.length} candidate(s) with n ≥ ${settings.minN}${settings.maxCostPerItemUsd === undefined ? "" : " within budget"}; need 2`,
    };
  }
  const order = new Map(candidates.map((c, i) => [c.route, i] as const));
  const best = [...eligible].sort(
    (a, b) =>
      (b.ciLow ?? 0) - (a.ciLow ?? 0) ||
      (a.costPerItemUsd ?? Number.POSITIVE_INFINITY) -
        (b.costPerItemUsd ?? Number.POSITIVE_INFINITY) ||
      (order.get(a.route) ?? 0) - (order.get(b.route) ?? 0),
  )[0]!;
  return {
    pick: {
      route: best.route,
      model: best.model,
      ciLow: best.ciLow ?? 0,
      n: best.n,
      costPerItemUsd: best.costPerItemUsd ?? null,
    },
    considered,
    reason: `best Wilson lower bound ${(best.ciLow ?? 0).toFixed(3)} (n=${best.n}) among ${eligible.length} eligible`,
  };
}

// ─── Applying it at spawn ───────────────────────────────────────────────────

export interface EvidenceRouteResult {
  /** The route to use: the evidence pick under `on`, else the router's. */
  route: string;
  model: string;
  applied: boolean;
  /** Numbers/labels for the `agent_decision` event (no free text beyond the reason). */
  signals: Record<string, number | string>;
  reason?: string;
}

/**
 * Consult benchmark evidence for a spawn-time route. `off` (or no families for
 * the role) returns the router's choice untouched with no signals. Any error
 * fails OPEN to the router's choice and is recorded as `evidence_error`.
 */
export function applyRouteEvidence(
  routed: { route: string; model: string },
  candidates: readonly EvidenceCandidate[],
  role: string | undefined,
  settings: RouteEvidenceSettings,
  db: EvidenceSource | undefined,
): EvidenceRouteResult {
  const unchanged = (signals: Record<string, number | string> = {}): EvidenceRouteResult => ({
    route: routed.route,
    model: routed.model,
    applied: false,
    signals,
  });
  if (settings.mode === "off") return unchanged();
  const families = familiesForRole(settings, role);
  if (families.length === 0 || !db) {
    return unchanged({
      evidence_mode: settings.mode,
      evidence: families.length === 0 ? "no_family" : "no_ledger",
    });
  }
  try {
    const entries = collectEvidence(loadEvidenceItems(db, families), {
      includeWindow: settings.includeWindow,
    });
    const result = pickByEvidence(candidates, entries, settings);
    const signals: Record<string, number | string> = {
      evidence_mode: settings.mode,
      evidence_families: families.join(","),
    };
    for (const c of result.considered) {
      signals[`evidence_n_${c.route}`] = c.n;
      if (c.ciLow !== undefined) signals[`evidence_lcb_${c.route}`] = Number(c.ciLow.toFixed(4));
    }
    if (!result.pick)
      return { ...unchanged({ ...signals, evidence: "insufficient" }), reason: result.reason };
    signals.evidence_pick = result.pick.route;
    const differs = result.pick.route !== routed.route;
    const apply = settings.mode === "on" && differs;
    signals.evidence = apply ? "applied" : differs ? "observed" : "agrees";
    return {
      route: apply ? result.pick.route : routed.route,
      model: apply ? result.pick.model : routed.model,
      applied: apply,
      signals,
      reason: result.reason,
    };
  } catch (err) {
    return unchanged({
      evidence_mode: settings.mode,
      evidence: "error",
      evidence_error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
  }
}
