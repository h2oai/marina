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
 *   MARINA_ROUTE_FAST_MODEL      provider/model for mechanical, local work
 *   MARINA_ROUTE_POWERFUL_MODEL  provider/model for multi-part or unclear work
 *
 * Without a decision backend (or a goal) the router fails OPEN to the
 * powerful tier: a routing outage costs money, never answer quality.
 */

import { getErrorMessage } from "../engine/errors";
import { getDecisionProvider } from "./config";
import { decideRoute, ROUTER_QUESTIONS, type RouteTier, type RouteVerdict } from "./policy";
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

export interface RoutedModel {
  model: string;
  tier: RouteTier;
  verdict: RouteVerdict;
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
