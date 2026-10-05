// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one knowledge-bound rule for every backtest that guards against model
 * weights having seen an outcome — the FutureX clean backtest
 * (`benchmarks/futurex/clean.ts`) and configuration selection (`select.ts`):
 *
 *   release table   `MODEL_RELEASES`, pinned public release dates (an upper
 *                   bound on a model's knowledge cutoff), overlaid on the live
 *                   catalogue's `created` dates when a caller has them
 *                   (`releaseTable`) — the pinned table always wins;
 *   floating alias  an id that can be re-pointed at newer weights after its
 *                   catalogue date (`isFloatingAlias`) has no trustworthy
 *                   release date: it is refused, never bounded;
 *   margin          a forecast is clean only when its cutoff is MORE than
 *                   `KNOWLEDGE_MARGIN_DAYS` after the latest release among its
 *                   models (`afterKnowledge`).
 *
 * A FutureX row's cutoff is its end time minus the backtest horizon (7 days by
 * default), so the default clean window is "ends more than 10 days after the
 * bound" — the rule the clean backtest has always applied.
 */

/**
 * Public release dates (UTC) — an upper bound on each model's knowledge
 * cutoff. Source: OpenRouter's model catalogue
 * (`https://openrouter.ai/api/v1/models`, field `created`), read 2026-10-02.
 * Keys are the id after the `openrouter/` routing prefix.
 */
export const MODEL_RELEASES: Record<string, string> = {
  "deepseek/deepseek-v4-pro-0813": "2026-08-12",
  "deepseek/deepseek-v4-pro": "2026-04-24",
  "deepseek/deepseek-v4-flash": "2026-04-24",
  "anthropic/claude-opus-5": "2026-07-24",
  "google/gemini-3.5-flash-lite": "2026-07-21",
  "google/gemini-3.8-flash": "2026-09-02",
  "moonshotai/kimi-k3": "2026-07-16",
  "z-ai/glm-5.1": "2026-04-07",
  "anthropic/claude-opus-5.5": "2026-09-22",
  "anthropic/claude-sonnet-5.5": "2026-09-28",
  "anthropic/claude-fable-5.1": "2026-09-01",
  "openai/gpt-6-astra-pro": "2026-09-04",
  "openai/gpt-6.1-sol-pro": "2026-09-29",
  "openai/gpt-6-luna": "2026-09-22",
  "openai/gpt-6-sol": "2026-09-22",
  "openai/gpt-6.1-sol": "2026-09-29",
};

/**
 * Unversioned ids known to have been re-pointed at newer weights after their
 * catalogue date. `isFloatingAlias` also catches the general shapes.
 */
export const FLOATING_ALIASES = new Set(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]);

/** A clean forecast's cutoff is more than this many days after its models' latest release. */
export const KNOWLEDGE_MARGIN_DAYS = 3;

const DAY = 86_400_000;

const bare = (m: string) => m.replace(/^openrouter\//, "");

/** A dated snapshot suffix: `-0813`, `-20260813`, `-2026-08-13`. */
const SNAPSHOT = /^(\d{4}|\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Whether `id` is a floating alias: a known one, a `~`-prefixed or `latest`
 * route, or an unversioned id with a dated pinned sibling among `known` ids
 * (`x/model` beside `x/model-0813`).
 */
export function isFloatingAlias(id: string, known: Iterable<string> = []): boolean {
  const m = bare(id);
  if (FLOATING_ALIASES.has(m) || m.startsWith("~") || /[-:/]latest$/i.test(m)) return true;
  for (const k of known) {
    const other = bare(k);
    if (other.startsWith(`${m}-`) && SNAPSHOT.test(other.slice(m.length + 1))) return true;
  }
  return false;
}

/** The release table: catalogue dates (bare id → YYYY-MM-DD) under the pinned ones. */
export function releaseTable(catalogue: Record<string, string> = {}): Record<string, string> {
  return { ...catalogue, ...MODEL_RELEASES };
}

export type KnowledgeBound =
  | { after: string }
  | { error: string; reason: "floating" | "unknown"; models: string[] };

/**
 * The latest release among `models` (YYYY-MM-DD), or why there is none: a
 * floating alias (refused everywhere) or a model with no known release.
 */
export function knowledgeBoundOf(
  models: string[],
  releases: Record<string, string> = MODEL_RELEASES,
): KnowledgeBound {
  const ids = [...new Set(models.map(bare))];
  const known = Object.keys(releases);
  const floating = ids.filter((m) => isFloatingAlias(m, known));
  if (floating.length) {
    return {
      error: `floating alias ${floating.join(", ")}: name a pinned model id`,
      reason: "floating",
      models: floating,
    };
  }
  const unknown = ids.filter((m) => !releases[m]);
  if (unknown.length) {
    return {
      error: `no known release date for ${unknown.join(", ")}`,
      reason: "unknown",
      models: unknown,
    };
  }
  return { after: ids.map((m) => releases[m]!).sort().at(-1)! };
}

/** Whether a forecast with this cutoff is clean of a model bound (strictly after the margin). */
export function afterKnowledge(
  cutoff: string | number,
  bound: string,
  marginDays = KNOWLEDGE_MARGIN_DAYS,
): boolean {
  const t = typeof cutoff === "number" ? cutoff : Date.parse(cutoff);
  return Number.isFinite(t) && t > Date.parse(bound) + marginDays * DAY;
}
