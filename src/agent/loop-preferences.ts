// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Loop preferences — the instruments an agent sets on its own loop through
 * core memory (`memory set <key> <value>` / `memory delete <key>`), the same
 * surface as `pace`. The harness OFFERS these; the agent chooses:
 *
 * - `rest <why>` — rest deliberately. Silent turns stop counting as failures
 *   (no backoff, no forced-action nudge) and the loop ticks at its idle rate.
 *   Events addressed to the agent ([!]) still nudge. `memory delete rest` wakes.
 * - `channel_sends <n>` — public channel updates per run, within the operator
 *   ceiling `MARINA_CHANNEL_SENDS_PER_RUN`. Default 1; 0 opts out.
 * - `focus_persistent true` — stuck detection only SUGGESTS releasing the
 *   focus; the harness never clears it.
 * - `autonomy full` — a crew responder opts into an autonomous life (own
 *   cycles, reflection, consolidation) instead of waking only on messages.
 *
 * Pure parsing lives here so the adapter and tests share one grammar.
 */

export interface LoopPreferences {
  rest: string | null;
  channelSends: number | null;
  focusPersistent: boolean;
  autonomyFull: boolean;
}

export const LOOP_PREFERENCE_KEYS = [
  "rest",
  "channel_sends",
  "focus_persistent",
  "autonomy",
] as const;
export type LoopPreferenceKey = (typeof LOOP_PREFERENCE_KEYS)[number];

export function defaultLoopPreferences(): LoopPreferences {
  return { rest: null, channelSends: null, focusPersistent: false, autonomyFull: false };
}

/** Apply one core-memory value (undefined = key absent/deleted) to `prefs`. */
export function applyLoopPreference(
  prefs: LoopPreferences,
  key: LoopPreferenceKey,
  raw: string | undefined,
): void {
  const value = raw?.trim() ?? "";
  switch (key) {
    case "rest":
      prefs.rest = value ? value.slice(0, 200) : null;
      return;
    case "channel_sends": {
      const n = Number.parseInt(value, 10);
      prefs.channelSends = Number.isFinite(n) && n >= 0 ? n : null;
      return;
    }
    case "focus_persistent":
      prefs.focusPersistent = /^(true|yes|on|1)$/i.test(value);
      return;
    case "autonomy":
      prefs.autonomyFull = /^full$/i.test(value);
      return;
  }
}

/**
 * Recognize `memory set <key> <value>` / `memory delete <key>` for a loop
 * preference in a raw command, so the adapter can apply it the moment the
 * agent issues it (the periodic core-memory read stays authoritative).
 */
export function parseLoopPreferenceCommand(
  command: string,
): { key: LoopPreferenceKey; value: string | undefined } | null {
  const match = command
    .trim()
    .match(/^memory\s+(set|delete|del|rm|remove)\s+([a-z_]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const key = match[2]!.toLowerCase();
  if (!(LOOP_PREFERENCE_KEYS as readonly string[]).includes(key)) return null;
  const set = match[1]!.toLowerCase() === "set";
  return { key: key as LoopPreferenceKey, value: set ? (match[3] ?? "") : undefined };
}

/** Default public channel updates per run. */
export const DEFAULT_CHANNEL_SENDS_PER_RUN = 1;
/** Ceiling when the operator sets none — an agent may raise its budget this far. */
export const DEFAULT_CHANNEL_SENDS_CEILING = 3;

/** Operator ceiling for channel sends per run (`MARINA_CHANNEL_SENDS_PER_RUN`). */
export function channelSendsCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.MARINA_CHANNEL_SENDS_PER_RUN ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CHANNEL_SENDS_CEILING;
}

/** The effective per-run budget: the agent's choice (default 1), clamped to the ceiling. */
export function channelSendsBudget(
  agentChoice: number | null,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const ceiling = channelSendsCeiling(env);
  return Math.min(agentChoice ?? DEFAULT_CHANNEL_SENDS_PER_RUN, ceiling);
}
