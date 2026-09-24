// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn-time model routing: `agent spawn <name> model:route goal:<…>` asks the
 * router questions about the goal ONCE, before the agent's conversation
 * exists, and resolves the model to one of two operator-configured tiers.
 * The resolved model is what gets persisted, so respawns keep it — a Marina
 * agent never switches model mid-conversation, which would discard the
 * provider's prompt cache for its whole transcript.
 *
 *   MARINA_ROUTES                a route TABLE: JSON `{ "<name>": { "model": "provider/model",
 *                                "criteria": "<what this model suits>" }, … }` (≥ 2 routes);
 *                                the criteria ARE the options of one `choice` question
 *   MARINA_ROUTE_INSTRUCTIONS    guidance for the pick (default: least costly model that can do it)
 *   MARINA_ROUTE_FALLBACK        route used on low confidence / outage (default `powerful`, else the last)
 *   MARINA_ROUTE_FAST_MODEL      two-route shorthand (tier choice + complexity escalation)
 *   MARINA_ROUTE_POWERFUL_MODEL  when MARINA_ROUTES is unset
 *
 * Without a decision backend (or a goal) the router fails OPEN to the
 * powerful tier: a routing outage costs money, never answer quality.
 */

import { getErrorMessage } from "../engine/errors";
import { getDecisionProvider } from "./config";
import { decideRoute, ROUTER_QUESTIONS, type RouteVerdict } from "./policy";
import { choice } from "./questions";
import type { DecisionProvider } from "./types";

/** The `model` value that asks the router to pick. */
export const ROUTE_MODEL = "route";

export interface RouteTiers {
  fast: string;
  powerful: string;
}

export function isRouteModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === ROUTE_MODEL;
}

export function routeTiersFromEnv(env: NodeJS.ProcessEnv = process.env): RouteTiers | undefined {
  const fast = env.MARINA_ROUTE_FAST_MODEL?.trim();
  const powerful = env.MARINA_ROUTE_POWERFUL_MODEL?.trim();
  return fast && powerful ? { fast, powerful } : undefined;
}

export interface RouteEntry {
  model: string;
  criteria: string;
}

export interface RouteTable {
  routes: Record<string, RouteEntry>;
  instructions: string;
  fallback: string;
}

export const DEFAULT_ROUTE_INSTRUCTIONS =
  "Choose the least costly model that can complete the task.";
/** Pick confidence below which the table's fallback route is used. */
export const ROUTE_TABLE_MIN_CONFIDENCE = 0.6;
const ROUTE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Invalid `MARINA_ROUTES` — refuses the spawn with the message. */
export class RouteConfigError extends Error {
  constructor(message: string) {
    super(`MARINA_ROUTES: ${message}`);
    this.name = "RouteConfigError";
  }
}

/** The route table from env, or undefined when MARINA_ROUTES is unset. Throws RouteConfigError. */
export function routeTableFromEnv(env: NodeJS.ProcessEnv = process.env): RouteTable | undefined {
  const raw = env.MARINA_ROUTES?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RouteConfigError('must be JSON: {"<name>": {"model": "...", "criteria": "..."}}');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RouteConfigError("must be an object keyed by route name");
  }
  const routes: Record<string, RouteEntry> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ROUTE_NAME.test(name)) throw new RouteConfigError(`invalid route name "${name}"`);
    const v = (value ?? {}) as Record<string, unknown>;
    const model = typeof v.model === "string" ? v.model.trim() : "";
    const criteria = typeof v.criteria === "string" ? v.criteria.trim() : "";
    if (!model || !criteria) {
      throw new RouteConfigError(`route "${name}" needs a non-empty model and criteria`);
    }
    routes[name] = { model, criteria };
  }
  const names = Object.keys(routes);
  if (names.length < 2) throw new RouteConfigError("needs at least two routes");
  const fallback =
    env.MARINA_ROUTE_FALLBACK?.trim() || (routes.powerful ? "powerful" : names.at(-1)!);
  if (!routes[fallback]) throw new RouteConfigError(`fallback "${fallback}" is not a route`);
  return {
    routes,
    instructions: env.MARINA_ROUTE_INSTRUCTIONS?.trim() || DEFAULT_ROUTE_INSTRUCTIONS,
    fallback,
  };
}

export interface RoutedModel {
  model: string;
  /** The chosen route (a table route name, or `fast` / `powerful`). */
  tier: string;
  verdict: { reason: string; signals: Record<string, number | string> };
  provider?: string;
  decisionModel?: string;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
}

const MAX_GOAL_CHARS = 4_000;

/** Pick the spawn model for a goal. Never throws for a backend failure (fails open). */
export async function routeModelForGoal(
  goal: string | undefined,
  role: string | undefined,
  tiers: RouteTiers,
  provider: DecisionProvider | undefined = getDecisionProvider(),
): Promise<RoutedModel> {
  const pick = (verdict: RouteVerdict, extra: Partial<RoutedModel> = {}): RoutedModel => ({
    model: tiers[verdict.tier],
    tier: verdict.tier,
    verdict,
    ...extra,
  });
  const text = goal?.trim();
  if (!provider || !text) {
    return pick({
      ...decideRoute(undefined),
      reason: !provider
        ? "no decision backend configured; using the powerful tier"
        : "no goal to route on; using the powerful tier",
    });
  }
  try {
    const result = await provider.ask({
      state: { goal: text.slice(0, MAX_GOAL_CHARS), ...(role ? { role } : {}) },
      questions: ROUTER_QUESTIONS,
    });
    return pick(decideRoute(result.answers), {
      provider: result.provider,
      decisionModel: result.model,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    });
  } catch (err) {
    return pick(decideRoute(undefined), {
      provider: provider.kind,
      decisionModel: provider.model,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Pick the spawn model from a route TABLE: one `choice` question whose options
 * are the routes' criteria. Low pick confidence, no backend, no goal or a
 * backend error use the table's fallback route (fails open, recorded).
 */
export async function routeModelWithTable(
  goal: string | undefined,
  role: string | undefined,
  table: RouteTable,
  provider: DecisionProvider | undefined = getDecisionProvider(),
): Promise<RoutedModel> {
  const route = (name: string, reason: string, extra: Partial<RoutedModel> = {}): RoutedModel => ({
    model: table.routes[name]!.model,
    tier: name,
    verdict: { reason, signals: {} },
    ...extra,
  });
  const text = goal?.trim();
  if (!provider)
    return route(table.fallback, "no decision backend configured; using the fallback route");
  if (!text) return route(table.fallback, "no goal to route on; using the fallback route");
  const question = choice(
    table.instructions,
    Object.fromEntries(Object.entries(table.routes).map(([name, r]) => [name, r.criteria])),
  );
  try {
    const result = await provider.ask({
      state: { goal: text.slice(0, MAX_GOAL_CHARS), ...(role ? { role } : {}) },
      questions: { route: question },
    });
    const meta = {
      provider: result.provider,
      decisionModel: result.model,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
    const answer = result.answers.route;
    if (answer?.type !== "choice")
      return route(table.fallback, "router gave no choice; fallback", meta);
    // Keep the whole distribution in the decision event (auditable routing).
    const signals: Record<string, number | string> = { route: answer.choice };
    if (answer.confidence !== undefined) signals.confidence = answer.confidence;
    for (const [name, p] of Object.entries(answer.probabilities ?? {})) signals[`p_${name}`] = p;
    const verdict = (name: string, reason: string) => ({
      ...route(name, reason, meta),
      verdict: { reason, signals },
    });
    if (answer.confidence !== undefined && answer.confidence < ROUTE_TABLE_MIN_CONFIDENCE) {
      return verdict(
        table.fallback,
        `pick confidence ${answer.confidence.toFixed(2)} < ${ROUTE_TABLE_MIN_CONFIDENCE}; fallback`,
      );
    }
    return verdict(answer.choice, `picked ${answer.choice}`);
  } catch (err) {
    return route(table.fallback, "router unavailable; using the fallback route", {
      provider: provider.kind,
      decisionModel: provider.model,
      error: getErrorMessage(err),
    });
  }
}
