// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Loop preferences — the instruments an agent sets on its own loop through
 * core memory (`memory [kv] set <key> <value>` / `memory [kv] delete <key>`, or
 * the memory tool's `rest` / `wake`), the same surface as `pace`. A choice
 * applies when its write succeeds; a refused call changes nothing. The
 * harness OFFERS these; the agent chooses:
 *
 * - `rest <why>` — rest deliberately: no model call until a reply is
 *   genuinely owed (a request tell, an addressed ask) or the long heartbeat
 *   (`MARINA_AGENT_HEARTBEAT_MS`); quiet turns are never failures.
 *   `memory delete rest` (or the memory tool's `wake`) resumes the loop.
 * - `channel_sends <n>` — public channel updates per run, within the operator
 *   ceiling `MARINA_CHANNEL_SENDS_PER_RUN`. Default 1; 0 opts out.
 * - `focus_persistent true` — stuck detection only SUGGESTS releasing the
 *   focus; the harness never clears it.
 * - `autonomy full` — a crew responder opts into self-scheduled cycles (own
 *   cycles, reflection, consolidation) instead of waking only on messages.
 * - `review off|observe|auto|on` — the pre-write review on the agent's own
 *   state-changing calls, within the operator ceiling `MARINA_OBLIGATIONS_REVIEW`
 *   (`src/obligations/review.ts`); unset means the ceiling.
 *
 * Pure parsing lives here so the adapter and tests share one grammar.
 */

import { parseReviewMode, type ReviewMode } from "../obligations/review";

export interface LoopPreferences {
  rest: string | null;
  channelSends: number | null;
  focusPersistent: boolean;
  autonomyFull: boolean;
  /** The agent's chosen pre-write review mode (capped by the operator), or null for the ceiling. */
  review: ReviewMode | null;
}

export const LOOP_PREFERENCE_KEYS = [
  "rest",
  "channel_sends",
  "focus_persistent",
  "autonomy",
  "review",
] as const;
export type LoopPreferenceKey = (typeof LOOP_PREFERENCE_KEYS)[number];

export function defaultLoopPreferences(): LoopPreferences {
  return {
    rest: null,
    channelSends: null,
    focusPersistent: false,
    autonomyFull: false,
    review: null,
  };
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
    case "review":
      prefs.review = parseReviewMode(value) ?? null;
      return;
  }
}

/**
 * Recognize `memory [kv] set <key> <value>` / `memory [kv] delete <key>` for a
 * loop preference in a raw command, so the adapter can apply it the moment
 * the write succeeds (the periodic core-memory read stays authoritative).
 */
export function parseLoopPreferenceCommand(
  command: string,
): { key: LoopPreferenceKey; value: string | undefined } | null {
  const match = command
    .trim()
    .match(/^memory\s+(?:kv\s+)?(set|delete|del|rm|remove)\s+([a-z_]+)(?:\s+([\s\S]*))?$/i);
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

/** What a successful self-write did to the agent's focus. */
export type FocusWrite = { set: string } | { clear: true };

/** Strip `task goal` modifiers (`priority:N`, `priority=N`, `--priority N`, `!pN`). */
function stripGoalModifiers(text: string): string {
  return text
    .replace(/(^|\s)--priority(?:=|\s+)\S+/gi, " ")
    .replace(/(^|\s)priority[:=]\S+/gi, " ")
    .replace(/(^|\s)!p\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The focus an agent declared through its own command — `memory [kv] set
 * focus|goal <text>`, `memory [kv] delete focus`, or `task goal <title> |
 * <description>` — so the loop's live focus follows the agent's choice.
 * `reply` is the command's output; a write that did not land changes nothing.
 */
export function parseFocusWrite(command: string, reply: string): FocusWrite | null {
  const cmd = command.trim();
  const set = cmd.match(/^memory\s+(?:kv\s+)?set\s+(focus|goal)\s+([\s\S]+)$/i);
  if (set) {
    const key = set[1]!.toLowerCase();
    if (!reply.includes(`Memory "${key}" set.`)) return null;
    let value = set[2]!.trim();
    if (value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value) as { description?: unknown };
        if (typeof parsed.description === "string") value = parsed.description;
      } catch {
        // allow-empty-catch: a value that is not JSON is the description itself
      }
    }
    return value ? { set: value.slice(0, 500) } : null;
  }
  if (/^memory\s+(?:kv\s+)?(?:delete|del|rm|remove)\s+focus\s*$/i.test(cmd)) {
    return { clear: true };
  }
  const goal = cmd.match(/^task\s+goal\s+([\s\S]+)$/i);
  if (goal) {
    if (!reply.includes("Goal set:")) return null;
    const rest = stripGoalModifiers(goal[1]!);
    const bar = rest.indexOf("|");
    const title = (bar >= 0 ? rest.slice(0, bar) : rest).trim();
    const description = bar >= 0 ? rest.slice(bar + 1).trim() : "";
    if (!title) return null;
    const text = description && description !== title ? `${title} — ${description}` : title;
    return { set: text.slice(0, 500) };
  }
  return null;
}

/**
 * The world command a self-directed tool call ran, for the loop-preference and
 * focus parsers: `marina_command` verbatim, and the focus/goal/memory tools'
 * actions spelled as the command they issue. Undefined for anything else.
 */
export function selfWriteCommand(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (toolName) {
    case "marina_command":
      return str(args.command) || undefined;
    case "marina_focus":
      if (args.action === "set" && str(args.description))
        return `memory set focus ${str(args.description)}`;
      return args.action === "clear" ? "memory delete focus" : undefined;
    case "marina_goal":
      if (args.action === "set") {
        const title = str(args.title);
        return `task goal ${title} | ${str(args.description) || title}`;
      }
      return undefined;
    case "memory":
      if (args.action === "rest") return `memory set rest ${str(args.content) || "resting"}`;
      return args.action === "wake" ? "memory delete rest" : undefined;
    default:
      return undefined;
  }
}

/** Cycles between the adapter's core-memory preference reads, right after a change. */
export const PREFERENCE_REFRESH_MIN_CYCLES = 50;
/** The ceiling the interval backs off to while nothing changes. */
export const PREFERENCE_REFRESH_MAX_CYCLES = 400;

/**
 * Next refresh interval: back to the minimum after a change, else double
 * (capped). An idle resident used to re-read pace and the five loop keys
 * every 50 cycles for ever — seven `memory get` round trips each time.
 */
export function nextPreferenceRefreshCycles(current: number, changed: boolean): number {
  if (changed) return PREFERENCE_REFRESH_MIN_CYCLES;
  return Math.min(
    PREFERENCE_REFRESH_MAX_CYCLES,
    Math.max(PREFERENCE_REFRESH_MIN_CYCLES, current * 2),
  );
}
