// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for macro expansion: argument substitution and the posture-
 * aware expansion limits. The command phase (`command-phase-coordinator.ts`)
 * owns cycle detection, rate-limit charging and execution.
 */

import { getAutonomyPosture } from "./autonomy";
import { isLocalUngated } from "./trust-profile";

/** Default nesting bound under shared/public posture (`MARINA_MACRO_MAX_DEPTH`). */
export const MAX_MACRO_DEPTH = 8;
/** Default per-invocation command bound under shared/public posture (`MARINA_MACRO_MAX_EXPANSIONS`). */
export const MAX_MACRO_EXPANSIONS = 100;

/** Owner key prefix for a room-scoped macro (`macros.author_id = "room:<roomId>"`). */
export const ROOM_MACRO_OWNER_PREFIX = "room:";

export function roomMacroOwner(roomId: string): string {
  return `${ROOM_MACRO_OWNER_PREFIX}${roomId}`;
}

export interface MacroLimits {
  /** Maximum nesting depth; `Infinity` when unlimited. */
  maxDepth: number;
  /** Maximum commands per top-level invocation; `Infinity` when unlimited. */
  maxExpansions: number;
}

/** A non-negative integer from env (`0` = unlimited), or undefined when unset or junk. */
function limitFromEnv(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

/**
 * Expansion limits for the current posture. An explicit env value wins in
 * every posture (`0` = unlimited). Unset, the operator's local-ungated
 * instance and the `open` posture are unlimited; shared/public keep the
 * defaults. Cycle detection is not a limit and is never lifted.
 */
export function macroLimits(env: NodeJS.ProcessEnv = process.env): MacroLimits {
  const lifted = isLocalUngated(env) || getAutonomyPosture(env) === "open";
  const fallbackDepth = lifted ? Number.POSITIVE_INFINITY : MAX_MACRO_DEPTH;
  const fallbackExpansions = lifted ? Number.POSITIVE_INFINITY : MAX_MACRO_EXPANSIONS;
  return {
    maxDepth: limitFromEnv(env.MARINA_MACRO_MAX_DEPTH) ?? fallbackDepth,
    maxExpansions: limitFromEnv(env.MARINA_MACRO_MAX_EXPANSIONS) ?? fallbackExpansions,
  };
}

const PLACEHOLDER = /\$(\$|\*|@|[1-9])/g;

/** True when the body references the caller's arguments (`$$` is an escape, not a reference). */
export function usesMacroArgs(body: string): boolean {
  for (const match of body.matchAll(PLACEHOLDER)) if (match[1] !== "$") return true;
  return false;
}

/**
 * Split a macro body on `;` and bind the caller's arguments.
 *
 * `args` is the caller's raw text after the verb and is never re-tokenised:
 * `$*` and `$@` insert it verbatim, `$1`..`$9` insert its whitespace-split
 * words (empty when absent), `$$` is a literal `$`. The body is split BEFORE
 * substitution, so a `;` inside the arguments never starts a new command.
 * With no argument placeholder anywhere in the body, non-empty arguments are
 * appended to the LAST command, which makes a one-command macro an alias.
 */
export function expandMacroBody(body: string, args: string): string[] {
  const commands = body
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  if (!usesMacroArgs(body)) {
    const bound = commands.map((c) => c.replace(PLACEHOLDER, (m, p) => (p === "$" ? "$" : m)));
    if (args && bound.length > 0) bound[bound.length - 1] = `${bound.at(-1)} ${args}`;
    return bound;
  }
  return commands.map((c) =>
    c.replace(PLACEHOLDER, (_m, p: string) => {
      if (p === "$") return "$";
      if (p === "*" || p === "@") return args;
      return words[Number(p) - 1] ?? "";
    }),
  );
}
