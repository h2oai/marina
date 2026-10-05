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
 * Spawn-time `model:route` consults this evidence (`MARINA_ROUTE_EVIDENCE`,
 * default `observe`: recorded on the route decision, never applied; `on` acts).
 * Families are `MARINA_ROUTE_EVIDENCE_FAMILIES`, else the role's own declared
 * `families` expanded to the benchmarks tagged with them (`evidenceFamilies`).
 * Only the route's own candidate models with at least `minN` items in the
 * configured families are eligible, at least two of them, within the optional
 * per-item cost budget. The objective (`MARINA_ROUTE_EVIDENCE_OBJECTIVE`) picks
 * among them:
 * - `lcb` (default): the best Wilson lower bound wins.
 * - `budget`: the same, restricted to candidates priced within
 *   `MARINA_ROUTE_EVIDENCE_MAX_COST_USD` per item; it needs that budget.
 * - `value`: the CHEAPEST priced candidate that is not measurably worse than
 *   the best-lower-bound one (`notMeasurablyWorse`) — "cheapest accurate by
 *   design".
 *
 * Evidence is per ROLE first: items where a participant playing the spawning
 * agent's role touched the item. When fewer than two candidates have `minN`
 * role-level items, the pick falls back to model-level evidence. `observe`
 * records the pick without acting; anything short of the rules leaves the
 * router's choice. The route resolves once at spawn and is persisted (never
 * mid-history).
 */

import { mcnemarExact, wilsonInterval } from "../../benchmarks/stats";
import type { BenchmarkItemRow, BenchmarkRunRow } from "../persistence/db-benchmarks";
import { benchmarksInFamilies } from "./benchmark-families";

export type RouteEvidenceMode = "off" | "observe" | "on";
export type RouteEvidenceObjective = "lcb" | "value" | "budget";

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
  /** What the pick optimizes (default `lcb`). */
  objective?: RouteEvidenceObjective;
  /** `value`: the largest accuracy gap below the best candidate still acceptable. */
  tolerance?: number;
}

export const DEFAULT_ROUTE_EVIDENCE_MIN_N = 30;
export const DEFAULT_ROUTE_EVIDENCE_TOLERANCE = 0.05;
/** `value`: a paired loss at least this significant (two-sided exact McNemar) is "worse". */
export const VALUE_PAIRED_ALPHA = 0.05;

/** Parse the evidence settings. Invalid values fall back to the safe default (observe / unset). */
export function routeEvidenceSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RouteEvidenceSettings {
  const raw = env.MARINA_ROUTE_EVIDENCE?.trim().toLowerCase();
  // `observe` by default: it records what the evidence would pick and never
  // changes a route. Only an explicit `on` acts; `off` skips the lookup.
  const mode: RouteEvidenceMode = raw === "off" || raw === "on" ? raw : "observe";
  const n = Number.parseInt(env.MARINA_ROUTE_EVIDENCE_MIN_N ?? "", 10);
  const budget = Number.parseFloat(env.MARINA_ROUTE_EVIDENCE_MAX_COST_USD ?? "");
  const obj = env.MARINA_ROUTE_EVIDENCE_OBJECTIVE?.trim().toLowerCase();
  const tol = Number.parseFloat(env.MARINA_ROUTE_EVIDENCE_TOLERANCE ?? "");
  return {
    mode,
    minN: Number.isFinite(n) && n >= 1 ? n : DEFAULT_ROUTE_EVIDENCE_MIN_N,
    includeWindow: env.MARINA_ROUTE_EVIDENCE_WINDOW?.trim().toLowerCase() === "true",
    ...(Number.isFinite(budget) && budget > 0 ? { maxCostPerItemUsd: budget } : {}),
    families: parseFamilies(env.MARINA_ROUTE_EVIDENCE_FAMILIES),
    objective: obj === "value" || obj === "budget" ? obj : "lcb",
    tolerance:
      Number.isFinite(tol) && tol >= 0 && tol <= 1 ? tol : DEFAULT_ROUTE_EVIDENCE_TOLERANCE,
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
 * The families a role declares itself: the union of its traits' `families`
 * capability (`role create`/`trait create` metadata). Empty when the role or
 * the store does not say.
 */
export function declaredRoleFamilies(db: EvidenceSource, role: string | undefined): string[] {
  if (!role || typeof db.getRole !== "function" || typeof db.getTrait !== "function") return [];
  try {
    const row = db.getRole(role);
    if (!row) return [];
    const traits = JSON.parse(row.traits || "[]") as unknown;
    const out = new Set<string>();
    for (const name of Array.isArray(traits) ? traits : []) {
      if (typeof name !== "string") continue;
      const t = db.getTrait(name);
      if (!t) continue;
      const caps = JSON.parse(t.capabilities || "{}") as { families?: unknown };
      for (const f of Array.isArray(caps.families) ? caps.families : []) {
        if (typeof f === "string" && f.trim()) out.add(f.trim());
      }
    }
    return [...out];
  } catch {
    // allow-empty-catch: unreadable role metadata declares no families
    return [];
  }
}

/**
 * Where a spawn's evidence comes from: the configured families
 * (`MARINA_ROUTE_EVIDENCE_FAMILIES`), else the role's DECLARED families,
 * expanded to the benchmarks tagged with them (`benchmarksInFamilies`; a
 * declared name that is itself a benchmark counts as one).
 */
export function evidenceFamilies(
  settings: RouteEvidenceSettings,
  role: string | undefined,
  db: EvidenceSource | undefined,
): { families: string[]; source: "configured" | "role" | "none" } {
  const configured = familiesForRole(settings, role);
  if (configured.length > 0) return { families: configured, source: "configured" };
  const declared = db ? declaredRoleFamilies(db, role) : [];
  if (declared.length === 0) return { families: [], source: "none" };
  const benchmarks = new Set<string>(benchmarksInFamilies(declared));
  for (const f of declared) benchmarks.add(f);
  return { families: [...benchmarks], source: "role" };
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
  /** The ledger item id; pairs outcomes across runs for the `value` objective. */
  itemId?: string;
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
  /** Per-item outcomes keyed `family\u0000itemId` (first outcome wins), for paired tests. */
  outcomes?: Map<string, boolean>;
}

export interface CollectOptions {
  includeWindow?: boolean;
  /**
   * Role-level evidence: count only participants whose agent plays this role
   * (per `roleOf`). Direct-model runs carry no role and are left out.
   */
  role?: string;
  roleOf?: (agent: string) => string | undefined;
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
  opts: CollectOptions = {},
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
    outcomes: Map<string, boolean>;
  };
  const byRole = opts.role !== undefined;
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
    const raw = parseRaw(item.participantsJson);
    for (const p of raw) {
      if (p.shared === true) continue;
      const via = p.via === "trace" ? "trace" : p.via === "window" ? "window" : undefined;
      if (!via || (via === "window" && !opts.includeWindow)) continue;
      const agent = typeof p.agent === "string" ? p.agent : "";
      // A participant counts for a role only when its agent is known to play it.
      if (byRole && (!agent || opts.roleOf?.(agent) !== opts.role)) continue;
      if (agent) add("agent", agent, via);
      if (typeof p.model === "string" && p.model) add("model", p.model, via);
    }
    if (!byRole && touched.size === 0 && item.targetModel && raw.length === 0) {
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
          outcomes: new Map(),
        } satisfies Acc);
      e.n++;
      if (item.correct) e.correct++;
      if (typeof item.costUsd === "number") {
        e.cost += item.costUsd;
        e.priced++;
      }
      if (item.itemId) {
        const ok = `${item.family}\u0000${item.itemId}`;
        if (!e.outcomes.has(ok)) e.outcomes.set(ok, item.correct);
      }
      e.sources[t.via]++;
      acc.set(k, e);
    }
  }
  return [...acc.values()]
    .map((e) => ({
      ...toEntry(e.kind, e.name, e.key, e.family, e.n, e.correct, e.cost, e.priced, e.sources),
      outcomes: e.outcomes,
    }))
    .sort((a, b) => b.ciLow - a.ciLow || b.n - a.n);
}

/** Pool entries of the same (kind, key) across families. */
export function poolFamilies(entries: readonly EvidenceEntry[]): EvidenceEntry[] {
  const acc = new Map<
    string,
    {
      e: EvidenceEntry;
      cost: number;
      priced: number;
      families: Set<string>;
      outcomes: Map<string, boolean>;
    }
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
        outcomes: new Map(e.outcomes ?? []),
      });
      continue;
    }
    cur.e.n += e.n;
    cur.e.correct += e.correct;
    cur.cost += (e.costPerItemUsd ?? 0) * priced;
    cur.priced += priced;
    cur.families.add(e.family);
    for (const s of ["trace", "target", "window"] as const) cur.e.sources[s] += e.sources[s];
    for (const [k, v] of e.outcomes ?? []) if (!cur.outcomes.has(k)) cur.outcomes.set(k, v);
  }
  return [...acc.values()]
    .map(({ e, cost, priced, families, outcomes }) => ({
      ...toEntry(
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
      outcomes,
    }))
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
  /** The agent's configured role, for role-level evidence (optional). */
  getAgentConfig?(name: string): { role?: string | null } | undefined;
  /** Role and trait rows, for a role's declared families (optional). */
  getRole?(name: string): { traits: string } | undefined;
  getTrait?(name: string): { capabilities: string } | undefined;
}

/** A cached `agent → role` lookup over the store; undefined when the store has none. */
export function roleLookup(
  db: EvidenceSource,
): ((agent: string) => string | undefined) | undefined {
  if (typeof db.getAgentConfig !== "function") return undefined;
  const cache = new Map<string, string | undefined>();
  return (agent) => {
    if (!cache.has(agent)) {
      let role: string | undefined;
      try {
        role = db.getAgentConfig?.(agent)?.role || undefined;
      } catch {
        role = undefined;
      }
      cache.set(agent, role);
    }
    return cache.get(agent);
  };
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
        itemId: item.item_id,
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
  ciHigh?: number;
  costPerItemUsd?: number | null;
  eligible: boolean;
  why: string;
}

export interface EvidencePick {
  /** The route evidence prefers, when it can choose at all. */
  pick?: { route: string; model: string; ciLow: number; n: number; costPerItemUsd: number | null };
  considered: EvidenceConsidered[];
  reason: string;
  /** The objective the pick optimized. */
  objective: RouteEvidenceObjective;
}

/**
 * `value`'s acceptance test: is `cand` NOT measurably worse than `best`?
 *
 * 1. Its point accuracy is within `tolerance` of the best's (a practical
 *    margin the operator sets), AND
 * 2. the data cannot show it is worse: when both were scored on at least
 *    `minN` shared items, a paired exact McNemar test must not find a
 *    significant loss (p < `VALUE_PAIRED_ALPHA`, best wins more discordant
 *    pairs); without enough pairs, its Wilson interval must overlap the best's
 *    lower bound (`ciHigh ≥ best.ciLow`).
 *
 * Both conditions guard against different failures: the tolerance stops a
 * large gap hidden by small samples (wide intervals overlap); the paired /
 * interval test stops a small gap that the data nonetheless resolves.
 */
export function notMeasurablyWorse(
  cand: EvidenceEntry,
  best: EvidenceEntry,
  tolerance: number,
  minN: number,
): { ok: boolean; why: string } {
  const gap = best.accuracy - cand.accuracy;
  if (gap > tolerance + 1e-12) {
    return { ok: false, why: `${(gap * 100).toFixed(1)} pts below best (> tolerance)` };
  }
  const a = best.outcomes;
  const b = cand.outcomes;
  if (a && b) {
    let bestOnly = 0;
    let candOnly = 0;
    let shared = 0;
    for (const [k, bv] of a) {
      const cv = b.get(k);
      if (cv === undefined) continue;
      shared++;
      if (bv && !cv) bestOnly++;
      else if (cv && !bv) candOnly++;
    }
    if (shared >= minN) {
      const t = mcnemarExact(bestOnly, candOnly);
      const worse = bestOnly > candOnly && t.p < VALUE_PAIRED_ALPHA;
      return {
        ok: !worse,
        why: `paired n=${shared} ${bestOnly}–${candOnly} p=${t.p.toFixed(3)}${worse ? " (worse)" : ""}`,
      };
    }
  }
  const overlap = cand.ciHigh >= best.ciLow;
  return {
    ok: overlap,
    why: overlap ? "interval overlaps best's lower bound" : "interval below best's lower bound",
  };
}

/**
 * Choose among the router's eligible candidates by measured evidence. Needs at
 * least two candidates with `minN` items (and within budget, when one is set);
 * otherwise returns no pick and the router's choice stands. Pure.
 *
 * - `lcb`: best Wilson lower bound; ties → cheaper → candidate order.
 * - `budget`: as `lcb` within `maxCostPerItemUsd` (refuses to pick without one).
 * - `value`: among priced eligible candidates not measurably worse than the
 *   best-lower-bound candidate (`notMeasurablyWorse`), the cheapest; ties →
 *   higher lower bound → candidate order.
 */
export function pickByEvidence(
  candidates: readonly EvidenceCandidate[],
  entries: readonly EvidenceEntry[],
  settings: Pick<RouteEvidenceSettings, "minN" | "maxCostPerItemUsd" | "objective" | "tolerance">,
): EvidencePick {
  const objective = settings.objective ?? "lcb";
  const tolerance = settings.tolerance ?? DEFAULT_ROUTE_EVIDENCE_TOLERANCE;
  const models = new Map(
    poolFamilies(entries.filter((e) => e.kind === "model")).map((e) => [e.key, e] as const),
  );
  if (objective === "budget" && settings.maxCostPerItemUsd === undefined) {
    return {
      objective,
      considered: candidates.map((c) => ({
        route: c.route,
        model: c.model,
        n: models.get(modelKey(c.model))?.n ?? 0,
        eligible: false,
        why: "no budget set",
      })),
      reason: "budget objective needs MARINA_ROUTE_EVIDENCE_MAX_COST_USD",
    };
  }
  const needsPrice = objective === "value" || settings.maxCostPerItemUsd !== undefined;
  const considered: EvidenceConsidered[] = candidates.map((c) => {
    const e = models.get(modelKey(c.model));
    if (!e) return { route: c.route, model: c.model, n: 0, eligible: false, why: "no evidence" };
    const base = {
      route: c.route,
      model: c.model,
      n: e.n,
      accuracy: e.accuracy,
      ciLow: e.ciLow,
      ciHigh: e.ciHigh,
      costPerItemUsd: e.costPerItemUsd,
    };
    if (e.n < settings.minN)
      return { ...base, eligible: false, why: `n ${e.n} < ${settings.minN}` };
    if (needsPrice && e.costPerItemUsd === null)
      return { ...base, eligible: false, why: "unpriced" };
    if (
      settings.maxCostPerItemUsd !== undefined &&
      (e.costPerItemUsd ?? Number.POSITIVE_INFINITY) > settings.maxCostPerItemUsd
    ) {
      return { ...base, eligible: false, why: "over budget" };
    }
    return { ...base, eligible: true, why: "eligible" };
  });
  const eligible = considered.filter((c) => c.eligible);
  if (eligible.length < 2) {
    return {
      objective,
      considered,
      reason: `insufficient evidence: ${eligible.length} candidate(s) with n ≥ ${settings.minN}${needsPrice ? " priced" : ""}${settings.maxCostPerItemUsd === undefined ? "" : " within budget"}; need 2`,
    };
  }
  const order = new Map(candidates.map((c, i) => [c.route, i] as const));
  const cost = (c: EvidenceConsidered) => c.costPerItemUsd ?? Number.POSITIVE_INFINITY;
  const byLcb = [...eligible].sort(
    (a, b) =>
      (b.ciLow ?? 0) - (a.ciLow ?? 0) ||
      cost(a) - cost(b) ||
      (order.get(a.route) ?? 0) - (order.get(b.route) ?? 0),
  );
  const top = byLcb[0]!;
  let chosen = top;
  let reason = `best Wilson lower bound ${(top.ciLow ?? 0).toFixed(3)} (n=${top.n}) among ${eligible.length} eligible`;
  if (objective === "budget") {
    reason += ` within $${settings.maxCostPerItemUsd}/item`;
  } else if (objective === "value") {
    const bestEntry = models.get(modelKey(top.model))!;
    const accepted: EvidenceConsidered[] = [];
    for (const c of eligible) {
      if (c === top) {
        accepted.push(c);
        continue;
      }
      const verdict = notMeasurablyWorse(
        models.get(modelKey(c.model))!,
        bestEntry,
        tolerance,
        settings.minN,
      );
      c.why = verdict.ok ? `not worse (${verdict.why})` : `worse (${verdict.why})`;
      if (verdict.ok) accepted.push(c);
    }
    top.why = "best lower bound";
    chosen = [...accepted].sort(
      (a, b) =>
        cost(a) - cost(b) ||
        (b.ciLow ?? 0) - (a.ciLow ?? 0) ||
        (order.get(a.route) ?? 0) - (order.get(b.route) ?? 0),
    )[0]!;
    reason =
      chosen === top
        ? `value: best lower bound ${(top.ciLow ?? 0).toFixed(3)} is also the cheapest acceptable ($${cost(top).toFixed(4)}/item; tolerance ${tolerance})`
        : `value: cheapest not measurably worse than ${top.route} (LCB ${(top.ciLow ?? 0).toFixed(3)}): ${chosen.route} at $${cost(chosen).toFixed(4)}/item vs $${cost(top).toFixed(4)} (${chosen.why}; tolerance ${tolerance})`;
  }
  return {
    objective,
    pick: {
      route: chosen.route,
      model: chosen.model,
      ciLow: chosen.ciLow ?? 0,
      n: chosen.n,
      costPerItemUsd: chosen.costPerItemUsd ?? null,
    },
    considered,
    reason,
  };
}

/**
 * Pick at the role level first (participants playing `role`), then fall back
 * to model-level evidence when the role level cannot choose. Pure apart from
 * the injected `roleOf` lookup.
 */
export function pickWithRoleFallback(
  candidates: readonly EvidenceCandidate[],
  items: readonly EvidenceItem[],
  settings: Pick<
    RouteEvidenceSettings,
    "minN" | "maxCostPerItemUsd" | "objective" | "tolerance" | "includeWindow"
  >,
  role: string | undefined,
  roleOf: ((agent: string) => string | undefined) | undefined,
): EvidencePick & { level: "role" | "model" } {
  if (role && roleOf) {
    const roleEntries = collectEvidence(items, {
      includeWindow: settings.includeWindow,
      role,
      roleOf,
    });
    const rolePick = pickByEvidence(candidates, roleEntries, settings);
    if (rolePick.pick)
      return { ...rolePick, reason: `role ${role}: ${rolePick.reason}`, level: "role" };
  }
  const entries = collectEvidence(items, { includeWindow: settings.includeWindow });
  return { ...pickByEvidence(candidates, entries, settings), level: "model" };
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
  const { families, source: familySource } = evidenceFamilies(settings, role, db);
  if (families.length === 0 || !db) {
    return unchanged({
      evidence_mode: settings.mode,
      evidence: families.length === 0 ? "no_family" : "no_ledger",
    });
  }
  try {
    const result = pickWithRoleFallback(
      candidates,
      loadEvidenceItems(db, families),
      settings,
      role,
      roleLookup(db),
    );
    const signals: Record<string, number | string> = {
      evidence_mode: settings.mode,
      evidence_families: families.join(","),
      evidence_family_source: familySource,
      evidence_objective: result.objective,
      evidence_level: result.level,
    };
    if (result.objective === "value")
      signals.evidence_tolerance = settings.tolerance ?? DEFAULT_ROUTE_EVIDENCE_TOLERANCE;
    if (settings.maxCostPerItemUsd !== undefined)
      signals.evidence_budget_usd = settings.maxCostPerItemUsd;
    for (const c of result.considered) {
      signals[`evidence_n_${c.route}`] = c.n;
      if (c.ciLow !== undefined) signals[`evidence_lcb_${c.route}`] = Number(c.ciLow.toFixed(4));
      if (typeof c.costPerItemUsd === "number")
        signals[`evidence_cost_${c.route}`] = Number(c.costPerItemUsd.toFixed(6));
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
